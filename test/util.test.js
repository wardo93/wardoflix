// v1.11.0 — first real test file. Covers the pure helpers in
// src/lib/util.js and src/lib/url.js. These are the lowest-risk
// functions to test (no DOM, no localStorage, no network) and the
// highest-payoff if they break (every stream URL goes through
// toAbsStreamUrl; every codec decision goes through
// upgradeStreamUrlForCodec; every magnet validation hits
// isMagnetLink).

import { describe, it, expect } from 'vitest'
import {
  isMagnetLink,
  isDirectUrl,
  BROWSER_SAFE_VCODECS,
  formatAudioTrackLabel,
  seedHealth,
  seedHealthLabel,
  inferType,
  formatSpeed,
  formatTime,
  uuid,
} from '../src/lib/util.js'
import { upgradeStreamUrlForCodec, toAbsStreamUrl, withResumeTime, parseRemuxOffset } from '../src/lib/url.js'

describe('isMagnetLink', () => {
  it('accepts valid magnet URIs (case insensitive)', () => {
    expect(isMagnetLink('magnet:?xt=urn:btih:abc')).toBe(true)
    expect(isMagnetLink('MAGNET:?xt=urn:btih:abc')).toBe(true)
    expect(isMagnetLink('  magnet:?xt=urn:btih:abc  ')).toBe(true)
  })
  it('rejects non-magnet strings', () => {
    expect(isMagnetLink('http://example.com')).toBe(false)
    expect(isMagnetLink('')).toBe(false)
    expect(isMagnetLink(null)).toBeFalsy()
    expect(isMagnetLink(undefined)).toBeFalsy()
  })
})

describe('isDirectUrl', () => {
  it('accepts http and https', () => {
    expect(isDirectUrl('http://example.com')).toBe(true)
    expect(isDirectUrl('https://example.com')).toBe(true)
    expect(isDirectUrl('  https://example.com  ')).toBe(true)
  })
  it('rejects magnets and others', () => {
    expect(isDirectUrl('magnet:?xt=urn:btih:abc')).toBe(false)
    expect(isDirectUrl('ftp://example.com')).toBe(false)
    expect(isDirectUrl('')).toBe(false)
    expect(isDirectUrl(null)).toBe(false)
  })
})

describe('BROWSER_SAFE_VCODECS', () => {
  it('includes h264 / avc1 only', () => {
    expect(BROWSER_SAFE_VCODECS.has('h264')).toBe(true)
    expect(BROWSER_SAFE_VCODECS.has('avc1')).toBe(true)
    expect(BROWSER_SAFE_VCODECS.has('hevc')).toBe(false)
    expect(BROWSER_SAFE_VCODECS.has('av1')).toBe(false)
    expect(BROWSER_SAFE_VCODECS.has('vp9')).toBe(false)
  })
})

describe('formatAudioTrackLabel', () => {
  it('formats lang + codec + layout', () => {
    expect(formatAudioTrackLabel({
      lang: 'en', langName: 'English', codec: 'aac', layout: '5.1',
    })).toBe('English (AAC 5.1)')
  })
  it('handles missing title / layout', () => {
    expect(formatAudioTrackLabel({ langName: 'Japanese', codec: 'opus' }))
      .toBe('Japanese (OPUS)')
  })
  it('falls back to track index when lang missing', () => {
    expect(formatAudioTrackLabel({ index: 2, codec: 'ac3' }))
      .toBe('Track 2 (AC3)')
  })
  it('includes track title', () => {
    expect(formatAudioTrackLabel({
      lang: 'en', langName: 'English', title: "Director's cut", codec: 'aac', layout: 'stereo',
    })).toBe("English — Director's cut (AAC Stereo)")
  })
  it('returns empty string on null', () => {
    expect(formatAudioTrackLabel(null)).toBe('')
    expect(formatAudioTrackLabel(undefined)).toBe('')
  })
})

describe('seedHealth', () => {
  it('classifies seeder counts', () => {
    expect(seedHealth(0)).toBe('dead')
    expect(seedHealth(1)).toBe('risky')
    expect(seedHealth(4)).toBe('risky')
    expect(seedHealth(5)).toBe('ok')
    expect(seedHealth(14)).toBe('ok')
    expect(seedHealth(15)).toBe('healthy')
    expect(seedHealth(9999)).toBe('healthy')
  })
  it('handles non-numbers gracefully', () => {
    expect(seedHealth(null)).toBe('dead')
    expect(seedHealth('foo')).toBe('dead')
    expect(seedHealth(undefined)).toBe('dead')
  })
})

describe('seedHealthLabel', () => {
  it('produces a sensible message for each bucket', () => {
    expect(seedHealthLabel(0)).toMatch(/will not start/)
    expect(seedHealthLabel(1)).toMatch(/1 seeder/)
    expect(seedHealthLabel(3)).toMatch(/3 seeders/)
    expect(seedHealthLabel(10)).toMatch(/no margin/)
    expect(seedHealthLabel(50)).toMatch(/healthy/)
  })
})

describe('inferType', () => {
  it('honours explicit type', () => {
    expect(inferType({ type: 'tv' })).toBe('tv')
    expect(inferType({ type: 'series' })).toBe('tv')
    expect(inferType({ type: 'movie' })).toBe('movies')
    expect(inferType({ type: 'movies' })).toBe('movies')
  })
  it('infers from date fields', () => {
    expect(inferType({ first_air_date: '2020-01-01' })).toBe('tv')
    expect(inferType({ release_date: '2020-01-01' })).toBe('movies')
  })
  it('infers from name vs title', () => {
    expect(inferType({ name: 'Breaking Bad' })).toBe('tv')
    expect(inferType({ title: 'Inception' })).toBe('movies')
  })
  it('defaults to movies on empty', () => {
    expect(inferType({})).toBe('movies')
    expect(inferType(null)).toBe('movies')
  })
})

describe('formatSpeed', () => {
  it('formats bytes/sec at each scale', () => {
    expect(formatSpeed(0)).toBe('0 KB/s')
    expect(formatSpeed(512)).toBe('0 KB/s')
    expect(formatSpeed(2048)).toBe('2 KB/s')
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s')
    expect(formatSpeed(5 * 1024 * 1024)).toBe('5.0 MB/s')
  })
  it('handles falsy input', () => {
    expect(formatSpeed(null)).toBe('0 KB/s')
    expect(formatSpeed(undefined)).toBe('0 KB/s')
    expect(formatSpeed(NaN)).toBe('0 KB/s')
  })
})

describe('formatTime', () => {
  it('formats seconds to M:SS / H:MM:SS', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(7)).toBe('0:07')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(125)).toBe('2:05')
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3661)).toBe('1:01:01')
    expect(formatTime(7325)).toBe('2:02:05')
  })
  it('never displays NaN', () => {
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
    expect(formatTime(-50)).toBe('0:00')
    expect(formatTime(null)).toBe('0:00')
    expect(formatTime(undefined)).toBe('0:00')
  })
})

describe('uuid', () => {
  it('produces unique strings', () => {
    const ids = new Set()
    for (let i = 0; i < 100; i++) ids.add(uuid())
    expect(ids.size).toBe(100)
  })
  it('returns a non-empty string', () => {
    expect(typeof uuid()).toBe('string')
    expect(uuid().length).toBeGreaterThan(8)
  })
})

describe('upgradeStreamUrlForCodec', () => {
  const STREAM = 'http://localhost:3000/stream/abc/file.mp4'

  it('leaves non-/stream URLs untouched', () => {
    const remux = 'http://localhost:3000/remux/abc/file.mp4'
    expect(upgradeStreamUrlForCodec(remux, 'hevc')).toBe(remux)
  })
  it('leaves h264 alone', () => {
    expect(upgradeStreamUrlForCodec(STREAM, 'h264')).toBe(STREAM)
    expect(upgradeStreamUrlForCodec(STREAM, 'avc1')).toBe(STREAM)
  })
  it('upgrades unsafe codecs to /remux?transcode=1', () => {
    expect(upgradeStreamUrlForCodec(STREAM, 'hevc'))
      .toBe('http://localhost:3000/remux/abc/file.mp4?transcode=1')
    expect(upgradeStreamUrlForCodec(STREAM, 'av1'))
      .toBe('http://localhost:3000/remux/abc/file.mp4?transcode=1')
    expect(upgradeStreamUrlForCodec(STREAM, 'vp9'))
      .toBe('http://localhost:3000/remux/abc/file.mp4?transcode=1')
  })
  it('upgrades when codec is unknown (probe timed out)', () => {
    expect(upgradeStreamUrlForCodec(STREAM, null))
      .toBe('http://localhost:3000/remux/abc/file.mp4?transcode=1')
    expect(upgradeStreamUrlForCodec(STREAM, undefined))
      .toBe('http://localhost:3000/remux/abc/file.mp4?transcode=1')
  })
  it('preserves existing query string with &', () => {
    expect(upgradeStreamUrlForCodec(STREAM + '?audio=1', 'hevc'))
      .toBe('http://localhost:3000/remux/abc/file.mp4?audio=1&transcode=1')
  })
  it('handles null/empty URLs', () => {
    expect(upgradeStreamUrlForCodec(null, 'hevc')).toBe(null)
    expect(upgradeStreamUrlForCodec('', 'hevc')).toBe('')
  })
})

describe('parseRemuxOffset (absolute-position resume fix, save side)', () => {
  it('reads the ?t= offset from a /remux URL', () => {
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?transcode=1&t=1800')).toBe(1800)
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?t=96')).toBe(96)
  })
  it('returns 0 for /remux without t', () => {
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?transcode=1')).toBe(0)
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv')).toBe(0)
  })
  it('returns 0 for /stream URLs (no local-time offset there)', () => {
    expect(parseRemuxOffset('http://x/stream/abc/f.mp4?t=1800')).toBe(0)
  })
  it('returns 0 for junk / non-string / zero / negative', () => {
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?t=0')).toBe(0)
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?t=-5')).toBe(0)
    expect(parseRemuxOffset('http://x/remux/abc/f.mkv?t=abc')).toBe(0)
    expect(parseRemuxOffset(null)).toBe(0)
    expect(parseRemuxOffset(undefined)).toBe(0)
  })
  it('round-trips with withResumeTime (bake t, then read it back)', () => {
    const baked = withResumeTime('http://x/remux/abc/f.mkv?transcode=1', 642)
    expect(parseRemuxOffset(baked)).toBe(642)
  })
})

describe('withResumeTime (the Continue-Watching resume fix)', () => {
  const REMUX = 'http://localhost:3000/remux/abc/file.mkv?transcode=1'

  it('adds ?t= to a /remux URL with a resume position', () => {
    expect(withResumeTime(REMUX, 1800)).toBe('http://localhost:3000/remux/abc/file.mkv?transcode=1&t=1800')
  })
  it('preserves other params (transcode, audio) when adding t', () => {
    const u = 'http://localhost:3000/remux/abc/file.mkv?transcode=1&audio=2'
    const out = withResumeTime(u, 1800)
    expect(out).toContain('transcode=1')
    expect(out).toContain('audio=2')
    expect(out).toContain('t=1800')
  })
  it('floors fractional seconds', () => {
    expect(withResumeTime(REMUX, 1800.7)).toContain('t=1800')
  })
  it('does NOT touch /stream URLs (byte-seekable — uses currentTime)', () => {
    const s = 'http://localhost:3000/stream/abc/file.mp4'
    expect(withResumeTime(s, 1800)).toBe(s)
  })
  it('does NOT override an existing ?t= (an explicit seek wins)', () => {
    const u = 'http://localhost:3000/remux/abc/file.mkv?transcode=1&t=600'
    expect(withResumeTime(u, 1800)).toBe(u)
  })
  it('no-ops for zero / negative / missing resume', () => {
    expect(withResumeTime(REMUX, 0)).toBe(REMUX)
    expect(withResumeTime(REMUX, -5)).toBe(REMUX)
    expect(withResumeTime(REMUX, null)).toBe(REMUX)
    expect(withResumeTime(REMUX, undefined)).toBe(REMUX)
  })
  it('handles a /remux URL with no existing query string', () => {
    expect(withResumeTime('http://localhost:3000/remux/abc/file.mkv', 90))
      .toBe('http://localhost:3000/remux/abc/file.mkv?t=90')
  })
  it('handles non-string input', () => {
    expect(withResumeTime(null, 1800)).toBe(null)
    expect(withResumeTime(undefined, 1800)).toBe(undefined)
  })
})

describe('toAbsStreamUrl', () => {
  it('passes through absolute URLs', () => {
    expect(toAbsStreamUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(toAbsStreamUrl('https://example.com')).toBe('https://example.com')
    expect(toAbsStreamUrl('blob:abc')).toBe('blob:abc')
    expect(toAbsStreamUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })
  it('leaves unknown relative paths alone', () => {
    expect(toAbsStreamUrl('/foo/bar')).toBe('/foo/bar')
    expect(toAbsStreamUrl('relative/path')).toBe('relative/path')
  })
  it('prepends API_BASE when present', () => {
    globalThis.window = { __API_BASE__: 'http://127.0.0.1:3000' }
    expect(toAbsStreamUrl('/stream/abc')).toBe('http://127.0.0.1:3000/stream/abc')
    expect(toAbsStreamUrl('/remux/abc')).toBe('http://127.0.0.1:3000/remux/abc')
    expect(toAbsStreamUrl('/api/something')).toBe('http://127.0.0.1:3000/api/something')
    expect(toAbsStreamUrl('/trailer')).toBe('http://127.0.0.1:3000/trailer')
    delete globalThis.window
  })
  it('returns the path unchanged when no API_BASE', () => {
    globalThis.window = {}
    expect(toAbsStreamUrl('/stream/abc')).toBe('/stream/abc')
    delete globalThis.window
  })
  it('handles non-string input', () => {
    expect(toAbsStreamUrl(null)).toBe(null)
    expect(toAbsStreamUrl(undefined)).toBe(undefined)
    expect(toAbsStreamUrl(42)).toBe(42)
  })
})
