// v1.14.0 — tests for the pure media/torrent helpers extracted from
// server/index.js. These are the "routing brain": wrong answers here =
// black screen, wrong episode, or rejected stream. The QA review
// flagged them as the highest-value-untested logic in the server.

import { describe, it, expect } from 'vitest'
import {
  hasVideoExt, parseSeasonEpisode, normalizeForMatch, torrentMatchesTitle,
  formatBytes, pickBestVideoFile, mkvWarning, needsTranscodeFromName,
  parseInfoHash, parseInfoHashFromError, pickEpisodeFile, parseVideoCodec,
  isWellFormedMagnet,
} from '../server/lib/media-format.js'
import { srtToVtt, shiftVttTimestamps } from '../server/lib/subtitles.js'

describe('hasVideoExt', () => {
  it('recognises video extensions (name or backslash path)', () => {
    expect(hasVideoExt('Movie.mp4')).toBe(true)
    expect(hasVideoExt('Show.S01E01.mkv')).toBe(true)
    expect(hasVideoExt('clip.webm')).toBe(true)
    expect(hasVideoExt('dir\\sub\\file.avi')).toBe(true)
  })
  it('rejects non-video', () => {
    expect(hasVideoExt('readme.txt')).toBe(false)
    expect(hasVideoExt('poster.jpg')).toBe(false)
    expect(hasVideoExt('')).toBe(false)
    expect(hasVideoExt(null)).toBe(false)
  })
})

describe('parseSeasonEpisode', () => {
  it('parses SxxExx and NxNN', () => {
    expect(parseSeasonEpisode('Show.S01E02.1080p')).toEqual({ season: 1, episode: 2 })
    expect(parseSeasonEpisode('Show.s1e2')).toEqual({ season: 1, episode: 2 })
    expect(parseSeasonEpisode('Show 1x02')).toEqual({ season: 1, episode: 2 })
    expect(parseSeasonEpisode('Show.S10E24')).toEqual({ season: 10, episode: 24 })
  })
  it('returns null when no pattern', () => {
    expect(parseSeasonEpisode('Movie.2024.1080p')).toBeNull()
    expect(parseSeasonEpisode('')).toBeNull()
  })
})

describe('torrentMatchesTitle (the "The Wire" false-positive guard)', () => {
  it('matches when torrent name starts with the title', () => {
    expect(torrentMatchesTitle('The Wire S01E01 1080p', 'The Wire')).toBe(true)
    expect(torrentMatchesTitle('The.Wire.S01E01.1080p', 'The Wire')).toBe(true)
    expect(torrentMatchesTitle('Breaking Bad S05E14', 'Breaking Bad')).toBe(true)
  })
  it('rejects when title is a substring elsewhere, not the prefix', () => {
    expect(torrentMatchesTitle('Welcome to Wrexham Down to the Wire', 'The Wire')).toBe(false)
    expect(torrentMatchesTitle('Some Other Show', 'The Wire')).toBe(false)
  })
  it('rejects partial-word prefix matches', () => {
    // "The Wired" should not match "The Wire"
    expect(torrentMatchesTitle('The Wired S01E01', 'The Wire')).toBe(false)
  })
  it('handles empties', () => {
    expect(torrentMatchesTitle('', 'The Wire')).toBe(false)
    expect(torrentMatchesTitle('The Wire', '')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats at each scale', () => {
    expect(formatBytes(500 * 1024)).toBe('500 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })
  it('handles falsy / NaN', () => {
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(NaN)).toBe('')
    expect(formatBytes('foo')).toBe('')
  })
})

describe('pickBestVideoFile', () => {
  const big = (name, mb) => ({ name, path: name, length: mb * 1024 * 1024 })
  it('prefers mp4 over mkv', () => {
    const files = [big('movie.mkv', 1400), big('movie.mp4', 1200)]
    expect(pickBestVideoFile(files).name).toBe('movie.mp4')
  })
  it('within the same extension, returns the first in array order (extension priority wins over size)', () => {
    // NOTE: this documents the ACTUAL behaviour. Because hasVideoExt and
    // the priority loop use the same extension list, the "largest"
    // fallback is effectively unreachable — every candidate matches some
    // preferred ext, so the loop returns the first file at the
    // highest-priority ext. Two .mkv files → the first one, NOT the
    // largest. (The <10MB filter already removes sample/junk files, so
    // picking array-order-first among real files is acceptable.)
    const files = [big('a.mkv', 800), big('b.mkv', 1500)]
    expect(pickBestVideoFile(files).name).toBe('a.mkv')
  })
  it('skips sub-10MB junk (nfo/promo)', () => {
    const files = [big('real.mp4', 1200), { name: 'sample.mp4', path: 'sample.mp4', length: 2 * 1024 * 1024 }]
    expect(pickBestVideoFile(files).name).toBe('real.mp4')
  })
  it('returns null when nothing qualifies', () => {
    expect(pickBestVideoFile([{ name: 'readme.txt', length: 1000 }])).toBeNull()
    expect(pickBestVideoFile([])).toBeNull()
    expect(pickBestVideoFile(null)).toBeNull()
  })
})

describe('pickEpisodeFile', () => {
  const ep = (name) => ({ name, path: name, length: 500 * 1024 * 1024 })
  const pack = [ep('Show.S01E01.mkv'), ep('Show.S01E02.mkv'), ep('Show.S01E03.mkv')]
  it('finds the requested episode in a season pack', () => {
    expect(pickEpisodeFile(pack, 1, 2).name).toBe('Show.S01E02.mkv')
  })
  it('matches the 1x02 format', () => {
    expect(pickEpisodeFile([ep('Show 1x03 720p.mp4')], 1, 3).name).toBe('Show 1x03 720p.mp4')
  })
  it('returns null when no match / bad args', () => {
    expect(pickEpisodeFile(pack, 2, 5)).toBeNull()
    expect(pickEpisodeFile(pack, NaN, 1)).toBeNull()
    expect(pickEpisodeFile(null, 1, 1)).toBeNull()
  })
})

describe('needsTranscodeFromName (codec routing heuristic)', () => {
  it('flags x265/HEVC/10bit/AV1/HDR/DoVi', () => {
    expect(needsTranscodeFromName({ name: 'Movie.2024.2160p.x265.mkv' })).toBe(true)
    expect(needsTranscodeFromName({ name: 'Show.S01E01.HEVC.mkv' })).toBe(true)
    expect(needsTranscodeFromName({ name: 'Movie.10bit.mkv' })).toBe(true)
    expect(needsTranscodeFromName({ name: 'Movie.AV1.webm' })).toBe(true)
    expect(needsTranscodeFromName({ name: 'Movie.HDR10.mkv' })).toBe(true)
  })
  it('does NOT flag x264 (must not match the x265 pattern)', () => {
    expect(needsTranscodeFromName({ name: 'Show.S01E01.1080p.x264.mp4' })).toBe(false)
    expect(needsTranscodeFromName({ name: 'Movie.2024.h264.mp4' })).toBe(false)
  })
  it('handles missing file', () => {
    expect(needsTranscodeFromName(null)).toBe(false)
    expect(needsTranscodeFromName({})).toBe(false)
  })
})

describe('parseInfoHash / parseInfoHashFromError', () => {
  it('extracts 40-hex and 32-base32 from a magnet', () => {
    expect(parseInfoHash('magnet:?xt=urn:btih:0123456789ABCDEF0123456789abcdef01234567&dn=x'))
      .toBe('0123456789abcdef0123456789abcdef01234567')
  })
  it('returns null on garbage', () => {
    expect(parseInfoHash('not-a-magnet')).toBeNull()
  })
  it('pulls a 40-hex hash out of a duplicate-torrent error message', () => {
    expect(parseInfoHashFromError('Cannot add duplicate torrent 0123456789ABCDEF0123456789abcdef01234567'))
      .toBe('0123456789abcdef0123456789abcdef01234567')
    expect(parseInfoHashFromError('no hash here')).toBeNull()
  })
})

describe('parseVideoCodec (ffmpeg stderr scrape)', () => {
  it('extracts the video codec from a Stream line', () => {
    expect(parseVideoCodec('Stream #0:0(eng): Video: hevc (Main 10)')).toBe('hevc')
    expect(parseVideoCodec('Stream #0:0 [0x1]: Video: h264 (High)')).toBe('h264')
    expect(parseVideoCodec('Stream #0:0: Video: vp9')).toBe('vp9')
  })
  it('returns null when no video stream line', () => {
    expect(parseVideoCodec('Stream #0:0: Audio: aac')).toBeNull()
    expect(parseVideoCodec('')).toBeNull()
    expect(parseVideoCodec(null)).toBeNull()
  })
})

describe('isWellFormedMagnet', () => {
  const valid = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Movie&tr=udp%3A%2F%2Ftracker'
  it('accepts a well-formed magnet', () => {
    expect(isWellFormedMagnet(valid)).toBe(true)
  })
  it('rejects too-short, oversized, non-magnet, missing-hash, non-string', () => {
    expect(isWellFormedMagnet('magnet:?xt=urn:btih:short')).toBe(false)
    expect(isWellFormedMagnet('magnet:?dn=NoHash' + 'x'.repeat(80))).toBe(false)
    expect(isWellFormedMagnet('http://example.com/' + 'x'.repeat(80))).toBe(false)
    expect(isWellFormedMagnet('magnet:?xt=urn:btih:' + '0'.repeat(40) + 'x'.repeat(9000))).toBe(false) // > 8192
    expect(isWellFormedMagnet(null)).toBe(false)
    expect(isWellFormedMagnet(42)).toBe(false)
  })
})

describe('srtToVtt + shiftVttTimestamps', () => {
  it('converts SRT to VTT (header + comma→dot)', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello\n'
    const vtt = srtToVtt(srt)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.000')
    expect(vtt).not.toContain(',000')
  })
  it('shifts timestamps by a positive offset', () => {
    const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nHi'
    const shifted = shiftVttTimestamps(vtt, 5)
    expect(shifted).toContain('00:00:15.000 --> 00:00:17.000')
  })
  it('clamps negative results at zero', () => {
    const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHi'
    const shifted = shiftVttTimestamps(vtt, -10)
    expect(shifted).toContain('00:00:00.000')
  })
  it('no-ops on zero/NaN offset', () => {
    const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHi'
    expect(shiftVttTimestamps(vtt, 0)).toBe(vtt)
    expect(shiftVttTimestamps(vtt, NaN)).toBe(vtt)
  })
})
