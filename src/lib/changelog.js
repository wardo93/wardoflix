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
