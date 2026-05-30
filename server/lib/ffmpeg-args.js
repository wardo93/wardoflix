// v1.12.0 — ffmpeg argument builder, extracted from the /remux route so
// it can be exercised by an end-to-end transcode smoke test WITHOUT
// booting the whole server. This is the single highest-leverage test
// hook in the codebase: the v1.11.3 disaster (every transcode broken
// because `-fps_mode` isn't recognised by our bundled 2018 ffmpeg)
// lived entirely in this arg list and shipped because nothing ever ran
// ffmpeg with these exact args before publish.
//
// CONTRACT: the route and the test MUST use this same function so they
// can never drift. A test that hardcoded its own copy of the args would
// have passed v1.11.3 anyway.
//
// Pure: no Node-specific deps, no I/O, no side effects. Given the same
// inputs it returns the same array.

/**
 * Build the ffmpeg argument vector for a /remux transcode/copy.
 *
 * @param {object} opts
 * @param {string} opts.inputUrl   - HTTP URL ffmpeg reads from (WebTorrent stream server)
 * @param {number} opts.seekSec    - seconds to seek (-ss) before input; 0 = no seek
 * @param {number|null} opts.audioIdx - audio stream index to select, or null for default (0)
 * @param {boolean} opts.needsTranscode - true → libx264 re-encode; false → -c:v copy
 * @returns {string[]} ffmpeg argv (excluding the binary itself)
 */
export function buildFfmpegArgs({ inputUrl, seekSec = 0, audioIdx = null, needsTranscode = true }) {
  // Audio stream mapping. Use `0:a:N` (relative-to-audio) not `0:N`
  // (absolute) so subtitle streams between audio tracks don't shift the
  // index. `-sn` drops subtitles entirely (MP4 can't carry ASS/PGS).
  // A user-picked non-default index keeps the `?` optional marker so a
  // since-removed track falls through to default rather than failing;
  // the default branch omits `?` so a genuinely-missing audio:0 fails
  // the spawn loudly instead of emitting silent video-only output.
  const audioMap = audioIdx != null && !isNaN(audioIdx) && audioIdx >= 0
    ? ['-map', '0:v:0', '-map', `0:a:${audioIdx}?`, '-sn']
    : ['-map', '0:v:0', '-map', '0:a:0', '-sn']

  // Video: libx264 main@4.0 zerolatency for transcode, or stream-copy.
  // The pinned main profile + level 4.0 is a Chromium-safe baseline
  // (see the long note in the route's git history re: Peaky Blinders
  // x265 MEDIA_ERR_DECODE).
  const videoEncoder = needsTranscode
    ? [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'main',
        '-level:v', '4.0',
      ]
    : ['-c:v', 'copy']

  return [
    // v1.12.0 — `-hwaccel auto` was REMOVED here. On the bundled 2018
    // N-92722 build, auto-hwaccel can select a D3D11VA/DXVA2 decode
    // path whose output pixel format doesn't round-trip through
    // `-pix_fmt yuv420p`, yielding a 0-byte transcode (the same
    // user-visible symptom as the -fps_mode bug). Software decode with
    // `-preset ultrafast` is the safe default for this binary. If a
    // future ffmpeg upgrade makes auto-hwaccel reliable, reintroduce
    // it behind an explicit, smoke-tested opt-in.
    '-threads', '0',
    ...(seekSec > 0 ? ['-ss', String(seekSec)] : []),
    '-analyzeduration', '1000000',  // 1s
    '-probesize', '1000000',        // 1MB
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    // +nobuffer low-latency; +discardcorrupt/+igndts tolerate broken
    // MKV timestamps without aborting. (NOT +genpts — that caused the
    // v1.10.0 audio drift.)
    '-fflags', '+nobuffer+discardcorrupt+igndts',
    '-i', inputUrl,
    ...audioMap,
    ...videoEncoder,
    // Constant framerate. LEGACY `-vsync cfr` spelling, NOT the modern
    // `-fps_mode cfr` — the bundled 2018 ffmpeg doesn't recognise
    // `-fps_mode` (added in ffmpeg 5.1, 2022) and errors at arg-parse.
    // This is the v1.11.3 regression: do NOT change this back to
    // -fps_mode unless the bundled ffmpeg is upgraded to 5.1+ AND the
    // transcode smoke test confirms it.
    '-vsync', 'cfr',
    // Resample audio to track the video clock; first_pts=0 aligns audio
    // start with video start after a seek (fixes the v1.10.0 "1s behind
    // on resume" drift).
    '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.100',
    '-ac', '2',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4',
    '-frag_duration', '200000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ]
}

// The set of ffmpeg options known to be UNSUPPORTED by the bundled
// 2018 N-92722 build. The smoke/unit tests assert buildFfmpegArgs()
// never emits any of these — a tripwire so a future "modernise the
// flags" edit can't silently reintroduce the v1.11.3 class of bug
// without a test going red.
export const FFMPEG_FLAGS_UNSUPPORTED_BY_BUNDLED_BUILD = [
  '-fps_mode',   // added ffmpeg 5.1 (2022); bundled build is 2018
]
