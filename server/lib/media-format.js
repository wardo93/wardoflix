// v1.14.0 — pure media/torrent format helpers, extracted from
// server/index.js so they're unit-testable in isolation (no Express,
// no WebTorrent client, no network, no module-level state). These are
// the "routing brain": they decide which file in a torrent to play,
// whether a stream needs transcoding, whether a torrent name matches
// the requested title, and validate magnets. A wrong answer here =
// black screen, wrong episode, or a rejected stream — so they're
// exactly the logic that most deserves test coverage (the QA review
// flagged them as high-value-untested). See test/media-format.test.js.
//
// Everything here is pure: same input → same output, no side effects.

// Video container extensions we recognise, in playback preference order
// (mp4 first — most browser-native; mkv/avi later — usually need remux).
export const PREFERRED_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.ogv', '.flv', '.wmv', '.ts', '.m2ts']

export function hasVideoExt(str) {
  return PREFERRED_EXTENSIONS.some((ext) => (str || '').toLowerCase().replace(/\\/g, '/').endsWith(ext))
}

export function parseSeasonEpisode(filename) {
  const m = (filename || '').match(/S(\d{1,4})E(\d{1,4})/i) || (filename || '').match(/(\d{1,2})x(\d{1,4})/i)
  return m ? { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) } : null
}

// Normalize a title or torrent name for fuzzy comparison.
// Lowercases, replaces all separators/punctuation with spaces, collapses whitespace.
export function normalizeForMatch(s) {
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
export function torrentMatchesTitle(torrentName, title) {
  if (!torrentName || !title) return false
  const t = normalizeForMatch(torrentName)
  const q = normalizeForMatch(title)
  if (!q || !t.startsWith(q)) return false
  const after = q.length
  // Char after must be end of string or whitespace (avoid partial-word matches)
  if (after < t.length && t[after] !== ' ') return false
  return true
}

export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return ''
  const b = Number(bytes)
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function pickBestVideoFile(files) {
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

export function mkvWarning(file) {
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
// route straight to /remux?transcode=1 instead of bouncing off a guaranteed
// MEDIA_ERR_DECODE. Word-ish boundaries so "x264" doesn't match "x265".
export function needsTranscodeFromName(file) {
  if (!file) return false
  const n = ((file.name || '') + ' ' + (file.path || '')).toLowerCase()
  return /(^|[^a-z0-9])(x[\s._-]?265|h[\s._-]?265|hevc|main10|10[\s._-]?bit|10b|av1|vp9|dovi|dv|hdr10)([^a-z0-9]|$)/.test(n)
}

export function parseInfoHash(magnet) {
  const m = String(magnet).match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

export function parseInfoHashFromError(errMsg) {
  const m = String(errMsg || '').match(/([a-fA-F0-9]{40})/)
  return m ? m[1].toLowerCase() : null
}

// Given an episode pack, pick the file that matches the user's requested
// season/episode. Falls back to null if we can't resolve unambiguously —
// the caller then defaults to pickBestVideoFile's largest-video heuristic.
export function pickEpisodeFile(files, season, episode) {
  if (!files || !Number.isFinite(season) || !Number.isFinite(episode)) return null
  const s = Number(season), e = Number(episode)
  const candidates = files.filter(f => (f.length || 0) > 10 * 1024 * 1024 && (hasVideoExt(f.name) || hasVideoExt(f.path)))
  // Accept any of the common episode-tag formats:
  //   S01E01 / s1e1 / 1x01 / 01x01 / season1ep1
  const match = candidates.find(f => {
    const name = (f.name || '').toLowerCase()
    if (new RegExp(`\\bs0*${s}[ _.-]?e0*${e}\\b`, 'i').test(name)) return true
    if (new RegExp(`\\b0*${s}\\s*x\\s*0*${e}\\b`, 'i').test(name)) return true
    if (new RegExp(`season\\s*0*${s}.{0,3}ep(?:isode)?\\s*0*${e}\\b`, 'i').test(name)) return true
    return false
  })
  return match || null
}

// Pull "Stream #0:N: Video: <codec>" out of ffmpeg stderr. Tolerates the
// optional (lang) and [0x1] stream-id annotations some builds emit.
export function parseVideoCodec(stderr) {
  const m = String(stderr || '').match(/Stream #0:\d+(?:\s*[(\[][^)\]]*[)\]])*\s*:\s*Video:\s*([a-z0-9_]+)/i)
  return m ? m[1].toLowerCase() : null
}

// Strict magnet validation before anything reaches WebTorrent.
export function isWellFormedMagnet(raw) {
  if (typeof raw !== 'string') return false
  const m = raw.trim()
  if (m.length < 60 || m.length > 8192) return false
  if (!m.toLowerCase().startsWith('magnet:?')) return false
  // Info-hash is mandatory and must be hex(40) or base32(32).
  const hashMatch = m.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})\b/)
  return Boolean(hashMatch)
}
