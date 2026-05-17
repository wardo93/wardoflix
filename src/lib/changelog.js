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
