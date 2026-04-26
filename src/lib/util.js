// Pure JS helpers — no React, no DOM. Exported because they were
// previously cluttering the top of App.jsx (5,833 lines), and you
// can't reason about a 5k-line file. Each function lives here so
// the renderer can import the ones it needs and not pull in the
// world. None of these depend on browser APIs except where the
// signature documents it (formatBytes/formatSpeed never touch
// `window`, etc.).

export const isMagnetLink = (str) => str?.trim().toLowerCase().startsWith('magnet:')
export const isDirectUrl = (str) => {
  const t = str?.trim() || ''
  return t.startsWith('http://') || t.startsWith('https://')
}

// Codecs Chromium can decode natively. Mirror of the set in server/index.js
// — kept deliberately narrow: even MPEG-4 ASP and VP8 can trip old builds,
// so we default anything we don't explicitly trust through /remux.
export const BROWSER_SAFE_VCODECS = new Set(['h264', 'avc1'])

// Human-readable audio track label. The server gives us raw ffmpeg
// codec names and channel layouts; we format them into the style
// Netflix/Plex use — "English (AAC 5.1)" or "Japanese — Director's
// commentary (Opus Stereo)". Falls back gracefully on partial data.
export function formatAudioTrackLabel(t) {
  if (!t) return ''
  const parts = []
  parts.push(t.langName || t.lang || `Track ${t.index}`)
  if (t.title) parts.push(`— ${t.title}`)
  const tech = []
  if (t.codec) tech.push(t.codec.toUpperCase())
  if (t.layout) {
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

// Seed-count health buckets — drives the color-coded dot next to each
// torrent in the picker. <1 = dead, 1-4 = risky, 5-14 = ok, 15+ = healthy.
export function seedHealth(n) {
  const s = Number(n) || 0
  if (s === 0) return 'dead'
  if (s < 5) return 'risky'
  if (s < 15) return 'ok'
  return 'healthy'
}
export function seedHealthLabel(n) {
  const s = Number(n) || 0
  if (s === 0) return 'No seeders — this torrent will not start. We will auto-fall-back to the next source.'
  if (s < 5) return `${s} seeder${s === 1 ? '' : 's'} — risky. Stream may stall.`
  if (s < 15) return `${s} seeders — should work, no margin.`
  return `${s} seeders — healthy.`
}

// Figure out whether a picked item is a TV show or a movie. Explicit
// `type` field always wins; otherwise we infer from the TMDB shape.
export function inferType(item) {
  if (!item) return 'movies'
  const t = item.type
  if (t === 'tv' || t === 'series') return 'tv'
  if (t === 'movies' || t === 'movie') return 'movies'
  if (item.first_air_date && !item.release_date) return 'tv'
  if (item.release_date && !item.first_air_date) return 'movies'
  if (item.name && !item.title) return 'tv'
  return 'movies'
}

export function formatSpeed(bytes) {
  if (!bytes || bytes < 1024) return '0 KB/s'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB/s`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`
}

// Seconds → "M:SS" or "H:MM:SS" (when ≥ 1h). Never NaN-displays.
export function formatTime(sec) {
  if (!sec || !Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// Short crypto-grade UUID for IDs that don't need to be RFC4122. Falls
// back when crypto.randomUUID isn't available (older Electron).
export function uuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID() } catch {}
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}
