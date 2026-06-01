// URL helpers for the streaming pipeline. See comments inside each
// function for context on the bugs they exist to prevent.

import { BROWSER_SAFE_VCODECS } from './util.js'

// Given a server stream URL and a probed vcodec, return the URL the
// player should actually load. If the URL is already /remux/... we
// leave it alone. If it's /stream/... and the codec is known-unsafe
// (HEVC, AV1, VP9…) OR unknown (null — probe timed out on a slow
// torrent), upgrade to /remux/?transcode=1 so ffmpeg transcodes via
// libx264.
//
// This is the proactive path — the error handler's /stream/ → /remux/
// swap is now a safety net for the rare case where the probe lied or
// was racing.
export function upgradeStreamUrlForCodec(url, vcodec) {
  if (!url || !url.includes('/stream/')) return url
  if (vcodec && BROWSER_SAFE_VCODECS.has(vcodec)) return url
  const swapped = url.replace('/stream/', '/remux/')
  const sep = swapped.includes('?') ? '&' : '?'
  return `${swapped}${sep}transcode=1`
}

// v1.14.6 — clamp a seek target to the real movie duration.
//
// The forward-seek bug: the seek path used to clamp against
// player.duration(), which on a live /remux transcode is the BUFFERED
// length (~30s), not the full movie. So every forward seek got pulled
// back to ~the current position ("can't play past what's buffered").
// Clamp to the ffprobed full duration when we have it; otherwise return
// the target unclamped and let the server clamp to the actual file
// length. Never clamp against the unreliable buffered length.
export function clampSeekTarget(target, fullDur) {
  const t = Math.max(0, Number(target) || 0)
  return (fullDur && fullDur > 0) ? Math.min(fullDur - 1, t) : t
}

// v1.14.4 — parse the /remux ?t= offset (seconds) out of a source URL.
// A /remux transcode that started at ?t=N has a LOCAL time axis (the
// player's currentTime() is 0 at content-second N), so the real movie
// position is currentTime() + this offset. Used both to DISPLAY the
// right time on the seekbar AND — the actual resume fix — to SAVE the
// absolute position (the save side was storing raw local currentTime,
// which is why resume never had a usable value). Returns 0 for /stream
// URLs, missing/zero t, or anything unparseable.
export function parseRemuxOffset(url) {
  try {
    if (typeof url !== 'string' || !url.includes('/remux/')) return 0
    const qs = new URLSearchParams(url.split('?')[1] || '')
    const t = parseFloat(qs.get('t') || '0')
    return Number.isFinite(t) && t > 0 ? t : 0
  } catch { return 0 }
}

// v1.14.2 — merge a resume position into a /remux URL as ?t=<sec>.
//
// This is THE fix for the long-standing "Continue Watching restarts from
// the beginning" bug. A /remux transcode is served non-byte-seekable
// (Accept-Ranges: none), so resuming means restarting the transcode at
// ?t=<sec> — NOT player.currentTime(). The bug that survived ~15 fix
// attempts: several async code paths (codec upgrade, audio-track
// re-issue) re-issue setSource a second or two AFTER playback starts,
// each rebuilding the URL from scratch and DROPPING the ?t=. So resume
// applied, then got clobbered → restart from 0. Funnelling every /remux
// URL through this helper keeps ?t= attached no matter which path set
// the source.
//
// No-op for: /stream URLs (byte-seekable; use currentTime instead),
// a 0/absent resume, or a URL that already carries ?t= (don't override
// an explicit seek). Preserves all other query params via URLSearchParams.
export function withResumeTime(url, resumeSec) {
  if (!resumeSec || resumeSec <= 0 || typeof url !== 'string' || !url.includes('/remux/')) return url
  if (/[?&]t=/.test(url)) return url
  const [base, q] = url.split('?')
  const qs = new URLSearchParams(q || '')
  qs.set('t', String(Math.floor(resumeSec)))
  return `${base}?${qs.toString()}`
}

// Normalise any server-relative URL to an absolute one before it reaches
// the <video> element. In packaged builds the document base is file://,
// which resolves `/remux/…` to `file:///remux/…` — the browser then
// fires MEDIA_ERR_SRC_NOT_SUPPORTED. We hit this repeatedly because
// setSource is called from half a dozen code paths and it's easy for
// one of them to forget the prefix. Funnelling every setSource through
// this helper makes the fix location-agnostic.
export function toAbsStreamUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (/^(https?:|blob:|data:)/i.test(url)) return url
  if (!/^\/(stream|remux|trailer|api)\b/.test(url)) return url
  const base = (typeof window !== 'undefined' && window.__API_BASE__) || ''
  return base + url
}
