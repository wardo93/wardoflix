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
