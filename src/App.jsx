import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import videojs from 'video.js'
import 'video.js/dist/video-js.css'
import './App.css'

const isMagnetLink = (str) => str?.trim().toLowerCase().startsWith('magnet:')
const isDirectUrl = (str) => {
  const t = str?.trim() || ''
  return t.startsWith('http://') || t.startsWith('https://')
}

// Codecs Chromium can decode natively. Mirror of the set in server/index.js
// — kept deliberately narrow: even MPEG-4 ASP and VP8 can trip old builds,
// so we default anything we don't explicitly trust through /remux.
const BROWSER_SAFE_VCODECS = new Set(['h264', 'avc1'])

// Human-readable audio track label. The server gives us raw ffmpeg
// codec names and channel layouts; we format them into the style
// Netflix/Plex use — "English (AAC 5.1)" or "Japanese — Director's
// commentary (Opus Stereo)". Falls back gracefully on partial data.
function formatAudioTrackLabel(t) {
  if (!t) return ''
  const parts = []
  parts.push(t.langName || t.lang || `Track ${t.index}`)
  if (t.title) parts.push(`— ${t.title}`)
  const tech = []
  if (t.codec) tech.push(t.codec.toUpperCase())
  if (t.layout) {
    // Prettify a few common ffmpeg layout strings.
    const pretty = {
      mono: 'Mono',
      stereo: 'Stereo',
      'downmix': 'Stereo',
      '2.1': '2.1',
      '4.0': '4.0',
      quad: 'Quad',
      '5.1': '5.1',
      '5.1(side)': '5.1',
      '7.1': '7.1',
    }[t.layout] || t.layout
    tech.push(pretty)
  }
  if (tech.length) parts.push(`(${tech.join(' ')})`)
  return parts.join(' ')
}

// Given a server stream URL and a probed vcodec, return the URL the player
// should actually load. If the URL is already /remux/... we leave it alone.
// If it's /stream/... and the codec is known-unsafe (HEVC, AV1, VP9…) OR
// unknown (null — probe timed out on a slow torrent), upgrade to
// /remux/?transcode=1 so ffmpeg transcodes via libx264.
//
// This is the proactive path — the error handler's /stream/ → /remux/ swap
// is now a safety net for the rare case where the probe lied or was racing.
function upgradeStreamUrlForCodec(url, vcodec) {
  if (!url || !url.includes('/stream/')) return url
  if (vcodec && BROWSER_SAFE_VCODECS.has(vcodec)) return url
  const swapped = url.replace('/stream/', '/remux/')
  const sep = swapped.includes('?') ? '&' : '?'
  return `${swapped}${sep}transcode=1`
}

// Normalise any server-relative URL to an absolute one before it reaches
// the <video> element. In packaged builds the document base is file://,
// which resolves `/remux/…` to `file:///remux/…` — the browser then fires
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4, "container/codec refused"). We hit
// this repeatedly because setSource is called from half a dozen code paths
// (initial play, audio-track switch, decode-error escalation, proactive
// codec upgrade) and it's too easy for one of them to forget the prefix.
// Funnelling every setSource through this helper makes the fix location-
// agnostic.
function toAbsStreamUrl(url) {
  if (!url || typeof url !== 'string') return url
  // Already absolute (http/https/blob/data) — leave alone.
  if (/^(https?:|blob:|data:)/i.test(url)) return url
  // Only prefix server routes. Anything else (plain magnet strings, etc.)
  // shouldn't be going to <video src> in the first place, but be safe.
  if (!/^\/(stream|remux|trailer|api)\b/.test(url)) return url
  const base = (typeof window !== 'undefined' && window.__API_BASE__) || ''
  return base + url
}

// Seed-count health buckets — drives the color-coded dot next to each
// torrent in the picker. Thresholds chosen from real-world experience:
// <1 seed = dead (won't start), 1–4 = likely stall halfway through,
// 5–14 = usable but no margin, 15+ = reliable.
function seedHealth(n) {
  const s = Number(n) || 0
  if (s === 0) return 'dead'
  if (s < 5) return 'risky'
  if (s < 15) return 'ok'
  return 'healthy'
}
function seedHealthLabel(n) {
  const s = Number(n) || 0
  if (s === 0) return 'No seeders — this torrent will not start. We will auto-fall-back to the next source.'
  if (s < 5) return `${s} seeder${s === 1 ? '' : 's'} — risky. Stream may stall.`
  if (s < 15) return `${s} seeders — should work, no margin.`
  return `${s} seeders — healthy.`
}

// Figure out whether a picked item is a TV show or a movie. Explicit
// `type` field always wins; otherwise we infer from the TMDB shape —
// TV items carry `first_air_date`/`name`, movies carry `release_date`/
// `title`. Needed because the home rows set `type` from a prop, but
// elsewhere (genre grid, similar carousel, stale history entries) the
// field occasionally drops and a TV show would render as a flat movie
// sources list. Everything downstream routes through this helper so
// that path cannot re-open.
function inferType(item) {
  if (!item) return 'movies'
  const t = item.type
  if (t === 'tv' || t === 'series') return 'tv'
  if (t === 'movies' || t === 'movie') return 'movies'
  // Type was missing — use TMDB field shape as a tiebreaker.
  if (item.first_air_date && !item.release_date) return 'tv'
  if (item.release_date && !item.first_air_date) return 'movies'
  if (item.name && !item.title) return 'tv'
  // Nothing to go on — default to movies (matches prior behaviour).
  return 'movies'
}

function formatSpeed(bytes) {
  if (!bytes || bytes < 1024) return '0 KB/s'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB/s`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`
}

function useDebounce(value, delay) {
  const [d, setD] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setD(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return d
}

// ═══════════════════════════════════════════════════════════════
// ── Profiles (localStorage) ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Netflix-style multi-user support. Up to PROFILE_MAX profiles per
// install. Each profile carries:
//   - identity:    id, name, emoji, color
//   - preferences: favoriteGenres { movies: [id,...], tv: [id,...] }
//                  mood (one of MOODS keys or null)
//   - derived:     createdAt (for sort order)
// History, resume positions, and volume prefs are namespaced per
// profile via the helpers below — a profile switch swaps the data
// layer automatically without the rest of the app needing to know.
const PROFILES_KEY = 'wardoflix:profiles'
const ACTIVE_PROFILE_KEY = 'wardoflix:active-profile'
const PROFILE_MAX = 4
// Curated avatar palette — rose/oxblood/indigo/teal/amber/violet/
// coral/graphite. Picked to read well on the dark UI without
// clashing with the rose-gold accent used across the app.
const PROFILE_COLORS = [
  '#c9a96e', // rose-gold (house accent)
  '#8a2f3c', // oxblood
  '#4f5d9e', // indigo
  '#3f8c8c', // teal
  '#b8863a', // amber
  '#6a4c93', // violet
  '#c6664a', // coral
  '#5c6470', // graphite
]
const PROFILE_EMOJIS = ['🎬','🎭','🍿','🎸','🎨','🎮','🚀','⭐','🌙','🦊','🐱','🐺','🔥','💫','🦄','🗿']

function uuid() {
  // Short random id — crypto.randomUUID isn't available under all
  // Electron runtimes, so we fall back to a hex-from-Math.random.
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID() } catch {}
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function saveProfiles(list) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list.slice(0, PROFILE_MAX))) } catch {}
  try { window.dispatchEvent(new Event('wardoflix:profiles-updated')) } catch {}
}

function getActiveProfileId() {
  try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || null } catch { return null }
}

function setActiveProfileId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, id)
    else localStorage.removeItem(ACTIVE_PROFILE_KEY)
  } catch {}
  try { window.dispatchEvent(new Event('wardoflix:profiles-updated')) } catch {}
}

function getActiveProfile() {
  const id = getActiveProfileId()
  if (!id) return null
  return loadProfiles().find((p) => p.id === id) || null
}

function createProfile({ name, emoji, color, favoriteGenres }) {
  const list = loadProfiles()
  if (list.length >= PROFILE_MAX) throw new Error(`At most ${PROFILE_MAX} profiles allowed`)
  const profile = {
    id: uuid(),
    name: String(name || 'New Profile').slice(0, 24),
    emoji: emoji || PROFILE_EMOJIS[list.length % PROFILE_EMOJIS.length],
    color: color || PROFILE_COLORS[list.length % PROFILE_COLORS.length],
    favoriteGenres: {
      movies: Array.isArray(favoriteGenres?.movies) ? favoriteGenres.movies.slice(0, 8) : [],
      tv: Array.isArray(favoriteGenres?.tv) ? favoriteGenres.tv.slice(0, 8) : [],
    },
    mood: null,
    createdAt: Date.now(),
  }
  const next = [...list, profile]
  saveProfiles(next)
  // First-profile bootstrap: migrate any pre-profile history/resume
  // data over to this profile so the user doesn't lose their watch
  // record when the profile system is introduced in an upgrade.
  // Remove the legacy keys after a successful copy — otherwise deleting
  // all profiles and creating a new one would re-migrate the same stale
  // data forever.
  if (list.length === 0) {
    try {
      const oldHist = localStorage.getItem('wardoflix:history')
      if (oldHist) {
        localStorage.setItem(`wardoflix:history:${profile.id}`, oldHist)
        localStorage.removeItem('wardoflix:history')
      }
      const oldResume = localStorage.getItem('wardoflix:resume')
      if (oldResume) {
        localStorage.setItem(`wardoflix:resume:${profile.id}`, oldResume)
        localStorage.removeItem('wardoflix:resume')
      }
    } catch {}
  }
  return profile
}

function updateProfile(id, patch) {
  const list = loadProfiles()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) return null
  const merged = { ...list[idx], ...patch }
  // Preserve nested shape for favoriteGenres if the patch is partial.
  if (patch.favoriteGenres) {
    merged.favoriteGenres = {
      movies: Array.isArray(patch.favoriteGenres.movies) ? patch.favoriteGenres.movies.slice(0, 8) : list[idx].favoriteGenres?.movies || [],
      tv: Array.isArray(patch.favoriteGenres.tv) ? patch.favoriteGenres.tv.slice(0, 8) : list[idx].favoriteGenres?.tv || [],
    }
  }
  list[idx] = merged
  saveProfiles(list)
  return merged
}

function deleteProfile(id) {
  const list = loadProfiles().filter((p) => p.id !== id)
  saveProfiles(list)
  // Clean the namespaced data for the deleted profile.
  try {
    localStorage.removeItem(`wardoflix:history:${id}`)
    localStorage.removeItem(`wardoflix:resume:${id}`)
  } catch {}
  // If the active profile was deleted, clear the pointer so the gate
  // re-opens on next render.
  if (getActiveProfileId() === id) setActiveProfileId(null)
}

// Subscribe React to the profile store. Covers both same-tab updates
// (via the custom 'wardoflix:profiles-updated' event) and cross-tab
// updates (via the native 'storage' event).
function useProfiles() {
  const [state, setState] = useState(() => ({
    profiles: loadProfiles(),
    activeId: getActiveProfileId(),
  }))
  useEffect(() => {
    const sync = () => setState({ profiles: loadProfiles(), activeId: getActiveProfileId() })
    window.addEventListener('wardoflix:profiles-updated', sync)
    const onStorage = (e) => {
      if (e.key === PROFILES_KEY || e.key === ACTIVE_PROFILE_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('wardoflix:profiles-updated', sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  const activeProfile = state.profiles.find((p) => p.id === state.activeId) || null
  return { profiles: state.profiles, activeProfile }
}

// ── Mood catalogue ──────────────────────────────────────────────
// Each mood carries a genre-weight overlay (added on top of the
// user's favourite-genre boost + their history-derived weights).
// Genre IDs come from TMDB — they're the same for /movie and /tv
// where the id is shared, and the rare mismatches (e.g. TV has a
// Reality genre) fall through to the shared ones below.
const MOODS = {
  chill:      { label: 'Chill',       emoji: '☕', movieGenres: [35, 10751, 99, 10402], tvGenres: [35, 10751, 99, 10764] },
  thrilling:  { label: 'Thrilling',   emoji: '⚡', movieGenres: [53, 28, 27, 80],       tvGenres: [9648, 80, 10759]       },
  funny:      { label: 'Funny',       emoji: '😂', movieGenres: [35, 10751, 10749],     tvGenres: [35, 10751]             },
  dramatic:   { label: 'Dramatic',    emoji: '🎭', movieGenres: [18, 36, 10752],        tvGenres: [18, 10768]             },
  mindBending:{ label: 'Mind-bending', emoji: '🌀', movieGenres: [878, 9648, 53, 14],   tvGenres: [10765, 9648, 10759]    },
  feelGood:   { label: 'Feel-good',   emoji: '🌞', movieGenres: [10751, 16, 35, 10402], tvGenres: [10751, 16, 35]         },
  romantic:   { label: 'Romantic',    emoji: '💘', movieGenres: [10749, 18, 35],        tvGenres: [18, 35]                },
  adventure:  { label: 'Adventure',   emoji: '🗺️', movieGenres: [12, 28, 14, 878],      tvGenres: [10759, 10765]          },
}

// ═══════════════════════════════════════════════════════════════
// ── Watch History (localStorage, namespaced per profile) ───────
// ═══════════════════════════════════════════════════════════════
const LEGACY_HISTORY_KEY = 'wardoflix:history'
const HISTORY_MAX = 24

function historyKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:history:${id}` : LEGACY_HISTORY_KEY
}
// Kept as a module-level constant for callers that still compare
// against `HISTORY_KEY` (e.g. the useHistory hook's storage-event
// filter). Resolved lazily at read time below.
const HISTORY_KEY = LEGACY_HISTORY_KEY

function loadHistory() {
  try {
    const raw = localStorage.getItem(historyKeyForActive())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function saveHistory(list, profileId) {
  // profileId lets the caller pin a write to a specific profile instead
  // of "whoever is active right now" — avoids the race where a stream
  // started under profile A commits history 15s later but profile B is
  // now active (user switched profiles during the connect).
  const key = profileId ? `wardoflix:history:${profileId}` : historyKeyForActive()
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, HISTORY_MAX))) } catch {}
}

function loadHistoryForProfile(profileId) {
  if (!profileId) return loadHistory()
  try {
    const raw = localStorage.getItem(`wardoflix:history:${profileId}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function addToHistory(entry, profileId) {
  if (!entry || !entry.magnet) return
  const list = profileId ? loadHistoryForProfile(profileId) : loadHistory()
  // Dedupe: same title+season+episode replaces earlier entry
  const key = `${entry.title || ''}|${entry.season || ''}|${entry.episode || ''}`
  const filtered = list.filter((e) => `${e.title || ''}|${e.season || ''}|${e.episode || ''}` !== key)
  filtered.unshift({ ...entry, lastPlayed: Date.now() })
  saveHistory(filtered, profileId)
}

function useHistory() {
  const [history, setHistory] = useState(() => loadHistory())
  useEffect(() => {
    // Match either the legacy unnamespaced key or the new per-profile
    // key. Easier to check the prefix than enumerate every active id.
    const onStorage = (e) => {
      if (e.key === LEGACY_HISTORY_KEY || e.key?.startsWith('wardoflix:history:')) {
        setHistory(loadHistory())
      }
    }
    window.addEventListener('storage', onStorage)
    // Same-tab signal — fired from addToHistory, profile-switches, etc.
    const onLocal = () => setHistory(loadHistory())
    window.addEventListener('wardoflix:history-updated', onLocal)
    // Profile switch changes which history is "active" — re-read.
    window.addEventListener('wardoflix:profiles-updated', onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('wardoflix:history-updated', onLocal)
      window.removeEventListener('wardoflix:profiles-updated', onLocal)
    }
  }, [])
  return history
}

// ── Resume position (localStorage, namespaced per profile) ──────
// Keyed per title+season+episode so each episode resumes independently.
// We skip restoring if the saved position is <30s (too close to start —
// user just opened it) or within 60s of the end (they finished it).
const LEGACY_RESUME_KEY = 'wardoflix:resume'
const RESUME_MAX = 200 // cap stored entries so the map can't grow forever

function resumeKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:resume:${id}` : LEGACY_RESUME_KEY
}

function resumeKey(meta) {
  if (!meta) return null
  const id = meta.id || meta.title
  if (!id) return null
  const s = meta.season || 0
  const e = meta.episode || 0
  return `${id}|${s}|${e}`
}

function loadResumeMap() {
  try {
    const raw = localStorage.getItem(resumeKeyForActive())
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function saveResumePosition(meta, time, duration) {
  const key = resumeKey(meta)
  if (!key || !isFinite(time) || time < 30) return
  // If within 60s of the end, clear the resume position AND flip the
  // item into the "watched" set so the episode list can render a ✓.
  if (duration > 0 && time > duration - 60) {
    clearResumePosition(meta)
    markWatched(meta)
    return
  }
  try {
    const map = loadResumeMap()
    map[key] = { t: Math.floor(time), d: duration > 0 ? Math.floor(duration) : 0, at: Date.now() }
    // Evict oldest entries past the cap
    const keys = Object.keys(map)
    if (keys.length > RESUME_MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      for (let i = 0; i < keys.length - RESUME_MAX; i++) delete map[keys[i]]
    }
    localStorage.setItem(resumeKeyForActive(), JSON.stringify(map))
  } catch {}
}

function readResumePosition(meta) {
  const key = resumeKey(meta)
  if (!key) return 0
  const map = loadResumeMap()
  const entry = map[key]
  if (!entry || !isFinite(entry.t) || entry.t < 30) return 0
  return entry.t
}

function clearResumePosition(meta) {
  const key = resumeKey(meta)
  if (!key) return
  try {
    const map = loadResumeMap()
    if (map[key]) { delete map[key]; localStorage.setItem(resumeKeyForActive(), JSON.stringify(map)) }
  } catch {}
}

// ── Watched set (separate from resume) ──────────────────────────
// Resume is "I stopped here"; watched is "I finished this". When a
// resume entry crosses the end-boundary we clear it *and* flip the
// episode into the watched set so the UI can show a ✓ on the list.
// Cap at 2000 entries per profile to keep the storage footprint sane
// on accounts that binge.
const WATCHED_MAX = 2000
function watchedKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:watched:${id}` : 'wardoflix:watched'
}
function loadWatchedMap() {
  try {
    const raw = localStorage.getItem(watchedKeyForActive())
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}
function markWatched(meta) {
  const key = resumeKey(meta)
  if (!key) return
  try {
    const map = loadWatchedMap()
    map[key] = Date.now()
    const keys = Object.keys(map)
    if (keys.length > WATCHED_MAX) {
      keys.sort((a, b) => (map[a] || 0) - (map[b] || 0))
      for (let i = 0; i < keys.length - WATCHED_MAX; i++) delete map[keys[i]]
    }
    localStorage.setItem(watchedKeyForActive(), JSON.stringify(map))
    // Broadcast so any open DetailModal / episode list can re-render
    // its watched indicators without waiting for a remount.
    try { window.dispatchEvent(new Event('wardoflix:watched-updated')) } catch {}
  } catch {}
}
function isWatched(meta) {
  const key = resumeKey(meta)
  if (!key) return false
  return !!loadWatchedMap()[key]
}

// ── Volume + mute persistence (localStorage) ────────────────────
const VOLUME_KEY = 'wardoflix:volume'
function loadVolumePref() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const v = Number(parsed.volume)
    if (!isFinite(v) || v < 0 || v > 1) return null
    return { volume: v, muted: !!parsed.muted }
  } catch { return null }
}
function saveVolumePref(volume, muted) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({
      volume: Math.max(0, Math.min(1, Number(volume) || 0)),
      muted: !!muted,
    }))
  } catch {}
}

// ── Hero Banner ─────────────────────────────────────────────────
function HeroBanner({ items, type, onSelect, onStream }) {
  const [idx, setIdx] = useState(0)
  const item = items[idx]

  useEffect(() => {
    if (items.length <= 1) return
    const id = setInterval(() => setIdx((i) => (i + 1) % items.length), 10000)
    return () => clearInterval(id)
  }, [items.length])

  useEffect(() => { setIdx(0) }, [type])

  if (!item) return <div className="hero hero--empty" />

  return (
    <div className="hero" key={item.id}>
      {item.backdrop_path && (
        <div className="hero-backdrop">
          <img src={item.backdrop_path} alt="" />
        </div>
      )}
      <div className="hero-gradient" />
      <div className="hero-content">
        <h2 className="hero-title">{item.title || item.name}</h2>
        {item.vote_average > 0 && (
          <div className="hero-meta">
            <span className="hero-rating">★ {item.vote_average.toFixed(1)}</span>
            {(item.release_date || item.first_air_date) && (
              <span className="hero-year">{(item.release_date || item.first_air_date).slice(0, 4)}</span>
            )}
          </div>
        )}
        {item.overview && <p className="hero-overview">{item.overview.slice(0, 200)}{item.overview.length > 200 ? '...' : ''}</p>}
        <div className="hero-actions">
          <button className="btn btn-hero" onClick={() => onSelect({ ...item, title: item.title || item.name, poster: item.poster_path, date: item.release_date || item.first_air_date, rating: item.vote_average, type })}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Play
          </button>
          <button className="btn btn-hero-secondary" onClick={() => onSelect({ ...item, title: item.title || item.name, poster: item.poster_path, date: item.release_date || item.first_air_date, rating: item.vote_average, type })}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            More Info
          </button>
        </div>
      </div>
      {items.length > 1 && (
        <div className="hero-dots">
          {items.slice(0, 5).map((_, i) => (
            <button key={i} className={`hero-dot ${i === idx ? 'active' : ''}`} onClick={() => setIdx(i)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Edge-hover auto-scroll ─────────────────────────────────────
// When the mouse lingers near the left/right edge of a scrollable row
// for a grace period (HOVER_DELAY_MS), we start auto-scrolling in that
// direction. Scroll speed is proportional to how close the pointer is
// to the edge — feels like Apple TV: no buttons to click, the content
// glides to you. rAF-driven so it's GPU-smooth; we cancel everything
// on mouse-leave or when the pointer moves back to the dead zone.
const HOVER_DELAY_MS = 380
const HOT_ZONE_PX = 160
const MAX_SPEED_PX = 11
function useEdgeHoverScroll(ref) {
  const stateRef = useRef({ rafId: null, dir: 0, speed: 0 })
  const delayRef = useRef(null)

  const stop = useCallback(() => {
    if (delayRef.current) { clearTimeout(delayRef.current); delayRef.current = null }
    if (stateRef.current.rafId) { cancelAnimationFrame(stateRef.current.rafId); stateRef.current.rafId = null }
    stateRef.current.dir = 0
    stateRef.current.speed = 0
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const loop = () => {
      const node = ref.current
      const { dir, speed } = stateRef.current
      if (!node || !dir || speed <= 0) { stateRef.current.rafId = null; return }
      // Stop once we've bumped into the scroll limits in that direction
      const atStart = node.scrollLeft <= 0
      const atEnd = node.scrollLeft >= node.scrollWidth - node.clientWidth - 1
      if ((dir < 0 && atStart) || (dir > 0 && atEnd)) {
        stateRef.current.rafId = null
        return
      }
      node.scrollLeft += dir * speed
      stateRef.current.rafId = requestAnimationFrame(loop)
    }

    const onMove = (e) => {
      const node = ref.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const x = e.clientX - rect.left
      let dir = 0
      let ratio = 0
      if (x < HOT_ZONE_PX) {
        dir = -1
        ratio = Math.max(0, 1 - x / HOT_ZONE_PX)
      } else if (x > rect.width - HOT_ZONE_PX) {
        dir = 1
        ratio = Math.max(0, 1 - (rect.width - x) / HOT_ZONE_PX)
      }
      // Smooth ease — squared curve so inner edge is slow and outer edge snaps
      const speed = Math.min(MAX_SPEED_PX, ratio * ratio * MAX_SPEED_PX)
      stateRef.current.dir = dir
      stateRef.current.speed = speed
      if (dir === 0) {
        if (delayRef.current) { clearTimeout(delayRef.current); delayRef.current = null }
        if (stateRef.current.rafId) { cancelAnimationFrame(stateRef.current.rafId); stateRef.current.rafId = null }
      } else if (!stateRef.current.rafId && !delayRef.current) {
        // Grace period — don't scroll if the user's just crossing through
        delayRef.current = setTimeout(() => {
          delayRef.current = null
          stateRef.current.rafId = requestAnimationFrame(loop)
        }, HOVER_DELAY_MS)
      }
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', stop)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', stop)
      stop()
    }
  }, [ref, stop])
}

// ── Content Row (horizontal scroll) ─────────────────────────────
function ContentRow({ title, url, type, onSelect }) {
  const [items, setItems] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0) // bump to force refetch
  const rowRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  useEdgeHoverScroll(rowRef)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    // Retry up to 3 times with exponential backoff. Covers the case where
    // the server was still chewing on a stream request and the first
    // catalog fetch came back empty.
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(url)
        const d = await r.json().catch(() => ({}))
        const results = d.results || []
        if (cancelled) return
        if (results.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 600 * (attempts + 1))
          return
        }
        setItems(results)
        setLoaded(true)
      } catch {
        if (cancelled) return
        if (attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 600 * (attempts + 1))
          return
        }
        setLoaded(true)
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [url, attempt])

  const updateScrollState = useCallback(() => {
    const el = rowRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 20)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 20)
  }, [])

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    return () => el.removeEventListener('scroll', updateScrollState)
  }, [items, updateScrollState])

  const scroll = (dir) => {
    const el = rowRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' })
  }

  if (!loaded || items.length === 0) return null

  return (
    <div className="content-row">
      <h3 className="row-title">{title}</h3>
      <div className="row-container">
        {canScrollLeft && (
          <button className="row-arrow row-arrow--left" onClick={() => scroll(-1)} aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        )}
        <div className="row-posters" ref={rowRef}>
          {items.map((item) => (
            <button
              key={item.id}
              className="row-poster"
              onClick={() => onSelect({
                id: item.id,
                title: item.title || item.name,
                name: item.name || null,
                poster: item.poster_path,
                backdrop: item.backdrop_path,
                overview: item.overview,
                date: item.release_date || item.first_air_date,
                release_date: item.release_date || null,
                first_air_date: item.first_air_date || null,
                rating: item.vote_average,
                type,
              })}
            >
              {item.poster_path ? (
                <img src={item.poster_path} alt="" loading="lazy" />
              ) : (
                <div className="poster-placeholder">{(item.title || item.name || '?')[0]}</div>
              )}
              <div className="row-poster-info">
                <span className="row-poster-title">{item.title || item.name}</span>
                {item.vote_average > 0 && <span className="row-poster-rating">★ {item.vote_average.toFixed(1)}</span>}
              </div>
            </button>
          ))}
        </div>
        {canScrollRight && (
          <button className="row-arrow row-arrow--right" onClick={() => scroll(1)} aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Search Results Grid ─────────────────────────────────────────
function SearchResults({ type, query, onSelect }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query) { setItems([]); return }
    let cancelled = false
    setLoading(true)
    fetch(`/api/catalog/${type}?search=${encodeURIComponent(query)}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => { if (!cancelled) setItems(d.results || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [type, query])

  if (loading) return <div className="search-loading"><span className="spinner large" /><p>Searching...</p></div>
  if (!items.length) return <div className="search-empty"><p>No results for "{query}"</p></div>

  return (
    <div className="search-grid">
      {items.map((item) => (
        <button
          key={item.id}
          className="search-card"
          onClick={() => onSelect({
            id: item.id,
            title: item.title || item.name,
            name: item.name || null,
            poster: item.poster_path,
            backdrop: item.backdrop_path,
            overview: item.overview,
            date: item.release_date || item.first_air_date,
            release_date: item.release_date || null,
            first_air_date: item.first_air_date || null,
            rating: item.vote_average,
            type,
          })}
        >
          {item.poster_path ? <img src={item.poster_path} alt="" loading="lazy" /> : <div className="poster-placeholder">{(item.title || item.name || '?')[0]}</div>}
          <div className="search-card-info">
            <span className="search-card-title">{item.title || item.name}</span>
            {item.vote_average > 0 && <span className="search-card-rating">★ {item.vote_average.toFixed(1)}</span>}
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Continue Watching Row ───────────────────────────────────────
function ContinueWatchingRow({ onPlay, onInfo }) {
  const history = useHistory()
  const rowRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  useEdgeHoverScroll(rowRef)

  const updateScrollState = useCallback(() => {
    const el = rowRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 20)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 20)
  }, [])

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    return () => el.removeEventListener('scroll', updateScrollState)
  }, [history, updateScrollState])

  const scroll = (dir) => {
    const el = rowRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' })
  }

  const removeEntry = (e, entry) => {
    e.stopPropagation()
    const list = loadHistory().filter((h) =>
      !(h.title === entry.title && h.season === entry.season && h.episode === entry.episode)
    )
    saveHistory(list)
    window.dispatchEvent(new Event('wardoflix:history-updated'))
  }

  if (!history.length) return null

  return (
    <div className="content-row">
      <h3 className="row-title">Continue Watching</h3>
      <div className="row-container">
        {canScrollLeft && (
          <button className="row-arrow row-arrow--left" onClick={() => scroll(-1)} aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        )}
        <div className="row-posters" ref={rowRef}>
          {history.map((entry, i) => (
            <button
              key={`${entry.title}-${entry.season || ''}-${entry.episode || ''}-${i}`}
              className="row-poster history-poster"
              onClick={() => onPlay(entry)}
              title={`${entry.title}${entry.season ? ` S${entry.season}` : ''}${entry.episode ? `E${entry.episode}` : ''}`}
            >
              {entry.poster ? (
                <img src={entry.poster} alt="" loading="lazy" />
              ) : (
                <div className="poster-placeholder">{(entry.title || '?')[0]}</div>
              )}
              <div className="history-overlay">
                <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
              </div>
              <button
                className="history-remove"
                onClick={(e) => removeEntry(e, entry)}
                title="Remove"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div className="row-poster-info">
                <span className="row-poster-title">{entry.title}</span>
                {entry.season && entry.episode && (
                  <span className="row-poster-rating">S{String(entry.season).padStart(2,'0')}E{String(entry.episode).padStart(2,'0')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
        {canScrollRight && (
          <button className="row-arrow row-arrow--right" onClick={() => scroll(1)} aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ── Profile UI ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Circular avatar with initial or emoji. Used on the picker screen,
// the topbar switcher, and inside the editor.
function ProfileAvatar({ profile, size = 96, onClick, className = '' }) {
  if (!profile) return null
  const initial = (profile.name || '?').trim().charAt(0).toUpperCase()
  const style = {
    width: size,
    height: size,
    background: `radial-gradient(circle at 30% 28%, ${profile.color}ee 0%, ${profile.color}aa 50%, ${profile.color}55 100%)`,
    borderColor: `${profile.color}88`,
    fontSize: Math.round(size * 0.42),
  }
  return (
    <button
      type="button"
      className={`wf-avatar ${onClick ? 'wf-avatar--clickable' : ''} ${className}`}
      style={style}
      onClick={onClick}
      aria-label={profile.name}
      title={profile.name}
    >
      <span className="wf-avatar-emoji" aria-hidden="true">{profile.emoji || initial}</span>
    </button>
  )
}

// Full-screen "Who's watching?" picker. Covers the whole app while
// no active profile is set, so history + recommendations always tie
// back to a known user.
function ProfileGate({ profiles, onPick, onManage }) {
  const [creating, setCreating] = useState(profiles.length === 0)
  // Auto-open the creator on first run — no profiles means we can't
  // show a picker anyway, and jumping straight to "make one" is less
  // friction than staring at an empty screen with a single button.
  return (
    <div className="wf-profile-gate">
      <div className="wf-profile-gate-inner">
        <h1 className="wf-profile-gate-title">Who's watching?</h1>
        <p className="wf-profile-gate-sub">Pick a profile to continue — your watch history and For You rail travel with it.</p>
        <div className="wf-profile-picker-grid">
          {profiles.map((p) => (
            <div key={p.id} className="wf-profile-pick">
              <ProfileAvatar profile={p} size={120} onClick={() => onPick(p.id)} />
              <div className="wf-profile-pick-name">{p.name}</div>
            </div>
          ))}
          {profiles.length < PROFILE_MAX && (
            <div className="wf-profile-pick">
              <button
                type="button"
                className="wf-avatar wf-avatar--add"
                style={{ width: 120, height: 120 }}
                onClick={() => setCreating(true)}
                aria-label="Add profile"
              >
                <span className="wf-avatar-plus" aria-hidden="true">+</span>
              </button>
              <div className="wf-profile-pick-name">Add profile</div>
            </div>
          )}
        </div>
        {profiles.length > 0 && (
          <button type="button" className="wf-profile-manage-btn" onClick={onManage}>Manage profiles</button>
        )}
      </div>
      {creating && (
        <ProfileEditor
          onClose={() => setCreating(false)}
          onSave={(data) => {
            const p = createProfile(data)
            setActiveProfileId(p.id)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

// Create/edit modal. Name, emoji, color, and favourite-genre picks
// per type. Genres are fetched from the same /api/catalog/genres
// endpoint the sidebar uses, so the list mirrors what the user
// sees when they browse.
function ProfileEditor({ profile, onClose, onSave, onDelete }) {
  const [name, setName] = useState(profile?.name || '')
  const [emoji, setEmoji] = useState(profile?.emoji || PROFILE_EMOJIS[0])
  const [color, setColor] = useState(profile?.color || PROFILE_COLORS[0])
  const [movieGenres, setMovieGenres] = useState(profile?.favoriteGenres?.movies || [])
  const [tvGenres, setTvGenres] = useState(profile?.favoriteGenres?.tv || [])
  const [allMovieGenres, setAllMovieGenres] = useState([])
  const [allTvGenres, setAllTvGenres] = useState([])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/catalog/genres/movies').then((r) => r.json()).catch(() => ({ genres: [] })),
      fetch('/api/catalog/genres/tv').then((r) => r.json()).catch(() => ({ genres: [] })),
    ]).then(([m, t]) => {
      if (cancelled) return
      setAllMovieGenres(m.genres || [])
      setAllTvGenres(t.genres || [])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleGenre = (list, setList, id) => {
    if (list.includes(id)) setList(list.filter((g) => g !== id))
    else if (list.length < 8) setList([...list, id])
  }

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave({
      name: trimmed,
      emoji,
      color,
      favoriteGenres: { movies: movieGenres, tv: tvGenres },
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wf-profile-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div className="modal-body">
          <h2 className="wf-profile-modal-title">{profile ? 'Edit profile' : 'New profile'}</h2>

          <div className="wf-profile-preview-row">
            <ProfileAvatar profile={{ name, emoji, color }} size={96} />
            <input
              className="wf-profile-name-input"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 24))}
              placeholder="Profile name"
              maxLength={24}
              autoFocus
            />
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">Avatar</div>
            <div className="wf-emoji-grid">
              {PROFILE_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`wf-emoji-chip ${e === emoji ? 'selected' : ''}`}
                  onClick={() => setEmoji(e)}
                >{e}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">Color</div>
            <div className="wf-color-grid">
              {PROFILE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`wf-color-chip ${c === color ? 'selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">
              Favourite movie genres <span className="wf-profile-section-hint">pick up to 8</span>
            </div>
            <div className="wf-genre-chip-grid">
              {allMovieGenres.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`wf-genre-chip ${movieGenres.includes(g.id) ? 'selected' : ''}`}
                  onClick={() => toggleGenre(movieGenres, setMovieGenres, g.id)}
                  disabled={!movieGenres.includes(g.id) && movieGenres.length >= 8}
                >{g.name}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">
              Favourite series genres <span className="wf-profile-section-hint">pick up to 8</span>
            </div>
            <div className="wf-genre-chip-grid">
              {allTvGenres.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`wf-genre-chip ${tvGenres.includes(g.id) ? 'selected' : ''}`}
                  onClick={() => toggleGenre(tvGenres, setTvGenres, g.id)}
                  disabled={!tvGenres.includes(g.id) && tvGenres.length >= 8}
                >{g.name}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-actions">
            {onDelete && profile && (
              <button className="btn btn-danger" onClick={() => {
                if (confirm(`Delete profile "${profile.name}"? This removes its watch history and resume positions.`)) onDelete()
              }}>Delete profile</button>
            )}
            <div className="wf-profile-actions-right">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" onClick={handleSave} disabled={!name.trim()}>
                {profile ? 'Save' : 'Create profile'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Topbar switcher — avatar button + dropdown to change or edit
// profiles. Clicking the gear-row item opens the editor for the
// current profile; "Switch profile" returns to the gate.
// ═══════════════════════════════════════════════════════════════
// ── Auto-updater ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
//
// `window.wardoflixUpdater` is exposed by electron/preload.cjs and only
// exists in the packaged app. In the browser preview the hook returns
// `hasApi: false` and the indicator renders nothing — clean no-op.
//
// The main process drives all state transitions; we just mirror them
// and offer two actions: trigger a check, or install once downloaded.

function useUpdater() {
  const hasApi = typeof window !== 'undefined' && !!window.wardoflixUpdater
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!hasApi) return
    const api = window.wardoflixUpdater
    let cancelled = false

    // Hydrate — the main process may have fired events before we mounted.
    Promise.resolve(api.getStatus?.())
      .then((s) => { if (!cancelled && s) setStatus(s) })
      .catch(() => {})

    const unsub = api.onStatus?.((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => { cancelled = true; try { unsub?.() } catch {} }
  }, [hasApi])

  const check = useCallback(async () => {
    if (!hasApi) return
    try { await window.wardoflixUpdater.check() } catch {}
  }, [hasApi])

  const install = useCallback(async () => {
    if (!hasApi) return
    try { await window.wardoflixUpdater.install() } catch {}
  }, [hasApi])

  return { status, check, install, hasApi }
}

function UpdaterIndicator() {
  const { status, check, install, hasApi } = useUpdater()
  const [open, setOpen] = useState(false)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!hasApi) return null

  const state = status?.state || 'idle'
  const version = status?.version
  const current = status?.currentVersion
  const progress = status?.progress
  const message = status?.message
  const hasNews = state === 'available' || state === 'downloading' || state === 'downloaded' || state === 'error'

  const hover = (() => {
    switch (state) {
      case 'checking': return 'Checking for updates…'
      case 'available': return `Update available: v${version || ''}`
      case 'not-available': return "You're up to date"
      case 'downloading': return `Downloading v${version || ''} — ${Math.round(progress?.percent || 0)}%`
      case 'downloaded': return `v${version || ''} ready — click to install`
      case 'error': return 'Update check failed'
      case 'disabled': return 'Updates disabled in dev'
      default: return 'Check for updates'
    }
  })()

  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)))

  return (
    <div className="wf-updater" ref={panelRef} data-state={state}>
      <button
        className="wf-updater-btn"
        type="button"
        title={hover}
        aria-label={hover}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className={`wf-updater-icon ${state === 'checking' || state === 'downloading' ? 'is-spinning' : ''}`}
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {state === 'downloaded' ? (
            <>
              <polyline points="20 6 9 17 4 12" />
            </>
          ) : (
            <>
              <path d="M21 12a9 9 0 1 1-3.55-7.15" />
              <polyline points="21 3 21 9 15 9" />
            </>
          )}
        </svg>
        {hasNews && <span className="wf-updater-dot" />}
      </button>

      {open && (
        <div className="wf-updater-panel">
          <div className="wf-updater-panel-head">
            <div className="wf-updater-panel-title">
              {state === 'downloaded'
                ? `Update ready: v${version || ''}`
                : state === 'available' || state === 'downloading'
                ? `Update ${version ? `v${version} ` : ''}in progress`
                : state === 'checking'
                ? 'Looking for updates'
                : state === 'error'
                ? 'Update check failed'
                : state === 'disabled'
                ? 'Updates disabled'
                : 'WardoFlix is up to date'}
            </div>
            <div className="wf-updater-panel-sub">
              {message || `Running version ${current || ''}`}
            </div>
          </div>

          {state === 'downloading' && (
            <div className="wf-updater-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="wf-updater-progress-bar" style={{ width: `${pct}%` }} />
              <div className="wf-updater-progress-label">
                <span>{pct}%</span>
                {progress?.bytesPerSecond > 0 && (
                  <span>{formatSpeed(progress.bytesPerSecond)}</span>
                )}
              </div>
            </div>
          )}

          {state === 'error' && status?.error && (
            <div className="wf-updater-error" title={status.error}>
              {status.error}
            </div>
          )}

          <div className="wf-updater-actions">
            {state === 'downloaded' ? (
              <button
                type="button"
                className="wf-updater-action primary"
                onClick={() => { setOpen(false); install() }}
              >
                Restart &amp; install
              </button>
            ) : (
              <button
                type="button"
                className="wf-updater-action"
                disabled={state === 'checking' || state === 'downloading' || state === 'disabled'}
                onClick={() => { check() }}
              >
                {state === 'checking'
                  ? 'Checking…'
                  : state === 'downloading'
                  ? 'Downloading…'
                  : state === 'disabled'
                  ? 'Unavailable'
                  : 'Check now'}
              </button>
            )}
          </div>

          <div className="wf-updater-foot">
            <span>Current: v{current || '—'}</span>
            {version && version !== current && (
              <span className="wf-updater-foot-new">New: v{version}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileSwitcher({ profiles, activeProfile }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null) // profile object being edited, or null
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!activeProfile) return null

  return (
    <div className="wf-profile-switcher" ref={menuRef}>
      <ProfileAvatar
        profile={activeProfile}
        size={34}
        onClick={() => setOpen((v) => !v)}
        className="wf-profile-switcher-avatar"
      />
      {open && (
        <div className="wf-profile-switcher-menu">
          <div className="wf-profile-switcher-header">
            <ProfileAvatar profile={activeProfile} size={40} />
            <div className="wf-profile-switcher-ident">
              <div className="wf-profile-switcher-name">{activeProfile.name}</div>
              <div className="wf-profile-switcher-sub">Active profile</div>
            </div>
          </div>
          <div className="wf-profile-switcher-divider" />
          {profiles.filter((p) => p.id !== activeProfile.id).map((p) => (
            <button
              key={p.id}
              className="wf-profile-switcher-row"
              onClick={() => { setActiveProfileId(p.id); setOpen(false) }}
            >
              <ProfileAvatar profile={p} size={28} />
              <span>Switch to {p.name}</span>
            </button>
          ))}
          <button
            className="wf-profile-switcher-row"
            onClick={() => { setEditing(activeProfile); setOpen(false) }}
          >
            <span className="wf-profile-switcher-icon" aria-hidden="true">✎</span>
            <span>Edit profile</span>
          </button>
          <button
            className="wf-profile-switcher-row"
            onClick={() => { setActiveProfileId(null); setOpen(false) }}
          >
            <span className="wf-profile-switcher-icon" aria-hidden="true">⇄</span>
            <span>Switch profile…</span>
          </button>
        </div>
      )}
      {editing && (
        <ProfileEditor
          profile={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => { updateProfile(editing.id, patch); setEditing(null) }}
          onDelete={() => { deleteProfile(editing.id); setEditing(null) }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ── For You ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Pill row at the top of the For You page. Mood selection is stored
// on the active profile (so it persists between sessions) and folds
// into the recommendation weights.
function MoodPicker({ activeMood, onChange }) {
  return (
    <div className="wf-mood-row">
      <span className="wf-mood-label">What's the mood?</span>
      <div className="wf-mood-pills">
        <button
          className={`wf-mood-pill ${!activeMood ? 'active' : ''}`}
          onClick={() => onChange(null)}
        >Any</button>
        {Object.entries(MOODS).map(([key, m]) => (
          <button
            key={key}
            className={`wf-mood-pill ${activeMood === key ? 'active' : ''}`}
            onClick={() => onChange(key)}
            title={m.label}
          >
            <span className="wf-mood-pill-emoji" aria-hidden="true">{m.emoji}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// Combine signals into per-type genre weights. Returns { movies:
// [{id, weight}, ...], tv: [...] }, each sorted high→low.
function computeGenreWeights(profile, history) {
  const movies = {}
  const tv = {}
  const bump = (map, id, amount) => { map[id] = (map[id] || 0) + amount }
  // (1) Favourite genres = the strongest manual signal.
  for (const id of (profile?.favoriteGenres?.movies || [])) bump(movies, id, 5)
  for (const id of (profile?.favoriteGenres?.tv || [])) bump(tv, id, 5)
  // (2) History-derived — each watched entry contributes to its
  // type's map. We don't have TMDB genre_ids on history entries,
  // but we DO know the type; this alone biases the type mix even
  // without per-genre details, and the history-resolver below
  // fills in the genre side via cached details.
  for (const h of (history || [])) {
    const tType = inferType(h)
    // The per-entry genre contribution is best-effort — we patched
    // addToHistory to carry genre_ids when they were available at
    // stream time (see App render). Older entries lack them and
    // fall through to the type bias only.
    const ids = Array.isArray(h.genreIds) ? h.genreIds : []
    const map = tType === 'tv' ? tv : movies
    for (const id of ids) bump(map, id, 2)
  }
  // (3) Mood overlay — light nudge on top of the manual+history mix.
  const mood = profile?.mood ? MOODS[profile.mood] : null
  if (mood) {
    for (const id of mood.movieGenres) bump(movies, id, 3)
    for (const id of mood.tvGenres) bump(tv, id, 3)
  }
  const rank = (obj) => Object.entries(obj)
    .map(([id, weight]) => ({ id: Number(id), weight }))
    .sort((a, b) => b.weight - a.weight)
  return { movies: rank(movies), tv: rank(tv) }
}

// Pull a genre-ID → name map, used to label the rows.
function useGenreNames() {
  const [names, setNames] = useState({ movies: {}, tv: {} })
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/catalog/genres/movies').then((r) => r.json()).catch(() => ({ genres: [] })),
      fetch('/api/catalog/genres/tv').then((r) => r.json()).catch(() => ({ genres: [] })),
    ]).then(([m, t]) => {
      if (cancelled) return
      const mm = {}; for (const g of (m.genres || [])) mm[g.id] = g.name
      const tt = {}; for (const g of (t.genres || [])) tt[g.id] = g.name
      setNames({ movies: mm, tv: tt })
    })
    return () => { cancelled = true }
  }, [])
  return names
}

function ForYou({ profile, onSelect, onPlayHistory }) {
  const history = useHistory()
  const genreNames = useGenreNames()
  const [mood, setMood] = useState(profile?.mood || null)

  // Persist mood back onto the profile so it survives a reload/session.
  const handleMood = (m) => {
    setMood(m)
    if (profile) updateProfile(profile.id, { mood: m })
  }

  const weights = useMemo(
    () => computeGenreWeights({ ...profile, mood }, history),
    [profile, mood, history]
  )

  // Pick top 3 per type — enough rows to feel personalised without
  // dragging the page out. If the user hasn't picked any favourites
  // and has no history, we fall through to generic trending below.
  const topMovieGenres = weights.movies.slice(0, 3)
  const topTvGenres = weights.tv.slice(0, 3)
  const hasAnySignal = topMovieGenres.length > 0 || topTvGenres.length > 0

  // "Because you watched X" — take the most-recent *distinct title*
  // from history and render its TMDB 'similar' list. We use the
  // existing /api/details endpoint so the request is cached server-
  // side and coexists with the detail modal's fetch.
  const lastWatched = history.find((h) => h.id) || null

  return (
    <>
      <div className="wf-foryou-header">
        <div className="wf-foryou-greet">
          <span className="wf-foryou-greet-emoji" aria-hidden="true">{profile?.emoji || '👋'}</span>
          <div>
            <h2 className="wf-foryou-title">For {profile?.name || 'You'}</h2>
            <p className="wf-foryou-sub">Picks blended from your favourites, your watch history and today's mood.</p>
          </div>
        </div>
        <MoodPicker activeMood={mood} onChange={handleMood} />
      </div>

      <div className="rows-section">
        <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelect} />

        {lastWatched && (
          <BecauseYouWatchedRow entry={lastWatched} onSelect={onSelect} />
        )}

        {topMovieGenres.map((g) => (
          <ContentRow
            key={`fy-m-${g.id}`}
            title={`${genreNames.movies[g.id] || 'Recommended'} · Movies`}
            url={`/api/catalog/movies?genre=${g.id}`}
            type="movies"
            onSelect={onSelect}
          />
        ))}
        {topTvGenres.map((g) => (
          <ContentRow
            key={`fy-t-${g.id}`}
            title={`${genreNames.tv[g.id] || 'Recommended'} · Series`}
            url={`/api/catalog/tv?genre=${g.id}`}
            type="tv"
            onSelect={onSelect}
          />
        ))}

        {/* Fallback when we have no signal yet — still gives the
            user something to click so the page doesn't look empty
            on a brand-new profile before they've picked anything. */}
        {!hasAnySignal && (
          <>
            <ContentRow title="Trending Movies" url={`/api/catalog/movies?category=trending`} type="movies" onSelect={onSelect} />
            <ContentRow title="Trending Series" url={`/api/catalog/tv?category=trending`} type="tv" onSelect={onSelect} />
          </>
        )}
      </div>
    </>
  )
}

// One-off row that pulls TMDB 'similar' items off the details
// endpoint. Shown when the user has at least one history entry
// with an id — otherwise TMDB can't resolve it.
function BecauseYouWatchedRow({ entry, onSelect }) {
  const [items, setItems] = useState([])
  const [loaded, setLoaded] = useState(false)
  const rowRef = useRef(null)
  useEdgeHoverScroll(rowRef)
  useEffect(() => {
    if (!entry?.id) { setLoaded(true); return }
    let cancelled = false
    const t = inferType(entry)
    fetch(`/api/details/${t}/${entry.id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) { setLoaded(true); return }
        setItems((d.similar || []).slice(0, 20))
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [entry?.id])

  if (!loaded || items.length === 0) return null

  return (
    <div className="content-row">
      <h3 className="row-title">Because you watched {entry.title}</h3>
      <div className="row-container">
        <div className="row-posters" ref={rowRef}>
          {items.map((s) => (
            <button
              key={s.id}
              className="row-poster"
              onClick={() => onSelect({
                id: s.id,
                title: s.title,
                type: s.type,
                date: s.year ? `${s.year}-01-01` : null,
                rating: s.rating,
                poster: s.poster,
                backdrop: s.poster,
              })}
            >
              {s.poster ? <img src={s.poster} alt="" loading="lazy" /> : <div className="poster-placeholder">{s.title?.[0] || '?'}</div>}
              <div className="row-poster-info">
                <span className="row-poster-title">{s.title}</span>
                {s.rating > 0 && <span className="row-poster-rating">★ {s.rating.toFixed(1)}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Browse Page ─────────────────────────────────────────────────
// Layout: Stremio-style left sidebar (Home / Movies / Series / genres)
// + main content area. View state:
//   - view === 'foryou' → personalised For You rows (default when a
//                         profile has any signal — favourites/history)
//   - view === 'home'  → trending movies + trending series rails
//   - view === 'movies' / 'tv' → full rails (trending/popular/top/new) + genre rails
//   - view === 'genre' → single genre grid for current type
function Browse({ onSelectTitle, onPlayHistory, activeProfile }) {
  // Default to 'foryou' when we have a profile to personalise for —
  // matches the mental model the user has (Netflix opens on your
  // personalised rail, not a generic catalogue). Falls through to
  // 'home' when there is no active profile (shouldn't happen in
  // practice since the gate blocks render until one is picked, but
  // it keeps the component resilient in isolation).
  const [view, setView] = useState(activeProfile ? 'foryou' : 'home') // 'foryou' | 'home' | 'movies' | 'tv' | 'genre'
  const [type, setType] = useState('movies')      // active type (drives top pills & genre sidebar)
  const [activeGenre, setActiveGenre] = useState(null) // { id, name } when view === 'genre'
  const [searchQuery, setSearchQuery] = useState('')
  const [genres, setGenres] = useState([])
  const [heroItems, setHeroItems] = useState([])

  const debouncedSearch = useDebounce(searchQuery, 400)

  useEffect(() => { setSearchQuery('') }, [view, type])

  // Fetch genres for the current type (drives sidebar list).
  // Retries twice if the first response is empty — covers the case where
  // TMDB was momentarily unresponsive while the stream was warming up.
  useEffect(() => {
    let cancelled = false
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(`/api/catalog/genres/${type}`)
        const d = await r.json().catch(() => ({}))
        const list = d.genres || []
        if (cancelled) return
        if (list.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
          return
        }
        setGenres(list)
      } catch {
        if (!cancelled && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
        }
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [type])

  // Hero items: trending of the active type (or movies on home).
  // Same retry strategy so the hero banner doesn't disappear after streaming.
  useEffect(() => {
    let cancelled = false
    const heroType = view === 'home' ? 'movies' : type
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(`/api/catalog/${heroType}?category=trending`)
        const d = await r.json().catch(() => ({}))
        const withBackdrop = (d.results || []).filter((i) => i.backdrop_path)
        if (cancelled) return
        if (withBackdrop.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
          return
        }
        setHeroItems(withBackdrop.slice(0, 5))
      } catch {
        if (!cancelled && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
        }
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [type, view])

  const isSearching = debouncedSearch.trim().length > 0

  // Sidebar nav handlers
  const goForYou = () => { setView('foryou'); setActiveGenre(null) }
  const goHome = () => { setView('home'); setActiveGenre(null) }
  const goType = (t) => { setType(t); setView(t); setActiveGenre(null) }
  const goGenre = (g) => { setActiveGenre(g); setView('genre') }

  return (
    <div className="browse">
      <aside className="sidebar">
        <div className="sidebar-section">
          {activeProfile && (
            <button
              className={`sidebar-item ${view === 'foryou' ? 'active' : ''}`}
              onClick={goForYou}
              title="For You"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l2.39 5.9L20 9l-4.5 3.9L17 19l-5-3-5 3 1.5-6.1L4 9l5.61-1.1z"/></svg>
              <span>For You</span>
            </button>
          )}
          <button
            className={`sidebar-item ${view === 'home' ? 'active' : ''}`}
            onClick={goHome}
            title="Home"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/></svg>
            <span>Home</span>
          </button>
          <button
            className={`sidebar-item ${view === 'movies' ? 'active' : ''}`}
            onClick={() => goType('movies')}
            title="Movies"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 13h4M3 17h4M17 9h4M17 13h4M17 17h4"/></svg>
            <span>Movies</span>
          </button>
          <button
            className={`sidebar-item ${view === 'tv' ? 'active' : ''}`}
            onClick={() => goType('tv')}
            title="Series"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
            <span>Series</span>
          </button>
        </div>

        <div className="sidebar-divider" />

        <div className="sidebar-section sidebar-scroll">
          <div className="sidebar-label">
            {type === 'movies' ? 'Movie Genres' : 'Series Genres'}
          </div>
          {genres.map((g) => (
            <button
              key={g.id}
              className={`sidebar-item sidebar-item--sub ${activeGenre?.id === g.id ? 'active' : ''}`}
              onClick={() => goGenre(g)}
            >
              <span>{g.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="browse-main">
        <div className="browse-nav">
          <div className="search-box">
            <svg className="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search titles..."
              aria-label="Search"
            />
          </div>
        </div>

        {isSearching ? (
          <SearchResults type={type} query={debouncedSearch} onSelect={onSelectTitle} />
        ) : view === 'foryou' && activeProfile ? (
          <ForYou profile={activeProfile} onSelect={onSelectTitle} onPlayHistory={onPlayHistory} />
        ) : view === 'home' ? (
          <>
            <HeroBanner items={heroItems} type="movies" onSelect={onSelectTitle} />
            <div className="rows-section">
              <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelectTitle} />
              <ContentRow title="Trending Movies" url={`/api/catalog/movies?category=trending`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Trending Series" url={`/api/catalog/tv?category=trending`} type="tv" onSelect={onSelectTitle} />
              <ContentRow title="Popular Movies" url={`/api/catalog/movies?category=popular`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Popular Series" url={`/api/catalog/tv?category=popular`} type="tv" onSelect={onSelectTitle} />
              <ContentRow title="Top Rated Movies" url={`/api/catalog/movies?category=top`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Top Rated Series" url={`/api/catalog/tv?category=top`} type="tv" onSelect={onSelectTitle} />
            </div>
          </>
        ) : view === 'genre' && activeGenre ? (
          <>
            <div className="browse-heading">
              <h2>{activeGenre.name}</h2>
              <p className="browse-heading-sub">{type === 'movies' ? 'Movies' : 'Series'}</p>
            </div>
            <GenreGrid type={type} genreId={activeGenre.id} onSelect={onSelectTitle} />
          </>
        ) : (
          <>
            <HeroBanner items={heroItems} type={type} onSelect={onSelectTitle} />
            <div className="rows-section">
              <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelectTitle} />
              <ContentRow title="Trending Now" url={`/api/catalog/${type}?category=trending`} type={type} onSelect={onSelectTitle} />
              <ContentRow title="Popular" url={`/api/catalog/${type}?category=popular`} type={type} onSelect={onSelectTitle} />
              <ContentRow title="Top Rated" url={`/api/catalog/${type}?category=top`} type={type} onSelect={onSelectTitle} />
              <ContentRow title={type === 'movies' ? 'Now Playing' : 'On The Air'} url={`/api/catalog/${type}?category=new`} type={type} onSelect={onSelectTitle} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Paginated grid for a single genre selection from the sidebar.
function GenreGrid({ type, genreId, onSelect }) {
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef(null)

  useEffect(() => {
    setItems([]); setPage(1); setTotalPages(1)
  }, [type, genreId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/catalog/${type}?genre=${genreId}&page=${page}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (cancelled) return
        setItems((prev) => page === 1 ? (d.results || []) : [...prev, ...(d.results || [])])
        setTotalPages(d.total_pages || 1)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [type, genreId, page])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && page < totalPages) {
        setPage((p) => p + 1)
      }
    }, { rootMargin: '400px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [loading, page, totalPages])

  return (
    <div className="genre-grid-wrap">
      <div className="poster-grid">
        {items.map((item) => (
          <button
            key={item.id}
            className="poster-card"
            // Normalize the item shape the modal expects — raw TMDB
            // payloads don't carry a `type` field, and without this
            // mapping a TV-genre click landed in DetailModal with
            // `type === undefined` and rendered as a flat movie list.
            onClick={() => onSelect({
              id: item.id,
              title: item.title || item.name,
              name: item.name || null,
              poster: item.poster_path,
              backdrop: item.backdrop_path,
              overview: item.overview,
              date: item.release_date || item.first_air_date,
              release_date: item.release_date || null,
              first_air_date: item.first_air_date || null,
              rating: item.vote_average,
              type,
            })}
          >
            {item.poster_path ? (
              <img src={item.poster_path} alt={item.title || item.name} loading="lazy" />
            ) : (
              <div className="poster-card-fallback">{item.title || item.name}</div>
            )}
            <div className="poster-card-title">{item.title || item.name}</div>
          </button>
        ))}
      </div>
      {page < totalPages && (
        <div ref={sentinelRef} className="scroll-sentinel">
          <span className="spinner large" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">No results found.</div>
      )}
    </div>
  )
}

// ── Detail Modal ────────────────────────────────────────────────
function DetailModal({ item, onClose, onStream, onSelectItem }) {
  const [input, setInput] = useState('')
  const [torrents, setTorrents] = useState([])
  const [bySeason, setBySeason] = useState({})
  const [seasons, setSeasons] = useState([])
  const [selectedSeason, setSelectedSeason] = useState('1')
  const [torrentsLoading, setTorrentsLoading] = useState(true)
  // Rich details: trailer, cast, similar titles (Stremio-parity)
  const [details, setDetails] = useState(null)
  const [showTrailer, setShowTrailer] = useState(false)
  // Detect TV with a heuristic fallback so a missing `type` field can't
  // silently downgrade a series into a movie (which renders a flat
  // torrent list instead of the episode picker). Regression fix for
  // "click series from homepage, see movie-style sources" — the prop
  // chain is correct but defence-in-depth covers similar-cards, genre
  // grid, and stale history entries where the field sometimes drops.
  const itemType = inferType(item)
  const isTv = itemType === 'tv'

  // Watched flags live in localStorage and change out-of-band (when
  // the player hits the end of an episode). Bump a tick on the
  // broadcast event so isWatched() reads below re-evaluate without
  // having to mirror the whole watched map into React state.
  const [watchedTick, setWatchedTick] = useState(0)
  useEffect(() => {
    const onTick = () => setWatchedTick((v) => v + 1)
    window.addEventListener('wardoflix:watched-updated', onTick)
    return () => window.removeEventListener('wardoflix:watched-updated', onTick)
  }, [])
  // Touch the tick so lint knows the dep tracks, and so future
  // refactors don't accidentally elide the re-render trigger.
  void watchedTick

  useEffect(() => {
    if (!item) return
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (showTrailer) setShowTrailer(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [item, onClose, showTrailer])

  // Extracted so "retry" button can re-fire the exact same request.
  const loadTorrents = useCallback(() => {
    if (!item) return
    setTorrents([])
    setBySeason({})
    setSeasons([])
    setSelectedSeason('1')
    setTorrentsLoading(true)

    // Use the inferred type (not raw item.type) so the server searches
    // the right catalog when the field is missing — otherwise a TV
    // show without an explicit `type` would trigger a movie torrent
    // lookup and mask the bug we just fixed at the UI layer.
    const params = new URLSearchParams({ title: item.title, type: itemType })
    if (item.date) params.set('year', item.date?.slice?.(0, 4) || '')
    if (item.id) params.set('tmdbId', String(item.id))
    fetch(`/api/torrents?${params}`)
      .then((r) => r.json().catch(() => ({ torrents: [] })))
      .then((data) => {
        setTorrents(data.torrents || [])
        setBySeason(data.bySeason || {})
        const s = data.seasons || []
        setSeasons(s)
        if (s.length && !s.includes(selectedSeason)) setSelectedSeason(String(s[0]))
      })
      .catch(() => setTorrents([]))
      .finally(() => setTorrentsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item])

  useEffect(() => {
    if (!item) return
    setDetails(null)
    setShowTrailer(false)
    loadTorrents()

    // Parallel: TMDB details (trailer + cast + similar). Best-effort —
    // if TMDB is down or the endpoint fails, the modal still works.
    if (item.id) {
      // Use the inferred type so details (trailer/cast/similar) hit
      // the right TMDB endpoint even when `item.type` is missing.
      fetch(`/api/details/${itemType}/${item.id}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d) setDetails(d) })
        .catch(() => {})
    }
  }, [item, loadTorrents])

  const [resolvingEpisode, setResolvingEpisode] = useState(null) // "s:e" string

  // Gather the fallback chain for the magnet the user clicked. We pass
  // this to the outer handleStream so that if the chosen torrent has no
  // seeders, the player can silently retry the next-best source instead
  // of stranding the user at "no stream found". For TV the alternatives
  // are all torrents matching that specific season/episode, sorted by
  // seeds desc; for movies it's every known torrent for the title.
  const buildAlternatives = useCallback((pickedMagnet, episodeMeta) => {
    if (!pickedMagnet) return []
    let pool = torrents || []
    if (isTv && episodeMeta?.season != null && episodeMeta?.episode != null) {
      const s = Number(episodeMeta.season)
      const e = Number(episodeMeta.episode)
      pool = pool.filter((t) => Number(t.season) === s && Number(t.episode) === e)
    }
    return pool
      .filter((t) => t?.magnet && t.magnet !== pickedMagnet)
      .sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
      .slice(0, 8) // cap the chain so we don't loop forever on truly dead titles
      .map((t) => ({
        magnet: t.magnet,
        quality: t.quality || '',
        seeds: t.seeds || 0,
        size: t.size || '',
      }))
  }, [torrents, isTv])

  const handleStream = (urlOrMagnet, episodeMeta) => {
    const t = (urlOrMagnet || input).trim()
    if (t) {
      // Pass the whole episode list so the player can autoplay the next one.
      // Only attach for TV titles (otherwise it's just dead weight).
      const playlist = isTv && Object.keys(bySeason).length
        ? { bySeason, seasons }
        : null
      // TMDB runtime (minutes) — used by the player as a duration fallback
      // until ffprobe resolves, so the scrubber shows the real length
      // instead of just the buffered portion.
      const runtime = isTv
        ? (details?.episode_run_time?.[0] || details?.runtime || null)
        : (details?.runtime || null)
      const alternatives = buildAlternatives(t, episodeMeta)
      onStream(t, { ...item, ...episodeMeta, playlist, runtime, alternatives })
      onClose()
    }
  }

  // On-demand search for a single episode — fired when the user clicks an
  // episode that didn't have a torrent in the initial sweep. Stremio-style:
  // list every episode always, find the stream when clicked. Retries once
  // automatically on empty result (Torrentio occasionally rate-limits).
  const handleUnavailableEpisode = async (ep) => {
    const key = `${ep.season}:${ep.episode}`
    if (resolvingEpisode) return
    setResolvingEpisode(key)
    try {
      const params = new URLSearchParams({
        title: item.title,
        season: String(ep.season),
        episode: String(ep.episode),
      })
      if (item.imdbId) params.set('imdbId', item.imdbId)
      if (item.id) params.set('tmdbId', String(item.id))

      const tryFetch = async () => {
        const r = await fetch(`/api/torrent-episode?${params}`)
        if (!r.ok) {
          console.error(`[episode] /api/torrent-episode returned ${r.status}`)
          return null
        }
        const j = await r.json().catch(() => null)
        return j
      }

      let j = await tryFetch()
      // Retry once if empty — Torrentio sometimes drops the first hit
      if (!j || !(j.torrents || []).length) {
        console.warn(`[episode] empty result, retrying S${ep.season}E${ep.episode}`)
        await new Promise((r) => setTimeout(r, 1200))
        j = await tryFetch()
      }

      const found = (j?.torrents || []).filter((t) => t?.magnet)
      // Sort the discovered list by seeds desc and pass the full tail as
      // a fallback chain. If the "best" one turns out to be dead, the
      // player can silently retry the next-best without a user round-trip.
      found.sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
      const best = found[0]
      if (best && best.magnet) {
        console.log(`[episode] S${ep.season}E${ep.episode} → ${best.quality} ${best.seeds}s ${best.size} (+ ${Math.max(0, found.length - 1)} fallbacks)`)
        // Overlay into bySeason so subsequent autoplay works
        const sKey = String(ep.season)
        const newBy = { ...bySeason }
        newBy[sKey] = (newBy[sKey] || []).map((x) =>
          x.episode === ep.episode ? { ...best, unavailable: false } : x
        )
        setBySeason(newBy)
        const alternatives = found.slice(1, 9).map((t) => ({
          magnet: t.magnet,
          quality: t.quality || '',
          seeds: t.seeds || 0,
          size: t.size || '',
        }))
        const playlist = isTv && Object.keys(bySeason).length ? { bySeason: newBy, seasons } : null
        const runtime = isTv
          ? (details?.episode_run_time?.[0] || details?.runtime || null)
          : (details?.runtime || null)
        onStream(best.magnet, { ...item, season: ep.season, episode: ep.episode, playlist, runtime, alternatives })
        onClose()
      } else {
        console.error(`[episode] No sources for S${ep.season}E${ep.episode}. Response:`, j)
        toast(
          `No source found for S${ep.season}E${ep.episode}. Torrentio may be rate-limiting — wait 30 s and try again.`,
          'warning',
          { title: 'No sources yet' }
        )
      }
    } catch (err) {
      console.error(`[episode] fetch failed:`, err)
      toast(`Could not reach the stream source server: ${err.message}`, 'error', { title: 'Source lookup failed' })
    } finally {
      setResolvingEpisode(null)
    }
  }

  const episodeList = isTv && seasons.length ? (bySeason[selectedSeason] || []) : []
  // Only fall through to "flat torrent list" for actual movies. A TV show
  // with no seasons yet is still a TV show — show a loading/retry state,
  // not the single-source movie layout. Fixes "Game of Thrones shows like
  // a movie" when the TMDB tv/ meta fetch was slow/rate-limited.
  const showFlatList = !isTv
  const showEpisodesLoading = isTv && !seasons.length

  if (!item) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {item.backdrop && (
          <div className="modal-hero">
            <img src={item.backdrop} alt="" />
            <div className="modal-hero-gradient" />
          </div>
        )}
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div className="modal-body">
          <div className="modal-header">
            <h2>{item.title}</h2>
            <div className="modal-meta-row">
              {item.rating > 0 && <span className="modal-rating">★ {item.rating.toFixed(1)}</span>}
              {item.date && <span className="modal-year">{String(item.date).split('-')[0]}</span>}
              {details?.runtime && <span className="modal-year">{details.runtime} min</span>}
              {details?.genres?.slice(0, 3).map((g) => (
                <span key={g} className="modal-genre">{g}</span>
              ))}
              {details?.videos?.[0] && (
                <button className="modal-trailer-btn" onClick={() => setShowTrailer(true)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  Watch Trailer
                </button>
              )}
            </div>
            {details?.tagline && <p className="modal-tagline">"{details.tagline}"</p>}
            {item.overview && <p className="modal-overview">{item.overview}</p>}
            {details?.crew?.length > 0 && (
              <p className="modal-credits">
                {details.crew.slice(0, 3).map((c) => (
                  <span key={c.id}><strong>{c.job}:</strong> {c.name}</span>
                ))}
              </p>
            )}
          </div>

          <div className="modal-streams">
            <h3>{isTv ? 'Episodes' : 'Available Sources'}</h3>
            {torrentsLoading ? (
              <div className="torrents-loading"><span className="spinner" /><span>Searching for sources...</span></div>
            ) : isTv && seasons.length > 0 ? (
              <>
                <div className="season-selector">
                  <select value={selectedSeason} onChange={(e) => setSelectedSeason(e.target.value)} className="season-select">
                    {seasons.filter((s) => s !== '0').map((s) => <option key={s} value={s}>Season {s}</option>)}
                    {seasons.includes('0') && <option value="0">Other</option>}
                  </select>
                </div>
                <div className="episodes-list">
                  {episodeList.length > 0 ? episodeList.map((t, i) => {
                    const epNum = t.episode || i + 1
                    const epKey = `${t.season || selectedSeason}:${epNum}`
                    const isResolving = resolvingEpisode === epKey
                    const hasMagnet = !!t.magnet
                    // Watched flag is scoped by the containing show +
                    // season/episode, so we build a minimal meta that
                    // matches resumeKey()'s expectations.
                    const watched = isWatched({ id: item?.id, title: item?.title, season: Number(t.season || selectedSeason), episode: epNum })
                    return (
                      <button
                        key={i}
                        className={`source-btn ${watched ? 'source-btn--watched' : ''}`}
                        data-watched={watched ? 'yes' : 'no'}
                        onClick={() => {
                          if (isResolving) return
                          if (hasMagnet) handleStream(t.magnet, { season: selectedSeason, episode: epNum })
                          else handleUnavailableEpisode({ season: Number(t.season || selectedSeason), episode: epNum })
                        }}
                      >
                        <span className="source-ep">E{String(epNum).padStart(2, '0')}</span>
                        {watched && (
                          <span className="source-watched" title="Watched" aria-label="Watched">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </span>
                        )}
                        {hasMagnet && <span className="source-quality">{t.quality}</span>}
                        {hasMagnet && (
                          <span
                            className={`source-seeds source-seeds--${seedHealth(t.seeds)}`}
                            title={seedHealthLabel(t.seeds)}
                          >
                            <span className="source-seeds-dot" />
                            {t.seeds || 0} seeds
                          </span>
                        )}
                        {hasMagnet && t.size && <span className="source-size">{t.size}</span>}
                        {!hasMagnet && !isResolving && <span className="source-quality source-quality--ghost">Click to play</span>}
                        {isResolving && <span className="source-quality source-quality--ghost">Finding source…</span>}
                      </button>
                    )
                  }) : <p className="no-sources">No episodes for this season.</p>}
                </div>
              </>
            ) : showFlatList && torrents.length > 0 ? (
              <div className="sources-list">
                {torrents.slice(0, 12).map((t, i) => (
                  <button key={i} className="source-btn" onClick={() => handleStream(t.magnet)}>
                    <span className="source-quality">{t.quality}</span>
                    <span
                      className={`source-seeds source-seeds--${seedHealth(t.seeds)}`}
                      title={seedHealthLabel(t.seeds)}
                    >
                      <span className="source-seeds-dot" />
                      {t.seeds || 0} seeds
                    </span>
                    {t.size && <span className="source-size">{t.size}</span>}
                  </button>
                ))}
              </div>
            ) : showEpisodesLoading ? (
              // TV show with empty season list — the TMDB tv/ meta fetch
              // failed or was rate-limited. Show a retry button rather than
              // silently falling through to the flat movie layout.
              <div className="episodes-empty">
                <p className="no-sources">Couldn't load the episode list for this show. Retry?</p>
                <button className="btn btn-accent" onClick={loadTorrents}>Retry</button>
              </div>
            ) : (
              <p className="no-sources">No sources found. Paste a magnet link below.</p>
            )}

            <div className="manual-stream">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStream()}
                placeholder="Paste magnet link or URL..."
              />
              <button className="btn btn-accent" onClick={() => handleStream()}>Stream</button>
            </div>
          </div>

          {details?.cast?.length > 0 && (
            <div className="modal-cast">
              <h3>Cast</h3>
              <div className="cast-rail">
                {details.cast.map((c) => (
                  <div key={c.id} className="cast-card">
                    <div className="cast-avatar">
                      {c.profile
                        ? <img src={c.profile} alt={c.name} loading="lazy" />
                        : <span className="cast-avatar-placeholder">{c.name?.[0] || '?'}</span>}
                    </div>
                    <div className="cast-name">{c.name}</div>
                    <div className="cast-char">{c.character}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {details?.similar?.length > 0 && (
            <div className="modal-similar">
              <h3>More Like This</h3>
              <div className="similar-rail">
                {details.similar.map((s) => (
                  <button
                    key={s.id}
                    className="similar-card"
                    onClick={() => {
                      if (onSelectItem) {
                        // Rebuild a full item object for the next modal
                        onSelectItem({
                          id: s.id,
                          title: s.title,
                          type: s.type,
                          date: s.year,
                          rating: s.rating,
                          poster: s.poster,
                          backdrop: s.poster, // no backdrop from similar
                        })
                      }
                    }}
                  >
                    {s.poster
                      ? <img src={s.poster} alt={s.title} loading="lazy" />
                      : <div className="similar-poster-placeholder">{s.title}</div>}
                    <div className="similar-meta">
                      <div className="similar-title">{s.title}</div>
                      <div className="similar-sub">
                        {s.year && <span>{s.year}</span>}
                        {s.rating > 0 && <span>★ {s.rating.toFixed(1)}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Trailer overlay — YouTube embed via our own /trailer wrapper.
            Under packaged Electron the renderer runs from file:// and YouTube
            refuses to embed (null origin). Routing the iframe through the
            local http server gives it a real http parent so the embed works. */}
        {showTrailer && details?.videos?.[0] && (
          <div className="trailer-overlay" onClick={() => setShowTrailer(false)}>
            <button className="trailer-close" onClick={() => setShowTrailer(false)} aria-label="Close trailer">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div className="trailer-frame" onClick={(e) => e.stopPropagation()}>
              <iframe
                src={`${window.__API_BASE__ || ''}/trailer?v=${encodeURIComponent(details.videos[0].key)}`}
                title={details.videos[0].name}
                frameBorder="0"
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Piracy quote database ─────────────────────────────────────
// Shown under the logo during the intro. Rotates randomly each intro so
// the app feels alive — half inside-joke for the pirate crowd, half wink
// at the "premium streaming" positioning. Kept one-liner short so the
// tagline slot doesn't overflow.
const PIRACY_QUOTES = [
  // ── Movie-reference twists ─────────────────────────────────────
  "I'm gonna make him an offer his CDN can't refuse.",
  "Frankly, my dear, I don't give a DRM.",
  "You had me at magnet:?xt=urn:btih:",
  "Here's looking at you, seeder.",
  "Say hello to my little tracker.",
  "They may take our wallets, but they'll never take our BANDWIDTH.",
  "One does not simply pay for nine streaming services.",
  "I see dead services. They don't know they're dead.",
  "Toto, I've a feeling we're not on Netflix anymore.",
  "E.T. phone home — over port 6881.",
  "These aren't the files you're looking for.",
  "Show me the magnet.",
  "Houston, we have a torrent.",
  "Nobody puts Wardo in a buffer.",
  "Why so serious? It's just a copy.",
  "I'll be back — with a better seed ratio.",
  "I feel the need — the need for seed.",
  "The first rule of Seed Club: you do not talk about ratio.",
  "Keep your friends close, and your seedboxes closer.",
  "Life finds a way. So do torrents.",
  "Do or do not — there is no DRM.",

  // ── Dry one-liners ─────────────────────────────────────────────
  "Premium streaming, at peasant prices.",
  "The subscription you cancel is the subscription that frees you.",
  "If it's on a server, it's on our server.",
  "We don't have regional restrictions. We have regional suggestions.",
  "Owning is for suckers. Having a copy is for winners.",
  "Your library, your rules, your bandwidth.",
  "Hollywood sends regards. The regards bounced.",
  "Buffering is a skill issue, and we have skill.",
  "Rated arrr, for all audiences.",

  // ── Deadpan cinephile ──────────────────────────────────────────
  "A film critic with zero expense reports.",
  "Every seeder is a small act of film preservation.",
  "The Criterion Collection wishes it had your hit-rate.",
  "Cinema belongs to whoever queues it up tonight.",
  "We ship the movies the algorithm forgot.",
  "Canon is decided by who still has a copy.",
  "The director's cut is the one that's seeded.",
  "Remember when renting a movie was an adventure? Still is.",

  // ── Tech-flavored ──────────────────────────────────────────────
  "ffmpeg is our priest. webtorrent is our congregation.",
  "The codec was inside you all along.",
  "We speak HTTP, BitTorrent, and zero legalese.",
  "Powered by caffeine, RAM, and moral flexibility.",
  "If the license won't scale, the peer swarm will.",
  "Lossless in principle. Seedless in fact.",

  // ── Wry aphorisms ──────────────────────────────────────────────
  "If buying isn't owning, downloading isn't stealing.",
  "Property is nine-tenths of the torrent.",
  "The best things in life are seeded.",
  "They can raise the price, but they can't raise our ratio.",
  "A gentleman's agreement with Hollywood: we watch, they cope.",
  "Somewhere between Robin Hood and your router.",
]

function pickPiracyQuote() {
  return PIRACY_QUOTES[Math.floor(Math.random() * PIRACY_QUOTES.length)]
}

// ── WardoFlix Intro (Netflix-style, with synthesized cinematic sting) ──
// The sound is generated with the Web Audio API (no asset file needed).
// Architecture: rising sub-whoosh → impact hit → minor-key chord bloom
// with detuned saw brass → shimmering cymbal tail. Stereo-widened for depth.
// Timing lines up with the visual beat: impact lands at ~1.1 s.
//
// Props:
//   onComplete: fired when intro finishes (or is clicked / Escape pressed)
//   quote:      optional pre-picked quote (stable across re-renders). If
//               omitted, a fresh random quote is picked on mount.
//   fullscreenTarget: optional element to auto-requestFullscreen on mount.
//               Used by the pre-stream intro so clicking Play jumps into
//               cinematic mode without a second click.
function WardoFlixIntro({ onComplete, quote, fullscreenTarget }) {
  const [phase, setPhase] = useState('playing') // playing | fading
  const audioRef = useRef(null)
  // Pick once and freeze for the lifetime of this intro instance so the
  // quote doesn't reshuffle if React re-renders mid-animation.
  const quoteRef = useRef(quote || pickPiracyQuote())

  // Stash props in refs so the setup effect can run exactly once on mount
  // without a stale-closure problem. Previously this effect had
  // [onComplete, fullscreenTarget] in its deps, so any parent re-render
  // (which happens constantly during stream loading because of SSE
  // progress ticks) would re-create the inline onComplete, invalidate
  // the deps, tear down the audio context, and re-fire the sting — plus
  // reset the completion timers so the intro never ended. That's the
  // "audio loops + intro hangs while streams load" bug.
  const onCompleteRef = useRef(onComplete)
  const fullscreenTargetRef = useRef(fullscreenTarget)
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => { fullscreenTargetRef.current = fullscreenTarget }, [fullscreenTarget])

  useEffect(() => {
    // Play the intro sound once on mount. Audio context creation has to
    // happen in a click/event handler in some browsers, but we're inside
    // a component that's mounted *because* the user clicked play, so the
    // page has user gesture.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        audioRef.current = ctx
        const now = ctx.currentTime

        // ── Master bus with a touch of dynamics control ──
        const master = ctx.createGain()
        master.gain.value = 0.32
        // Subtle compressor so the impact + chord stack don't clip even
        // when everything peaks together at t≈1.2s.
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = -14
        comp.ratio.value = 4
        comp.attack.value = 0.003
        comp.release.value = 0.25
        master.connect(comp).connect(ctx.destination)

        // Helpers — build a stereo pair by running a mono source through
        // two panners with a small delay so it widens without smearing.
        const panLeft = ctx.createStereoPanner(); panLeft.pan.value = -0.6
        const panRight = ctx.createStereoPanner(); panRight.pan.value = 0.6
        panLeft.connect(master); panRight.connect(master)

        // ── 1. Pre-swell whoosh (0 → 1.1s) ──
        // Bandpass-swept white noise rising in pitch. Builds tension like
        // the reel spin before an old-Hollywood title card.
        const noiseBufSize = ctx.sampleRate * 3
        const noiseBuf = ctx.createBuffer(2, noiseBufSize, ctx.sampleRate)
        for (let ch = 0; ch < 2; ch++) {
          const d = noiseBuf.getChannelData(ch)
          for (let i = 0; i < noiseBufSize; i++) d[i] = (Math.random() * 2 - 1) * 0.55
        }
        const whoosh = ctx.createBufferSource()
        whoosh.buffer = noiseBuf
        const whooshFilter = ctx.createBiquadFilter()
        whooshFilter.type = 'bandpass'
        whooshFilter.Q.value = 1.4
        whooshFilter.frequency.setValueAtTime(400, now)
        whooshFilter.frequency.exponentialRampToValueAtTime(7500, now + 1.05)
        whooshFilter.frequency.exponentialRampToValueAtTime(1200, now + 2.2)
        const whooshGain = ctx.createGain()
        whooshGain.gain.setValueAtTime(0.0001, now)
        whooshGain.gain.exponentialRampToValueAtTime(0.28, now + 1.0)
        whooshGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.3)
        whoosh.connect(whooshFilter).connect(whooshGain).connect(master)
        whoosh.start(now)
        whoosh.stop(now + 2.5)

        // ── 2. Impact transient (1.1s) ──
        // Sharp triangle pitch-drop that gives the hit its body and click.
        const impact = ctx.createOscillator()
        const impactGain = ctx.createGain()
        impact.type = 'triangle'
        impact.frequency.setValueAtTime(220, now + 1.05)
        impact.frequency.exponentialRampToValueAtTime(32, now + 1.25)
        impactGain.gain.setValueAtTime(0.0001, now + 1.05)
        impactGain.gain.exponentialRampToValueAtTime(0.85, now + 1.11)
        impactGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55)
        impact.connect(impactGain).connect(master)
        impact.start(now + 1.05)
        impact.stop(now + 1.6)

        // ── 3. Sub-bass tonic (1.1s → 2.8s) — 55 Hz A1 ──
        const sub = ctx.createOscillator()
        const subGain = ctx.createGain()
        sub.type = 'sine'
        sub.frequency.setValueAtTime(55, now + 1.1)
        subGain.gain.setValueAtTime(0.0001, now + 1.08)
        subGain.gain.exponentialRampToValueAtTime(1.0, now + 1.18)
        subGain.gain.exponentialRampToValueAtTime(0.35, now + 1.9)
        subGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.8)
        sub.connect(subGain).connect(master)
        sub.start(now + 1.08)
        sub.stop(now + 2.9)

        // ── 4. Minor-key brass chord bloom (1.2s → 2.6s) ──
        // A minor triad (A2=110, C3=130.8, E3=164.8) with detuned saws
        // stacked for "analog brass" richness. Each note gets its own
        // subtle stereo position to create width.
        const chordNotes = [
          { freq: 110.0,  detune: -6, pan: -0.35, start: 1.20, gain: 0.32 },
          { freq: 110.0,  detune: +6, pan:  0.35, start: 1.20, gain: 0.32 },
          { freq: 130.81, detune: -4, pan: -0.15, start: 1.28, gain: 0.26 },
          { freq: 130.81, detune: +4, pan:  0.15, start: 1.28, gain: 0.26 },
          { freq: 164.81, detune: 0,  pan:  0.00, start: 1.36, gain: 0.22 },
        ]
        // Single warm lowpass to tame the saw fizz into brass body.
        const brassFilter = ctx.createBiquadFilter()
        brassFilter.type = 'lowpass'
        brassFilter.frequency.setValueAtTime(800, now + 1.20)
        brassFilter.frequency.exponentialRampToValueAtTime(2400, now + 1.50)
        brassFilter.frequency.exponentialRampToValueAtTime(900, now + 2.4)
        brassFilter.Q.value = 0.9
        brassFilter.connect(master)
        for (const n of chordNotes) {
          const osc = ctx.createOscillator()
          osc.type = 'sawtooth'
          osc.frequency.setValueAtTime(n.freq, now + n.start)
          osc.detune.value = n.detune
          const g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, now + n.start)
          g.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.18)
          g.gain.exponentialRampToValueAtTime(n.gain * 0.5, now + n.start + 0.7)
          g.gain.exponentialRampToValueAtTime(0.0001, now + 2.5)
          const p = ctx.createStereoPanner()
          p.pan.value = n.pan
          osc.connect(g).connect(p).connect(brassFilter)
          osc.start(now + n.start)
          osc.stop(now + 2.6)
        }

        // ── 5. Bright harmonic bell (1.22s) ──
        // Clean sine high above the chord — lends a rose-gold shimmer
        // that feels expensive.
        const bell = ctx.createOscillator()
        const bellGain = ctx.createGain()
        bell.type = 'sine'
        bell.frequency.setValueAtTime(659.25, now + 1.22) // E5
        bellGain.gain.setValueAtTime(0.0001, now + 1.22)
        bellGain.gain.exponentialRampToValueAtTime(0.18, now + 1.34)
        bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.7)
        bell.connect(bellGain).connect(master)
        bell.start(now + 1.22)
        bell.stop(now + 2.75)

        // ── 6. Cymbal tail (1.15s → 3.0s) ──
        // Stereo white-noise through a high bandpass, long exponential
        // decay for that "sparkle" shimmer after the hit.
        const cymBuf = ctx.createBuffer(2, noiseBufSize, ctx.sampleRate)
        for (let ch = 0; ch < 2; ch++) {
          const d = cymBuf.getChannelData(ch)
          for (let i = 0; i < noiseBufSize; i++) d[i] = (Math.random() * 2 - 1) * 0.5
        }
        const cym = ctx.createBufferSource()
        cym.buffer = cymBuf
        const cymFilter = ctx.createBiquadFilter()
        cymFilter.type = 'bandpass'
        cymFilter.frequency.value = 6800
        cymFilter.Q.value = 1.6
        const cymGain = ctx.createGain()
        cymGain.gain.setValueAtTime(0.0001, now + 1.10)
        cymGain.gain.exponentialRampToValueAtTime(0.22, now + 1.22)
        cymGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.0)
        cym.connect(cymFilter).connect(cymGain).connect(master)
        cym.start(now + 1.10)
        cym.stop(now + 3.05)

        // Fade master out at the end so we don't click on context close
        master.gain.setValueAtTime(master.gain.value, now + 2.6)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 3.2)

        // Suppress the unused-panner lint — we keep the stereo pair wired
        // so any future source can pick left/right without rebuilding.
        void panLeft; void panRight
      }
    } catch {}

    // Total intro length = fadeTimer + 800ms fade out. Bumped to accommodate
    // the longer cinematic sting (impact now lands at 1.1s instead of 0.35s).
    const fadeTimer = setTimeout(() => setPhase('fading'), 3700)
    const doneTimer = setTimeout(() => onCompleteRef.current?.(), 4500)

    // The intro overlay covers the video with z-index: 50, which hid the
    // PlayerControls' fullscreen button. Rather than poke pointer-events
    // holes, we: (a) auto-request fullscreen on the provided target so the
    // common case "user clicked Play, wanted cinema" just works, and
    // (b) listen for F / F11 / Escape / Enter / Space during the intro so
    // the user can take control without waiting for it to finish.
    const fsTarget = fullscreenTargetRef.current
    if (fsTarget && typeof document !== 'undefined' && !document.fullscreenElement) {
      // requestFullscreen needs a user gesture. It *is* one (the click/keypress
      // that set showIntro=true), but the browser sometimes rejects it when
      // fired from inside a useEffect. Swallow rejection silently — the user
      // can still press F in the handler below.
      try { fsTarget.requestFullscreen?.().catch(() => {}) } catch {}
    }

    const onKey = (ev) => {
      if (ev.key === 'f' || ev.key === 'F' || ev.key === 'F11') {
        ev.preventDefault()
        const t = fullscreenTargetRef.current
        if (t && !document.fullscreenElement) {
          try { t.requestFullscreen?.() } catch {}
        } else if (document.fullscreenElement) {
          try { document.exitFullscreen() } catch {}
        }
        // Skip the rest of the intro so the user isn't staring at the logo
        // after going fullscreen.
        onCompleteRef.current?.()
      } else if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        onCompleteRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(doneTimer)
      window.removeEventListener('keydown', onKey)
      try { audioRef.current?.close?.() } catch {}
    }
    // Empty deps — setup happens exactly once per mount. Callbacks read
    // through refs above so they stay fresh without re-triggering setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`wf-intro ${phase === 'fading' ? 'wf-intro--fade' : ''}`} onClick={() => onComplete()}>
      {/* Soft radial vignette + deep-space gradient backdrop */}
      <div className="wf-intro-vignette" aria-hidden="true" />

      <div className="wf-intro-content">
        {/* Expanding concentric rings — clean, not stripey */}
        <div className="wf-intro-rings" aria-hidden="true">
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--1" />
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--2" />
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--3" />
        </div>

        {/* Glowing orb that swells at the "tudum" beat */}
        <div className="wf-intro-orb" aria-hidden="true" />

        {/* Particle sparks drifting outward from the center */}
        <div className="wf-intro-sparks" aria-hidden="true">
          {[...Array(16)].map((_, i) => (
            <div
              key={i}
              className="wf-intro-spark"
              style={{
                '--angle': `${(360 / 16) * i}deg`,
                '--delay': `${0.2 + (i % 4) * 0.08}s`,
                '--distance': `${38 + (i % 5) * 6}vmin`,
              }}
            />
          ))}
        </div>

        <div className="wf-intro-logo">
          <span className="wf-intro-w">W</span>
          <div className="wf-intro-ring" aria-hidden="true" />
        </div>
        <div className="wf-intro-text">
          {'WARDOFLIX'.split('').map((ch, i) => (
            <span key={i} className="wf-intro-char" style={{ animationDelay: `${1.05 + i * 0.05}s` }}>{ch}</span>
          ))}
        </div>
        <div className="wf-intro-tagline wf-intro-tagline--quote">{quoteRef.current}</div>
      </div>

      {/* Bright flash at the "tudum" beat */}
      <div className="wf-intro-flash" />
    </div>
  )
}

// ── Time formatter ─────────────────────────────────────────────
function formatTime(sec) {
  if (!sec || !isFinite(sec)) return '0:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// ── Custom Player Controls (Stremio-style) ──────────────────────
function PlayerControls({
  playerRef, playerReady, containerRef, metadata, availableSubs, subOffset, setSubOffset,
  streamProgress, castState, onCast, onStopCast, onBack,
  audioTracks, activeAudioIdx, onAudioChange, knownDuration,
  dlnaDevices, dlnaActive, onDlnaCast, onDlnaStop, onDlnaRefresh,
  onSeek,
}) {
  // Route every seek through the parent's `onSeek` handler instead of
  // calling player.currentTime(target) directly. The parent knows
  // whether the current source is a /remux stream (Accept-Ranges: none)
  // and will either run a native seek (in-buffer, fast) or a URL
  // reload with ?t=<target> (out-of-buffer — respawns ffmpeg at the
  // new offset). Calling currentTime() directly on an out-of-buffer
  // /remux target makes Chromium issue a new GET from byte 0 to read
  // forward until it hits the target, which the user perceives as
  // "the movie restarted from the start." That's the bug this
  // indirection fixes.
  const doSeek = (t) => { if (typeof onSeek === 'function') onSeek(t); else { try { playerRef.current?.currentTime(t) } catch {} } }
  const [castPanelOpen, setCastPanelOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [visible, setVisible] = useState(true)
  const [activeSub, setActiveSub] = useState(null)
  const [subsMenuOpen, setSubsMenuOpen] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const hideTimer = useRef(null)
  const seekBarRef = useRef(null)
  const volumeBarRef = useRef(null)
  const seekingRef = useRef(false)
  const menusRef = useRef({ subs: false, timing: false, audio: false })
  menusRef.current = { subs: subsMenuOpen, timing: timingOpen, audio: audioMenuOpen }

  const showControls = useCallback(() => {
    setVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!menusRef.current.subs && !menusRef.current.timing && !menusRef.current.audio) setVisible(false)
    }, 3500)
  }, [])

  useEffect(() => {
    showControls()
    return () => clearTimeout(hideTimer.current)
  }, [showControls])

  // Keep menus from auto-hiding controls
  useEffect(() => {
    if (subsMenuOpen || timingOpen || audioMenuOpen) {
      clearTimeout(hideTimer.current)
      setVisible(true)
    }
  }, [subsMenuOpen, timingOpen, audioMenuOpen])

  // Helper: get a safe seekable duration (handles Infinity from remuxed streams)
  // Priority: knownDuration (ffprobe, seconds) > TMDB runtime > player.duration()
  // > buffered.end(). TMDB runtime arrives with the metadata object — using it
  // as a fallback means the scrubber shows the real length even before the
  // ffprobe round-trip completes, instead of tracking the buffered edge.
  const metaRuntimeSec = useMemo(() => {
    const r = metadata?.runtime
    if (!r || !isFinite(r) || r <= 0) return 0
    // TMDB returns runtime in minutes for both movies and TV episodes.
    return r * 60
  }, [metadata])
  const getSafeDuration = useCallback(() => {
    if (knownDuration && knownDuration > 0) return knownDuration
    const p = playerRef.current
    if (p && !p.isDisposed()) {
      const d = p.duration()
      if (d && isFinite(d) && d > 0) return d
    }
    if (metaRuntimeSec > 0) return metaRuntimeSec
    if (p && !p.isDisposed()) {
      const buf = p.buffered()
      return buf?.length ? buf.end(buf.length - 1) : 0
    }
    return 0
  }, [playerRef, knownDuration, metaRuntimeSec])

  // Sync state from video.js player
  useEffect(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => {
      if (seekingRef.current) return
      setCurrentTime(p.currentTime() || 0)
      const d = getSafeDuration()
      setDuration(d)
      const buf = p.buffered()
      if (buf?.length) setBuffered(buf.end(buf.length - 1))
    }
    const onVolChange = () => {
      setVolume(p.volume())
      setMuted(p.muted())
    }
    const onWait = () => setWaiting(true)
    const onCanPlay = () => setWaiting(false)
    const onDuration = () => setDuration(getSafeDuration())
    p.on('play', onPlay)
    p.on('pause', onPause)
    p.on('timeupdate', onTime)
    p.on('volumechange', onVolChange)
    p.on('loadedmetadata', onDuration)
    p.on('durationchange', onDuration)
    p.on('waiting', onWait)
    p.on('canplay', onCanPlay)
    p.on('playing', onCanPlay)
    // Init
    setPlaying(!p.paused())
    setVolume(p.volume())
    setMuted(p.muted())
    setDuration(getSafeDuration())
    return () => {
      if (!p.isDisposed()) {
        p.off('play', onPlay); p.off('pause', onPause)
        p.off('timeupdate', onTime); p.off('volumechange', onVolChange)
        p.off('loadedmetadata', onDuration); p.off('durationchange', onDuration)
        p.off('waiting', onWait); p.off('canplay', onCanPlay); p.off('playing', onCanPlay)
      }
    }
  }, [playerRef, playerReady, getSafeDuration])

  // Track active subtitle
  useEffect(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const checkSubs = () => {
      const tracks = p.textTracks()
      for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].mode === 'showing') { setActiveSub(tracks[i].language); return }
      }
      setActiveSub(null)
    }
    const tracks = p.textTracks()
    tracks.addEventListener('change', checkSubs)
    return () => tracks.removeEventListener('change', checkSubs)
  }, [playerRef, playerReady, availableSubs])

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    p.paused() ? p.play() : p.pause()
  }, [playerRef])

  const seekTo = useCallback((e) => {
    const p = playerRef.current
    const bar = seekBarRef.current
    if (!p || p.isDisposed() || !bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const d = getSafeDuration()
    if (d > 0) doSeek(pct * d)
    showControls()
  }, [playerRef, getSafeDuration, showControls])

  const startSeek = useCallback((e) => {
    seekingRef.current = true
    const bar = seekBarRef.current
    if (!bar) return
    const p = playerRef.current
    const d = getSafeDuration()

    const onMove = (ev) => {
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      setCurrentTime(pct * d)
    }
    const onUp = (ev) => {
      seekingRef.current = false
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      if (p && !p.isDisposed() && d > 0) doSeek(pct * d)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    // Immediate feedback
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setCurrentTime(pct * d)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [playerRef, getSafeDuration])

  const changeVolume = useCallback((e) => {
    const p = playerRef.current
    const bar = volumeBarRef.current
    if (!p || p.isDisposed() || !bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    p.volume(pct)
    p.muted(pct === 0)
    showControls()
  }, [playerRef, showControls])

  const toggleMute = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    p.muted(!p.muted())
  }, [playerRef])

  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef?.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen().catch(() => {})
    }
    showControls()
  }, [containerRef, showControls])

  const skip = useCallback((sec) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const cur = p.currentTime() || 0
    const d = getSafeDuration()
    const target = Math.max(0, d > 0 ? Math.min(d, cur + sec) : cur + sec)
    doSeek(target)
    showControls()
  }, [playerRef, getSafeDuration, showControls])

  const selectSub = (lang) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const tracks = p.textTracks()
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = (lang && tracks[i].language === lang) ? 'showing' : 'disabled'
    }
    setActiveSub(lang)
    setSubsMenuOpen(false)
  }

  // Keyboard shortcuts — Stremio/YouTube-style
  useEffect(() => {
    const handler = (e) => {
      // Full in-field guard. Previously this only looked at INPUT/TEXTAREA
      // which missed: contentEditable fields, native SELECT dropdowns, and
      // form controls inside the detail-modal dialog. Triggering play/pause
      // while the user is typing in the Stream tab's URL box or picking a
      // genre dropdown was confusing; this matches the guard the other
      // (top-level) shortcut handler already uses.
      const t = e.target
      if (t) {
        const tag = t.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (t.isContentEditable) return
      }
      const p = playerRef.current
      if (!p || p.isDisposed()) return
      // Number keys 0-9: jump to N*10% of the video (YouTube/Stremio parity)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        const n = Number(e.key)
        const d = getSafeDuration()
        if (d > 0) {
          e.preventDefault()
          doSeek(d * (n / 10))
          showControls()
        }
        return
      }
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); togglePlay(); showControls(); break
        case 'ArrowLeft': e.preventDefault(); skip(-10); break
        case 'ArrowRight': e.preventDefault(); skip(10); break
        case 'j': e.preventDefault(); skip(-10); break    // YouTube-style
        case 'l': e.preventDefault(); skip(10); break     // YouTube-style
        case 'ArrowUp': e.preventDefault(); p.volume(Math.min(1, p.volume() + 0.1)); showControls(); break
        case 'ArrowDown': e.preventDefault(); p.volume(Math.max(0, p.volume() - 0.1)); showControls(); break
        case 'f': toggleFullscreen(); break
        case 'm': toggleMute(); showControls(); break
        case 'c': {
          // Toggle subtitles (cycle: first track ↔ off, Stremio-style quick toggle)
          const tt = p.textTracks?.()
          if (tt && tt.length) {
            let anyShowing = false
            for (let i = 0; i < tt.length; i++) if (tt[i].mode === 'showing') { anyShowing = true; break }
            for (let i = 0; i < tt.length; i++) {
              if (i === 0 && !anyShowing) tt[i].mode = 'showing'
              else tt[i].mode = 'disabled'
            }
            showControls()
          }
          break
        }
        case ',':
        case '<': {
          e.preventDefault()
          const rate = Math.max(0.25, (p.playbackRate() || 1) - 0.25)
          p.playbackRate(rate)
          showControls()
          break
        }
        case '.':
        case '>': {
          e.preventDefault()
          const rate = Math.min(3, (p.playbackRate() || 1) + 0.25)
          p.playbackRate(rate)
          showControls()
          break
        }
        case 'Escape': {
          // If a menu is open, close it. If fullscreen is on, let the
          // browser handle it (exit fullscreen). Otherwise, back out of
          // the player entirely — this is the keyboard equivalent of
          // clicking the back arrow.
          if (menusRef.current.subs || menusRef.current.timing || menusRef.current.audio) {
            setSubsMenuOpen(false); setTimingOpen(false); setAudioMenuOpen(false)
          } else if (document.fullscreenElement) {
            // Browser handles Escape automatically; nothing to do.
          } else {
            e.preventDefault()
            onBack?.()
          }
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePlay, skip, toggleFullscreen, toggleMute, showControls, getSafeDuration, onBack])

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const bufferPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0

  const title = metadata?.title || ''
  const episodeLabel = metadata?.season && metadata?.episode
    ? `S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}`
    : ''

  return (
    <div
      className={`custom-controls ${visible ? 'visible' : ''}`}
      onMouseMove={showControls}
      onClick={(e) => { if (e.target === e.currentTarget) togglePlay() }}
    >
      {/* Top gradient + title */}
      <div className="cc-top" onClick={(e) => e.stopPropagation()}>
        <button className="cc-back" onClick={onBack} title="Back">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div className="cc-title">
          <span className="cc-title-main">{title}</span>
          {episodeLabel && <span className="cc-title-ep">{episodeLabel}</span>}
        </div>
        {streamProgress && streamProgress.peers >= 0 && (
          <div className="cc-stats">
            <span>{streamProgress.peers} peers</span>
            <span>{formatSpeed(streamProgress.speed)}</span>
            {streamProgress.progress > 0 && streamProgress.progress < 100 && (
              <span>{streamProgress.progress}%</span>
            )}
          </div>
        )}
      </div>

      {/* Center play/loading indicator */}
      <div className="cc-center" onClick={togglePlay} onDoubleClick={(e) => { e.stopPropagation(); toggleFullscreen() }}>
        {waiting ? (
          <div className="cc-spinner" />
        ) : !playing ? (
          <button className="cc-play-big">
            <svg viewBox="0 0 24 24" width="56" height="56" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
        ) : null}
      </div>

      {/* Bottom controls */}
      <div className="cc-bottom" onClick={(e) => e.stopPropagation()}>
        {/* Seek bar */}
        <div
          className="cc-seek"
          ref={seekBarRef}
          onMouseDown={startSeek}
        >
          <div className="cc-seek-buffer" style={{ width: `${bufferPct}%` }} />
          <div className="cc-seek-progress" style={{ width: `${progress}%` }} />
          <div className="cc-seek-thumb" style={{ left: `${progress}%` }} />
        </div>

        <div className="cc-bar">
          <div className="cc-bar-left">
            <button className="cc-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
              )}
            </button>
            <button className="cc-btn" onClick={() => skip(-10)} title="Rewind 10s">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12.5 8c-3.6 0-6.5 2.9-6.5 6.5s2.9 6.5 6.5 6.5 6.5-2.9 6.5-6.5H17c0 2.5-2 4.5-4.5 4.5S8 17 8 14.5 10 10 12.5 10V8z"/><polygon points="12.5,5 9,8.5 12.5,12"/><text x="11" y="16.5" fontSize="6" fontWeight="700" textAnchor="middle" fill="white">10</text></svg>
            </button>
            <button className="cc-btn" onClick={() => skip(10)} title="Forward 10s">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M11.5 8c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5S5 18.1 5 14.5H7c0 2.5 2 4.5 4.5 4.5S16 17 16 14.5 14 10 11.5 10V8z"/><polygon points="11.5,5 15,8.5 11.5,12"/><text x="13" y="16.5" fontSize="6" fontWeight="700" textAnchor="middle" fill="white">10</text></svg>
            </button>
            <div className="cc-volume-group">
              <button className="cc-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2"/><line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54 8.46a5 5 0 010 7.07" fill="none" stroke="white" strokeWidth="1.5"/>{volume > 0.5 && <path d="M19.07 4.93a10 10 0 010 14.14" fill="none" stroke="white" strokeWidth="1.5"/>}</svg>
                )}
              </button>
              <div className="cc-volume-slider" ref={volumeBarRef} onClick={changeVolume}>
                <div className="cc-volume-level" style={{ width: `${muted ? 0 : volume * 100}%` }} />
              </div>
            </div>
            <span className="cc-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="cc-bar-right">
            {/* Subtitles button */}
            {availableSubs.length > 0 && (
              <div className="cc-sub-wrap">
                <button
                  className={`cc-btn ${activeSub ? 'cc-btn-active' : ''}`}
                  onClick={() => { setSubsMenuOpen((v) => !v); setTimingOpen(false); setAudioMenuOpen(false) }}
                  title="Subtitles"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="1.5">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <line x1="6" y1="10" x2="10" y2="10"/>
                    <line x1="12" y1="10" x2="18" y2="10"/>
                    <line x1="6" y1="14" x2="14" y2="14"/>
                  </svg>
                </button>
                {subsMenuOpen && (
                  <div className="cc-subs-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="cc-subs-header">
                      <span>Subtitles</span>
                      <button className="cc-subs-timing-btn" onClick={() => { setTimingOpen(true); setSubsMenuOpen(false) }}>
                        Timing {subOffset !== 0 ? `(${subOffset > 0 ? '+' : ''}${subOffset.toFixed(1)}s)` : ''}
                      </button>
                    </div>
                    <button
                      className={`cc-sub-option ${!activeSub ? 'active' : ''}`}
                      onClick={() => selectSub(null)}
                    >Off</button>
                    {availableSubs.map((s) => (
                      <button
                        key={s.lang}
                        className={`cc-sub-option ${activeSub === (s.lang || 'en') ? 'active' : ''}`}
                        onClick={() => selectSub(s.lang || 'en')}
                      >{s.langName || s.lang}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Timing panel */}
            {timingOpen && (
              <div className="cc-timing-panel" onClick={(e) => e.stopPropagation()}>
                <span className="cc-timing-label">Subtitle delay</span>
                <button className="cc-timing-btn" onClick={() => setSubOffset((v) => Math.round((v - 0.5) * 10) / 10)}>−0.5s</button>
                <span className="cc-timing-value">{subOffset > 0 ? '+' : ''}{subOffset.toFixed(1)}s</span>
                <button className="cc-timing-btn" onClick={() => setSubOffset((v) => Math.round((v + 0.5) * 10) / 10)}>+0.5s</button>
                {subOffset !== 0 && <button className="cc-timing-reset" onClick={() => setSubOffset(0)}>Reset</button>}
                <button className="cc-timing-done" onClick={() => setTimingOpen(false)}>Done</button>
              </div>
            )}

            {/* Audio tracks */}
            {audioTracks.length > 0 && (
              <div className="cc-audio-wrap">
                <button
                  className={`cc-btn ${activeAudioIdx != null ? 'cc-btn-active' : ''}`}
                  onClick={() => { setAudioMenuOpen((v) => !v); setSubsMenuOpen(false); setTimingOpen(false) }}
                  title="Audio track"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                </button>
                {audioMenuOpen && (
                  <div className="cc-audio-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="cc-subs-header"><span>Audio</span></div>
                    {audioTracks.map((t) => (
                      <button
                        key={t.index}
                        className={`cc-sub-option ${(activeAudioIdx ?? audioTracks[0]?.index) === t.index ? 'active' : ''}`}
                        onClick={() => { if (t.index !== activeAudioIdx) onAudioChange(t.index); setAudioMenuOpen(false) }}
                      >
                        {formatAudioTrackLabel(t)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Cast (Chromecast + DLNA picker) */}
            <div className="cc-cast-wrap">
              <button
                className={`cc-btn ${(castState === 'connected' || dlnaActive) ? 'cc-btn-active' : ''}`}
                onClick={() => {
                  if (dlnaActive) { onDlnaStop?.(); return }
                  if (castState === 'connected') { onStopCast?.(); return }
                  setCastPanelOpen((o) => !o)
                  onDlnaRefresh?.()
                }}
                title={dlnaActive ? 'Stop casting (DLNA)' : castState === 'connected' ? 'Stop casting' : 'Cast to TV'}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/>
                </svg>
              </button>
              {castPanelOpen && !dlnaActive && castState !== 'connected' && (
                <div className="cc-cast-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="cc-cast-panel-title">Cast to device</div>
                  {castState !== 'unavailable' && (
                    <button
                      className="cc-cast-device"
                      onClick={() => { setCastPanelOpen(false); onCast?.() }}
                    >
                      <span className="cc-cast-device-dot" />
                      <span className="cc-cast-device-name">Chromecast…</span>
                      <span className="cc-cast-device-type">Chromecast</span>
                    </button>
                  )}
                  {(dlnaDevices || []).length === 0 && castState === 'unavailable' && (
                    <div className="cc-cast-empty">No devices found on your network.</div>
                  )}
                  {(dlnaDevices || []).map((d) => (
                    <button
                      key={d.id}
                      className="cc-cast-device"
                      onClick={() => { setCastPanelOpen(false); onDlnaCast?.(d) }}
                    >
                      <span className="cc-cast-device-dot" />
                      <span className="cc-cast-device-name">{d.name}</span>
                      <span className="cc-cast-device-type">DLNA</span>
                    </button>
                  ))}
                  <button className="cc-cast-refresh" onClick={onDlnaRefresh}>Refresh</button>
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button className="cc-btn" onClick={toggleFullscreen} title="Fullscreen">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2">
                <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                <polyline points="21 3 14 10"/><polyline points="3 21 10 14"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Given playingMetadata that includes a `playlist` from the detail modal,
// find the next episode after (currentSeason, currentEpisode). Skips forward
// through seasons if the current season has no more episodes.
function findNextEpisode(meta) {
  if (!meta?.playlist?.bySeason) return null
  const { bySeason, seasons } = meta.playlist
  const curS = String(meta.season ?? '')
  const curE = Number(meta.episode ?? 0)
  if (!curS) return null

  // Return magnet when we have it, otherwise null — handleStream() will
  // resolve it via the on-demand Torrentio endpoint.
  // Season is emitted as a Number (not String) so downstream consumers
  // — history keys, resume storage, next-episode lookups — can't stringly-
  // compare "1" against 1 and end up with two separate cache entries for
  // the same season.
  const inSeason = (bySeason[curS] || [])
    .filter((t) => typeof t.episode === 'number' && t.episode > curE)
    .sort((a, b) => a.episode - b.episode)
  if (inSeason.length) return { magnet: inSeason[0].magnet || null, season: Number(curS), episode: inSeason[0].episode }

  const seasonList = (seasons || []).filter((s) => s !== '0').map(String).sort((a, b) => Number(a) - Number(b))
  const idx = seasonList.indexOf(curS)
  if (idx === -1 || idx === seasonList.length - 1) return null
  for (let i = idx + 1; i < seasonList.length; i++) {
    const eps = (bySeason[seasonList[i]] || []).filter((t) => typeof t.episode === 'number').sort((a, b) => a.episode - b.episode)
    if (eps.length) return { magnet: eps[0].magnet || null, season: Number(seasonList[i]), episode: eps[0].episode }
  }
  return null
}

// ── Toast system ────────────────────────────────────────────────
// Tiny event-bus-backed toast host. `toast(msg, variant)` dispatches a
// CustomEvent on window; <ToastHost /> listens and renders a stack in
// the bottom-right. Much nicer than alert() — non-blocking, styled to
// the app, and multiple can stack so a second one doesn't steamroll
// the first. Intentionally decoupled from React context so any code
// in the tree can fire a toast without prop-drilling.
const TOAST_EVENT = 'wardoflix:toast'
let toastIdSeq = 1
function toast(message, variant = 'info', opts = {}) {
  const detail = {
    id: toastIdSeq++,
    message: String(message ?? ''),
    variant, // 'info' | 'success' | 'warning' | 'error'
    // Errors persist longer — users need time to read them.
    timeoutMs: opts.timeoutMs ?? (variant === 'error' ? 8000 : 4000),
    title: opts.title || null,
  }
  try { window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail })) } catch {}
  return detail.id
}

function ToastHost() {
  const [items, setItems] = useState([])
  useEffect(() => {
    const onAdd = (e) => {
      const d = e.detail
      if (!d) return
      setItems((cur) => [...cur, d])
      if (d.timeoutMs > 0) {
        setTimeout(() => {
          setItems((cur) => cur.filter((x) => x.id !== d.id))
        }, d.timeoutMs)
      }
    }
    window.addEventListener(TOAST_EVENT, onAdd)
    return () => window.removeEventListener(TOAST_EVENT, onAdd)
  }, [])
  const dismiss = (id) => setItems((cur) => cur.filter((x) => x.id !== id))
  if (!items.length) return null
  return (
    <div className="wf-toast-host" role="region" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="wf-toast" data-variant={t.variant} role="alert">
          <div className="wf-toast-body">
            {t.title && <div className="wf-toast-title">{t.title}</div>}
            <div className="wf-toast-msg">{t.message}</div>
          </div>
          <button className="wf-toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  )
}

// ── ShortcutsOverlay ────────────────────────────────────────────
// Cheat-sheet modal, opened with `?`. Documents what's otherwise a
// completely undiscoverable keybind surface — most users would never
// know about F11 / Ctrl+Shift+D / spacebar-to-pause otherwise.
function ShortcutsOverlay({ onClose }) {
  const groups = [
    {
      title: 'Playback',
      items: [
        ['Space', 'Play / pause'],
        ['← / →', 'Seek ±10 s'],
        ['↑ / ↓', 'Volume ±5%'],
        ['M', 'Mute / unmute'],
        ['F', 'Fullscreen'],
      ],
    },
    {
      title: 'App',
      items: [
        ['F11', 'Native fullscreen'],
        ['F12', 'Toggle DevTools'],
        ['Ctrl + Shift + D', 'Debug overlay'],
        ['?', 'This help panel'],
        ['Esc', 'Close overlays / exit fullscreen'],
      ],
    },
  ]
  return (
    <div className="wf-shortcuts-backdrop" onClick={onClose}>
      <div className="wf-shortcuts" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="wf-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="wf-shortcuts-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="wf-shortcuts-body">
          {groups.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([keys, desc]) => (
                  <div key={keys} className="wf-shortcut-row">
                    <dt><kbd>{keys}</kbd></dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── DebugOverlay ────────────────────────────────────────────────
// Ctrl+Shift+D toggles this fixed-position diagnostic panel. It's
// non-interactive in the sense that it doesn't drive any app state —
// it only reads the props it's handed. Kept outside App() so a render
// of the overlay doesn't ripple through unrelated memoized children.
//
// Fields chosen specifically so a user screenshot tells us everything
// we need to triage a decode error: what URL is the player on, what
// escalation stage are we at, what codec did ffmpeg probe, and what
// was the last error event.
function DebugOverlay({
  source,
  sourceType,
  streamInfoHash,
  streamDuration,
  streamBaseUrl,
  probedVcodec,
  remuxStage,
  playbackError,
  streamWarning,
  appVersion,
  serverHealthy,
  audioTracks,
  activeAudioIdx,
  onClose,
}) {
  // Install-ID state — fetched lazily from the main process on overlay
  // mount. Exposed here so users can copy it to request allowlisting
  // (see electron/access-control.js).
  const [accessInfo, setAccessInfo] = useState(null)
  useEffect(() => {
    let cancelled = false
    try {
      window.wardoflixAccess?.getInfo?.().then((info) => {
        if (!cancelled) setAccessInfo(info)
      }).catch(() => {})
    } catch {}
    return () => { cancelled = true }
  }, [])
  const copyInstallId = async () => {
    if (!accessInfo?.installId) return
    try { await navigator.clipboard?.writeText(accessInfo.installId) } catch {}
  }
  // Which endpoint is the player on right now? Derived from the URL
  // instead of kept as a separate state value so it can't drift.
  const endpoint = (() => {
    if (!source) return '—'
    if (source.includes('/stream/')) return 'stream'
    if (source.includes('/remux/')) {
      const fresh = /[?&]fresh=/.test(source)
      const transcode = /[?&]transcode=1/.test(source)
      const audio = /[?&]audio=\d+/.test(source)
      const tags = [transcode && 'transcode', fresh && 'fresh', audio && 'audio'].filter(Boolean).join('+')
      return tags ? `remux (${tags})` : 'remux'
    }
    if (source.startsWith('http')) return 'external'
    return 'unknown'
  })()
  const codecBadge = probedVcodec
    ? (BROWSER_SAFE_VCODECS.has(probedVcodec) ? 'ok' : 'transcode')
    : 'unknown'

  const copyAll = async () => {
    const payload = {
      version: appVersion,
      serverHealthy,
      endpoint,
      sourceType,
      source,
      streamBaseUrl,
      streamInfoHash,
      streamDuration,
      probedVcodec,
      codecBadge,
      remuxStage,
      playbackError,
      streamWarning: streamWarning || null,
      audio: { count: audioTracks?.length || 0, activeIdx: activeAudioIdx },
      ts: new Date().toISOString(),
    }
    try { await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)) } catch {}
  }

  return (
    <div className="wf-debug" role="dialog" aria-label="Debug overlay">
      <div className="wf-debug-head">
        <span className="wf-debug-title">Debug</span>
        <span className="wf-debug-sub">Ctrl+Shift+D to toggle · Esc to close</span>
        <button className="wf-debug-close" type="button" onClick={onClose} aria-label="Close debug overlay">×</button>
      </div>
      <dl className="wf-debug-grid">
        <dt>App</dt><dd>v{appVersion || '?'} · server {serverHealthy === false ? 'down' : serverHealthy === true ? 'up' : '?'}</dd>
        <dt>Endpoint</dt><dd data-endpoint={endpoint.split(' ')[0]}>{endpoint}</dd>
        <dt>Remux stage</dt><dd>{remuxStage} / 2</dd>
        <dt>Codec</dt><dd data-codec={codecBadge}>{probedVcodec || '(not probed)'} <span className="wf-debug-badge">{codecBadge}</span></dd>
        <dt>Info-hash</dt><dd className="wf-debug-mono">{streamInfoHash || '—'}</dd>
        <dt>Duration</dt><dd>{streamDuration ? `${Math.floor(streamDuration / 60)}m ${Math.floor(streamDuration % 60)}s` : '—'}</dd>
        <dt>Audio</dt><dd>{(audioTracks?.length || 0)} track(s){typeof activeAudioIdx === 'number' ? ` · active #${activeAudioIdx}` : ''}</dd>
        <dt>Source type</dt><dd>{sourceType || '—'}</dd>
        <dt>Source URL</dt><dd className="wf-debug-mono wf-debug-wrap" title={source || ''}>{source || '—'}</dd>
        <dt>Base URL</dt><dd className="wf-debug-mono wf-debug-wrap">{streamBaseUrl || '—'}</dd>
        <dt>Last error</dt><dd>{playbackError ? `code ${playbackError.code}: ${playbackError.message}` : '—'}</dd>
        <dt>Warning</dt><dd>{streamWarning || '—'}</dd>
        <dt>Install ID</dt><dd className="wf-debug-mono wf-debug-wrap" title={accessInfo?.installId || ''}>{accessInfo?.installId || '—'}</dd>
      </dl>
      <div className="wf-debug-foot">
        <button type="button" className="wf-debug-btn" onClick={copyAll}>Copy as JSON</button>
        <button type="button" className="wf-debug-btn" onClick={copyInstallId} disabled={!accessInfo?.installId}>Copy install ID</button>
      </div>
    </div>
  )
}

// ── App ─────────────────────────────────────────────────────────
function App() {
  const [tab, setTab] = useState('browse')
  const [input, setInput] = useState('')
  const [source, _setSourceRaw] = useState(null)
  // All setSource calls funnel through toAbsStreamUrl so a stray relative
  // URL can never reach <video src> and trip MEDIA_ERR_SRC_NOT_SUPPORTED
  // in packaged (file://) builds. See toAbsStreamUrl's comment for why.
  const setSource = useCallback((url) => _setSourceRaw(toAbsStreamUrl(url)), [])
  const [sourceType, setSourceType] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailItem, setDetailItem] = useState(null)
  const [playingMetadata, setPlayingMetadata] = useState(null)
  const [streamWarning, setStreamWarning] = useState('')
  const [streamProgress, setStreamProgress] = useState(null)
  const [availableSubs, setAvailableSubs] = useState([])
  const [subOffset, setSubOffset] = useState(0)
  const [subPanelOpen, setSubPanelOpen] = useState(false)
  const [audioTracks, setAudioTracks] = useState([])
  const [activeAudioIdx, setActiveAudioIdx] = useState(null)
  const [streamInfoHash, setStreamInfoHash] = useState(null)
  const [streamDuration, setStreamDuration] = useState(null)
  const [streamBaseUrl, setStreamBaseUrl] = useState(null)
  const [playbackError, setPlaybackError] = useState(null) // { code, message } | null — surfaced when video.js emits 'error' mid-playback
  // Probed video codec reported by /api/tracks (e.g. 'h264', 'hevc', 'av1').
  // Surfaced in the debug overlay so we can tell from a screenshot whether
  // a given decode failure was Chromium-unsupported (hevc/av1) vs. genuinely
  // broken bytes (ffmpeg didn't recognise the stream, vcodec === null).
  const [probedVcodec, setProbedVcodec] = useState(null)
  // Ctrl+Shift+D toggles a developer overlay — when a user reports a
  // decode error, the overlay shows the exact source URL, remux stage,
  // probed codec, info-hash, and recent playback error so we can
  // diagnose from a screenshot instead of guessing.
  const [debugOpen, setDebugOpen] = useState(false)
  // `?` toggles the keyboard shortcut cheat-sheet. Discoverable without
  // having to hunt through a settings menu for power-user keybinds.
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [showIntro, setShowIntro] = useState(false)
  const [castState, setCastState] = useState('unavailable') // unavailable | available | connecting | connected
  const [dlnaDevices, setDlnaDevices] = useState([])
  const [dlnaActive, setDlnaActive] = useState(null) // device id or null
  const [playerReady, setPlayerReady] = useState(0) // increments each time a new player is created; used to re-run child effects that attach listeners
  // Show the WardoFlix intro on every fresh launch. Runs once when the app
  // module first mounts — not again on hot-reloads or tab switches.
  const [showStartupIntro, setShowStartupIntro] = useState(true)

  // Multi-profile support. The gate covers the app any time no profile
  // is active — on first boot, or after the user explicitly clicked
  // "Switch profile…". Once the gate dismisses (via onPick), the rest
  // of the app reads through the active profile automatically because
  // history/resume/volume helpers all resolve against it.
  const { profiles, activeProfile } = useProfiles()
  // "Manage" mode from the gate opens an empty editor so the user can
  // add a fresh profile even when the picker already has some.
  const [manageCreate, setManageCreate] = useState(false)

  // App version & backend health — both polled from /api/health. The dot in
  // the topbar turns amber/red when the backend stops responding so a user
  // knows to retry (or restart the app) instead of thinking the UI is frozen.
  const [appVersion, setAppVersion] = useState(null)
  const [serverHealthy, setServerHealthy] = useState(null) // null = unknown, true/false after first probe

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        if (!r.ok) throw new Error(`status ${r.status}`)
        const j = await r.json()
        if (cancelled) return
        if (j.version) setAppVersion(j.version)
        setServerHealthy(true)
      } catch {
        if (!cancelled) setServerHealthy(false)
      }
    }
    probe()
    // Cheap liveness check every 30s — the dot flips red if the server dies.
    const id = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Mouse-parallax for the cinematic backdrop. We write two CSS vars
  // on <html> — --wf-mx / --wf-my, each in [-1, 1] — and the aurora
  // layer in App.css reads them via calc() to shift a few px per axis.
  // Throttled through rAF so it stays on the compositor thread and
  // never fires more than once per frame. Also respects prefers-
  // reduced-motion so accessibility-minded users get a static frame.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const root = document.documentElement
    let rafId = 0
    let targetX = 0, targetY = 0
    let curX = 0, curY = 0
    const onMove = (e) => {
      targetX = (e.clientX / window.innerWidth) * 2 - 1   // -1..1
      targetY = (e.clientY / window.innerHeight) * 2 - 1
      if (!rafId) rafId = requestAnimationFrame(tick)
    }
    const tick = () => {
      // Ease toward the target — lerp at 0.08/frame gives a pleasant
      // ~8–12 frame trail so the aurora drifts rather than snaps.
      curX += (targetX - curX) * 0.08
      curY += (targetY - curY) * 0.08
      root.style.setProperty('--wf-mx', curX.toFixed(3))
      root.style.setProperty('--wf-my', curY.toFixed(3))
      if (Math.abs(curX - targetX) > 0.001 || Math.abs(curY - targetY) > 0.001) {
        rafId = requestAnimationFrame(tick)
      } else {
        rafId = 0
      }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Developer overlay toggle. Ctrl+Shift+D (or Cmd+Shift+D on macOS)
  // flips a fixed-position diagnostic panel showing the current stream
  // URL, remux stage, probed codec, info-hash and recent playback error.
  // Escape closes it. Hidden by default — zero cost when closed.
  // `?` (shift+/) brings up the keyboard shortcut cheat-sheet.
  useEffect(() => {
    const onKey = (e) => {
      // Don't capture when the user is typing into a field.
      const target = e.target
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setDebugOpen((v) => !v)
      } else if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if (e.key === 'Escape') {
        if (debugOpen) setDebugOpen(false)
        if (shortcutsOpen) setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [debugOpen, shortcutsOpen])

  // While the intro plays, lock page scroll and hide the scrollbar so the
  // ugly default Windows scrollbar doesn't flash over the animation.
  useEffect(() => {
    if (!showStartupIntro) return
    document.documentElement.classList.add('wf-intro-lock')
    document.body.classList.add('wf-intro-lock')
    return () => {
      document.documentElement.classList.remove('wf-intro-lock')
      document.body.classList.remove('wf-intro-lock')
    }
  }, [showStartupIntro])
  const videoContainerRef = useRef(null)
  const playerContainerRef = useRef(null)
  const playerRef = useRef(null)
  const playerSectionRef = useRef(null)
  const progressRef = useRef(null)
  const castSessionRef = useRef(null)
  const playingMetadataRef = useRef(null)
  const handleStreamRef = useRef(null)
  // AbortControllers for in-flight fetches that otherwise race with the
  // next handleStream() and corrupt state (e.g. stale audio tracks).
  const tracksAbortRef = useRef(null)
  const subsAbortRef = useRef(null)
  // Also abort the main /api/stream POST so a slow torrent announce
  // (the 25s budget on the server side) can't resolve into stale UI
  // state long after the user navigated away or started another title.
  const streamAbortRef = useRef(null)
  // Mirror of streamProgress state so the peer-watchdog loop inside
  // handleStream can read the latest SSE data without re-rendering.
  const streamProgressRef = useRef(null)
  // Flag the fallback loop checks each tick: goes false when the user
  // clears the player or starts a different stream, so a stale retry
  // can't spawn a zombie request against the backend.
  const streamAliveRef = useRef(false)
  // Escalation stage for the auto-remux fallback. On decode errors
  // (MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED) we walk through:
  //   0 → /stream/...               (direct WebTorrent HTTP)
  //   1 → /remux/...?transcode=1    (ffmpeg + libx264)
  //   2 → /remux/...?transcode=1&fresh=<ts>  (re-probe, bust meta cache)
  //   ≥3 → give up, show the user-facing error dialog
  // Reset to 0 each time a new stream starts via handleStream.
  const remuxFallbackRef = useRef(0)
  // Set by the /remux seek handler when a user seek outside the buffered
  // region is about to trigger a URL reload with ?t=<target>. The decode-
  // error handler checks this ref and skips the stage-1/2 escalation in
  // that window — otherwise the native <video> seek fires a decode error
  // (byte-range refused by our Accept-Ranges:none server → immediate
  // error) BEFORE our debounced reload fires, the error handler wipes
  // the URL to re-run transcode from 0, and the final reload lands on a
  // torn-down player and plays from the start. Root cause of "±10s
  // restarts the whole show" in 1.4.9.
  const seekReloadPendingRef = useRef(false)
  // How many seconds into the *original* movie the current /remux
  // stream represents. Set every time seekRemuxAware performs a
  // URL-based reload with ?t=<sec>. Used so the progress UI can show
  // real-movie time rather than stream-local time; not currently
  // wired through to PlayerControls, but the ref is kept so the
  // reload path has somewhere to record the offset for future use.
  const remuxTimeOffsetRef = useRef(0)
  useEffect(() => { playingMetadataRef.current = playingMetadata }, [playingMetadata])

  useEffect(() => {
    return () => {
      if (playerRef.current && !playerRef.current.isDisposed()) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!source || sourceType !== 'url' || !videoContainerRef.current) return

    if (playerRef.current && !playerRef.current.isDisposed()) {
      playerRef.current.dispose()
      playerRef.current = null
    }

    const videoEl = document.createElement('video')
    videoEl.className = 'video-js vjs-big-play-centered vjs-fluid'
    videoEl.setAttribute('playsinline', '')
    videoContainerRef.current.innerHTML = ''
    videoContainerRef.current.appendChild(videoEl)

    const player = videojs(videoEl, {
      controls: false,
      autoplay: false,  // we control play() manually after intro
      preload: 'auto',
      fluid: true,
      responsive: true,
      inactivityTimeout: 0,
    })
    playerRef.current = player
    // Signal to child components (PlayerControls) that the player ref is populated.
    // Their effects depend on this bump so they re-run after the ref is assigned.
    setPlayerReady((n) => n + 1)

    // Trigger intro only when the video is actually ready to play
    let introTriggered = false
    const triggerIntro = () => {
      if (introTriggered) return
      introTriggered = true
      try { player.pause() } catch {}
      setShowIntro(true)
    }
    player.one('canplay', triggerIntro)
    player.one('loadeddata', triggerIntro)
    // Safety fallback: if neither fires within 20s, just start playing without intro
    const introFallback = setTimeout(() => {
      if (!introTriggered) { introTriggered = true; try { player.play() } catch {} }
    }, 20000)
    player.one('dispose', () => clearTimeout(introFallback))

    // ── Surface playback errors mid-stream (network drop, ffmpeg
    // exit, corrupt container). Without this the screen just freezes
    // on the last rendered frame with no feedback.
    player.on('error', () => {
      try {
        const err = player.error()
        if (!err) return
        // MEDIA_ERR_ABORTED=1 fires on user-initiated dispose — ignore it.
        if (err.code === 1) return
        // If a /remux seek-reload is already scheduled, a decode error
        // here is almost certainly the native seek hitting our Accept-
        // Ranges:none server. Don't escalate; the seek handler will
        // rebuild the URL with ?t=<target> in ~120ms. Escalating here
        // would wipe ?t= and restart the show from 0 — the exact bug
        // user reported for ±10s buttons.
        if (seekReloadPendingRef.current) return

        // ── Auto-remux fallback ────────────────────────────────────
        // MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4)
        // almost always mean the browser choked on a codec it can't
        // handle natively — HEVC/x265 in an MP4 is the classic case.
        // The server has an ffmpeg-backed /remux endpoint that emits
        // fragmented MP4 with H.264 + AAC, so transparently swap the
        // source and reload instead of making the user click Retry
        // (which would just try the same unplayable URL again).
        //
        // Implementation note: the player useEffect is keyed on [source],
        // so setSource() will dispose THIS player and create a fresh one.
        // That means any listener we attach here (e.g. the old code's
        // player.one('loadedmetadata') for the seek restore) would fire
        // on an orphan. Instead, we bank the current position into the
        // per-title resume store — the new player's existing resume
        // handler picks it up automatically when it loads.
        const decodeLike = err.code === 3 || err.code === 4
        // React source state is the canonical URL; player.currentSrc()
        // can be empty if the error fired before the HTTP request even
        // opened (e.g. unsupported-source on first probe).
        const currentUrl = source || ''
        // Two-stage escalation:
        //   stage 0 → /stream/... (direct WebTorrent HTTP, fast path)
        //   stage 1 → /remux/...?transcode=1 (libx264 via ffmpeg)
        //   stage 2 → /remux/...?transcode=1&fresh=<ts> (cache-buster +
        //             forces the server to re-probe the codec, in case
        //             the cached probe was stale or lied)
        const stage = remuxFallbackRef.current || 0
        const onStream = currentUrl.includes('/stream/')
        const onSoftRemux = currentUrl.includes('/remux/') && !/[?&]fresh=/.test(currentUrl)
        const canEscalate = decodeLike && (
          (stage === 0 && onStream) ||
          (stage < 2 && onSoftRemux)
        )
        if (canEscalate) {
          const nextStage = stage + 1
          remuxFallbackRef.current = nextStage
          const pos = (() => { try { return player.currentTime() || 0 } catch { return 0 } })()
          const dur = (() => { try { return player.duration() || 0 } catch { return 0 } })()
          if (pos > 0 && playingMetadataRef.current) {
            try { saveResumePosition(playingMetadataRef.current, pos, dur) } catch {}
          }
          let newUrl
          if (onStream) {
            const swapped = currentUrl.replace('/stream/', '/remux/')
            const sep = swapped.includes('?') ? '&' : '?'
            newUrl = `${swapped}${sep}transcode=1`
          } else {
            // Already on /remux — force a fresh probe + transcode by
            // busting the server's meta cache with ?fresh=<timestamp>.
            const sep = currentUrl.includes('?') ? '&' : '?'
            newUrl = `${currentUrl}${sep}fresh=${Date.now()}`
          }
          setStreamWarning(
            nextStage === 1
              ? 'Original codec unsupported — transcoding on the fly…'
              : 'Transcode stalled — restarting with a fresh probe…'
          )
          setStreamBaseUrl(newUrl.split('?')[0])
          setSource(newUrl)
          setSourceType('url')
          setTimeout(() => setStreamWarning(''), 3500)
          return
        }

        const codeMap = {
          2: 'Network error while loading the stream.',
          3: 'Video decode error — the file may be corrupted or use an unsupported codec.',
          4: 'Source not supported (the browser refused the container/codec).',
        }
        setPlaybackError({
          code: err.code,
          message: codeMap[err.code] || err.message || 'Playback interrupted.',
        })
      } catch {}
    })

    // (previous `seeking` event interceptor removed — it ran AFTER the
    // native browser had already started a seek which, under our
    // Accept-Ranges:none /remux contract, caused Chromium to issue a
    // fresh GET from byte 0 and play forward from the start. Seek
    // handling now lives upstream in seekRemuxAware (see App), which
    // is invoked by PlayerControls BEFORE the native seek fires.)

    // ── Autoplay next episode when current one finishes ─────────
    player.on('ended', () => {
      const meta = playingMetadataRef.current
      // Finished — drop any saved resume mark, flip the watched flag so
      // the episode list shows a ✓, then chain into the next episode.
      try { clearResumePosition(meta) } catch {}
      try { markWatched(meta) } catch {}
      const next = findNextEpisode(meta)
      if (!next || !handleStreamRef.current) return
      handleStreamRef.current(next.magnet, {
        ...meta,
        season: next.season,
        episode: next.episode,
      })
    })

    // ── Restore volume/mute pref (so the next session starts where
    // the viewer left the slider) ──────────────────────────────────
    try {
      const pref = loadVolumePref()
      if (pref) {
        player.volume(pref.volume)
        player.muted(pref.muted)
      }
    } catch {}
    // Persist on change, debounced via rAF so dragging the volume slider
    // doesn't thrash localStorage.
    let volSaveScheduled = false
    player.on('volumechange', () => {
      if (volSaveScheduled) return
      volSaveScheduled = true
      requestAnimationFrame(() => {
        volSaveScheduled = false
        try { saveVolumePref(player.volume(), player.muted()) } catch {}
      })
    })

    // ── Resume position: seek to saved time once metadata is loaded,
    // and save current time every few seconds while playing ─────────
    let resumeApplied = false
    player.on('loadedmetadata', () => {
      if (resumeApplied) return
      resumeApplied = true
      const meta = playingMetadataRef.current
      const t = readResumePosition(meta)
      if (t > 0) {
        try {
          const d = player.duration()
          // Don't resume if we're within 60s of the end — treat as finished.
          if (!isFinite(d) || d <= 0 || t < d - 60) {
            player.currentTime(t)
          }
        } catch {}
      }
    })
    // Throttle resume-save to once every ~5 seconds.
    let lastResumeSave = 0
    player.on('timeupdate', () => {
      const now = Date.now()
      if (now - lastResumeSave < 5000) return
      lastResumeSave = now
      const meta = playingMetadataRef.current
      const t = player.currentTime() || 0
      const d = player.duration()
      saveResumePosition(meta, t, isFinite(d) ? d : 0)
    })

    const guessType = (url) => {
      const lower = url.toLowerCase()
      if (lower.includes('.m3u8')) return 'application/x-mpegURL'
      if (lower.includes('.webm')) return 'video/webm'
      if (lower.includes('.ogv') || lower.includes('.ogg')) return 'video/ogg'
      if (lower.includes('.mkv')) return 'video/mp4' // browsers can't play MKV natively, try mp4 container compat
      return 'video/mp4'
    }
    player.src({ type: guessType(source), src: source })
    playerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    setSubOffset(0)
    setAvailableSubs([])
    setSubPanelOpen(false)

    if (playingMetadata?.id && playingMetadata?.type) {
      const subParams = new URLSearchParams({ tmdbId: playingMetadata.id, type: playingMetadata.type })
      if (playingMetadata.season) subParams.set('season', playingMetadata.season)
      if (playingMetadata.episode) subParams.set('episode', playingMetadata.episode)
      try { subsAbortRef.current?.abort() } catch {}
      const subCtl = new AbortController()
      subsAbortRef.current = subCtl
      fetch(`/api/subtitles?${subParams}`, { signal: subCtl.signal })
        .then((r) => r.json().catch(() => ({ subtitles: [] })))
        .then((data) => {
          if (subCtl.signal.aborted) return
          const subs = (data.subtitles || []).filter((s) => s.url)
          // Guard every interaction with playerRef — by the time this fetch
          // resolves the user may have hit Back and disposed the player.
          if (!playerRef.current || playerRef.current.isDisposed()) return
          setAvailableSubs(subs)
          subs.forEach((s) => {
            if (playerRef.current && !playerRef.current.isDisposed()) {
              try {
                playerRef.current.addRemoteTextTrack({
                  kind: 'subtitles',
                  src: `/api/subtitles/proxy?url=${encodeURIComponent(s.url)}`,
                  srclang: s.lang || 'en',
                  label: s.langName || s.lang || 'Unknown',
                  default: false,
                }, false)
              } catch {}
            }
          })
        })
        .catch(() => {})
    }
  }, [source, sourceType, playingMetadata])

  // ── Subtitle offset: reload tracks with shifted timestamps ─────
  // When subOffset changes, remove existing tracks and re-add them with the
  // ?offset=N query param so the proxy serves time-shifted VTT.
  useEffect(() => {
    const player = playerRef.current
    if (!player || player.isDisposed() || !availableSubs.length) return

    // Remember which track was active so we can restore it
    const tracks = player.textTracks()
    let activeLang = null
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].mode === 'showing') { activeLang = tracks[i].language; break }
    }

    // Remove all current remote text tracks
    const remoteEls = player.remoteTextTracks()
    const toRemove = []
    for (let i = 0; i < remoteEls.length; i++) toRemove.push(remoteEls[i])
    toRemove.forEach((t) => player.removeRemoteTextTrack(t))

    // Re-add with offset
    availableSubs.forEach((s) => {
      const params = new URLSearchParams({ url: s.url })
      if (subOffset) params.set('offset', String(subOffset))
      const track = player.addRemoteTextTrack({
        kind: 'subtitles',
        src: `/api/subtitles/proxy?${params}`,
        srclang: s.lang || 'en',
        label: s.langName || s.lang || 'Unknown',
        default: false,
      }, false)
      if (activeLang && (s.lang || 'en') === activeLang && track?.track) {
        // Restore previous selection on next tick (after the track is ready)
        setTimeout(() => { try { track.track.mode = 'showing' } catch {} }, 100)
      }
    })
  }, [subOffset, availableSubs])

  // ── Google Cast initialization ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let initialized = false // guard: both the polled init() and the
                            // __onGCastApiAvailable callback try to init
    let ctxRef = null
    let listener = null
    const init = () => {
      if (cancelled || initialized) return
      if (!window.chrome?.cast || !window.cast?.framework) {
        setTimeout(init, 500)
        return
      }
      initialized = true
      const context = window.cast.framework.CastContext.getInstance()
      ctxRef = context
      context.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      })
      listener = () => {
        const s = context.getCastState()
        if (s === 'NO_DEVICES_AVAILABLE') setCastState('unavailable')
        else if (s === 'NOT_CONNECTED') setCastState('available')
        else if (s === 'CONNECTING') setCastState('connecting')
        else if (s === 'CONNECTED') {
          setCastState('connected')
          castSessionRef.current = context.getCurrentSession()
        }
      }
      listener()
      context.addEventListener(
        window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
        listener,
      )
    }
    window['__onGCastApiAvailable'] = (isAvailable) => { if (isAvailable) init() }
    init()
    return () => {
      cancelled = true
      // Remove the cast state listener so repeated mounts don't stack up
      // duplicate handlers (fires setCastState N times per event).
      try {
        if (ctxRef && listener) {
          ctxRef.removeEventListener(
            window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
            listener,
          )
        }
      } catch {}
    }
  }, [])

  // Guess a usable MIME from a stream URL. Cast receivers + many DLNA TVs
  // refuse media when the advertised Content-Type doesn't match the actual
  // container — hardcoding 'video/mp4' for an .mkv fails silently on LG/Samsung.
  const guessMime = useCallback((url) => {
    if (!url) return 'video/mp4'
    const clean = url.split('?')[0].toLowerCase()
    if (clean.endsWith('.m3u8')) return 'application/x-mpegURL'
    if (clean.endsWith('.mpd')) return 'application/dash+xml'
    if (clean.endsWith('.mkv')) return 'video/x-matroska'
    if (clean.endsWith('.webm')) return 'video/webm'
    if (clean.endsWith('.avi')) return 'video/x-msvideo'
    if (clean.endsWith('.mov')) return 'video/quicktime'
    if (clean.endsWith('.ts')) return 'video/mp2t'
    return 'video/mp4'
  }, [])

  // Resolve the current stream into an absolute URL the TV can actually reach.
  // In packaged Electron and dev, window.location.hostname is `localhost`,
  // which a Chromecast/TV on the LAN can't resolve — fetch our LAN IP from
  // the server and rewrite.
  //
  // `forceRemux` rewrites /stream/HASH/file.mkv → /remux/HASH/file.mp4 so
  // ffmpeg repackages into fragmented MP4 (stream-copy video + AAC audio).
  // Most DLNA TVs refuse MKV with protocol error 701; MP4 is near-universal.
  const buildCastUrl = useCallback(async ({ forceRemux = false } = {}) => {
    if (!source) return null
    let path = source
    if (forceRemux && /^\/stream\//.test(path)) {
      path = path.replace(/^\/stream\//, '/remux/').replace(/\.(mkv|avi|mov|webm|ts|wmv|flv)(\?|$)/i, '.mp4$2')
    }
    let mediaUrl = path.startsWith('http')
      ? path
      : `${window.location.protocol}//${window.location.hostname}:3000${path}`
    try {
      const devRes = await fetch('/api/dlna/devices')
      const devData = await devRes.json().catch(() => ({}))
      const lanIp = devData.lanIp
      if (lanIp && lanIp !== '127.0.0.1') {
        mediaUrl = mediaUrl
          .replace(/\/\/localhost(?=[:/])/g, `//${lanIp}`)
          .replace(/\/\/127\.0\.0\.1(?=[:/])/g, `//${lanIp}`)
      }
    } catch {}
    return mediaUrl
  }, [source])

  const handleCast = useCallback(async () => {
    if (!source || !window.cast?.framework) return
    const context = window.cast.framework.CastContext.getInstance()
    // Build the LAN-reachable URL BEFORE requesting session so we can bail
    // early if we can't resolve a routable address.
    const absoluteUrl = await buildCastUrl()
    if (!absoluteUrl) return
    try {
      await context.requestSession()
      const session = context.getCurrentSession()
      if (!session) return
      castSessionRef.current = session
      const mime = guessMime(absoluteUrl)
      const mediaInfo = new window.chrome.cast.media.MediaInfo(absoluteUrl, mime)
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata()
      mediaInfo.metadata.title = playingMetadata?.title || 'WardoFlix'
      // HLS needs the streamType hint so the receiver picks the right player
      if (mime === 'application/x-mpegURL') {
        mediaInfo.hlsSegmentFormat = 'ts'
        mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED
      }
      const request = new window.chrome.cast.media.LoadRequest(mediaInfo)
      request.currentTime = playerRef.current?.currentTime?.() || 0
      await session.loadMedia(request).then(
        () => { try { playerRef.current?.pause() } catch {} },
        (err) => {
          console.error('Cast load failed:', err)
          toast(
            `Chromecast refused the stream (${err?.code || 'unknown'}). Your TV may not support ${mime}.`,
            'error',
            { title: 'Cast failed' }
          )
        },
      )
    } catch (err) {
      // user dismissed picker — not an error
      if (err !== 'cancel' && err?.code !== 'cancel') {
        console.error('Cast session error:', err)
      }
    }
  }, [source, playingMetadata, buildCastUrl, guessMime])

  const stopCasting = useCallback(() => {
    const context = window.cast?.framework?.CastContext?.getInstance?.()
    context?.endCurrentSession?.(true)
    castSessionRef.current = null
  }, [])

  // ── DLNA (Samsung / LG / Sony Smart TVs) ──────────────────────
  const refreshDlna = useCallback(async () => {
    try {
      await fetch('/api/dlna/refresh', { method: 'POST' })
      // short delay so SSDP replies arrive
      await new Promise((r) => setTimeout(r, 1200))
      const res = await fetch('/api/dlna/devices')
      const data = await res.json().catch(() => ({}))
      setDlnaDevices(data.devices || [])
    } catch {}
  }, [])

  // Initial & periodic discovery while streaming
  useEffect(() => {
    refreshDlna()
    const id = setInterval(refreshDlna, 30_000)
    return () => clearInterval(id)
  }, [refreshDlna])

  const castDlna = useCallback(async (device) => {
    if (!source || !device?.id) return
    // Preemptively remux for DLNA when the source isn't an MP4. Most older
    // Samsung/LG/Medion TVs return DLNA error 701 ("incompatible protocol info")
    // on MKV/AVI, so we route through /remux → fMP4 by default.
    const sourceIsMp4 = /\.mp4(\?|$)/i.test(source)
    const shouldRemux = !sourceIsMp4

    const tryOnce = async (forceRemux) => {
      const mediaUrl = await buildCastUrl({ forceRemux })
      if (!mediaUrl) throw new Error('Could not build stream URL')
      const mime = guessMime(mediaUrl)
      const r = await fetch('/api/dlna/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: device.id,
          url: mediaUrl,
          title: playingMetadata?.title,
          type: mime,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(data.error || 'Cast failed')
        err.mime = mime
        throw err
      }
      return { mime }
    }

    try {
      const { mime } = await tryOnce(shouldRemux)
      setDlnaActive(device.id)
      try { playerRef.current?.pause() } catch {}
      console.log(`DLNA cast OK (${mime})${shouldRemux ? ' via remux' : ''}`)
    } catch (e) {
      // Error 701 = incompatible protocol info; retry through remux if we
      // weren't already using it. This catches TVs that accept MP4 but not
      // e.g. a stray AVI or WebM source.
      const is701 = /701/.test(e.message) || /protocol info/i.test(e.message)
      if (is701 && !shouldRemux) {
        try {
          const { mime } = await tryOnce(true)
          setDlnaActive(device.id)
          try { playerRef.current?.pause() } catch {}
          console.log(`DLNA cast OK after remux (${mime})`)
          return
        } catch (e2) {
          toast(
            `DLNA cast failed even after remux: ${e2.message}. Your TV may be offline or on a different network.`,
            'error',
            { title: 'DLNA cast failed' }
          )
          return
        }
      }
      toast(
        `DLNA cast failed: ${e.message}. If this keeps happening, try a different source from the list.`,
        'error',
        { title: 'DLNA cast failed' }
      )
    }
  }, [source, playingMetadata, buildCastUrl, guessMime])

  const stopDlna = useCallback(async () => {
    if (!dlnaActive) return
    try {
      await fetch('/api/dlna/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dlnaActive }),
      })
    } catch {}
    setDlnaActive(null)
  }, [dlnaActive])

  const startProgress = useCallback((url) => {
    // Extract infoHash from stream URL like /stream/HASH/... or /remux/HASH/...
    const match = url?.match(/\/(?:stream|remux)\/([a-f0-9]{40})\//i)
    if (!match) return
    if (progressRef.current) progressRef.current.close()
    streamProgressRef.current = null
    const es = new EventSource(`/api/stream/progress/${match[1]}`)
    progressRef.current = es
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        streamProgressRef.current = d
        setStreamProgress(d)
      } catch {}
    }
    es.onerror = () => { es.close(); progressRef.current = null }
  }, [])

  const handleStream = async (urlOrMagnet, metadata) => {
    let trimmed = (urlOrMagnet || input).trim()
    // Snapshot the active profile at stream-start so the history commit
    // (fired 15s+ later when the peer-watchdog clears) lands under the
    // profile that launched the stream, even if the user has since
    // switched profiles. Without this snapshot, addToHistory reads the
    // *current* active profile at write time, which is the wrong one.
    const streamProfileId = getActiveProfileId()

    // Stremio-style flow: if we were handed episode metadata but no magnet
    // (e.g. autoplay-next-episode on an unavailable slot), resolve it via
    // Torrentio on demand.
    if (!trimmed && metadata?.season && metadata?.episode && (metadata.id || metadata.title)) {
      try {
        setTab('stream')
        setLoading(true)
        const params = new URLSearchParams({
          title: metadata.title || '',
          season: String(metadata.season),
          episode: String(metadata.episode),
        })
        if (metadata.id) params.set('tmdbId', String(metadata.id))
        if (metadata.imdbId) params.set('imdbId', metadata.imdbId)
        const r = await fetch(`/api/torrent-episode?${params}`)
        // Distinguish "backend is down / network" from "no torrents found"
        // so the user sees an actionable message, not a confusing "no
        // source" when really the server crashed.
        if (!r.ok) {
          setError(`Episode lookup failed (HTTP ${r.status}) — the backend may be unreachable.`)
          setLoading(false); return
        }
        const j = await r.json().catch(() => null)
        if (!j || !Array.isArray(j.torrents)) {
          setError('Episode lookup returned an invalid response from the indexer.')
          setLoading(false); return
        }
        const best = j.torrents[0]
        if (!best?.magnet) { setError(`No source found for S${metadata.season}E${metadata.episode}`); setLoading(false); return }
        trimmed = best.magnet
      } catch (err) {
        // TypeError: fetch failed = network error (DNS, offline, backend down)
        const isNetwork = err?.name === 'TypeError'
        setError(isNetwork
          ? 'Could not reach the backend to look up the episode. Is the server running?'
          : `Lookup failed: ${err.message}`)
        setLoading(false); return
      }
    }

    if (!trimmed) { setError('Please paste a URL or magnet link'); return }

    setTab('stream')
    setError('')
    setStreamWarning('')
    setLoading(true)
    setSource(null)
    setSourceType(null)
    setDetailItem(null)
    setPlayingMetadata(metadata || null)
    setShowIntro(false)  // will be triggered when player emits canplay
    setStreamProgress(null)
    setAudioTracks([])
    setActiveAudioIdx(null)
    setStreamInfoHash(null)
    setStreamBaseUrl(null)
    setStreamDuration(null)
    setProbedVcodec(null)
    setPlaybackError(null)
    if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
    streamProgressRef.current = null
    // Flip alive: any previous fallback-loop iterations will see the
    // flag change and bail before firing another /api/stream request.
    streamAliveRef.current = false
    // Next microtask, the new handleStream run is in charge — re-arm.
    queueMicrotask(() => { streamAliveRef.current = true })
    // Kill any in-flight background fetches from the previous stream so
    // their late results can't clobber the new one.
    try { tracksAbortRef.current?.abort() } catch {}
    try { subsAbortRef.current?.abort() } catch {}
    try { streamAbortRef.current?.abort() } catch {}
    const streamCtl = new AbortController()
    streamAbortRef.current = streamCtl

    if (isMagnetLink(trimmed)) {
      // ── Build the fallback chain ──────────────────────────────────
      // Queue = [user's pick, ...pre-sorted alternatives]. We retry down
      // the list on 4xx/5xx from /api/stream OR when the peer watchdog
      // fires (0 peers + 0 bytes after 15s on a supposedly-live stream).
      // This is the core of the "no more 'no stream found' dead-ends"
      // promise — if ANY source in the chain is alive, we play it.
      const altList = Array.isArray(metadata?.alternatives) ? metadata.alternatives : []
      const queue = [
        { magnet: trimmed, quality: metadata?.quality || '', seeds: metadata?.seeds, size: metadata?.size || '' },
        ...altList,
      ]

      let success = false
      let lastErr = null
      for (let i = 0; i < queue.length; i++) {
        const candidate = queue[i]
        if (!candidate?.magnet) continue
        // Surface "trying alternate source" to the user so a 20-second
        // silence doesn't feel like the app froze.
        if (i > 0) {
          const q = candidate.quality || 'source'
          const s = typeof candidate.seeds === 'number' ? ` · ${candidate.seeds} seeds` : ''
          setStreamWarning(`Previous source had no seeders. Trying source ${i + 1} of ${queue.length} (${q}${s})…`)
        }
        try {
          const res = await fetch('/api/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Pass fileIdx when Torrentio told us which file in a
            // multi-episode pack matches the episode the user clicked.
            // Without this, pickBestVideoFile just picks the largest
            // video and we play "S2E7" when the user asked for "S1E1" —
            // reproducing every time a pack covers multiple episodes.
            body: JSON.stringify({
              magnet: candidate.magnet,
              fileIdx: typeof candidate.fileIdx === 'number' ? candidate.fileIdx : undefined,
              season: playingMetadata?.season,
              episode: playingMetadata?.episode,
              titleHint: playingMetadata?.title,
            }),
            signal: streamCtl.signal,
          })
          // If the user started a different stream (or handleClear ran)
          // while this request was in flight, bail now — the new run has
          // already set up its own state and we'd corrupt it.
          if (streamCtl.signal.aborted) throw new Error('stream request aborted')
          const data = await res.json().catch(() => { throw new Error('Backend not responding. Run: npm start') })
          if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
          if (!data.url) throw new Error('No stream URL returned')

          const abs = (window.__API_BASE__ || '') + data.url
          // New stream → reset the remux-escalation stage to 0 so we're
          // allowed to walk the full /stream/ → /remux/ → /remux/&fresh
          // ladder if this new source misbehaves.
          remuxFallbackRef.current = 0
          setSource(abs)
          setSourceType('url')
          setStreamWarning(data.warning || '')
          setStreamInfoHash(data.infoHash || null)
          setStreamBaseUrl(data.isRemuxed ? abs : null)
          startProgress(abs)

          // ── Peer watchdog ────────────────────────────────────────
          // Even after /api/stream returns 200 (torrent is "ready" and
          // we have a file list), the swarm can still be too thin to
          // actually send video bytes. Watch the SSE progress for 15s:
          // if peers and downloaded both stay at 0, the torrent is dead
          // in all but name — kill it and try the next alternative.
          const deadChain = await new Promise((resolve) => {
            let decided = false
            const decide = (dead) => { if (decided) return; decided = true; resolve(dead) }
            const watchdog = setTimeout(() => {
              const p = streamProgressRef.current
              const peers = p?.peers || 0
              const bytes = p?.downloaded || 0
              decide(peers === 0 && bytes === 0)
            }, 15000)
            // If the user navigates away or picks something else, bail.
            const abortId = setInterval(() => {
              if (!streamAliveRef.current) {
                clearTimeout(watchdog); clearInterval(abortId); decide(false)
              }
            }, 500)
            // Fast-path exit: peers appeared before the timeout, no point
            // waiting the full 15s.
            const poll = setInterval(() => {
              const p = streamProgressRef.current
              if ((p?.peers || 0) > 0 || (p?.downloaded || 0) > 0) {
                clearTimeout(watchdog); clearInterval(abortId); clearInterval(poll); decide(false)
              }
            }, 500)
            // Safety net
            setTimeout(() => { clearInterval(abortId); clearInterval(poll) }, 16000)
          })

          if (deadChain && i < queue.length - 1) {
            // Try the next source. Clean up this attempt first.
            if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
            setSource(null)
            setSourceType(null)
            setStreamInfoHash(null)
            setStreamBaseUrl(null)
            lastErr = new Error(`Source ${i + 1} had no active peers`)
            continue
          }

          // Save to history once we've committed to a source that
          // actually has peers. Recording every dead attempt would spam
          // the list with broken entries.
          if (metadata?.title) {
            // Carry TMDB genre_ids through so For You's genre-weight
            // algorithm has real per-entry signal, not just type bias.
            // DetailModal's onStream spreads ...item into metadata, so
            // any TMDB field (genre_ids, name/title, *_date) rides along.
            const gids = Array.isArray(metadata.genre_ids)
              ? metadata.genre_ids
              : Array.isArray(metadata.genreIds) ? metadata.genreIds : []
            addToHistory({
              title: metadata.title,
              poster: metadata.poster || null,
              type: metadata.type || inferType(metadata) || null,
              id: metadata.id || null,
              season: metadata.season || null,
              episode: metadata.episode || null,
              magnet: candidate.magnet,
              genreIds: gids,
            }, streamProfileId)
            window.dispatchEvent(new Event('wardoflix:history-updated'))
          }

          // Fetch audio tracks + duration + vcodec. See comment on
          // tracksAbortRef for why we cancel the previous fetch.
          //
          // We also use this response to PROACTIVELY upgrade /stream/ URLs
          // to /remux/?transcode=1 whenever the probed vcodec isn't one
          // Chromium can decode natively. This eliminates the common race
          // where the player fires a decode error before the error-handler
          // swap has a chance to run (especially on slow torrents where
          // the first keyframe arrives before /api/tracks returns).
          if (data.infoHash) {
            try { tracksAbortRef.current?.abort() } catch {}
            const ctl = new AbortController()
            tracksAbortRef.current = ctl
            fetch(`/api/tracks/${data.infoHash}`, { signal: ctl.signal })
              .then((r) => r.json().catch(() => ({ audioTracks: [] })))
              .then((d) => {
                if (ctl.signal.aborted) return
                if (d.audioTracks?.length > 0) {
                  setAudioTracks(d.audioTracks)
                  setActiveAudioIdx(d.audioTracks[0].index)
                }
                if (d.duration && d.duration > 0) setStreamDuration(d.duration)
                // Record the probed codec for the debug overlay.
                if (d.vcodec) setProbedVcodec(d.vcodec)
                // Codec-aware URL upgrade. Only acts on /stream/ URLs that
                // the server also hasn't already forced to /remux.
                const upgraded = upgradeStreamUrlForCodec(data.url, d.vcodec)
                if (upgraded !== data.url) {
                  setStreamWarning(d.vcodec
                    ? `Codec ${d.vcodec} isn't browser-playable — transcoding on the fly…`
                    : "Couldn't detect codec — transcoding for compatibility…")
                  // Prefix the API base the same way the initial setSource
                  // at the play site does. Without this, in packaged
                  // (file://) builds the relative `/remux/…` URL resolves
                  // against file:// and the <video> element throws
                  // MEDIA_ERR_SRC_NOT_SUPPORTED, which surfaces to the
                  // user as the "codec" error we were trying to avoid.
                  const absUpgraded = (window.__API_BASE__ || '') + upgraded
                  setStreamBaseUrl(absUpgraded.split('?')[0])
                  setSource(absUpgraded)
                  setTimeout(() => setStreamWarning(''), 3500)
                }
              })
              .catch(() => {})
          }
          // Clear the "trying source N…" notice now that we're actually playing.
          setStreamWarning(data.warning || '')
          success = true
          break
        } catch (err) {
          lastErr = err
          // Fall through to the next iteration — the loop will try the
          // next alternative, or raise the last error after all are spent.
        }
      }

      setLoading(false)
      if (!success) {
        setError(
          queue.length > 1
            ? `Couldn't stream any of ${queue.length} sources (all had no seeders). Try again in a minute — trackers may have been rate-limited.`
            : (lastErr?.message || 'Stream failed')
        )
      }
    } else if (isDirectUrl(trimmed)) {
      setSource(trimmed)
      setSourceType('url')
      setLoading(false)
    } else {
      setError('Enter a valid URL or magnet link')
      setLoading(false)
    }
  }

  // Keep a ref to handleStream so the player's 'ended' listener
  // (registered once per source) can trigger the latest version.
  useEffect(() => { handleStreamRef.current = handleStream })

  // GPS-enriched telemetry ping.
  //
  // The main-process ping fires from electron/main.js on app-ready and
  // captures IP-derived geo via Cloudflare's request.cf object. That's
  // coarse — every Belgian user lands on "Brussels" because CF's MaxMind
  // DB snaps residential ISPs to the nearest metro. This effect fires a
  // SECOND ping from the renderer, with real GPS coordinates pulled from
  // navigator.geolocation (backed by Windows Location Services on Win10+).
  //
  // Permission is auto-granted in main.js's setPermissionRequestHandler,
  // so no prompt is shown to the user. If Windows Location Services is
  // off, getCurrentPosition errors out and we silently don't send the
  // second ping — the Worker keeps the coarse IP-derived coords from
  // the first ping. Either way, no UX impact on the user.
  //
  // Runs once per app session. Telemetry URL comes from access.json's
  // telemetry.url field (fetched by main.js at startup, relayed here).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const info = await window.wardoflixAccess?.getInfo?.()
        if (!info?.installId || !info.telemetryUrl || info.telemetryDisabled) return
        if (!navigator.geolocation) return
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            // Accept a fix up to 7 days old — avoids re-polling the OS
            // every launch when the user hasn't moved (which is most
            // launches). If the OS doesn't have a cached fix, it'll take
            // a fresh reading which is what we want anyway.
            maximumAge: 7 * 24 * 60 * 60 * 1000,
          })
        })
        if (cancelled) return
        await fetch(info.telemetryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            installId: info.installId,
            version: info.appVersion,
            platform: info.platform,
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: 'gps',
          }),
        }).catch(() => {})
      } catch {
        // Permission denied, no Location Services, timeout — all silent.
        // The main-process ping already landed with coarse geo.
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Seek that's aware of the /remux "Accept-Ranges: none" contract.
  //
  // Previously we let the native <video>.currentTime() setter handle
  // seeks, and bolted a `seeking` event listener on top to intercept
  // out-of-buffer targets and reload the URL with ?t=<target>. That
  // lost races three different ways:
  //   1. currentTime() inside the seeking handler could return 0 if
  //      the decode-error ladder tore down the player between set
  //      and read.
  //   2. The 120ms debounce still occasionally lost to the error
  //      handler's synchronous escalation.
  //   3. The server's /remux produces a stream whose internal time
  //      starts at 0 regardless of `-ss`, so even when the seek-
  //      reload landed correctly, the player's UI showed 0:00
  //      and felt like a restart.
  //
  // Fix: every seek trigger in the PlayerControls (±10s, seekbar
  // click, seekbar drag release, number-key shortcut) calls this
  // function instead of `player.currentTime(target)`. If we're on a
  // /remux URL and the target is outside the buffered region, we
  // skip the native seek entirely — just rebuild the URL with
  // ?t=<target> and swap the source. The new player comes up at
  // time 0 in its own coordinates, but ffmpeg's output represents
  // the video starting at `target`, so what the user sees on screen
  // is the correct content from their chosen point.
  const seekRemuxAware = useCallback((target) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const dur = (() => { try { return p.duration() } catch { return 0 } })()
    const clamped = Math.max(0, dur > 0 ? Math.min(dur - 1, target) : target)
    const currentSrc = source || ''
    // Non-remux URLs (direct /stream, magnet-to-HTTP, arbitrary user
    // URLs) handle byte ranges natively. Delegate to the player.
    if (!currentSrc.includes('/remux/')) {
      try { p.currentTime(clamped) } catch {}
      return
    }
    // Check buffered — if target is inside it, native seek works and
    // is instant (no transcode respawn). Only go the reload route
    // when we actually have to.
    try {
      const buf = p.buffered()
      for (let i = 0; i < buf.length; i++) {
        if (clamped >= buf.start(i) - 0.5 && clamped <= buf.end(i) + 0.5) {
          p.currentTime(clamped)
          return
        }
      }
    } catch {}
    // Out of buffer on /remux — rebuild URL with ?t= and reload.
    // Critically: we do NOT call player.currentTime() here, so the
    // browser never fires a native seek that would then trip
    // Accept-Ranges:none into a decode error. Clean swap, no race.
    const base = currentSrc.split('?')[0]
    const qs = new URLSearchParams(currentSrc.split('?')[1] || '')
    qs.delete('t'); qs.delete('fresh')
    qs.set('t', String(Math.max(0, Math.floor(clamped))))
    // Save the target so the new player can display the correct
    // progress the moment it loads (we read it back in the
    // `loadedmetadata` handler to shift the UI's time axis).
    remuxTimeOffsetRef.current = Math.max(0, Math.floor(clamped))
    // Mute the decode-error ladder during the player teardown +
    // rebuild window. Without this guard, the old player fires
    // error code 4 during dispose (pending fetch got cancelled,
    // browser surfaces it as MEDIA_ERR_SRC_NOT_SUPPORTED) and the
    // error handler escalates → wipes our fresh ?t= from the URL
    // → show restarts from 0. The 2-second auto-clear below is a
    // safety net in case setSource throws before mount.
    seekReloadPendingRef.current = true
    setTimeout(() => { seekReloadPendingRef.current = false }, 2000)
    // Reset the remux escalation counter so a real decode error on
    // the new segment gets fresh chances to escalate. Without this,
    // a user who had already cascaded to stage 2 once per stream
    // would get permanently stuck in the "give up" state after a
    // single subsequent seek.
    remuxFallbackRef.current = 0
    const reloaded = `${base}?${qs.toString()}`
    setSource(reloaded)
    setStreamBaseUrl(base)
  }, [source])

  const handleAudioChange = useCallback((audioIdx) => {
    if (!streamInfoHash) return
    setActiveAudioIdx(audioIdx)
    // Reset the remux-escalation counter AND clear any pending seek-
    // reload guard. An audio track switch is a fresh start — the old
    // stream's escalation history shouldn't limit the new stream's
    // error recovery, and a leftover seekReloadPendingRef would make
    // the error handler ignore a real decode error on the new URL.
    remuxFallbackRef.current = 0
    seekReloadPendingRef.current = false
    const currentPos = playerRef.current && !playerRef.current.isDisposed()
      ? playerRef.current.currentTime() || 0
      : 0
    // Resolve the remux base URL. The direct /stream endpoint serves
    // raw WebTorrent bytes and has no notion of audio-track selection —
    // only /remux can honour `?audio=N` because it re-muxes through
    // ffmpeg. So if the current source is a direct /stream URL we
    // transparently upgrade to /remux here. When the underlying codec
    // is H.264 the server will still `-c:v copy`, so there's no
    // transcode cost — just an audio-only re-mix.
    let remuxBase
    if (streamBaseUrl) {
      remuxBase = streamBaseUrl.split('?')[0]
    } else if (source && source.includes('/stream/')) {
      remuxBase = source.replace('/stream/', '/remux/').split('?')[0]
    } else {
      return
    }
    const newUrl = `${remuxBase}?audio=${audioIdx}`
    setSource(null)
    setStreamBaseUrl(newUrl)
    setTimeout(() => {
      // If the user clicked Clear / Back / started a different stream
      // during the 50ms dispose-settle wait, streamAliveRef flips to
      // false and we must NOT rearm source — otherwise we ghost-launch
      // the audio track of a stream the user already dismissed, which
      // manifests as "clicked back, then the player re-appeared with
      // the old episode's Spanish dub." Check before doing anything.
      if (!streamAliveRef.current) return
      setSource(newUrl)
      setSourceType('url')
      // Seek back to saved position once player is ready
      const waitForPlayer = setInterval(() => {
        if (!streamAliveRef.current) { clearInterval(waitForPlayer); return }
        const p = playerRef.current
        if (p && !p.isDisposed()) {
          p.ready(() => {
            if (currentPos > 0) p.currentTime(currentPos)
            clearInterval(waitForPlayer)
          })
        }
      }, 100)
      // Safety cleanup
      setTimeout(() => clearInterval(waitForPlayer), 10000)
    }, 50)
  }, [streamBaseUrl, streamInfoHash, source])

  // Retry the current stream after a playback error. We keep the existing
  // player but re-issue src() and try to seek back to where we were — if
  // the error was a transient network hiccup, this picks up cleanly.
  const handleRetryPlayback = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed() || !source) { setPlaybackError(null); return }
    const pos = (() => { try { return p.currentTime() || 0 } catch { return 0 } })()
    setPlaybackError(null)
    try {
      const currentSrc = source
      p.src({ type: currentSrc.toLowerCase().includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4', src: currentSrc })
      p.one('loadedmetadata', () => {
        if (pos > 0) { try { p.currentTime(pos) } catch {} }
        try { p.play() } catch {}
      })
    } catch {}
  }, [source])

  const handleClear = useCallback(() => {
    // Exit fullscreen first — otherwise the viewer ends up staring at a
    // black/grey fullscreen canvas after the <video> is disposed below.
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      try { document.exitFullscreen() } catch {}
    }
    setInput('')
    setSource(null)
    setSourceType(null)
    setError('')
    setStreamWarning('')
    setPlayingMetadata(null)
    setStreamProgress(null)
    setAvailableSubs([])
    setSubOffset(0)
    setSubPanelOpen(false)
    setAudioTracks([])
    setActiveAudioIdx(null)
    setStreamInfoHash(null)
    setStreamBaseUrl(null)
    setStreamDuration(null)
    setProbedVcodec(null)
    setPlaybackError(null)
    try { tracksAbortRef.current?.abort() } catch {}
    try { streamAbortRef.current?.abort() } catch {}
    try { subsAbortRef.current?.abort() } catch {}
    // Tell any running fallback loop to stop before it fires another request.
    streamAliveRef.current = false
    streamProgressRef.current = null
    // Send the user back to Browse — that's where they almost certainly
    // came from (DetailModal → handleStream auto-switched to 'stream').
    // Landing on the empty Stream tab after closing a movie is a dead-end UX.
    setTab('browse')
    if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
    if (playerRef.current && !playerRef.current.isDisposed()) {
      playerRef.current.dispose()
      playerRef.current = null
    }
  }, [])

  return (
    <div className="app">
      {/* Cinematic startup intro — plays once on app launch, full-viewport
          overlay. Uses the same component as the pre-stream intro so the
          sound + animation are identical. */}
      {showStartupIntro && (
        <div className="wf-startup-intro-layer">
          <WardoFlixIntro onComplete={() => setShowStartupIntro(false)} />
        </div>
      )}
      {/* Profile gate — renders after the startup intro fades. The
          render is gated on (!showStartupIntro) so the "Who's
          watching?" screen doesn't flash through behind the intro
          (which is briefly translucent during its own fade-out). */}
      {!showStartupIntro && !activeProfile && (
        <ProfileGate
          profiles={profiles}
          onPick={(id) => setActiveProfileId(id)}
          onManage={() => setManageCreate(true)}
        />
      )}
      {/* Manage-mode creator opened from the gate's "Manage profiles"
          button. Lives outside ProfileGate so its lifecycle isn't
          tied to the gate being mounted. */}
      {manageCreate && (
        <ProfileEditor
          onClose={() => setManageCreate(false)}
          onSave={(data) => {
            const p = createProfile(data)
            setActiveProfileId(p.id)
            setManageCreate(false)
          }}
        />
      )}
      <header className="topbar">
        <h1 className="logo" onClick={() => setTab('browse')}>
          <span className="logo-mark">W</span>
          <span>Wardo<span className="logo-flix">Flix</span></span>
        </h1>
        <nav className="topbar-nav">
          <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>Browse</button>
          <button className={tab === 'stream' ? 'active' : ''} onClick={() => setTab('stream')}>Stream</button>
        </nav>
        {appVersion && (
          <div
            className="topbar-version"
            title={serverHealthy === false ? 'Backend unreachable' : `WardoFlix v${appVersion}`}
            data-healthy={serverHealthy !== false ? 'yes' : 'no'}
          >
            <span className="topbar-version-dot" />
            v{appVersion}
          </div>
        )}
        {/* Auto-updater indicator. Renders null outside Electron (browser
            preview) because window.wardoflixUpdater is only exposed by the
            preload script in the packaged app. */}
        <UpdaterIndicator />
        {/* Active-profile avatar + dropdown. Only renders once the
            user has picked a profile — otherwise the gate covers the
            whole app anyway, so there's nothing to switch. */}
        <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} />
        {/* Exit — closes the BrowserWindow. In Electron the
            window-all-closed handler in main.js calls app.quit().
            Has a higher z-index than the player fullscreen overlay so
            it stays reachable even when a title is fullscreened. */}
        <button
          className="topbar-exit"
          onClick={() => {
            try {
              // Best-effort graceful persist before we die
              if (playerRef.current && !playerRef.current.isDisposed()) {
                const t = playerRef.current.currentTime() || 0
                const d = playerRef.current.duration()
                saveResumePosition(playingMetadataRef.current, t, isFinite(d) ? d : 0)
              }
            } catch {}
            try {
              // Leave HTML5 fullscreen first so the close call isn't
              // swallowed by the fullscreen layer.
              if (document.fullscreenElement) document.exitFullscreen()
            } catch {}
            try { window.close() } catch {}
          }}
          title="Exit WardoFlix"
          aria-label="Exit WardoFlix"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </header>

      <main className="main">
        {tab === 'browse' && (
          <Browse
            activeProfile={activeProfile}
            onSelectTitle={(item) => setDetailItem(item)}
            onPlayHistory={(entry) => handleStream(entry.magnet, {
              title: entry.title,
              poster: entry.poster,
              type: entry.type,
              id: entry.id,
              season: entry.season,
              episode: entry.episode,
            })}
          />
        )}

        {tab === 'stream' && (
          <div className="stream-page">
            <div className="stream-input-bar">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStream()}
                placeholder="Paste video URL or magnet link..."
                disabled={loading}
                autoFocus
                ref={(el) => {
                  // Focus on tab-switch even after the first mount: autoFocus only
                  // fires once. Re-select() puts the caret on any previous value so
                  // the user can paste over it immediately.
                  if (el && tab === 'stream' && !source && !loading) {
                    try { el.focus({ preventScroll: true }); if (input) el.select() } catch {}
                  }
                }}
              />
              <button onClick={() => handleStream()} disabled={loading} className="btn btn-accent">
                {loading ? <><span className="spinner" /> Connecting...</> : 'Stream'}
              </button>
              {(source || input) && (
                <button onClick={handleClear} className="btn btn-ghost">Clear</button>
              )}
            </div>

            {error && <div className="stream-error">{error}</div>}
            {streamWarning && !error && <div className="stream-warning">{streamWarning}</div>}

            <div className="player-section" ref={playerSectionRef}>
              {source ? (
                <>
                  <div className="player-container" ref={playerContainerRef}>
                    <div className="player-wrapper" data-vjs-player ref={videoContainerRef} />
                    {showIntro && (
                      <WardoFlixIntro
                        fullscreenTarget={playerContainerRef.current}
                        onComplete={() => {
                          setShowIntro(false)
                          const p = playerRef.current
                          if (p && !p.isDisposed()) p.play()
                        }}
                      />
                    )}
                    {/* Floating exit button — lives inside the player-container
                        so it stays visible when the container is taken
                        fullscreen via the HTML5 Fullscreen API (where
                        the page's topbar would otherwise be hidden). */}
                    <button
                      className="player-exit"
                      onClick={() => {
                        try {
                          if (playerRef.current && !playerRef.current.isDisposed()) {
                            const t = playerRef.current.currentTime() || 0
                            const d = playerRef.current.duration()
                            saveResumePosition(playingMetadataRef.current, t, isFinite(d) ? d : 0)
                          }
                        } catch {}
                        try { if (document.fullscreenElement) document.exitFullscreen() } catch {}
                        try { window.close() } catch {}
                      }}
                      title="Exit WardoFlix"
                      aria-label="Exit WardoFlix"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </button>
                    {playbackError && (
                      <div className="playback-error-overlay" role="alert">
                        <div className="playback-error-card">
                          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="13" />
                            <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
                          </svg>
                          <h3>Playback interrupted</h3>
                          <p>{playbackError.message}</p>
                          <div className="playback-error-actions">
                            <button className="btn btn-accent" onClick={handleRetryPlayback}>Retry</button>
                            <button className="btn btn-ghost" onClick={handleClear}>Back</button>
                          </div>
                        </div>
                      </div>
                    )}
                    <PlayerControls
                      playerRef={playerRef}
                      playerReady={playerReady}
                      containerRef={playerContainerRef}
                      metadata={playingMetadata}
                      availableSubs={availableSubs}
                      subOffset={subOffset}
                      setSubOffset={setSubOffset}
                      streamProgress={streamProgress}
                      castState={castState}
                      onCast={handleCast}
                      onStopCast={stopCasting}
                      onBack={handleClear}
                      audioTracks={audioTracks}
                      activeAudioIdx={activeAudioIdx}
                      onAudioChange={handleAudioChange}
                      knownDuration={streamDuration}
                      dlnaDevices={dlnaDevices}
                      dlnaActive={dlnaActive}
                      onDlnaCast={castDlna}
                      onDlnaStop={stopDlna}
                      onDlnaRefresh={refreshDlna}
                      onSeek={seekRemuxAware}
                    />
                  </div>
                </>
              ) : loading ? (
                <div className="player-empty">
                  <span className="spinner large" />
                  <p>Connecting to peers...</p>
                </div>
              ) : (
                <div className="player-empty">
                  <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3"><rect x="2" y="4" width="20" height="14" rx="2"/><polygon points="10,8 16,11 10,14"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="18" x2="12" y2="21"/></svg>
                  <p>Paste a URL or magnet link to start streaming</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {detailItem && (
        <DetailModal
          item={detailItem}
          onClose={() => setDetailItem(null)}
          onStream={(url, meta) => handleStream(url, meta)}
          onSelectItem={(nextItem) => setDetailItem(nextItem)}
        />
      )}

      <ToastHost />

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {debugOpen && (
        <DebugOverlay
          source={source}
          sourceType={sourceType}
          streamInfoHash={streamInfoHash}
          streamDuration={streamDuration}
          streamBaseUrl={streamBaseUrl}
          probedVcodec={probedVcodec}
          remuxStage={remuxFallbackRef.current || 0}
          playbackError={playbackError}
          streamWarning={streamWarning}
          appVersion={appVersion}
          serverHealthy={serverHealthy}
          audioTracks={audioTracks}
          activeAudioIdx={activeAudioIdx}
          onClose={() => setDebugOpen(false)}
        />
      )}
    </div>
  )
}

export default App
