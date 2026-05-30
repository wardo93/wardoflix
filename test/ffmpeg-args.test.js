// v1.12.0 — regression tests for the ffmpeg arg builder.
//
// The v1.11.3 disaster: `-fps_mode cfr` (ffmpeg 5.1, 2022) shipped in
// the arg list, but the bundled binary is a 2018 build that rejects it
// at arg-parse time → every transcode produced 0 bytes → every stream
// showed "Source not supported". No test caught it because the args
// were inline in the route and never asserted on. These tests are the
// fence.

import { describe, it, expect } from 'vitest'
import {
  buildFfmpegArgs,
  FFMPEG_FLAGS_UNSUPPORTED_BY_BUNDLED_BUILD,
} from '../server/lib/ffmpeg-args.js'

const INPUT = 'http://127.0.0.1:3001/webtorrent/HASH/file.mkv'

describe('buildFfmpegArgs — bundled-binary compatibility (v1.11.3 fence)', () => {
  it('NEVER emits an option unsupported by the 2018 bundled build', () => {
    // This is THE regression assertion. If anyone changes -vsync back
    // to -fps_mode (or adds another ffmpeg-5-only flag), this fails.
    const variants = [
      buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true }),
      buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: false }),
      buildFfmpegArgs({ inputUrl: INPUT, seekSec: 42, needsTranscode: true }),
      buildFfmpegArgs({ inputUrl: INPUT, audioIdx: 1, needsTranscode: true }),
    ]
    for (const args of variants) {
      for (const banned of FFMPEG_FLAGS_UNSUPPORTED_BY_BUNDLED_BUILD) {
        expect(args).not.toContain(banned)
      }
    }
  })

  it('uses the legacy -vsync spelling, not -fps_mode', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    expect(args).toContain('-vsync')
    expect(args).not.toContain('-fps_mode')
    // -vsync's value must immediately follow it
    expect(args[args.indexOf('-vsync') + 1]).toBe('cfr')
  })

  it('does NOT pass -hwaccel auto (v1.12.0 removed it — unsafe on 2018 build)', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    expect(args).not.toContain('-hwaccel')
  })
})

describe('buildFfmpegArgs — transcode branch', () => {
  it('uses libx264 main@4.0 zerolatency when transcoding', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    expect(args).toContain('-c:v')
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-profile:v') + 1]).toBe('main')
    expect(args[args.indexOf('-level:v') + 1]).toBe('4.0')
    expect(args[args.indexOf('-preset') + 1]).toBe('ultrafast')
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
  })
})

describe('buildFfmpegArgs — copy branch', () => {
  it('uses -c:v copy when not transcoding', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: false })
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
    expect(args).not.toContain('libx264')
  })
})

describe('buildFfmpegArgs — seek', () => {
  it('adds -ss before -i when seekSec > 0', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, seekSec: 90, needsTranscode: true })
    const ssIdx = args.indexOf('-ss')
    const iIdx = args.indexOf('-i')
    expect(ssIdx).toBeGreaterThanOrEqual(0)
    expect(args[ssIdx + 1]).toBe('90')
    expect(ssIdx).toBeLessThan(iIdx) // -ss must precede -i (fast seek)
  })
  it('omits -ss when seekSec is 0', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, seekSec: 0, needsTranscode: true })
    expect(args).not.toContain('-ss')
  })
})

describe('buildFfmpegArgs — audio mapping', () => {
  it('maps default audio (0:a:0) with no optional marker', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, audioIdx: null, needsTranscode: true })
    expect(args).toContain('0:a:0')
    expect(args).not.toContain('0:a:0?')
  })
  it('maps a user-picked audio index with the optional ? marker', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, audioIdx: 2, needsTranscode: true })
    expect(args).toContain('0:a:2?')
  })
  it('always drops subtitles with -sn', () => {
    expect(buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })).toContain('-sn')
    expect(buildFfmpegArgs({ inputUrl: INPUT, audioIdx: 1, needsTranscode: true })).toContain('-sn')
  })
})

describe('buildFfmpegArgs — output container', () => {
  it('emits fragmented MP4 to stdout', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    expect(args[args.indexOf('-f') + 1]).toBe('mp4')
    expect(args[args.length - 1]).toBe('pipe:1')
    expect(args).toContain('-movflags')
    expect(args[args.indexOf('-movflags') + 1]).toBe('frag_keyframe+empty_moov+default_base_moof')
  })
  it('does NOT use the +genpts flag that caused v1.10.0 audio drift', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    const fflags = args[args.indexOf('-fflags') + 1]
    expect(fflags).not.toContain('genpts')
    expect(fflags).toContain('nobuffer')
  })
  it('includes the audio resample sync filter', () => {
    const args = buildFfmpegArgs({ inputUrl: INPUT, needsTranscode: true })
    expect(args).toContain('-af')
    expect(args[args.indexOf('-af') + 1]).toContain('aresample=async=1')
  })
})
