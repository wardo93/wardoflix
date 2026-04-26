// localStorage layer for WardoFlix. Profiles, watch history, resume
// positions, watched set, sub offsets, intro marks, sub style, audio
// language preference, volume. Extracted from App.jsx so feature code
// can `import { saveResumePosition } from '../lib/storage.js'` instead
// of being part of a 5,800-line god file.

import { useState, useEffect } from 'react'
import { uuid } from './util.js'

// ═══════════════════════════════════════════════════════════════
// ── Profiles (localStorage) ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Netflix-style multi-user support. Up to PROFILE_MAX profiles per
// install. Each profile carries:
//   - identity:    id, name, emoji, color
//   - preferences: favoriteGenres { movies: [id,...], tv: [id,...] }
//                  mood (one of MOODS keys or null)
//   - derived:     createdAt (for sort order)
// History, resume positions, and volume prefs are namespaced per
// profile via the helpers below — a profile switch swaps the data
// layer automatically without the rest of the app needing to know.
export const PROFILES_KEY = 'wardoflix:profiles'
export const ACTIVE_PROFILE_KEY = 'wardoflix:active-profile'
export const PROFILE_MAX = 4
// Curated avatar palette — rose/oxblood/indigo/teal/amber/violet/
// coral/graphite. Picked to read well on the dark UI without
// clashing with the rose-gold accent used across the app.
export const PROFILE_COLORS = [
  '#c9a96e', // rose-gold (house accent)
  '#8a2f3c', // oxblood
  '#4f5d9e', // indigo
  '#3f8c8c', // teal
  '#b8863a', // amber
  '#6a4c93', // violet
  '#c6664a', // coral
  '#5c6470', // graphite
]
export const PROFILE_EMOJIS = ['🎬','🎭','🍿','🎸','🎨','🎮','🚀','⭐','🌙','🦊','🐱','🐺','🔥','💫','🦄','🗿']

export function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveProfiles(list) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list.slice(0, PROFILE_MAX))) } catch {}
  try { window.dispatchEvent(new Event('wardoflix:profiles-updated')) } catch {}
}

export function getActiveProfileId() {
  try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || null } catch { return null }
}

export function setActiveProfileId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, id)
    else localStorage.removeItem(ACTIVE_PROFILE_KEY)
  } catch {}
  try { window.dispatchEvent(new Event('wardoflix:profiles-updated')) } catch {}
}

export function getActiveProfile() {
  const id = getActiveProfileId()
  if (!id) return null
  return loadProfiles().find((p) => p.id === id) || null
}

export function createProfile({ name, emoji, color, favoriteGenres }) {
  const list = loadProfiles()
  if (list.length >= PROFILE_MAX) throw new Error(`At most ${PROFILE_MAX} profiles allowed`)
  const profile = {
    id: uuid(),
    name: String(name || 'New Profile').slice(0, 24),
    emoji: emoji || PROFILE_EMOJIS[list.length % PROFILE_EMOJIS.length],
    color: color || PROFILE_COLORS[list.length % PROFILE_COLORS.length],
    favoriteGenres: {
      movies: Array.isArray(favoriteGenres?.movies) ? favoriteGenres.movies.slice(0, 8) : [],
      tv: Array.isArray(favoriteGenres?.tv) ? favoriteGenres.tv.slice(0, 8) : [],
    },
    mood: null,
    createdAt: Date.now(),
  }
  const next = [...list, profile]
  saveProfiles(next)
  // First-profile bootstrap: migrate any pre-profile history/resume
  // data over to this profile so the user doesn't lose their watch
  // record when the profile system is introduced in an upgrade.
  // Remove the legacy keys after a successful copy — otherwise deleting
  // all profiles and creating a new one would re-migrate the same stale
  // data forever.
  if (list.length === 0) {
    try {
      const oldHist = localStorage.getItem('wardoflix:history')
      if (oldHist) {
        localStorage.setItem(`wardoflix:history:${profile.id}`, oldHist)
        localStorage.removeItem('wardoflix:history')
      }
      const oldResume = localStorage.getItem('wardoflix:resume')
      if (oldResume) {
        localStorage.setItem(`wardoflix:resume:${profile.id}`, oldResume)
        localStorage.removeItem('wardoflix:resume')
      }
    } catch {}
  }
  return profile
}

export function updateProfile(id, patch) {
  const list = loadProfiles()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) return null
  const merged = { ...list[idx], ...patch }
  // Preserve nested shape for favoriteGenres if the patch is partial.
  if (patch.favoriteGenres) {
    merged.favoriteGenres = {
      movies: Array.isArray(patch.favoriteGenres.movies) ? patch.favoriteGenres.movies.slice(0, 8) : list[idx].favoriteGenres?.movies || [],
      tv: Array.isArray(patch.favoriteGenres.tv) ? patch.favoriteGenres.tv.slice(0, 8) : list[idx].favoriteGenres?.tv || [],
    }
  }
  list[idx] = merged
  saveProfiles(list)
  return merged
}

export function deleteProfile(id) {
  const list = loadProfiles().filter((p) => p.id !== id)
  saveProfiles(list)
  // Clean the namespaced data for the deleted profile.
  try {
    localStorage.removeItem(`wardoflix:history:${id}`)
    localStorage.removeItem(`wardoflix:resume:${id}`)
  } catch {}
  // If the active profile was deleted, clear the pointer so the gate
  // re-opens on next render.
  if (getActiveProfileId() === id) setActiveProfileId(null)
}

// Subscribe React to the profile store. Covers both same-tab updates
// (via the custom 'wardoflix:profiles-updated' event) and cross-tab
// updates (via the native 'storage' event).
export function useProfiles() {
  const [state, setState] = useState(() => ({
    profiles: loadProfiles(),
    activeId: getActiveProfileId(),
  }))
  useEffect(() => {
    const sync = () => setState({ profiles: loadProfiles(), activeId: getActiveProfileId() })
    window.addEventListener('wardoflix:profiles-updated', sync)
    const onStorage = (e) => {
      if (e.key === PROFILES_KEY || e.key === ACTIVE_PROFILE_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('wardoflix:profiles-updated', sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  const activeProfile = state.profiles.find((p) => p.id === state.activeId) || null
  return { profiles: state.profiles, activeProfile }
}

// ── Mood catalogue ──────────────────────────────────────────────
// Each mood carries a genre-weight overlay (added on top of the
// user's favourite-genre boost + their history-derived weights).
// Genre IDs come from TMDB — they're the same for /movie and /tv
// where the id is shared, and the rare mismatches (e.g. TV has a
// Reality genre) fall through to the shared ones below.
export const MOODS = {
  chill:      { label: 'Chill',       emoji: '☕', movieGenres: [35, 10751, 99, 10402], tvGenres: [35, 10751, 99, 10764] },
  thrilling:  { label: 'Thrilling',   emoji: '⚡', movieGenres: [53, 28, 27, 80],       tvGenres: [9648, 80, 10759]       },
  funny:      { label: 'Funny',       emoji: '😂', movieGenres: [35, 10751, 10749],     tvGenres: [35, 10751]             },
  dramatic:   { label: 'Dramatic',    emoji: '🎭', movieGenres: [18, 36, 10752],        tvGenres: [18, 10768]             },
  mindBending:{ label: 'Mind-bending', emoji: '🌀', movieGenres: [878, 9648, 53, 14],   tvGenres: [10765, 9648, 10759]    },
  feelGood:   { label: 'Feel-good',   emoji: '🌞', movieGenres: [10751, 16, 35, 10402], tvGenres: [10751, 16, 35]         },
  romantic:   { label: 'Romantic',    emoji: '💘', movieGenres: [10749, 18, 35],        tvGenres: [18, 35]                },
  adventure:  { label: 'Adventure',   emoji: '🗺️', movieGenres: [12, 28, 14, 878],      tvGenres: [10759, 10765]          },
}

// ═══════════════════════════════════════════════════════════════
// ── Watch History (localStorage, namespaced per profile) ───────
// ═══════════════════════════════════════════════════════════════
export const LEGACY_HISTORY_KEY = 'wardoflix:history'
export const HISTORY_MAX = 24

export function historyKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:history:${id}` : LEGACY_HISTORY_KEY
}
// Kept as a module-level constant for callers that still compare
// against `HISTORY_KEY` (e.g. the useHistory hook's storage-event
// filter). Resolved lazily at read time below.
export const HISTORY_KEY = LEGACY_HISTORY_KEY

export function loadHistory() {
  try {
    const raw = localStorage.getItem(historyKeyForActive())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveHistory(list, profileId) {
  // profileId lets the caller pin a write to a specific profile instead
  // of "whoever is active right now" — avoids the race where a stream
  // started under profile A commits history 15s later but profile B is
  // now active (user switched profiles during the connect).
  const key = profileId ? `wardoflix:history:${profileId}` : historyKeyForActive()
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, HISTORY_MAX))) } catch {}
}

export function loadHistoryForProfile(profileId) {
  if (!profileId) return loadHistory()
  try {
    const raw = localStorage.getItem(`wardoflix:history:${profileId}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function addToHistory(entry, profileId) {
  if (!entry || !entry.magnet) return
  const list = profileId ? loadHistoryForProfile(profileId) : loadHistory()
  // Dedupe: same title+season+episode replaces earlier entry
  const key = `${entry.title || ''}|${entry.season || ''}|${entry.episode || ''}`
  const filtered = list.filter((e) => `${e.title || ''}|${e.season || ''}|${e.episode || ''}` !== key)
  filtered.unshift({ ...entry, lastPlayed: Date.now() })
  saveHistory(filtered, profileId)
}

export function useHistory() {
  const [history, setHistory] = useState(() => loadHistory())
  useEffect(() => {
    // Match either the legacy unnamespaced key or the new per-profile
    // key. Easier to check the prefix than enumerate every active id.
    const onStorage = (e) => {
      if (e.key === LEGACY_HISTORY_KEY || e.key?.startsWith('wardoflix:history:')) {
        setHistory(loadHistory())
      }
    }
    window.addEventListener('storage', onStorage)
    // Same-tab signal — fired from addToHistory, profile-switches, etc.
    const onLocal = () => setHistory(loadHistory())
    window.addEventListener('wardoflix:history-updated', onLocal)
    // Profile switch changes which history is "active" — re-read.
    window.addEventListener('wardoflix:profiles-updated', onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('wardoflix:history-updated', onLocal)
      window.removeEventListener('wardoflix:profiles-updated', onLocal)
    }
  }, [])
  return history
}

// ── Resume position (localStorage, namespaced per profile) ──────
// Keyed per title+season+episode so each episode resumes independently.
// We skip restoring if the saved position is <30s (too close to start —
// user just opened it) or within 60s of the end (they finished it).
export const LEGACY_RESUME_KEY = 'wardoflix:resume'
export const RESUME_MAX = 200 // cap stored entries so the map can't grow forever

export function resumeKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:resume:${id}` : LEGACY_RESUME_KEY
}

export function resumeKey(meta) {
  if (!meta) return null
  const id = meta.id || meta.title
  if (!id) return null
  const s = meta.season || 0
  const e = meta.episode || 0
  return `${id}|${s}|${e}`
}

export function loadResumeMap() {
  try {
    const raw = localStorage.getItem(resumeKeyForActive())
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function saveResumePosition(meta, time, duration) {
  const key = resumeKey(meta)
  if (!key || !isFinite(time) || time < 30) return
  // If within 60s of the end, clear the resume position AND flip the
  // item into the "watched" set so the episode list can render a ✓.
  if (duration > 0 && time > duration - 60) {
    clearResumePosition(meta)
    markWatched(meta)
    return
  }
  try {
    const map = loadResumeMap()
    map[key] = { t: Math.floor(time), d: duration > 0 ? Math.floor(duration) : 0, at: Date.now() }
    // Evict oldest entries past the cap
    const keys = Object.keys(map)
    if (keys.length > RESUME_MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      for (let i = 0; i < keys.length - RESUME_MAX; i++) delete map[keys[i]]
    }
    localStorage.setItem(resumeKeyForActive(), JSON.stringify(map))
  } catch {}
}

export function readResumePosition(meta) {
  const key = resumeKey(meta)
  if (!key) return 0
  const map = loadResumeMap()
  const entry = map[key]
  if (!entry || !isFinite(entry.t) || entry.t < 30) return 0
  return entry.t
}

export function clearResumePosition(meta) {
  const key = resumeKey(meta)
  if (!key) return
  try {
    const map = loadResumeMap()
    if (map[key]) { delete map[key]; localStorage.setItem(resumeKeyForActive(), JSON.stringify(map)) }
  } catch {}
}

// ── Subtitle offset, persisted per title ────────────────────────
// Previously sub offset reset every time you switched episodes. For a
// show with consistently-mistimed subs, that meant adjusting on every
// click. Now stored per (showId, season, episode) AND a fallback per
// (showId, *) so a series-wide offset applies to every episode unless
// you specifically tuned that one. The lookup tries episode-specific
// first, then the show fallback.
export function loadSubOffsets() {
  try {
    const raw = localStorage.getItem('wardoflix:sub-offsets')
    return raw ? (JSON.parse(raw) || {}) : {}
  } catch { return {} }
}
export function subOffsetKey(meta, scope = 'ep') {
  if (!meta) return null
  const id = meta.id || meta.title
  if (!id) return null
  if (scope === 'show') return `${id}|*|*`
  return `${id}|${meta.season || 0}|${meta.episode || 0}`
}
export function readSubOffset(meta) {
  if (!meta) return 0
  const map = loadSubOffsets()
  const epKey = subOffsetKey(meta, 'ep')
  const showKey = subOffsetKey(meta, 'show')
  const v = (epKey && map[epKey]) ?? (showKey && map[showKey]) ?? 0
  return Number.isFinite(v) ? v : 0
}
export function saveSubOffset(meta, offset, applyToShow = false) {
  const key = subOffsetKey(meta, applyToShow ? 'show' : 'ep')
  if (!key) return
  try {
    const map = loadSubOffsets()
    if (Math.abs(offset) < 0.05) delete map[key]
    else map[key] = Math.round(offset * 100) / 100
    // Cap stored entries
    const keys = Object.keys(map)
    if (keys.length > 500) for (let i = 0; i < 100; i++) delete map[keys[i]]
    localStorage.setItem('wardoflix:sub-offsets', JSON.stringify(map))
  } catch {}
}

// ── Skip intro / outro marks, per show ──────────────────────────
// User can mark "intro starts at X, intro ends at Y" once per show
// and the player offers a "Skip Intro" button between those
// timestamps for every episode. Stored per show id (not per episode)
// because intro/outro positions are show-wide (~always).
export function loadIntroMarks() {
  try { return JSON.parse(localStorage.getItem('wardoflix:intro-marks') || '{}') || {} }
  catch { return {} }
}
export function readIntroMark(showId) {
  if (!showId) return null
  return loadIntroMarks()[String(showId)] || null
}
export function saveIntroMark(showId, mark) {
  if (!showId) return
  try {
    const map = loadIntroMarks()
    if (!mark) delete map[String(showId)]
    else map[String(showId)] = { introStart: mark.introStart || null, introEnd: mark.introEnd || null, outroStart: mark.outroStart || null }
    localStorage.setItem('wardoflix:intro-marks', JSON.stringify(map))
  } catch {}
}

// ── Subtitle styling preferences (global per profile) ───────────
// Size, position, font, background. Applied via inline CSS variables
// on the player container so video.js text tracks pick up the styling
// from the existing .video-js .vjs-text-track-display rules.
export function subStyleKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:sub-style:${id}` : 'wardoflix:sub-style'
}
export const DEFAULT_SUB_STYLE = { size: 100, position: 0, weight: 'normal', bg: 'shadow' }
export function loadSubStyle() {
  try {
    const raw = localStorage.getItem(subStyleKeyForActive())
    return { ...DEFAULT_SUB_STYLE, ...(raw ? JSON.parse(raw) : {}) }
  } catch { return { ...DEFAULT_SUB_STYLE } }
}
export function saveSubStyle(style) {
  try { localStorage.setItem(subStyleKeyForActive(), JSON.stringify({ ...DEFAULT_SUB_STYLE, ...style })) } catch {}
}

// ── Audio language preference (per profile) ─────────────────────
// When a torrent has multiple audio tracks and one matches the user's
// preferred language code(s), auto-pick that instead of the default
// (which is just track #0). Codes use the same ISO-639-2/B form
// (eng, dut, nld, fre, spa…) we surface in the audio picker.
export function audioPrefKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:audio-pref:${id}` : 'wardoflix:audio-pref'
}
export function loadAudioPref() {
  try {
    const raw = localStorage.getItem(audioPrefKeyForActive())
    if (!raw) return ['eng']
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, 6) : ['eng']
  } catch { return ['eng'] }
}
export function saveAudioPref(langs) {
  try { localStorage.setItem(audioPrefKeyForActive(), JSON.stringify((langs || []).slice(0, 6))) } catch {}
}
// Pick the best track index given the user's preference order. Falls
// back to track 0 if no preference matches.
export function pickPreferredAudioTrack(tracks, prefs) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null
  if (!Array.isArray(prefs) || prefs.length === 0) return tracks[0].index
  for (const want of prefs) {
    const w = String(want || '').toLowerCase()
    if (!w) continue
    const m = tracks.find((t) => String(t.lang || '').toLowerCase() === w)
    if (m) return m.index
  }
  return tracks[0].index
}

// ── Watched set (separate from resume) ──────────────────────────
// Resume is "I stopped here"; watched is "I finished this". When a
// resume entry crosses the end-boundary we clear it *and* flip the
// episode into the watched set so the UI can show a ✓ on the list.
// Cap at 2000 entries per profile to keep the storage footprint sane
// on accounts that binge.
export const WATCHED_MAX = 2000
export function watchedKeyForActive() {
  const id = getActiveProfileId()
  return id ? `wardoflix:watched:${id}` : 'wardoflix:watched'
}
export function loadWatchedMap() {
  try {
    const raw = localStorage.getItem(watchedKeyForActive())
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}
export function markWatched(meta) {
  const key = resumeKey(meta)
  if (!key) return
  try {
    const map = loadWatchedMap()
    map[key] = Date.now()
    const keys = Object.keys(map)
    if (keys.length > WATCHED_MAX) {
      keys.sort((a, b) => (map[a] || 0) - (map[b] || 0))
      for (let i = 0; i < keys.length - WATCHED_MAX; i++) delete map[keys[i]]
    }
    localStorage.setItem(watchedKeyForActive(), JSON.stringify(map))
    // Broadcast so any open DetailModal / episode list can re-render
    // its watched indicators without waiting for a remount.
    try { window.dispatchEvent(new Event('wardoflix:watched-updated')) } catch {}
  } catch {}
}
// Inverse of markWatched — called by the manual toggle (shift-click on
// an episode button). Idempotent: noop if the entry isn't there.
export function unmarkWatched(meta) {
  const key = resumeKey(meta)
  if (!key) return
  try {
    const map = loadWatchedMap()
    if (map[key]) {
      delete map[key]
      localStorage.setItem(watchedKeyForActive(), JSON.stringify(map))
      try { window.dispatchEvent(new Event('wardoflix:watched-updated')) } catch {}
    }
  } catch {}
}

export function isWatched(meta) {
  const key = resumeKey(meta)
  if (!key) return false
  return !!loadWatchedMap()[key]
}

// ── Volume + mute persistence (localStorage) ────────────────────
export const VOLUME_KEY = 'wardoflix:volume'
export function loadVolumePref() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const v = Number(parsed.volume)
    if (!isFinite(v) || v < 0 || v > 1) return null
    return { volume: v, muted: !!parsed.muted }
  } catch { return null }
}
export function saveVolumePref(volume, muted) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({
      volume: Math.max(0, Math.min(1, Number(volume) || 0)),
      muted: !!muted,
    }))
  } catch {}
}
