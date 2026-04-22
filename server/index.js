import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

// Read app version from package.json so /api/health can report it and
// the client can pin a build identifier to its topbar.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
let APP_VERSION = '0.0.0'
try {
  const pkgPath = path.join(__dirname, '..', 'package.json')
  APP_VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0'
} catch {}

// Electron packaging quirk: @ffmpeg-installer returns a path like
//   .../app.asar/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe
// but we asarUnpack ffmpeg (binaries can't be executed from inside an
// asar archive), so the real file lives under app.asar.unpacked.
// Rewrite the path and verify it exists before we try to spawn it.
let FFMPEG_PATH = ffmpegInstaller.path
if (FFMPEG_PATH.includes('app.asar') && !FFMPEG_PATH.includes('app.asar.unpacked')) {
  FFMPEG_PATH = FFMPEG_PATH.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}
try {
  fs.accessSync(FFMPEG_PATH, fs.constants.X_OK)
  console.log('ffmpeg:', FFMPEG_PATH)
} catch (e) {
  console.error('ffmpeg NOT FOUND at', FFMPEG_PATH, '-', e.message)
}

// ── Config ──────────────────────────────────────────────────────
const PREFERRED_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.ogv', '.flv', '.wmv', '.ts', '.m2ts']
const STREAM_PORT = 3001
const API_PORT = 3000

const TMDB_API_KEY = process.env.TMDB_API_KEY
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500'
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/w1280'
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY

const FETCH_OPTS = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  // Abort stalled requests so we don't queue up retries against dead mirrors.
  signal: undefined, // placeholder; per-call timeout handled by fetchWithTimeout
}

// Fetch with a timeout so dead mirrors don't stall us.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...FETCH_OPTS, ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

// Log throttler — suppresses duplicate error lines. We were flooding the
// console when a catalog endpoint hiccupped and the UI retried on every
// tab switch.
const LOG_THROTTLE_MS = 60_000
const _logSeen = new Map()
function logThrottled(level, key, msg) {
  const now = Date.now()
  const last = _logSeen.get(key) || 0
  if (now - last < LOG_THROTTLE_MS) return
  _logSeen.set(key, now)
  if (level === 'error') console.error(msg)
  else if (level === 'warn') console.warn(msg)
  else console.log(msg)
}

// Well-known trackers for reliable peer discovery
const TRACKERS = [
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
]
const TRACKER_PARAMS = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')

function addTrackers(magnet) {
  if (!magnet) return magnet
  // Don't double-add if it already has trackers
  if (/&tr=/i.test(magnet)) return magnet
  return magnet + TRACKER_PARAMS
}

// ── YTS / EZTV mirrors ─────────────────────────────────────────
const YTS_MIRRORS = [
  'https://movies-api.accel.li/api/v2',
  'https://yts.lt/api/v2',
  'https://yts.mx/api/v2',
]
const EZTV_BASE = 'https://eztvx.to/api'

// ── Kill old processes on our ports before starting ─────────────
async function freePort(port) {
  try {
    const { execSync } = await import('child_process')
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTEN"`, { encoding: 'utf8', timeout: 3000 }).trim()
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && p !== '0'))]
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 }) } catch {}
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 500))
  } catch {}
}

await freePort(STREAM_PORT)
await freePort(API_PORT)

// ── Disk cache ──────────────────────────────────────────────────
// WebTorrent downloads are persisted here so re-watching doesn't redownload.
// We cap the cache at CACHE_MAX_BYTES and prune oldest torrents (by access
// time) on startup and whenever a new torrent is added.
// Honor the env var set by Electron main (userData/cache). In dev fall
// back to ./cache next to the project so streams persist between runs.
const CACHE_DIR = process.env.WARDOFLIX_CACHE_DIR || path.join(process.cwd(), 'cache')
const CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024 // 20 GB default
try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch (e) {
  console.error('Cache dir create failed:', CACHE_DIR, e.message)
}
console.log('CACHE_DIR:', CACHE_DIR)

function dirSize(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += dirSize(p)
        else if (entry.isFile()) total += fs.statSync(p).size
      } catch {}
    }
  } catch {}
  return total
}

function pruneCache() {
  try {
    const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = path.join(CACHE_DIR, e.name)
        let atime = 0, size = 0
        try { const st = fs.statSync(p); atime = st.atimeMs || st.mtimeMs; size = dirSize(p) } catch {}
        return { name: e.name, path: p, atime, size }
      })
    // Skip dirs currently in use by a live torrent
    const inUse = new Set(client.torrents.map((t) => (t.infoHash || '').toLowerCase()))
    const candidates = entries.filter((e) => !inUse.has(e.name.toLowerCase()))
    let total = entries.reduce((s, e) => s + e.size, 0)
    candidates.sort((a, b) => a.atime - b.atime) // oldest-access first
    for (const c of candidates) {
      if (total <= CACHE_MAX_BYTES) break
      try {
        fs.rmSync(c.path, { recursive: true, force: true })
        total -= c.size
        console.log(`Cache: pruned ${c.name} (${(c.size / 1e9).toFixed(2)} GB)`)
      } catch (e) {
        logThrottled('warn', `prune:${c.name}`, `Cache prune failed for ${c.name}: ${e.message}`)
      }
    }
  } catch {}
}

// ── WebTorrent ──────────────────────────────────────────────────
const client = new WebTorrent()
const wtServer = client.createServer({ pathname: '/stream' })
try {
  wtServer.listen(STREAM_PORT, () => console.log(`Stream server: http://localhost:${STREAM_PORT}`))
} catch (err) {
  console.error('Stream server failed to start:', err.message)
}

const streamBaseUrl = ''

// Auto-cleanup inactive torrents after 2 hours — detach from client but
// KEEP files on disk so a re-stream can resume from cache.
const TORRENT_TTL = 2 * 60 * 60 * 1000
const torrentTimers = new Map()
function touchTorrent(infoHash) {
  // Normalize the info-hash to lowercase so the Map key and the lookup
  // below always match. Some call sites pass mixed-case hashes which
  // previously caused the cleanup timer to silently find no torrent
  // (leaking memory until process restart).
  const key = String(infoHash || '').toLowerCase()
  if (!key) return
  if (torrentTimers.has(key)) clearTimeout(torrentTimers.get(key))
  torrentTimers.set(key, setTimeout(() => {
    const t = client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === key)
    if (t) {
      console.log(`Cleanup: ${t.name || key} (files kept in cache)`)
      // destroy({ destroyStore: false }) is the default — we rely on it.
      t.destroy({ destroyStore: false })
    }
    torrentTimers.delete(key)
    // Evict the REMUX_META entry for this hash — otherwise the map grows
    // every time a new torrent is added, and the cached duration could
    // also go stale if the same hash is later re-added with a different
    // track selection.
    try { REMUX_META?.delete(key) } catch {}
  }, TORRENT_TTL))
}

// ── Express setup ───────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

// Health probe — Electron main polls this before loading the UI.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    cache: CACHE_DIR,
    lanIp: typeof getLanIp === 'function' ? getLanIp() : null,
  })
})

// Dedicated version endpoint — cheap to call, the client polls once on boot.
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION })
})

// ── Helper: TMDB fetch (in-memory cache + retry) ────────────────
// In-memory cache stops the Browse page from blanking out when the user
// returns from streaming — the TMDB API can be slow/rate-limited while
// WebTorrent is hogging the event loop, so serving from cache keeps the
// UI populated even if the upstream request fails.
const TMDB_CACHE = new Map() // url -> { ts, data }
const TMDB_CACHE_TTL_OK = 10 * 60 * 1000    // 10 min for successful responses
const TMDB_CACHE_TTL_STALE = 60 * 60 * 1000 // 1 h — serve stale while errors
async function tmdbFetch(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY not set in .env')
  const url = new URL(`${TMDB_BASE}/${path}`)
  url.searchParams.set('api_key', TMDB_API_KEY)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const key = url.toString()
  const cached = TMDB_CACHE.get(key)
  const now = Date.now()

  // Fresh cache hit → return immediately
  if (cached && now - cached.ts < TMDB_CACHE_TTL_OK) return cached.data

  // Retry once on transient network failures
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchWithTimeout(key, {}, 8000)
      if (!r.ok) throw new Error(`TMDB ${r.status}`)
      const data = await r.json()
      TMDB_CACHE.set(key, { ts: now, data })
      // Keep cache map from growing unboundedly
      if (TMDB_CACHE.size > 500) {
        const oldest = [...TMDB_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
        if (oldest) TMDB_CACHE.delete(oldest[0])
      }
      return data
    } catch (e) {
      lastErr = e
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
    }
  }

  // Stale-while-error: serve cached data if we have it, up to 1 h old
  if (cached && now - cached.ts < TMDB_CACHE_TTL_STALE) {
    logThrottled('warn', `tmdb-stale:${path}`, `TMDB ${path} failed — serving stale cache`)
    return cached.data
  }
  throw lastErr
}

// ── Trailer wrapper page ───────────────────────────────────────
// In packaged Electron the renderer loads via file:// which makes YouTube
// refuse to embed (null origin). We serve a tiny HTML wrapper from this
// http://localhost:3000 origin so the iframe sees a real http parent and
// YouTube's embed works. The React app points its trailer <iframe> at
// /trailer?v=KEY instead of YouTube directly.
app.get('/trailer', (req, res) => {
  const v = String(req.query.v || '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!v) return res.status(400).send('Missing video id')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Trailer</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe
  src="https://www.youtube-nocookie.com/embed/${v}?autoplay=1&rel=0&modestbranding=1&playsinline=1"
  title="Trailer"
  allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
  allowfullscreen
></iframe>
</body>
</html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(html)
})

// ── Catalog: genres (from TMDB) ─────────────────────────────────
app.get('/api/catalog/genres/:type', async (req, res) => {
  const { type } = req.params
  if (type !== 'movies' && type !== 'tv') return res.status(400).json({ error: 'Invalid type' })
  try {
    const endpoint = type === 'movies' ? 'genre/movie/list' : 'genre/tv/list'
    const data = await tmdbFetch(endpoint)
    res.json({ genres: data.genres || [] })
  } catch (err) {
    logThrottled('error', `genres:${type}:${err.message}`, `Genres error (${type}): ${err.message}`)
    res.json({ genres: [] })
  }
})

// ── Catalog: browse movies & TV (from TMDB) ─────────────────────
app.get('/api/catalog/:type', async (req, res) => {
  const { type } = req.params
  const { category = 'popular', genre, page = 1, search } = req.query
  if (type !== 'movies' && type !== 'tv') {
    return res.status(400).json({ error: 'Invalid type' })
  }
  try {
    const mediaType = type === 'movies' ? 'movie' : 'tv'
    let data

    if (search && String(search).trim()) {
      data = await tmdbFetch(`search/${mediaType}`, { query: search, page })
    } else if (genre) {
      data = await tmdbFetch(`discover/${mediaType}`, {
        with_genres: genre,
        sort_by: 'popularity.desc',
        page,
      })
    } else {
      const endpointMap = {
        popular: `${mediaType}/popular`,
        trending: `trending/${mediaType}/week`,
        top: `${mediaType}/top_rated`,
        new: type === 'movies' ? 'movie/now_playing' : 'tv/on_the_air',
      }
      const endpoint = endpointMap[category] || endpointMap.popular
      data = await tmdbFetch(endpoint, { page })
    }

    const results = (data.results || []).map((item) => ({
      id: item.id,
      title: item.title || item.name,
      name: item.name || item.title,
      poster_path: item.poster_path ? `${TMDB_IMAGE}${item.poster_path}` : null,
      backdrop_path: item.backdrop_path ? `${TMDB_BACKDROP}${item.backdrop_path}` : null,
      overview: item.overview || '',
      release_date: item.release_date || null,
      first_air_date: item.first_air_date || null,
      vote_average: item.vote_average || 0,
      genre_ids: item.genre_ids || [],
    }))

    res.json({
      results,
      page: data.page || 1,
      total_pages: Math.min(data.total_pages || 1, 500),
    })
  } catch (err) {
    logThrottled('error', `catalog:${type}:${category}:${err.message}`, `Catalog error (${type}/${category}): ${err.message}`)
    // Never 500 on catalog — the UI treats that as "broken". Return an
    // empty result set so the row quietly disappears instead of blanking
    // the whole page when a single TMDB fetch fails.
    res.json({ results: [], page: 1, total_pages: 1, stale: true, error: err.message })
  }
})

// ── TMDB: get external IDs (IMDb) for a title ───────────────────
async function getImdbId(tmdbId, type) {
  if (!TMDB_API_KEY || !tmdbId) return null
  try {
    const mediaType = type === 'movies' ? 'movie' : 'tv'
    const data = await tmdbFetch(`${mediaType}/${tmdbId}/external_ids`)
    return data.imdb_id || null
  } catch { return null }
}

// ── TMDB rich details (trailer + credits + similar + external_ids) ──
// Single call using TMDB's append_to_response — one request fetches
// everything the DetailModal needs. Cached for 1 h per title.
const DETAILS_CACHE = new Map()
const DETAILS_CACHE_TTL = 60 * 60 * 1000

app.get('/api/details/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const mediaType = (type === 'tv' || type === 'series') ? 'tv' : 'movie'
  const cacheKey = `${mediaType}:${tmdbId}`
  const cached = DETAILS_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < DETAILS_CACHE_TTL) {
    return res.json(cached.data)
  }
  try {
    const data = await tmdbFetch(`${mediaType}/${tmdbId}`, {
      append_to_response: 'videos,credits,similar,external_ids',
    })
    // Trim videos to YouTube trailers/teasers only
    const videos = (data.videos?.results || [])
      .filter((v) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type))
      .sort((a, b) => {
        // Official trailers first, then teasers; newest-last within same kind
        if (a.type === 'Trailer' && b.type !== 'Trailer') return -1
        if (b.type === 'Trailer' && a.type !== 'Trailer') return 1
        return (a.official ? 0 : 1) - (b.official ? 0 : 1)
      })
      .slice(0, 5)
      .map((v) => ({ key: v.key, name: v.name, type: v.type, official: !!v.official }))

    const cast = (data.credits?.cast || []).slice(0, 12).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profile: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    }))

    const crew = (data.credits?.crew || [])
      .filter((c) => ['Director', 'Creator', 'Writer'].includes(c.job) || c.department === 'Writing')
      .slice(0, 6)
      .map((c) => ({ id: c.id, name: c.name, job: c.job }))

    const similar = (data.similar?.results || []).slice(0, 12).map((s) => ({
      id: s.id,
      title: s.title || s.name,
      year: (s.release_date || s.first_air_date || '').slice(0, 4),
      poster: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : null,
      rating: s.vote_average || 0,
      type: mediaType === 'tv' ? 'tv' : 'movies',
    }))

    const payload = {
      tmdbId: Number(tmdbId),
      imdbId: data.external_ids?.imdb_id || null,
      videos,
      cast,
      crew,
      similar,
      runtime: data.runtime || (data.episode_run_time?.[0] || null),
      tagline: data.tagline || '',
      genres: (data.genres || []).map((g) => g.name),
      status: data.status,
      networks: (data.networks || []).map((n) => n.name),
    }
    DETAILS_CACHE.set(cacheKey, { data: payload, timestamp: Date.now() })
    res.json(payload)
  } catch (err) {
    console.error(`[details] ${mediaType}/${tmdbId}: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

// ── Torrent search ──────────────────────────────────────────────
function parseSeasonEpisode(filename) {
  const m = (filename || '').match(/S(\d{1,4})E(\d{1,4})/i) || (filename || '').match(/(\d{1,2})x(\d{1,4})/i)
  return m ? { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) } : null
}

// Normalize a title or torrent name for fuzzy comparison.
// Lowercases, replaces all separators/punctuation with spaces, collapses whitespace.
function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['`’]/g, '')
    .replace(/[._\-+()[\]{}:!,?&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Strict: torrent name must START with the show/movie title (after normalization).
// Filters out results where the title appears as a substring elsewhere
// (e.g. "Welcome to Wrexham ... Down to the Wire" when searching "The Wire").
function torrentMatchesTitle(torrentName, title) {
  if (!torrentName || !title) return false
  const t = normalizeForMatch(torrentName)
  const q = normalizeForMatch(title)
  if (!q || !t.startsWith(q)) return false
  const after = q.length
  // Char after must be end of string or whitespace (avoid partial-word matches)
  if (after < t.length && t[after] !== ' ') return false
  return true
}

function normalizeTorrent(t, title, type) {
  let magnet = t.magnet_url || (t.url?.startsWith('magnet:') ? t.url : null) ||
    (t.hash ? `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.filename || title)}` : null)
  if (!magnet) return null
  magnet = addTrackers(magnet)
  const se = type === 'tv'
    ? (t.season != null && t.episode != null
      ? { season: Number(t.season), episode: Number(t.episode) }
      : parseSeasonEpisode(t.filename || t.title || ''))
    : null
  const quality = t.quality || (se ? `S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')}` : 'HD')
  return {
    quality,
    seeds: t.seeds || 0,
    size: t.size || t.size_bytes ? formatBytes(t.size_bytes) : (t.size || ''),
    magnet,
    ...(se && { season: se.season, episode: se.episode }),
  }
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return ''
  const b = Number(bytes)
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// In-memory cache for torrent search results.
// Keyed by title|year|type|tmdbId. EZTV/APIBAY occasionally rate-limit or return
// incomplete pagination on repeat hits, which made re-opening a title show fewer
// episodes than the first time. Caching keeps the result stable for 10 minutes.
const TORRENT_CACHE = new Map()
const TORRENT_CACHE_TTL = 10 * 60 * 1000

app.get('/api/torrents', async (req, res) => {
  const { title, year, type, tmdbId, imdbId } = req.query
  if (!title || !type) return res.status(400).json({ error: 'Missing title or type' })

  const cacheKey = `${title}|${year || ''}|${type}|${tmdbId || ''}|${imdbId || ''}`
  const cached = TORRENT_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return res.json(cached.data)
  }

  try {
    const allTorrents = []
    const seen = new Set()

    if (type === 'movies') {
      // Try IMDb-based lookup first (most precise)
      let imdb = imdbId || null
      if (!imdb && tmdbId) imdb = await getImdbId(tmdbId, 'movies')

      // 1. Torrentio — the canonical Stremio source. Aggregates ~20 trackers
      //    (YTS/RARBG/1337x/TPB/EZTV/…) so we get *every* release, not just
      //    YTS's small curated catalog. This is the single biggest reason
      //    Stremio loads obscure or newer movies that our old YTS-only
      //    pipeline didn't.
      if (imdb) {
        try {
          const imdbStr = String(imdb).startsWith('tt') ? imdb : `tt${imdb}`
          const results = await torrentioLookup('movie', imdbStr)
          for (const entry of results) {
            const h = entry.magnet.match(/btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase()
            if (!h || seen.has(h)) continue
            seen.add(h)
            allTorrents.push({
              quality: entry.quality,
              seeds: entry.seeds,
              size: entry.size,
              magnet: entry.magnet,
            })
          }
        } catch (err) {
          console.warn(`[torrents] movie Torrentio failed: ${err.message}`)
        }
      }

      // 2. YTS — still a great source for 1080p/2160p movie releases
      const queries = []
      if (imdb) queries.push(imdb) // YTS supports IMDb ID as query_term
      if (year) queries.push(`${title} ${String(year).slice(0, 4)}`)
      queries.push(String(title).trim())

      let data = {}
      for (const base of YTS_MIRRORS) {
        for (const q of queries) {
          try {
            const r = await fetchWithTimeout(`${base}/list_movies.json?query_term=${encodeURIComponent(q)}&limit=10`, {}, 6000)
            data = await r.json().catch(() => ({}))
            if (data.status === 'ok' && data.data?.movies?.length) break
          } catch (e) { logThrottled('warn', `yts:${base}:${e.message}`, `YTS ${base}: ${e.message}`) }
        }
        if (data.status === 'ok' && data.data?.movies?.length) break
      }

      if (data.status === 'ok' && data.data?.movies?.length) {
        // Find the best title match
        const titleLower = title.toLowerCase()
        const yearStr = year ? String(year).slice(0, 4) : null
        const movies = data.data.movies.sort((a, b) => {
          const aMatch = a.title?.toLowerCase() === titleLower ? 2 : a.title?.toLowerCase().includes(titleLower) ? 1 : 0
          const bMatch = b.title?.toLowerCase() === titleLower ? 2 : b.title?.toLowerCase().includes(titleLower) ? 1 : 0
          if (aMatch !== bMatch) return bMatch - aMatch
          if (yearStr) {
            const aYear = String(a.year) === yearStr ? 1 : 0
            const bYear = String(b.year) === yearStr ? 1 : 0
            if (aYear !== bYear) return bYear - aYear
          }
          return 0
        })

        for (const movie of movies) {
          if (!Array.isArray(movie.torrents)) continue
          for (const t of movie.torrents) {
            if (!t?.hash || seen.has(t.hash)) continue
            seen.add(t.hash)
            const magnet = addTrackers(`magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title || title)}`)
            allTorrents.push({
              quality: t.quality || 'HD',
              seeds: t.seeds || 0,
              size: t.size || '',
              magnet,
            })
          }
        }
      }

      // APIBAY fallback for movies if YTS returned few/no results
      if (allTorrents.length < 3) {
        try {
          const q = year ? `${title} ${String(year).slice(0, 4)}` : title
          const r = await fetchWithTimeout(`https://apibay.org/q.php?q=${encodeURIComponent(q)}`, {}, 7000)
          const results = await r.json().catch(() => [])
          const movieResults = (Array.isArray(results) ? results : [])
            .filter((t) => t.id !== '0' && torrentMatchesTitle(t.name, title) && (parseInt(t.seeders) || 0) > 0)
            .sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0))
            .slice(0, 8)
          for (const t of movieResults) {
            if (seen.has(t.info_hash?.toLowerCase())) continue
            seen.add(t.info_hash.toLowerCase())
            const magnet = addTrackers(`magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}`)
            // Try to extract quality from name
            const qualityMatch = t.name.match(/\b(2160p|1080p|720p|480p|4K)\b/i)
            allTorrents.push({
              quality: qualityMatch ? qualityMatch[1] : 'HD',
              seeds: parseInt(t.seeders) || 0,
              size: formatBytes(t.size),
              magnet,
            })
          }
        } catch {}
      }
    }

    // For TV we do NOT search for torrents upfront. That's what Stremio
    // does wrong-in-theory-but-right-in-practice: it fetches only the
    // episode catalog (metadata), renders every episode, then calls
    // Torrentio on-demand when the user clicks one. This is fast, reliable,
    // and matches what every Stremio user is used to. The bySeason skeleton
    // built below gives every episode a placeholder; /api/torrent-episode
    // handles the actual stream lookup per-click.
    const episodesPerSeason = {} // { seasonNum: episodeCount }
    if (type === 'tv' && tmdbId && TMDB_API_KEY) {
      // Retry the TMDB meta fetch up to 3 times — we've seen episodic
      // blips where the first request times out while webtorrent is
      // chewing. An empty episodesPerSeason cascades into the client
      // rendering the show as a single-source movie, which is the
      // "Game of Thrones looks like a movie" bug.
      let meta = null
      for (let attempt = 0; attempt < 3 && !meta; attempt++) {
        try {
          meta = await tmdbFetch(`tv/${tmdbId}`)
        } catch (err) {
          logThrottled('warn', `tv-meta:${tmdbId}`, `TMDB tv/${tmdbId} attempt ${attempt + 1} failed: ${err.message}`)
          if (attempt < 2) await new Promise((r) => setTimeout(r, 600))
        }
      }
      if (meta) {
        for (const s of (meta.seasons || [])) {
          if (s.season_number > 0) episodesPerSeason[s.season_number] = s.episode_count || 0
        }
      }
      // Last-resort: if TMDB is completely dead, seed 1–3 season
      // placeholders so the client still renders the TV layout. The
      // per-episode /api/torrent-episode lookup will still work when the
      // user clicks — better than showing nothing.
      if (Object.keys(episodesPerSeason).length === 0) {
        for (let s = 1; s <= 3; s++) episodesPerSeason[s] = 10
      }
    }

    const torrents = allTorrents.sort((a, b) => (b.seeds || 0) - (a.seeds || 0))

    if (type === 'tv') {
      // Build bySeason from TMDB's episode catalog as the source of truth so
      // every episode always shows (Stremio-style), not just ones that happen
      // to have a torrent right now. Slots without a found torrent are marked
      // unavailable; the client runs an on-demand per-episode search when the
      // user clicks one.
      const bySeason = {}
      // 1. Seed a placeholder for every TMDB episode
      for (const sNum of Object.keys(episodesPerSeason)) {
        const s = String(sNum)
        const count = episodesPerSeason[sNum] || 0
        if (!bySeason[s]) bySeason[s] = {}
        for (let e = 1; e <= count; e++) {
          bySeason[s][e] = {
            season: Number(sNum),
            episode: e,
            quality: `S${String(sNum).padStart(2, '0')}E${String(e).padStart(2, '0')}`,
            seeds: 0,
            size: '',
            magnet: null,
            unavailable: true,
          }
        }
      }
      // 2. Overlay torrent hits (best seeder wins)
      for (const t of torrents) {
        const s = t.season != null ? String(t.season) : '0'
        if (!bySeason[s]) bySeason[s] = {}
        const ep = t.episode != null ? t.episode : `x${Math.random()}`
        const existing = bySeason[s][ep]
        if (!existing || existing.unavailable || (t.seeds || 0) > (existing.seeds || 0)) {
          bySeason[s][ep] = { ...t, unavailable: false }
        }
      }
      // 3. Flatten each season to a sorted array
      for (const k of Object.keys(bySeason)) {
        bySeason[k] = Object.values(bySeason[k]).sort(
          (a, b) => (a.episode || 0) - (b.episode || 0)
        )
      }
      const seasons = Object.keys(bySeason).filter((k) => k !== '0').sort((a, b) => Number(a) - Number(b))
      if (bySeason['0']?.length) seasons.push('0')
      const payload = { torrents, bySeason, seasons }
      // Only cache "rich" responses. EZTV occasionally returns a degraded
      // partial response on retry; we don't want to cache that for 10 minutes.
      // Replace cached entry only if the new result is at least as rich as the
      // existing one (more or equal torrents).
      const prev = TORRENT_CACHE.get(cacheKey)
      if (!prev || (prev.data.torrents?.length || 0) <= torrents.length) {
        TORRENT_CACHE.set(cacheKey, { data: payload, timestamp: Date.now() })
      } else {
        // New response is poorer than cache — return the cached richer one.
        return res.json(prev.data)
      }
      return res.json(payload)
    }

    const payload = { torrents }
    if (torrents.length > 0) {
      const prev = TORRENT_CACHE.get(cacheKey)
      if (!prev || (prev.data.torrents?.length || 0) <= torrents.length) {
        TORRENT_CACHE.set(cacheKey, { data: payload, timestamp: Date.now() })
      } else {
        return res.json(prev.data)
      }
    }
    return res.json(payload)
  } catch (err) {
    console.error('Torrent search error:', err.message)
    return res.json({ torrents: [] })
  }
})

// On-demand per-episode Torrentio lookup — this is the core of our TV
// flow, matching how Stremio actually works. Called when the user clicks
// an episode. Torrentio aggregates ~20 trackers (YTS, EZTV, RARBG mirrors,
// TPB, 1337x, etc.) so this gives reliable results even for obscure shows.
const EPISODE_CACHE = new Map()
const EPISODE_CACHE_TTL = 30 * 60 * 1000 // 30 min

// Torrentio endpoints — we hit MANY variants in parallel and keep every
// stream we get back. The core reliability trick: Torrentio is sometimes
// flaky on specific endpoints, and different provider combos return
// different results. Parallel shotgun + dedupe is way more reliable than
// any sequential fallback chain.
//
// Provider sets:
//   DEFAULT — what Stremio uses out of the box (small, always works)
//   FULL    — everything Stremio supports (broadest coverage but sometimes
//             rejected or slow)
const TORRENTIO_DEFAULT = 'yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents'
const TORRENTIO_FULL = [
  'yts','eztv','rarbg','1337x','thepiratebay','kickasstorrents','torrentgalaxy',
  'magnetdl','horriblesubs','nyaasi','tokyotosho','anidex','rutor','rutracker',
  'comando','bludv','torrent9','ilcorsaronero','mejortorrent','wolfmax4k','cinecalidad',
].join(',')

// Hosts — two public Torrentio mirrors and (optionally) a user-set one.
const TORRENTIO_HOSTS_BASE = [
  'https://torrentio.strem.fun',
  'https://torrentio.strem.io',
]

// Build every URL variant we want to try. For a single lookup we fire all
// of these simultaneously and merge results.
function buildTorrentioUrls(kind, id, season, episode) {
  const idPath = kind === 'series' ? `${id}:${season}:${episode}` : id
  const paths = [
    '', // bare — Torrentio's built-in defaults
    `/providers=${TORRENTIO_DEFAULT}`,
    `/providers=${TORRENTIO_FULL}`,
  ]
  const urls = []
  for (const host of TORRENTIO_HOSTS_BASE) {
    for (const p of paths) {
      urls.push(`${host}${p}/stream/${kind}/${idPath}.json`)
    }
  }
  return urls
}

// Shared call: fires every Torrentio variant IN PARALLEL. Streams merge
// into a shared bucket as they arrive, and we return EARLY once we have
// enough good results — no need to wait for the slowest mirror. This
// cuts typical lookup time from ~5–8 s to ~1–2 s after the first stream
// is already active (event-loop contention makes Torrentio feel slow in
// that scenario).
// Concurrency gate for Torrentio fan-out. Previously every browse +
// detail-open was firing ~27 parallel requests across the mirror list
// and provider permutations, which Torrentio rate-limits us for after a
// handful of tabs. 5 in flight is plenty for the early-exit heuristic
// (≥5 results within 1.5s) while still well under any public rate cap.
const TORRENTIO_CONCURRENCY = 5
let torrentioInFlight = 0
const torrentioQueue = []
function torrentioAcquire() {
  return new Promise((resolve) => {
    const tryGo = () => {
      if (torrentioInFlight < TORRENTIO_CONCURRENCY) {
        torrentioInFlight++
        resolve(() => {
          torrentioInFlight--
          const next = torrentioQueue.shift()
          if (next) next()
        })
      } else {
        torrentioQueue.push(tryGo)
      }
    }
    tryGo()
  })
}

async function torrentioLookup(kind, id, season, episode) {
  const urls = buildTorrentioUrls(kind, id, season, episode)
  const tag = kind === 'series'
    ? `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    : ''

  const fetchOne = async (url) => {
    const release = await torrentioAcquire()
    try {
      const r = await fetchWithTimeout(url, {}, 6000)
      if (!r.ok) {
        console.warn(`[torrentio] ${r.status} ${url}`)
        return []
      }
      const j = await r.json().catch(() => ({}))
      return j.streams || []
    } catch (err) {
      console.warn(`[torrentio] fail ${url}: ${err.message}`)
      return []
    } finally {
      release()
    }
  }

  const seen = new Set()
  const out = []
  let rawCount = 0
  const mergeStreams = (streams) => {
    for (const st of streams) {
      rawCount++
      const entry = parseTorrentioStream(st, season, episode, tag)
      if (!entry) continue
      const h = entry.magnet.match(/btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase()
      if (!h || seen.has(h)) continue
      seen.add(h)
      out.push(entry)
    }
  }

  // Fire every URL; each merges results into `out` as it resolves
  const settled = Promise.allSettled(urls.map((u) => fetchOne(u).then(mergeStreams)))

  // Early-exit deadlines:
  //   softMs — once we have ≥ MIN_RESULTS, return immediately
  //   mediumMs — return whatever we've got (even a small number) and
  //              stop waiting on the slow mirrors
  //   hardMs — final safety cap; return empty if nothing came back
  const MIN_RESULTS = 5
  const softMs = 1500
  const mediumMs = 3000
  const hardMs = 7000

  await new Promise((resolve) => {
    let resolved = false
    const done = () => { if (!resolved) { resolved = true; resolve() } }
    settled.then(done)
    // Poll for early exit
    const poll = setInterval(() => {
      if (out.length >= MIN_RESULTS) { clearInterval(poll); done() }
    }, 150)
    setTimeout(() => { if (out.length >= 1) { clearInterval(poll); done() } }, mediumMs)
    setTimeout(() => { clearInterval(poll); done() }, hardMs)
    setTimeout(() => { /* soft tick — let fast ones settle */ }, softMs)
  })

  console.log(`[torrentio] ${kind} ${id}${kind === 'series' ? `:${season}:${episode}` : ''} — ${rawCount} raw → ${out.length} deduped`)
  out.sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
  return out
}

// APIBAY (The Pirate Bay API) — run in parallel with Torrentio.
// Returns torrents matching title + season/episode. Strict episode match
// to avoid dumping a whole-season pack in place of a single episode.
async function apibayLookupEpisode(titleOrId, season, episode) {
  const tag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  const altTag = `${season}x${String(episode).padStart(2, '0')}`
  const queries = [
    `${titleOrId} ${tag}`,
    `${titleOrId} s${season}e${episode}`,
    `${titleOrId} ${altTag}`,
  ]
  const out = []
  const seen = new Set()
  await Promise.allSettled(queries.map(async (q) => {
    try {
      const r = await fetchWithTimeout(`https://apibay.org/q.php?q=${encodeURIComponent(q)}`, {}, 7000)
      const results = await r.json().catch(() => [])
      const matching = (Array.isArray(results) ? results : [])
        .filter((t) => t.id !== '0' && torrentMatchesTitle(t.name, titleOrId))
        .filter((t) => {
          const se = parseSeasonEpisode(t.name)
          return se && se.season === season && se.episode === episode
        })
      for (const t of matching.slice(0, 8)) {
        const hash = t.info_hash?.toLowerCase()
        if (!hash || seen.has(hash)) continue
        seen.add(hash)
        const qm = t.name.match(/\b(2160p|1080p|720p|480p|4K)\b/i)
        out.push({
          quality: qm ? qm[1] : tag,
          seeds: parseInt(t.seeders) || 0,
          size: formatBytes(t.size),
          magnet: addTrackers(`magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}`),
          season,
          episode,
        })
      }
    } catch (err) {
      console.warn(`[apibay] "${q}": ${err.message}`)
    }
  }))
  return out
}

function parseTorrentioStream(st, s, e, tag) {
  // Torrentio's response shape has varied over versions. Streams may use:
  //   - infoHash field directly
  //   - url field with "magnet:?xt=urn:btih:..."
  //   - sources[] array containing tracker URLs and/or DHT:hash nodes
  // All stats live in the `title` field, which is multi-line:
  //   "Show.Name.S01E01.1080p.WEB.x264-GROUP\n👤 123 💾 2.5 GB ⚙️ EZTV"
  let hash = ''
  if (st.infoHash && typeof st.infoHash === 'string') hash = st.infoHash.toLowerCase()
  if (!hash && st.url && typeof st.url === 'string') {
    const m = st.url.match(/btih:([a-f0-9]{40})/i)
    if (m) hash = m[1].toLowerCase()
  }
  if (!hash) return null
  const title = st.title || st.name || ''
  const firstLine = title.split('\n')[0] || ''
  const qm = title.match(/\b(2160p|1080p|720p|480p|4K|HDR)\b/i)
  const seedsM = title.match(/👤\s*(\d+)/) || title.match(/[Ss]eeds?[:\s]+(\d+)/)
  const sizeM = title.match(/💾\s*([\d.]+\s*[KMGT]B)/i) || title.match(/\b([\d.]+\s*[KMGT]B)\b/i)
  const fileIdx = typeof st.fileIdx === 'number' ? st.fileIdx : null

  // Build magnet: start with btih + name, append every tracker Torrentio gave us,
  // then wrap with our own tracker list on top. More trackers = better peer finding.
  const parts = [`magnet:?xt=urn:btih:${hash}`, `dn=${encodeURIComponent(firstLine || tag)}`]
  if (Array.isArray(st.sources)) {
    for (const src of st.sources) {
      if (typeof src !== 'string') continue
      if (src.startsWith('tracker:')) {
        parts.push(`tr=${encodeURIComponent(src.slice('tracker:'.length))}`)
      } else if (src.startsWith('dht:')) {
        // DHT node hint — some WebTorrent versions accept these
        parts.push(`x.pe=${encodeURIComponent(src.slice('dht:'.length))}`)
      }
    }
  }
  const rawMagnet = parts.join('&')
  return {
    quality: qm ? qm[1] : tag.toUpperCase(),
    seeds: seedsM ? parseInt(seedsM[1], 10) : 0,
    size: sizeM ? sizeM[1] : '',
    magnet: addTrackers(rawMagnet),
    season: s,
    episode: e,
    fileIdx,
  }
}

app.get('/api/torrent-episode', async (req, res) => {
  const { title, season, episode, tmdbId } = req.query
  let { imdbId } = req.query
  if (!title || !season || !episode) return res.status(400).json({ error: 'title, season, episode required' })
  const s = Number(season), e = Number(episode)

  // Derive imdbId from tmdbId if the client didn't have it (always the case
  // when coming from the TMDB catalog).
  if (!imdbId && tmdbId && TMDB_API_KEY) {
    try { imdbId = await getImdbId(tmdbId, 'tv') } catch {}
  }

  const cacheKey = `${imdbId || tmdbId || title}:${s}:${e}`
  const cached = EPISODE_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < EPISODE_CACHE_TTL) {
    return res.json(cached.data)
  }

  // PARALLEL shotgun: Torrentio (6 URL variants) + APIBAY (3 queries) all
  // simultaneously. First to return results unblocks the others; merge the
  // union and dedupe by info-hash. This is way more reliable than any
  // sequential fallback — one flaky endpoint never blocks a working one.
  const imdbForLookup = imdbId ? (String(imdbId).startsWith('tt') ? imdbId : `tt${imdbId}`) : null
  const [torrentioResult, apibayResult] = await Promise.allSettled([
    imdbForLookup ? torrentioLookup('series', imdbForLookup, s, e) : Promise.resolve([]),
    apibayLookupEpisode(title, s, e),
  ])

  const seen = new Set()
  const out = []
  const addAll = (arr) => {
    if (!Array.isArray(arr)) return
    for (const t of arr) {
      const h = t.magnet?.match(/btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase()
      if (!h || seen.has(h)) continue
      seen.add(h)
      out.push(t)
    }
  }
  if (torrentioResult.status === 'fulfilled') addAll(torrentioResult.value)
  if (apibayResult.status === 'fulfilled')    addAll(apibayResult.value)

  out.sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
  const payload = { torrents: out }
  console.log(`[torrent-episode] ${title} S${s}E${e} → ${out.length} results (torrentio:${torrentioResult.status === 'fulfilled' ? torrentioResult.value.length : 'x'} apibay:${apibayResult.status === 'fulfilled' ? apibayResult.value.length : 'x'})`)
  if (out.length > 0) EPISODE_CACHE.set(cacheKey, { data: payload, timestamp: Date.now() })
  res.json(payload)
})

// Diagnostic: hit /api/debug/torrent-episode?tmdbId=...&season=1&episode=1
// to see raw Torrentio + APIBAY responses. Use this if an episode won't
// load — it shows which provider returned data and what the magnets look
// like, without caching.
app.get('/api/debug/torrent-episode', async (req, res) => {
  const { title = '', season = '1', episode = '1', tmdbId } = req.query
  let { imdbId } = req.query
  if (!imdbId && tmdbId && TMDB_API_KEY) {
    try { imdbId = await getImdbId(tmdbId, 'tv') } catch {}
  }
  const s = Number(season), e = Number(episode)
  const imdbForLookup = imdbId ? (String(imdbId).startsWith('tt') ? imdbId : `tt${imdbId}`) : null
  const [torrentioResult, apibayResult] = await Promise.allSettled([
    imdbForLookup ? torrentioLookup('series', imdbForLookup, s, e) : Promise.resolve([]),
    apibayLookupEpisode(title, s, e),
  ])
  res.json({
    title,
    season: s,
    episode: e,
    imdbId: imdbForLookup,
    torrentio: {
      status: torrentioResult.status,
      count: torrentioResult.status === 'fulfilled' ? torrentioResult.value.length : 0,
      error: torrentioResult.status === 'rejected' ? String(torrentioResult.reason?.message || torrentioResult.reason) : null,
      sample: torrentioResult.status === 'fulfilled' ? torrentioResult.value.slice(0, 3) : [],
    },
    apibay: {
      status: apibayResult.status,
      count: apibayResult.status === 'fulfilled' ? apibayResult.value.length : 0,
      sample: apibayResult.status === 'fulfilled' ? apibayResult.value.slice(0, 3) : [],
    },
    urls_tried: buildTorrentioUrls('series', imdbForLookup || 'tt?', s, e),
  })
})

// ── Subtitles (free, via Stremio OpenSubtitles addon) ───────────

// ISO 639-2/B language code → display name
const LANG_NAMES = {
  eng:'English',fre:'French',spa:'Spanish',ger:'German',por:'Portuguese',pob:'Portuguese (BR)',
  ita:'Italian',nld:'Dutch',pol:'Polish',tur:'Turkish',ara:'Arabic',ell:'Greek',heb:'Hebrew',
  hun:'Hungarian',ron:'Romanian',hrv:'Croatian',srp:'Serbian',bul:'Bulgarian',cze:'Czech',
  dan:'Danish',swe:'Swedish',nor:'Norwegian',fin:'Finnish',rus:'Russian',kor:'Korean',
  jpn:'Japanese',chi:'Chinese',hin:'Hindi',ind:'Indonesian',per:'Persian',tha:'Thai',vie:'Vietnamese',
}

function srtToVtt(srt) {
  // Convert SRT → WebVTT
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') // comma → dot in timestamps
}

// Shift every WebVTT timestamp by `offsetSec` seconds (may be negative).
// Used to fix subs that are out of sync with the video.
function shiftVttTimestamps(vtt, offsetSec) {
  if (!offsetSec || isNaN(offsetSec)) return vtt
  return vtt.replace(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})/g, (_, h, m, s, ms) => {
    const total = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000 + offsetSec
    if (total < 0) return '00:00:00.000'
    const hh = Math.floor(total / 3600)
    const mm = Math.floor((total % 3600) / 60)
    const ss = Math.floor(total % 60)
    const mmm = Math.round((total - Math.floor(total)) * 1000)
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`
  })
}

app.get('/api/subtitles', async (req, res) => {
  const { tmdbId, type, season, episode } = req.query
  if (!tmdbId) return res.json({ subtitles: [] })

  // Get IMDB ID from TMDB
  const imdbId = await getImdbId(tmdbId, type || 'movies')
  if (!imdbId) return res.json({ subtitles: [] })

  try {
    // Build Stremio addon URLs — try multiple sources for better coverage
    const stremioType = (type === 'tv' || type === 'series') ? 'series' : 'movie'
    let path = imdbId
    if (stremioType === 'series' && season && episode) {
      path = `${imdbId}:${season}:${episode}`
    }
    const sources = [
      `https://opensubtitles-v3.strem.io/subtitles/${stremioType}/${path}.json`,
    ]

    // Fetch all sources in parallel, merge results
    const results = await Promise.allSettled(
      sources.map(url =>
        fetch(url, FETCH_OPTS)
          .then(r => r.json().catch(() => ({ subtitles: [] })))
          .then(d => d.subtitles || [])
      )
    )

    // Merge and deduplicate: keep the first (best) subtitle per language
    const seen = new Set()
    const subs = []
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const s of r.value) {
        const lang = s.lang || 'und'
        if (seen.has(lang)) continue
        seen.add(lang)
        subs.push({
          id: s.id,
          url: s.url,
          lang,
          langName: LANG_NAMES[lang] || lang,
        })
      }
    }

    // Sort: English first, then alphabetically
    subs.sort((a, b) => {
      if (a.lang === 'eng' && b.lang !== 'eng') return -1
      if (b.lang === 'eng' && a.lang !== 'eng') return 1
      return a.langName.localeCompare(b.langName)
    })

    // If no subs found for a TV episode, try without episode specifics
    if (subs.length === 0 && stremioType === 'series' && season && episode) {
      try {
        const fallbackUrl = `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}.json`
        const fr = await fetch(fallbackUrl, FETCH_OPTS)
        const fd = await fr.json().catch(() => ({ subtitles: [] }))
        for (const s of (fd.subtitles || [])) {
          const lang = s.lang || 'und'
          if (seen.has(lang)) continue
          seen.add(lang)
          subs.push({ id: s.id, url: s.url, lang, langName: LANG_NAMES[lang] || lang })
        }
        subs.sort((a, b) => {
          if (a.lang === 'eng' && b.lang !== 'eng') return -1
          if (b.lang === 'eng' && a.lang !== 'eng') return 1
          return a.langName.localeCompare(b.langName)
        })
      } catch {}
    }

    res.json({ subtitles: subs })
  } catch { res.json({ subtitles: [] }) }
})

app.get('/api/subtitles/proxy', async (req, res) => {
  const { url, offset } = req.query
  if (!url || !url.startsWith('https://')) return res.status(400).json({ error: 'Invalid URL' })
  try {
    const r = await fetch(url, FETCH_OPTS)
    if (!r.ok) return res.status(502).json({ error: 'Fetch failed' })
    const text = await r.text()
    let vtt = text.trimStart().startsWith('WEBVTT') ? text : srtToVtt(text)
    const offsetSec = parseFloat(offset)
    if (offsetSec) vtt = shiftVttTimestamps(vtt, offsetSec)
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(vtt)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Video file helpers ──────────────────────────────────────────
function hasVideoExt(str) {
  return PREFERRED_EXTENSIONS.some((ext) => (str || '').toLowerCase().replace(/\\/g, '/').endsWith(ext))
}

function pickBestVideoFile(files) {
  // Only consider files > 10MB with video extensions (skip promo images/nfos)
  const MIN_SIZE = 10 * 1024 * 1024
  const videoFiles = (files || [])
    .filter((f) => (f.length || 0) > MIN_SIZE && (hasVideoExt(f.name) || hasVideoExt(f.path)))
  if (!videoFiles.length) return null
  // Prefer by extension priority (mp4 > mkv etc)
  for (const ext of PREFERRED_EXTENSIONS) {
    const found = videoFiles.find((f) => {
      const n = (f.name || '').toLowerCase()
      const p = (f.path || '').toLowerCase().replace(/\\/g, '/')
      return n.endsWith(ext) || p.endsWith(ext)
    })
    if (found) return found
  }
  // Fall back to largest video file
  return [...videoFiles].sort((a, b) => (b.length || 0) - (a.length || 0))[0]
}

function mkvWarning(file) {
  if (!file) return null
  const n = (file.name || '').toLowerCase()
  if (n.endsWith('.mkv') || (file.path || '').toLowerCase().endsWith('.mkv')) {
    return 'MKV often has no sound in browser (AC3/DTS codec). Try 720p/MP4 or use VLC.'
  }
  return null
}

// Release-group naming conventions almost always declare the codec and bit
// depth right in the filename (e.g. "Supernatural.S01E01.1080p.x265-RARBG"
// or "Movie.2024.2160p.10bit.HEVC"). When we spot one of these tags we can
// route straight to /remux?transcode=1 instead of serving /stream/ and
// bouncing off a guaranteed MEDIA_ERR_DECODE. Zero-config, filename-only;
// if the tag is absent we fall through to the normal direct-stream path.
function needsTranscodeFromName(file) {
  if (!file) return false
  const n = ((file.name || '') + ' ' + (file.path || '')).toLowerCase()
  // word-ish boundaries around each tag so "x264" doesn't match "x265"
  return /(^|[^a-z0-9])(x[\s._-]?265|h[\s._-]?265|hevc|10[\s._-]?bit|av1|vp9)([^a-z0-9]|$)/.test(n)
}

function parseInfoHash(magnet) {
  const m = String(magnet).match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

function parseInfoHashFromError(errMsg) {
  const m = String(errMsg || '').match(/([a-fA-F0-9]{40})/)
  return m ? m[1].toLowerCase() : null
}

function getStreamFromTorrent(t) {
  const videoFile = pickBestVideoFile(t.files)
  if (!videoFile) return null
  touchTorrent(t.infoHash)
  const fileName = (videoFile.name || '').toLowerCase()
  const isMkv = fileName.endsWith('.mkv') || fileName.endsWith('.avi')
  const transcodeHint = needsTranscodeFromName(videoFile)
  // Routing decision:
  //   - MKV/AVI always goes through /remux (browsers can't play the
  //     container natively; ffmpeg repackages into fMP4).
  //   - An MP4 with HEVC/x265/10-bit/AV1/VP9 in the filename ALSO goes
  //     through /remux, with ?transcode=1 so ffmpeg uses libx264 instead
  //     of -c:v copy (which would emit an MP4 the browser still can't
  //     decode — the Supernatural case we saw).
  //   - Everything else takes the fast path: direct WebTorrent HTTP,
  //     no ffmpeg hop, zero start-up latency.
  const encodedPath = videoFile.path.split(/[/\\]/).map(encodeURIComponent).join('/')
  const routeToRemux = isMkv || transcodeHint
  const remuxQuery = transcodeHint ? '?transcode=1' : ''
  const url = routeToRemux
    ? `/remux/${t.infoHash}/${encodedPath}${remuxQuery}`
    : `${streamBaseUrl}${wtServer.pathname}/${t.infoHash}/${encodedPath}`
  return {
    url,
    name: videoFile.name,
    infoHash: t.infoHash,
    isRemuxed: routeToRemux,
    warning: routeToRemux ? null : mkvWarning(videoFile), // no warning needed when remuxing
  }
}

// ── Stream endpoint ─────────────────────────────────────────────
app.post('/api/stream', (req, res) => {
  let { magnet } = req.body || {}
  if (!magnet || !String(magnet).trim().toLowerCase().startsWith('magnet:')) {
    return res.status(400).json({ error: 'Invalid magnet link' })
  }

  magnet = addTrackers(magnet.trim())

  let responded = false
  // 25s budget per torrent — long enough for a healthy swarm to hand us
  // a file list, short enough that the client's fallback chain can cycle
  // through 3–4 candidates in under two minutes if they're all dead.
  // The old 120s budget left the user staring at a spinner forever when
  // the very first torrent had zero seeds.
  const timeoutId = setTimeout(() => {
    if (!responded) { responded = true; res.status(504).json({ error: 'Timeout connecting to peers. The torrent may have no seeders — try a different source.' }) }
  }, 25000)

  const send = (status, data) => {
    if (responded) return
    responded = true
    clearTimeout(timeoutId)
    res.status(status).json(data)
  }

  const findExisting = (hash) => {
    if (!hash) return null
    return client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === hash)
  }

  const waitForTorrent = (t) => {
    if (t.ready && t.files?.length) {
      const result = getStreamFromTorrent(t)
      if (result) return send(200, result)
    }
    t.once('ready', () => {
      console.log(`Torrent ready: ${t.name}, files: ${t.files.length}`)
      t.files.forEach((f, i) => console.log(`  [${i}] ${f.name} (${(f.length / 1024 / 1024).toFixed(1)} MB)`))
      const result = getStreamFromTorrent(t)
      if (result) {
        const videoFile = pickBestVideoFile(t.files)
        if (videoFile) videoFile.select()
        t.files.forEach((f) => { if (f !== videoFile) f.deselect() })
        send(200, result)
      } else {
        const largest = [...t.files].sort((a, b) => (b.length || 0) - (a.length || 0))[0]
        if (largest && largest.length > 1024 * 1024) {
          console.log(`Fallback: using largest file: ${largest.name} (${(largest.length / 1024 / 1024).toFixed(1)} MB)`)
          touchTorrent(t.infoHash)
          largest.select()
          t.files.forEach((f) => { if (f !== largest) f.deselect() })
          const isMkv = /\.(mkv|avi)$/i.test(largest.name)
          const transcodeHint = needsTranscodeFromName(largest)
          const routeToRemux = isMkv || transcodeHint
          const remuxQuery = transcodeHint ? '?transcode=1' : ''
          const encoded = largest.path.split(/[/\\]/).map(encodeURIComponent).join('/')
          const url = routeToRemux
            ? `/remux/${t.infoHash}/${encoded}${remuxQuery}`
            : `${streamBaseUrl}${wtServer.pathname}/${t.infoHash}/${encoded}`
          send(200, { url, name: largest.name, infoHash: t.infoHash, isRemuxed: routeToRemux, warning: routeToRemux ? null : mkvWarning(largest) })
        } else {
          send(400, { error: 'No playable video file found in this torrent' })
        }
      }
    })
    t.once('error', (err) => {
      send(500, { error: String(err?.message || 'Torrent error') })
    })
  }

  try {
    const infoHash = parseInfoHash(magnet)
    const existing = findExisting(infoHash)
    if (existing) {
      if (existing.files?.length) {
        const result = getStreamFromTorrent(existing)
        if (result) return send(200, result)
      }
      // Torrent exists but still loading — wait for it
      return waitForTorrent(existing)
    }

    let torrent
    try {
      // Persist to disk cache so repeat viewings reuse files.
      // WebTorrent creates a subdir per infoHash inside CACHE_DIR.
      torrent = client.add(magnet, { path: CACHE_DIR })
      pruneCache()
    } catch (err) {
      if (/duplicate/i.test(err.message)) {
        const hash = (parseInfoHashFromError(err.message) || infoHash)?.toLowerCase()
        const dup = findExisting(hash)
        if (dup) return waitForTorrent(dup)
        return send(409, { error: 'Torrent is loading. Please wait a moment and try again.' })
      }
      return send(500, { error: err.message || 'Failed to add torrent' })
    }

    waitForTorrent(torrent)
  } catch (err) {
    send(500, { error: err.message || 'Server error' })
  }
})

// ── Stream progress (SSE) ───────────────────────────────────────
app.get('/api/stream/progress/:infoHash', (req, res) => {
  const hash = req.params.infoHash?.toLowerCase()
  const torrent = hash && client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === hash)

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (!torrent) {
    res.write(`data: ${JSON.stringify({ error: 'Torrent not found' })}\n\n`)
    res.end()
    return
  }

  const interval = setInterval(() => {
    const data = {
      peers: torrent.numPeers,
      downloaded: torrent.downloaded,
      speed: torrent.downloadSpeed,
      progress: Math.round((torrent.progress || 0) * 100),
      ready: torrent.ready,
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }, 1000)

  req.on('close', () => clearInterval(interval))
})

// ── Audio tracks probe endpoint ─────────────────────────────────
app.get('/api/tracks/:infoHash', (req, res) => {
  const hash = req.params.infoHash?.toLowerCase()
  const torrent = hash && client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === hash)
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' })

  const videoFile = pickBestVideoFile(torrent.files)
  if (!videoFile) return res.status(404).json({ error: 'No video file' })

  touchTorrent(hash)

  // Pipe just a small chunk into ffmpeg — it prints stream info to stderr immediately
  const readSize = Math.min(videoFile.length - 1, 5 * 1024 * 1024) // 5MB is enough for header
  const stream = videoFile.createReadStream({ start: 0, end: readSize })
  const probe = spawn(FFMPEG_PATH, [
    '-analyzeduration', '5000000',
    '-probesize', '5000000',
    '-i', 'pipe:0',
    '-hide_banner',
    '-f', 'null', '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  let stderr = ''
  let done = false

  // Client-abort cleanup. Without this, a client that navigates away
  // (e.g. user picks a different title mid-probe) leaves the ffmpeg
  // process running for up to 8s per aborted request — wastes CPU and
  // swarm bandwidth on torrents that are already being unseeded.
  req.on('close', () => {
    if (done) return
    done = true
    try { stream.destroy() } catch {}
    try { probe.kill('SIGTERM') } catch {}
  })

  probe.stderr.on('data', (d) => {
    stderr += d.toString()
    // Once we see "Input #0" and at least one "Stream", we have what we need
    if (!done && stderr.includes('Input #0') && /Stream #0:\d+/.test(stderr)) {
      // Wait a tiny bit for all stream lines to arrive
      setTimeout(() => {
        if (done) return
        done = true
        try { stream.destroy() } catch {}
        try { probe.kill('SIGTERM') } catch {}
        sendResult()
      }, 300)
    }
  })

  stream.pipe(probe.stdin)
  probe.stdin.on('error', () => {})
  stream.on('error', () => { try { probe.kill() } catch {} })

  const timeout = setTimeout(() => {
    if (done) return
    done = true
    try { stream.destroy() } catch {}
    try { probe.kill('SIGTERM') } catch {}
    sendResult()
  }, 8000)

  function sendResult() {
    clearTimeout(timeout)
    // Parse audio streams from ffmpeg stderr.
    //
    // Typical line:
    //   "Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s"
    //
    // We pull: index, lang, codec, channel layout (stereo / 5.1 / mono…).
    // The client composes a human label from these.
    const audioTracks = []
    const regex = /Stream #0:(\d+)(?:\(([a-z]{2,3})\))?:\s*Audio:\s*(\S+)([^\n]*)/gi
    let m
    while ((m = regex.exec(stderr)) !== null) {
      const idx = parseInt(m[1])
      const langCode = (m[2] || '').toLowerCase()
      const codec = m[3].replace(',', '')
      const rest = m[4] || ''
      // Channel layout keywords ffmpeg emits. Ordered most-specific first.
      const layoutMatch = rest.match(/\b(7\.1|5\.1\(side\)|5\.1|quad|stereo|mono|downmix|2\.1|4\.0)\b/i)
      const layout = layoutMatch ? layoutMatch[1].toLowerCase() : null
      const titleMatch = stderr.match(new RegExp(`Stream #0:${idx}[\\s\\S]*?title\\s*:\\s*(.+)`, 'i'))
      const title = titleMatch?.[1]?.trim() || ''
      audioTracks.push({
        index: idx,
        lang: langCode,
        langName: LANG_NAMES[langCode] || langCode || 'Unknown',
        codec,
        layout,
        title,
      })
    }
    // Parse duration: "Duration: 00:45:12.34, start:..."
    let duration = null
    const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
    if (durMatch) {
      const h = parseInt(durMatch[1])
      const mm = parseInt(durMatch[2])
      const ss = parseInt(durMatch[3])
      const cs = parseInt(durMatch[4])
      duration = h * 3600 + mm * 60 + ss + cs / 100
    }
    // Share duration + video codec with /remux so byte→time seek math
    // works on first hit, and the copy-vs-transcode decision has data
    // before the first /remux hit (saves a second round-trip ffmpeg probe).
    const vcodec = parseVideoCodec(stderr)
    if (duration > 0 || vcodec) {
      // setRemuxMeta merges with existing, stamps cachedAt, and enforces
      // the LRU cap. Previous direct Map.set skipped the cap check.
      setRemuxMeta(hash, {
        ...(duration > 0 ? { duration } : {}),
        ...(vcodec ? { vcodec } : {}),
      })
    }
    // Return vcodec alongside audio tracks so the client can preemptively
    // route HEVC / AV1 / VP9 / unknown-codec content through /remux BEFORE
    // a decode error fires, instead of relying on the error-handler swap
    // (which races the player and sometimes leaves the user stuck).
    try { res.json({ audioTracks, duration, vcodec }) } catch {}
  }

  probe.on('exit', () => {
    if (done) return
    done = true
    try { stream.destroy() } catch {}
    sendResult()
  })

  probe.on('error', () => {
    if (done) return
    done = true
    clearTimeout(timeout)
    try { stream.destroy() } catch {}
    try { res.json({ audioTracks: [] }) } catch {}
  })
})

// ── Remux endpoint (MKV → fMP4 with AAC audio via ffmpeg) ───────
// Cached per-torrent: ffprobe duration is needed for byte↔time translation
// on seek, and vcodec drives the copy-vs-transcode decision below.
// Populated by /api/tracks; we also probe lazily on first /remux hit.
//
// Bounded LRU Map — previously this was an unbounded Map that would
// accumulate one entry per torrent the user ever probed, never evicting
// even when the associated torrent had already been swept from the disk
// cache. On a long session (dozens of titles browsed + streamed) the map
// could quietly pin tens of stale infoHashes forever. Now we enforce:
//   - a hard cap (REMUX_META_MAX) with LRU eviction on insert
//   - a TTL (REMUX_META_TTL) so entries expire even without new inserts
//   - a periodic prune timer so stale entries don't wait for a new write
//     to be noticed
const REMUX_META = new Map() // hash -> { duration, vcodec, cachedAt }
const REMUX_META_MAX = 50
const REMUX_META_TTL = 6 * 60 * 60 * 1000 // 6h — stale meta is useless once
                                          // the torrent itself is reclaimed
                                          // from disk cache, and we re-probe
                                          // cheaply on the next /remux hit.

function setRemuxMeta(hash, patch) {
  if (!hash) return
  const existing = REMUX_META.get(hash) || {}
  // Delete + set so this hash lands at the tail of insertion order
  // (Map iteration is insertion-ordered, giving us free LRU).
  try { REMUX_META.delete(hash) } catch {}
  REMUX_META.set(hash, { ...existing, ...patch, cachedAt: Date.now() })
  while (REMUX_META.size > REMUX_META_MAX) {
    const oldest = REMUX_META.keys().next().value
    if (!oldest) break
    REMUX_META.delete(oldest)
  }
}

function getRemuxMeta(hash) {
  if (!hash) return null
  const m = REMUX_META.get(hash)
  if (!m) return null
  if (Date.now() - (m.cachedAt || 0) > REMUX_META_TTL) {
    REMUX_META.delete(hash)
    return null
  }
  return m
}

function pruneRemuxMeta() {
  const cutoff = Date.now() - REMUX_META_TTL
  let dropped = 0
  for (const [hash, m] of REMUX_META.entries()) {
    if ((m.cachedAt || 0) < cutoff) { REMUX_META.delete(hash); dropped++ }
  }
  if (dropped) console.log(`[remux-meta] pruned ${dropped} stale entries (size=${REMUX_META.size})`)
}
// Every 30 min — cheap Map walk.
setInterval(pruneRemuxMeta, 30 * 60 * 1000).unref?.()

// Codecs Chromium/Electron's <video> can decode natively. Everything else
// (hevc/h265, vp9 in MKV, av1, mpeg4, wmv3…) has to go through libx264 in
// the /remux pipeline or the browser throws MEDIA_ERR_DECODE on first keyframe.
const BROWSER_SAFE_VCODECS = new Set(['h264', 'avc1'])

// Pull "Stream #0:N: Video: codec_name" out of ffmpeg stderr. Returns the
// codec string lowercased (e.g. "hevc", "h264", "vp9") or null if absent.
// Handles parenthesised language tags ("Stream #0:0(eng):") AND bracketed
// stream-id annotations ("Stream #0:0 [0x1]:") which some ffmpeg builds emit.
function parseVideoCodec(stderr) {
  const m = stderr.match(/Stream #0:\d+(?:\s*[(\[][^)\]]*[)\]])*\s*:\s*Video:\s*([a-z0-9_]+)/i)
  return m ? m[1].toLowerCase() : null
}

async function probeDuration(videoFile) {
  // Feed 5MB of header into ffprobe and return { duration, vcodec }.
  // Both may be null if the probe times out or the header is malformed.
  return new Promise((resolve) => {
    const readSize = Math.min(videoFile.length - 1, 5 * 1024 * 1024)
    const stream = videoFile.createReadStream({ start: 0, end: readSize })
    const probe = spawn(FFMPEG_PATH, [
      '-analyzeduration', '5000000',
      '-probesize', '5000000',
      '-i', 'pipe:0',
      '-hide_banner',
      '-f', 'null', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { stream.destroy() } catch {}
      try { probe.kill('SIGTERM') } catch {}
      resolve(result)
    }
    probe.stderr.on('data', (d) => {
      stderr += d.toString()
      // Wait until we've seen BOTH Duration and at least one Stream line —
      // the codec parse otherwise races and comes back null.
      if (stderr.includes('Duration:') && /Stream #0:\d+/.test(stderr)) {
        const durM = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        const duration = durM ? (+durM[1] * 3600 + +durM[2] * 60 + +durM[3] + +durM[4] / 100) : null
        finish({ duration, vcodec: parseVideoCodec(stderr) })
      }
    })
    stream.pipe(probe.stdin)
    probe.stdin.on('error', () => {})
    stream.on('error', () => finish({ duration: null, vcodec: null }))
    setTimeout(() => finish({ duration: null, vcodec: parseVideoCodec(stderr) }), 8000)
    probe.on('exit', () => finish({ duration: null, vcodec: parseVideoCodec(stderr) }))
  })
}

// HEAD shortcut — DLNA TVs probe with HEAD before GET to check container
// and byte-range support. Spawning ffmpeg on a HEAD would be wasteful and
// often hangs the TV; just return the right headers.
app.head('/remux/:infoHash/*', (req, res) => {
  const hash = req.params.infoHash?.toLowerCase()
  const torrent = hash && client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === hash)
  const videoFile = torrent && pickBestVideoFile(torrent.files)
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-cache')
  if (videoFile?.length) res.setHeader('Content-Length', String(videoFile.length))
  res.end()
})

app.get('/remux/:infoHash/*', async (req, res) => {
  // Wrap the whole handler so an unhandled throw (bad probe, ffmpeg spawn
  // failure, socket-ended-mid-response) can't hang the request forever.
  try {
  const hash = req.params.infoHash?.toLowerCase()
  const torrent = hash && client.torrents.find((t) => String(t.infoHash || '').toLowerCase() === hash)
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' })

  const videoFile = pickBestVideoFile(torrent.files)
  if (!videoFile) return res.status(404).json({ error: 'No video file' })

  touchTorrent(hash)

  // ?fresh=<timestamp> busts the cached probe and forces a fresh run.
  // The client uses this to escalate out of a stalled transcode — if the
  // cached meta is stale (e.g. we picked -c:v copy because the cached
  // vcodec said "h264" but the stream is actually 10-bit) this gives the
  // server a second bite with accurate codec info.
  if (req.query.fresh) {
    try { REMUX_META.delete(hash) } catch {}
  }

  // We need duration (for byte→time seek translation) AND vcodec (for
  // the copy-vs-transcode decision below). First call probes and caches;
  // subsequent seeks reuse. getRemuxMeta enforces the TTL — a 6h-old
  // cached codec that's technically still here but could have been
  // replaced (e.g. user switched episodes on the same infoHash? unlikely
  // but cheap to handle) counts as a miss.
  let meta = getRemuxMeta(hash)
  if (!meta || !meta.duration || !meta.vcodec) {
    const probed = await probeDuration(videoFile)
    const merged = {
      duration: probed.duration || meta?.duration || 0,
      vcodec: probed.vcodec || meta?.vcodec || null,
    }
    setRemuxMeta(hash, merged)
    meta = { ...merged, cachedAt: Date.now() }
  }
  const duration = meta.duration

  // Advertise the SOURCE file size as our totalSize. The browser uses
  // this model to pick byte ranges on seek — we translate back to time.
  const totalSize = videoFile.length || 0

  // Parse Range header ("bytes=12345-" or "bytes=12345-67890")
  const rangeHeader = req.headers.range
  let isRange = false
  let startByte = 0
  let endByte = totalSize > 0 ? totalSize - 1 : 0
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      isRange = true
      startByte = parseInt(m[1]) || 0
      if (m[2]) endByte = parseInt(m[2])
    }
  }

  // Compute seek time: explicit ?t= wins, else derive from Range startByte.
  let seekSec = req.query.t != null ? parseFloat(req.query.t) : 0
  if (!seekSec && startByte > 0 && duration > 0 && totalSize > 0) {
    seekSec = (startByte / totalSize) * duration
    // Stay a few seconds clear of the end so ffmpeg has output to produce
    seekSec = Math.max(0, Math.min(Math.max(0, duration - 5), seekSec))
  }

  // Response headers — advertise byte ranges so the browser knows seek is
  // supported. Even though our "bytes" are a fiction (we re-translate to
  // time on every range request), keeping the model consistent lets the
  // <video> element's seek bar work correctly.
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-cache')
  if (isRange && totalSize > 0) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`)
  } else if (totalSize > 0) {
    res.status(200)
    res.setHeader('Content-Length', String(totalSize))
  } else {
    res.status(200)
  }

  // Audio track selection: ?audio=N selects a specific audio stream index
  const audioIdx = req.query.audio != null ? parseInt(req.query.audio) : null
  const audioMap = audioIdx != null && !isNaN(audioIdx)
    ? ['-map', '0:v:0', '-map', `0:${audioIdx}`]
    : ['-map', '0:v:0', '-map', '0:a:0']

  // Use WebTorrent's own HTTP server as ffmpeg's input. Unlike stdin,
  // an HTTP URL supports byte-range seeks — ffmpeg issues a Range request
  // to WT for the byte offset corresponding to `-ss seekSec`, WT prioritizes
  // those pieces, and ffmpeg streams forward from there. This is what
  // unblocks scrubbing in the player.
  const encodedPath = videoFile.path.split(/[/\\]/).map(encodeURIComponent).join('/')
  const inputUrl = `http://127.0.0.1:${STREAM_PORT}${wtServer.pathname}/${hash}/${encodedPath}`

  // Copy-vs-transcode decision.
  //   - `-c:v copy` repackages without re-encoding (cheap, instant start)
  //     but only works when the source codec is already one Chromium can
  //     decode natively — effectively just H.264.
  //   - Anything else (HEVC/H.265, VP9-in-MKV, AV1, MPEG-4 ASP, WMV…)
  //     must go through libx264 or the browser throws MEDIA_ERR_DECODE
  //     on the first keyframe despite having a clean MP4 container.
  // The client can also force transcode with ?transcode=1 — used by the
  // auto-fallback when /stream/ emitted a decode error, which bypasses
  // any lingering meta-cache staleness from a previous probe.
  //
  // IMPORTANT: when the codec probe timed out (vcodec === null — common
  // on slow torrents where 5 MB of header wasn't available in 8s), we
  // used to default to copy, which silently served unplayable output.
  // Now we default to transcode — the CPU cost is bounded and the user
  // gets a playable stream instead of a decode error.
  const forceTranscode = req.query.transcode === '1'
  const vcodecKnown = !!meta.vcodec
  const needsTranscode =
    forceTranscode
    || (vcodecKnown && !BROWSER_SAFE_VCODECS.has(meta.vcodec))
    || !vcodecKnown
  const videoEncoder = needsTranscode
    ? [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',   // minimise CPU + first-frame latency; size cost is fine for streaming
        '-tune', 'zerolatency',   // no B-frames, smaller GOP — cuts startup from ~8s to ~1s
        '-crf', '23',             // quality-equivalent to source for most 1080p content
        '-pix_fmt', 'yuv420p',    // Safari/older Chromium refuse 10-bit; force 8-bit 4:2:0
      ]
    : ['-c:v', 'copy']

  const ffmpegArgs = [
    ...(seekSec > 0 ? ['-ss', String(seekSec)] : []),
    '-analyzeduration', '10000000',
    '-probesize', '10000000',
    '-i', inputUrl,
    ...audioMap,
    ...videoEncoder,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ]

  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  ffmpeg.stdout.pipe(res)

  // Keep a ring buffer of recent ffmpeg stderr. Chunks get appended as
  // they arrive; once we're over 10KB we slice to the tail 5KB. Old
  // cap of 2KB/1KB was routinely truncating the most useful multi-line
  // error messages (e.g. "Conversion failed!\n[mov,mp4] decoder not
  // found for stream #…\nError splitting the argument list: …") so we
  // never saw the root cause in the server log.
  let stderrBuf = ''
  ffmpeg.stderr.on('data', (d) => {
    stderrBuf += d.toString()
    if (stderrBuf.length > 10_000) stderrBuf = stderrBuf.slice(-5_000)
  })

  // Hard cleanup: SIGTERM → wait 5s → SIGKILL. On Windows, SIGTERM can
  // silently fail to kill a child that's blocked on a read pipe, leaving
  // a zombie ffmpeg.exe. The SIGKILL fallback guarantees the process dies.
  // Also tear down stdout/stderr before kill so the event loop doesn't
  // hold open handles after the process is gone.
  let killed = false
  const cleanup = () => {
    if (killed) return
    killed = true
    try { ffmpeg.stdout?.destroy() } catch {}
    try { ffmpeg.stderr?.destroy() } catch {}
    try { ffmpeg.kill('SIGTERM') } catch {}
    setTimeout(() => { try { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL') } catch {} }, 5000).unref?.()
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  ffmpeg.on('error', (err) => { console.error('ffmpeg error:', err.message); cleanup() })
  ffmpeg.on('exit', (code) => {
    // Log a wider slice (2KB instead of 500 chars) so the root cause
    // of a transcode crash — which can be dozens of lines before the
    // final "Conversion failed!" — is visible in the log.
    if (code && code !== 0 && code !== 255) console.error('ffmpeg exit code', code, stderrBuf.slice(-2000))
    if (!res.writableEnded) res.end()
  })
  } catch (err) {
    console.error('[/remux] unhandled:', err?.stack || err)
    if (!res.headersSent) res.status(500).json({ error: 'Remux server error' })
    else if (!res.writableEnded) res.end()
  }
})

// ── Stream proxy (route all stream requests through Express) ────
// Handle GET + HEAD so Chromecast/DLNA receivers can probe Content-Length
// and byte-range support before requesting playback. The prior GET-only
// handler caused some TVs to fall back to a 404 and silently bail.
app.all('/stream/*', (req, res) => {
  // Wrap in try/catch so a synchronous throw (bad URL, kernel refusing
  // the socket, etc.) can't leave the Express stack holding the req.
  try {
    const proxyReq = http.request({
      hostname: 'localhost',
      port: STREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${STREAM_PORT}` },
    }, (proxyRes) => {
      // Ensure TVs/receivers see byte-range support advertised even if the
      // underlying server omitted it on HEAD.
      const headers = { ...proxyRes.headers }
      if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes'
      try { res.writeHead(proxyRes.statusCode, headers) } catch {}
      if (req.method === 'HEAD') { try { res.end() } catch {}; return }
      proxyRes.pipe(res)
      // If the client abandons the connection mid-stream, tear down the
      // upstream request too — otherwise WebTorrent keeps pumping pieces
      // into a black hole until the file ends.
      const abort = () => { try { proxyReq.destroy() } catch {} }
      req.on('close', abort)
      proxyRes.on('error', () => {
        if (!res.writableEnded) { try { res.end() } catch {} }
      })
    })
    proxyReq.on('error', (err) => {
      console.warn('[/stream] proxy error:', err?.message || err)
      if (!res.headersSent) {
        try { res.status(502).json({ error: 'Stream server unavailable' }) } catch {}
      } else if (!res.writableEnded) {
        try { res.end() } catch {}
      }
    })
    if (req.method !== 'HEAD' && req.method !== 'GET') req.pipe(proxyReq)
    else proxyReq.end()
  } catch (err) {
    console.error('[/stream] unhandled:', err?.stack || err)
    if (!res.headersSent) {
      try { res.status(500).json({ error: 'Stream proxy error' }) } catch {}
    } else if (!res.writableEnded) {
      try { res.end() } catch {}
    }
  }
})

// ── DLNA / UPnP casting (for Samsung/LG/Sony TVs on LAN) ────────
// Google Cast only works with Chromecast devices. Older Smart TVs
// (Samsung 2016–2020, most LG, Sony) speak DLNA instead. We discover
// renderers on the LAN via SSDP and push a media URL via AVTransport.
let dlnaPlayers = new Map() // id -> player instance
let dlnaCaster = null
// 'unknown' | 'ok' | 'unavailable' — exposed via /api/dlna/devices so
// the UI can distinguish "your LAN has no DLNA devices" (ok + empty
// list) from "the DLNA subsystem itself never booted" (unavailable).
// Without this both paths render the same silent "no devices" hint
// and a dead import is undiagnosable from the client.
let dlnaStatus = 'unknown'
async function initDlna() {
  try {
    const mod = await import('dlnacasts2')
    const dlnacasts = mod.default || mod
    dlnaCaster = dlnacasts()
    dlnaCaster.on('update', (player) => {
      // player.host is the renderer's LAN IP; use it + name as id
      const id = `${player.host}:${player.name || 'device'}`
      dlnaPlayers.set(id, player)
    })
    dlnaCaster.update()
    // Refresh device list every 60s to track renderers turning on/off
    setInterval(() => { try { dlnaCaster.update() } catch {} }, 60_000)
    dlnaStatus = 'ok'
    console.log('DLNA: discovery started')
  } catch (e) {
    dlnaStatus = 'unavailable'
    console.warn('DLNA unavailable:', e.message)
  }
}
initDlna()

// Helper: pick the first non-internal IPv4 so TVs can reach our stream server
function getLanIp() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address
    }
  }
  return '127.0.0.1'
}

app.get('/api/dlna/devices', (req, res) => {
  const list = [...dlnaPlayers.entries()].map(([id, p]) => ({
    id,
    name: p.name || p.host || 'Unknown device',
    host: p.host,
  }))
  res.json({ devices: list, lanIp: getLanIp(), status: dlnaStatus })
})

app.post('/api/dlna/refresh', (req, res) => {
  try { dlnaCaster?.update(); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// Guess a DLNA-friendly MIME from a URL. Many TVs (Medion, older Samsung/LG)
// flat-out refuse a stream advertised as video/mp4 when it's actually MKV.
function guessMimeForDlna(url) {
  const clean = (url || '').split('?')[0].toLowerCase()
  if (clean.endsWith('.m3u8')) return 'application/x-mpegURL'
  if (clean.endsWith('.mkv')) return 'video/x-matroska'
  if (clean.endsWith('.webm')) return 'video/webm'
  if (clean.endsWith('.avi')) return 'video/x-msvideo'
  if (clean.endsWith('.mov')) return 'video/quicktime'
  if (clean.endsWith('.ts')) return 'video/mp2t'
  return 'video/mp4'
}

app.post('/api/dlna/play', (req, res) => {
  const { id, url, title, type } = req.body || {}
  if (!id || !url) return res.status(400).json({ error: 'Missing id or url' })
  const player = dlnaPlayers.get(id)
  if (!player) return res.status(404).json({ error: 'Device not found — try refresh' })
  const mime = type || guessMimeForDlna(url)
  // DLNA renderers expect a contentFeatures.dlna.org hint. OP=01 enables
  // byte-range seeks; CI=0 says "not converted"; the flags mask advertises
  // streaming/bg-transfer support. Without this, some TVs (esp. Medion,
  // Samsung <2018) display an error and stop playback immediately.
  const dlnaFeatures = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
  const opts = {
    title: title || 'WardoFlix',
    type: mime,
    dlnaFeatures,
    contentFeatures: dlnaFeatures, // some forks of dlnacasts use this name
  }
  let settled = false
  const finish = (err) => {
    if (settled) return
    settled = true
    if (err) return res.status(500).json({ error: err.message || 'Cast failed' })
    res.json({ ok: true, mime })
  }
  // Callback safety net: dlnacasts2 sometimes never fires the cb when the
  // TV silently rejects the media. Time out so the UI gets feedback.
  const guard = setTimeout(() => finish(new Error('TV did not acknowledge — it may not support this container')), 15_000)
  try {
    player.play(url, opts, (err) => { clearTimeout(guard); finish(err) })
  } catch (e) {
    clearTimeout(guard); finish(e)
  }
})

app.post('/api/dlna/stop', (req, res) => {
  const { id } = req.body || {}
  const player = dlnaPlayers.get(id)
  if (!player) return res.status(404).json({ error: 'Device not found' })
  try { player.stop(() => res.json({ ok: true })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/dlna/pause', (req, res) => {
  const { id } = req.body || {}
  const player = dlnaPlayers.get(id)
  if (!player) return res.status(404).json({ error: 'Device not found' })
  try { player.pause(() => res.json({ ok: true })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/dlna/resume', (req, res) => {
  const { id } = req.body || {}
  const player = dlnaPlayers.get(id)
  if (!player) return res.status(404).json({ error: 'Device not found' })
  try { player.resume(() => res.json({ ok: true })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Error handler ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Internal server error' })
})

// Bind explicitly to 0.0.0.0 so LAN devices (Chromecast, DLNA TVs) can
// reach us. Node's default dual-stack binding occasionally fails on Windows
// when IPv6 is disabled; being explicit avoids that class of bug.
const apiServer = app.listen(API_PORT, '0.0.0.0', () => {
  console.log(`API server: http://localhost:${API_PORT} (LAN: http://${getLanIp()}:${API_PORT})`)
})
apiServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${API_PORT} still in use. Retrying...`)
    setTimeout(() => apiServer.listen(API_PORT, '0.0.0.0'), 1000)
  } else {
    console.error('API server error:', err.message)
  }
})
