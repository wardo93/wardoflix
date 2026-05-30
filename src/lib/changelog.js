// Per-version changelog entries — surfaced as a modal on the first
// launch after an upgrade so users actually find out what changed
// (vs. silently auto-updating and never noticing).
//
// Each entry: { version, date (YYYY-MM-DD), title, items[] }. The
// `items` array is rendered as a bulleted list — keep entries
// concise, 1 line per bullet ideally. `title` is the one-line
// summary shown at the top of the modal.
//
// Add new entries at the TOP of the array. The modal shows every
// entry whose version > the user's last-seen version, so a user
// who skipped two updates sees both changelogs stacked.

export const CHANGELOG_ENTRIES = [
  {
    version: '1.12.0',
    date: '2026-05-18',
    title: '🛡️ Release safety net + critical server reliability (6-expert audit, phases 0-1)',
    items: [
      'Six experts reviewed the whole codebase. The #1 finding: the last 4 releases shipped BROKEN because the publish gate only checked /api/health (which never touches ffmpeg or the module graph that kept breaking). This release builds the net that stops that.',
      'Transcode smoke test: the real ffmpeg arg list is now extracted into a testable builder, and the test suite spawns the actual bundled ffmpeg against a tiny generated video to assert it produces output. This is the test that would have caught the v1.11.3 disaster (every transcode broken by an incompatible flag). It runs before every build — a broken arg list can no longer reach the installer.',
      'Server-boot test: CI now actually boots the server and polls /api/health on every push — catches the v1.11.1 class (server crashes on import) in seconds, before a release is ever attempted.',
      'Regression tests for every recently-shipped bug: v1.11.3 (ffmpeg flag), v1.11.6 (rate-limit loopback), v1.10.0 (audio-drift flags), plus the existing path-traversal coverage. 72 tests now (was 50).',
      'Fixed the subtitle 502 storm: when a subtitle CDN was down, the player hammered it 40+ times in seconds (once per track, per retry). Now a failed host goes into a 60s cooldown that short-circuits the rest of the burst, and successful subtitle fetches are cached — so re-selecting a track is instant instead of another network round-trip.',
      'Server crash guards: a single unhandled promise rejection used to be able to kill the server mid-watch (Node terminates on unhandled rejection by default). Now logged and survived — playback keeps going.',
      'Dropped -hwaccel auto from the transcode pipeline: on the bundled 2018 ffmpeg it could silently produce a 0-byte transcode (same symptom as the -fps_mode bug). Software decode with ultrafast preset is the safe, fast default.',
      'A timed-out stream now destroys its dead torrent instead of leaving it announcing to trackers for 2 hours — cycling through dead fallback sources no longer leaks background bandwidth.',
    ],
  },
  {
    version: '1.11.6',
    date: '2026-05-18',
    title: '⚡ Hotfix — the app was rate-limiting itself',
    items: [
      'User saw "Episode lookup failed (HTTP 429) — the backend may be unreachable" while clicking around. Root cause: the v1.9.0 hardening pass added a 200-requests-per-60-second-per-IP rate limit. That sounded generous but turns out a single stream-start fires ~50 calls in 5 seconds (subtitle proxy ~20 retries, audio probe, SSE setup, progress polling, etc.), so the renderer kept rate-limiting itself.',
      'Fix: skip the rate limit entirely for loopback IPs (127.0.0.1, ::1, ::ffff:127.0.0.1). The /api/* surface is already locked to localhost via requireLocal; a local process spamming us is the only "attacker" the rate limit was blocking, and that process already has filesystem read on our localStorage / .env / asar — the rate limit defends against nothing it doesn\'t. For non-loopback fallback (which shouldn\'t happen because requireLocal already 403s those) bumped to 1000/60s.',
      'Also fixed the misleading error message: a 429 used to say "backend may be unreachable", which is wrong — 429 means rate-limited, not down. Now distinguishes 429 ("throttled, wait a few seconds"), 504 ("indexer slow"), and other 5xx ("indexer returned an error").',
    ],
  },
  {
    version: '1.11.5',
    date: '2026-05-18',
    title: '🎯 Netflix-style UX cleanup',
    items: [
      'Removed the "Paste video URL or magnet link…" input bar from above the player. The app is a full Netflix-style flow now — users land on Browse, click a title, click Play. The paste-URL field was a holdover from the early dev UX that nobody used once Browse was good enough.',
      'Removed the Browse / Stream tab buttons from the topbar. Same reason: the navigation is implicit now (click a title → player appears; player back button → back to Browse). The internal routing still exists but it\'s invisible.',
      'Connecting state is now a prominent centered card over the player area showing the title being loaded ("Connecting to The Boys · S01E01") and a live peer count that updates as the swarm fills ("Reaching 12 peers…"). Pulses subtly so the user knows the app is alive even when the peer count is still climbing. The card occupies the exact 16:9 area the video will fill, so the swap-in is layout-stable.',
      'The empty-state card (rare case: stream tab with no source, not loading) is now a friendly "Nothing playing — pick something from Browse" instead of the old "paste a magnet link" instructions.',
    ],
  },
  {
    version: '1.11.4',
    date: '2026-05-18',
    title: '🎚️ Player rewrite — seek, subtitles, and the lag are fixed',
    items: [
      'Three-expert roundtable on the player after multiple bug reports: seeking to a new time made the player jump to fullscreen + black screen; adjusting subtitles stopped + restarted playback; everything felt laggy.',
      'Root cause of seek-bug: every URL change was tearing down the video.js instance and creating a fresh one. That meant the intro re-fired on each seek (which auto-requests fullscreen) and the buffer was empty until ffmpeg produced new bytes. Fix: same-media URL changes (re-seeks within the same /remux path) now call player.src() on the EXISTING player instead of disposing it. No intro re-fire, no fullscreen request, no buffer wipe — just a clean source swap. Player teardown only happens on stream end / different stream.',
      'Root cause of subtitle stop-and-restart: the subOffset slider was re-fetching + re-adding ALL text tracks on every slider tick (60Hz). Fix: debounced the actual track swap to 400ms after the slider stops moving. The slider feels instant (UI updates immediately) but the track-fetch only happens once per drag-end. ~150x fewer requests.',
      'Root cause of overall lag: the v1.11.0 timeupdate throttle was set to 4Hz — every 250ms — making the "01:23 / 45:67" time display visibly jump and feel sluggish. Bumped to 10Hz (every 100ms). Still way cheaper than the native 30-60Hz cadence; finally feels like a real player.',
    ],
  },
  {
    version: '1.11.3',
    date: '2026-05-18',
    title: '🎬 Playback hotfix — ffmpeg flag incompatibility was breaking every transcode',
    items: [
      'Every transcode-needing stream (10-bit HEVC, AV1, MKV anything) failed with "Source not supported (the browser refused the container/codec)" on every v1.10.0+ install. Root cause: my v1.10.0 audio-drift fix used `-fps_mode cfr`, which was only added in ffmpeg 5.1 (2022). The @ffmpeg-installer/ffmpeg package ships an N-92722 build from 2018. The bundled binary errored on arg-parse (`Unrecognized option \'fps_mode\'`) in 85ms, before any bytes hit the response — so the player saw an empty stream and surfaced MEDIA_ERR_SRC_NOT_SUPPORTED.',
      'Fix: replaced `-fps_mode cfr` with `-vsync cfr` — same behaviour, in ffmpeg since 2010, works on every release. The audio-drift fix from v1.10.0 is restored; this is the form it should have been in from day one.',
      'Why the smoke test missed it: the v1.11.2 publish gate boots the server and pings /api/health, but never actually spawns ffmpeg with our transcode args. A real fix would run a tiny end-to-end transcode of a test fixture. Tracked for v1.12.0.',
    ],
  },
  {
    version: '1.11.2',
    date: '2026-05-18',
    title: '🚨 Hotfix — v1.11.1 was a broken release',
    items: [
      'v1.11.1 shipped with the server in a crash loop. Cause: I moved the path-traversal helper into src/lib/path-safety.js so unit tests could import it, but src/ is not in electron-builder\'s build.files (only dist/, electron/, server/ are). The asar never contained the file. Every server fork crashed with ERR_MODULE_NOT_FOUND, the watchdog gave up after 5 retries, and every /api/* call returned connection-refused — meaning For You, Home, Library, and Search all rendered empty.',
      'Fix: moved to server/lib/path-safety.js where it\'s covered by server/**/*. The renderer never imported it; this move is invisible everywhere except the asar.',
      'Prevention: new electron-builder afterAllArtifactBuild hook spawns the packaged WardoFlix.exe and polls /api/health for up to 25 seconds. If the server doesn\'t come up, the publish aborts. Future packaging regressions of this class — anything imported from a path not in build.files, missing asarUnpack entries, native binding mismatches — get caught at the last possible moment instead of reaching users.',
      'The v1.11.1 path-traversal security fix itself was correct; it just wasn\'t actually running because the server couldn\'t start. v1.11.2 restores it.',
    ],
  },
  {
    version: '1.11.1',
    date: '2026-05-18',
    title: 'v1.11.0 self-QA — three bugs found and fixed',
    items: [
      'Roleplayed as a user testing v1.11.0; probed the new attack surface; found three bugs in my own changes; fixed them.',
      'Bug 1 (security): the path-traversal guard on /api/external-url only caught fully-literal `..` or fully-encoded `%2e%2e`. Mixed encodings (`%2e.`, `.%2e`) and double-encodings slipped through, and would have decoded to `..` once the external player\'s HTTP client opened them. Replaced the inline regex with a `hasPathTraversal()` helper that decodes repeatedly until stable, then checks for a `..` SEGMENT (preceded by start-or-slash, followed by end-or-slash) so legitimate filenames like `..foo` still pass.',
      'Bug 2 (UX/DX): DetailModal\'s AbortController had no `useEffect` cleanup, so closing the modal mid-fetch left the `/api/torrents` request resolving onto a torn-down component. Now both the torrent list and the TMDB details fetch abort on unmount.',
      'Bug 3 (lint): removed dead `Component` import from App.jsx left over from the earlier inline error boundary.',
      'Path-safety logic extracted to src/lib/path-safety.js + 16 new regression tests in test/path-safety.test.js. Total test count: 50/50 passing across 2 files.',
    ],
  },
  {
    version: '1.11.0',
    date: '2026-05-18',
    title: '🏗️ Full-codebase audit pass — reliability, security, tests, CI',
    items: [
      'Nine-expert audit covering backend (server/index.js, ~3.3k lines), frontend (App.jsx + components, ~4.5k lines), Electron (main.js + build config), and tooling. Resulted in a phased work list — this release ships phases 1-7, with phase 8 (big StreamPage refactor) deferred to v1.12.0.',
      'Reliability: single-instance lock so double-clicking the icon no longer spawns a second server that dies with EADDRINUSE. Graceful SIGTERM shutdown in the server cleans up every running ffmpeg + the WebTorrent client before the process exits — no more orphan ffmpeg.exe holding file handles open after quit. Atomic window-state writes (.tmp + rename) so a crash mid-save can\'t leave a torn preferences file. Race fix in the per-hash ffmpeg registry.',
      'Security: added will-navigate handler in the main process — a renderer XSS that tried `document.location = "https://evil"` can no longer escape into a navigated BrowserWindow; the URL is sent to the user\'s default browser instead. Path-traversal guard on /api/external-url so the URL we hand to VLC/MPV can\'t be tricked into resolving onto a different endpoint.',
      'Frontend: a top-level React error boundary catches uncaught render errors and shows a "try again" card instead of the black screen. Smaller boundary specifically around the title-details modal. AbortController on the details torrent fetch so rapid item-switching can\'t let an old request overwrite the new title\'s state.',
      'Performance: PlayerControls timeupdate throttled from 30-60Hz down to 4Hz — saves ~3-5% CPU on transcoded streams where the host is already under heavy load. Same UI smoothness; the eye can\'t tell the difference.',
      'UX: profile picker shows "Welcome to WardoFlix" on first launch instead of the misleading "Who\'s watching?". Player seek bar got a 16px-tall invisible hit-box (visible bar still 4px thin) and the visual bar enlarges to 10px on touchscreens.',
      'Tests: vitest installed; 34 unit tests covering src/lib/util.js + src/lib/url.js (the lowest-risk-highest-payoff helpers — every stream URL goes through toAbsStreamUrl, every codec decision through upgradeStreamUrlForCodec).',
      'CI: GitHub Actions workflow runs lint + test + production build + npm audit on every push and PR.',
      'Storage: schema versioning scaffold + per-key corruption logging. Sets us up for the localStorage encryption migration that\'s next on the security roadmap.',
    ],
  },
  {
    version: '1.10.0',
    date: '2026-05-18',
    title: '🎬 Playback overhaul — no more black screens or audio drift',
    items: [
      'Fixed the "audio plays but screen is black" bug on first stream start. Root cause: Chromium\'s MSE video decoder went idle while paused at t=0 during the 4.5s intro animation. The decoder now stays hot — playback runs muted under the intro overlay, then snaps back to the start position when the intro ends. No more "go back, click Continue Watching to actually see the show" workaround.',
      'Fixed audio drift on transcoded streams (the "show becomes unwatchable, audio is a second ahead" bug). Rewrote the ffmpeg pipeline: dropped the old +genpts timestamp regeneration, added aresample=async=1 to keep audio resampling in lockstep with video, pinned a constant output framerate, and standardised the audio sample rate to 48 kHz. VFR sources and weirdly-muxed MKVs now stay tight.',
      'Bigger muxing queue (4096 packets) so brief A/V drift during seek/recovery no longer aborts the transcode with "too many packets buffered".',
      'First-frame watchdog: if the decoder is silently stuck 1.5s after the intro ends (rare belt-and-suspenders case), the player auto-reloads via the fresh-probe path instead of leaving you staring at a blank screen.',
      'Android port paused — desktop reliability comes first.',
    ],
  },
  {
    version: '1.9.3',
    date: '2026-05-17',
    title: 'Hover trailers: fixed YouTube error 153',
    items: [
      'YouTube was rejecting embed playback for videos whose owners restrict embedding (most indie/small-channel trailers) — symptom: "Watch video on YouTube · Error 153 · Video player configuration error" inside the popup.',
      'Root cause: the v1.9.0 Referrer-Policy: no-referrer security header was sending zero referer to YouTube, so embed-restricted videos saw the request as "from unknown origin" and refused. Carved a route-specific exception for /trailer that sends strict-origin-when-cross-origin instead. Every other route keeps the strictest no-referrer.',
    ],
  },
  {
    version: '1.9.2',
    date: '2026-05-17',
    title: 'Hover trailers fixed (black-screen + double-popup)',
    items: [
      'Hover trailers were black screens because the v1.9.0 X-Frame-Options security header was blocking the renderer from embedding /trailer in an iframe. Carved out an exception for that single route — every other endpoint still refuses framing.',
      'Multiple trailer popups could be visible at once when moving the cursor between posters. Added a module-level event bus so only ONE trailer popup is ever active; sibling cards force-dismiss when another claims the slot.',
    ],
  },
  {
    version: '1.9.1',
    date: '2026-05-17',
    title: 'Updater back on GitHub Releases',
    items: [
      'Auto-updates are now pulled from github.com/wardo93/wardoflix/releases — same flow you knew before v1.7.0',
      'The local-folder updater introduced in v1.7.0 is retired; the file is kept in electron/local-updater.js as a reference fallback',
      'WF_UPDATE_LOCAL_PATH in .env is no longer read; the line is commented out',
      'Differential updates via blockmap restored — typical update is ~1 MB instead of full 110 MB installer',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-05-17',
    title: '🔐 Security hardening pass — 10-expert audit',
    items: [
      'Express API locked to localhost for control endpoints — LAN can only reach the data plane (/stream, /remux for TV cast)',
      'CORS allow-list replaces wildcard — only our own renderer can hit /api/*',
      'Strict Content Security Policy on the renderer — blocks any script/connect that isn\'t to TMDB/OpenSubs/Torrentio',
      'Subtitle proxy SSRF-hardened: 1 MB size cap, 8 s timeout, URL length cap',
      'Magnet links schema-validated before reaching WebTorrent',
      'Body-size caps + per-IP rate limit (200 req/min) on the API',
      'Log scrubber strips magnet hashes + public IPs from disk logs',
      'Discord Rich Presence payloads sanitized (control-char strip + length cap)',
      'Per-IP request IDs on the API for forensic correlation',
      'Log retention reduced 50 MB → 6 MB',
      'Electron permission handler tightened (mic/camera dropped, sync-permission probes blocked)',
      'NEW: 🔒 Privacy Mode toggle in the topbar — suspends history, resume, and Discord RPC for the session',
    ],
  },
  {
    version: '1.8.1',
    date: '2026-05-17',
    title: 'Library badges, accessibility, and this modal',
    items: [
      'Library: cards now show "Watched" or "In progress" badges so you can see at a glance what you\'ve started',
      'Subtitles: new "High Contrast" preset — large bold text with a solid box, designed for low-vision viewing',
      'You\'re reading the new "What\'s New" modal — shows once per update so big changes don\'t slip past unnoticed',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-05-17',
    title: 'Internal refactor: cleaner codebase',
    items: [
      'DetailModal and PlayerControls now live in their own files (~1,500 lines moved out of App.jsx)',
      'No user-visible changes — byte-identical behaviour',
      'Future updates iterate faster as a result',
    ],
  },
  {
    version: '1.7.9',
    date: '2026-05-17',
    title: 'Performance + accessibility polish',
    items: [
      'Home page no longer re-renders every card on every state tick (React.memo on PosterCard, ContentRow)',
      'Auto-pick profile when only one exists — no more "Who\'s watching?" screen with one face',
      'Right-click any Continue Watching card to hide it (with Undo)',
      'Stream tab empty state explains what the tab does and links to Browse',
      'Keyboard focus traps on modal dialogs',
    ],
  },
  {
    version: '1.7.8',
    date: '2026-05-17',
    title: 'Intro performance + black-screen fix',
    items: [
      'Intro animation no longer stutters — six GPU bottlenecks cut',
      'Fixed: streams sometimes started with audio but a black screen',
    ],
  },
  {
    version: '1.7.7',
    date: '2026-05-17',
    title: 'Hover trailer popup',
    items: [
      'Hover trailers now play in a proper 480×270 popup — no more black bars from squashed aspect ratio',
      'Captions auto-enabled on hover trailers when available',
      'Always silent — preview audio toggle removed',
    ],
  },
  {
    version: '1.7.6',
    date: '2026-05-17',
    title: 'Six new features from Netflix / Amazon / Stremio / Popcorn Time',
    items: [
      'Surprise Me button in the browse nav — random pick from library or catalog',
      'Random Episode button on TV show detail modal (Popcorn Time style)',
      'Next-episode countdown overlay with Cancel button (Netflix style)',
      '"Still Watching?" prompt after 3 consecutive auto-plays',
      '"Because you watched X" recommendation rows on home',
      'Subtitle style presets: Netflix / Cinema / Caption Box',
    ],
  },
]

// Read the user's last-seen version from localStorage. If they're on
// a fresh install (no last-seen value yet), we return the CURRENT
// version so the modal doesn't fire on first launch — that would be
// a strange experience for someone who just opened the app.
const LAST_SEEN_KEY = 'wardoflix:last-seen-version'

export function readLastSeenVersion(currentVersion) {
  try {
    const v = localStorage.getItem(LAST_SEEN_KEY)
    if (v) return v
    // Fresh install — store the current version as last-seen so the
    // modal doesn't surface for someone with no upgrade context.
    localStorage.setItem(LAST_SEEN_KEY, currentVersion)
    return currentVersion
  } catch { return currentVersion }
}

export function markVersionSeen(version) {
  try { localStorage.setItem(LAST_SEEN_KEY, version) } catch {}
}

// Compare versions as strict semver (major.minor.patch). Returns
// the entries whose version is strictly greater than `lastSeen`.
// Anything that doesn't parse is treated as equal to skip — corrupt
// version data shouldn't trigger a spurious changelog modal.
function compareSemver(a, b) {
  const pa = String(a || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

export function changelogEntriesNewerThan(lastSeen) {
  return CHANGELOG_ENTRIES.filter((entry) => compareSemver(entry.version, lastSeen) > 0)
}
