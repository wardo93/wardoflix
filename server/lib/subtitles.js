// v1.14.0 — pure subtitle format helpers, extracted from
// server/index.js. SRT→VTT conversion and timestamp shifting are pure
// string transforms with no I/O, so they're trivially testable. The
// /api/subtitles + /api/subtitles/proxy routes (with their host
// cooldown + VTT cache) stay in index.js and call these.

// Convert SRT → WebVTT (header + comma→dot in timestamps).
export function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt || '')
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
}

// Shift every WebVTT timestamp by `offsetSec` seconds (may be negative).
// Used to fix subs that are out of sync with the video. Clamps at 0.
export function shiftVttTimestamps(vtt, offsetSec) {
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
