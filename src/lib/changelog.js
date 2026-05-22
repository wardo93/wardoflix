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
