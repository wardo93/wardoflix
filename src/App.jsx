import { useState, useRef, useEffect, useCallback, useMemo, Component } from 'react'
import videojs from 'video.js'
import 'video.js/dist/video-js.css'
import './App.css'

// Pure helpers extracted to src/lib/. The relevant comments live there.
import {
  isMagnetLink, isDirectUrl, BROWSER_SAFE_VCODECS, formatAudioTrackLabel,
  seedHealth, seedHealthLabel, inferType, formatSpeed, formatTime, uuid,
} from './lib/util.js'
import { upgradeStreamUrlForCodec, toAbsStreamUrl } from './lib/url.js'
import {
  useDebounce, useEdgeHoverScroll, useWheelHorizontalScroll, useHorizontalRowGestures, useFocusTrap,
} from './lib/hooks.js'
import { ToastHost, ShortcutsOverlay, DebugOverlay, toast } from './components/Overlays.jsx'
import { WardoFlixIntro, pickPiracyQuote } from './components/WardoFlixIntro.jsx'
import { PosterCard } from './components/PosterCard.jsx'
import { ContentRow } from './components/ContentRow.jsx'
import { DetailModal } from './components/DetailModal.jsx'
import { PlayerControls } from './components/PlayerControls.jsx'
import { readLastSeenVersion, markVersionSeen, changelogEntriesNewerThan } from './lib/changelog.js'
// Storage layer — profiles, history, resume, watched, sub offsets,
// intro marks, sub style, audio language pref, volume.
import {
  PROFILE_MAX, PROFILE_COLORS, PROFILE_EMOJIS, MOODS,
  loadProfiles, saveProfiles, getActiveProfileId, setActiveProfileId, getActiveProfile,
  createProfile, updateProfile, deleteProfile, useProfiles,
  loadHistory, saveHistory, loadHistoryForProfile, addToHistory, useHistory,
  resumeKey, loadResumeMap, saveResumePosition, readResumePosition, clearResumePosition,
  loadSubOffsets, readSubOffset, saveSubOffset,
  loadIntroMarks, readIntroMark, saveIntroMark,
  loadSubStyle, saveSubStyle,
  loadAudioPref, saveAudioPref, pickPreferredAudioTrack,
  loadQualityPrefs, readQualityPref, saveQualityPref, sortByQualityPref,
  loadLibrary, isInLibrary, addToLibrary, removeFromLibrary, useLibrary,
  readPlaybackRate, savePlaybackRate,
  loadWatchedMap, markWatched, unmarkWatched, isWatched,
  loadVolumePref, saveVolumePref,
  loadPrivacyMode, savePrivacyMode, usePrivacyMode,
} from './lib/storage.js'


// ── Hero Banner ─────────────────────────────────────────────────
function HeroBanner({ items, type, onSelect, onStream }) {
  const [idx, setIdx] = useState(0)
  const item = items[idx]

  useEffect(() => {
    if (items.length <= 1) return
    const id = setInterval(() => setIdx((i) => (i + 1) % items.length), 10000)
    return () => clearInterval(id)
  }, [items.length])

  useEffect(() => { setIdx(0) }, [type])

  if (!item) return <div className="hero hero--empty" />

  return (
    <div className="hero" key={item.id}>
      {item.backdrop_path && (
        <div className="hero-backdrop">
          <img src={item.backdrop_path} alt="" />
        </div>
      )}
      <div className="hero-gradient" />
      <div className="hero-content">
        <h2 className="hero-title">{item.title || item.name}</h2>
        {item.vote_average > 0 && (
          <div className="hero-meta">
            <span className="hero-rating">★ {item.vote_average.toFixed(1)}</span>
            {(item.release_date || item.first_air_date) && (
              <span className="hero-year">{(item.release_date || item.first_air_date).slice(0, 4)}</span>
            )}
          </div>
        )}
        {item.overview && <p className="hero-overview">{item.overview.slice(0, 200)}{item.overview.length > 200 ? '...' : ''}</p>}
        <div className="hero-actions">
          <button className="btn btn-hero" onClick={() => onSelect({ ...item, title: item.title || item.name, poster: item.poster_path, date: item.release_date || item.first_air_date, rating: item.vote_average, type })}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Play
          </button>
          <button className="btn btn-hero-secondary" onClick={() => onSelect({ ...item, title: item.title || item.name, poster: item.poster_path, date: item.release_date || item.first_air_date, rating: item.vote_average, type })}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            More Info
          </button>
        </div>
      </div>
      {items.length > 1 && (
        <div className="hero-dots" role="tablist" aria-label="Featured titles">
          {items.slice(0, 5).map((_, i) => (
            <button
              key={i}
              className={`hero-dot ${i === idx ? 'active' : ''}`}
              onClick={() => setIdx(i)}
              role="tab"
              aria-selected={i === idx}
              aria-label={`Featured title ${i + 1} of ${Math.min(5, items.length)}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── PosterCard + ContentRow ─────────────────────────────────────
// Both extracted to ./components/ in v1.7.0. Imports above.

// ── Search Results Grid ─────────────────────────────────────────
function SearchResults({ type, query, onSelect }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query) { setItems([]); return }
    let cancelled = false
    setLoading(true)
    fetch(`/api/catalog/${type}?search=${encodeURIComponent(query)}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => { if (!cancelled) setItems(d.results || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [type, query])

  if (loading) return (
    // Skeleton grid while we wait — feels much faster than a single
    // spinner because the page commits to its final shape immediately
    // and only the contents fade in. Same component shape as the
    // populated grid below so layout doesn't jump on transition.
    <div className="search-grid">
      {[...Array(18)].map((_, i) => (
        <div key={i} className="search-card-skeleton" aria-hidden="true">
          <div className="skeleton-poster" />
          <div className="skeleton-line skeleton-line--wide" />
          <div className="skeleton-line skeleton-line--narrow" />
        </div>
      ))}
    </div>
  )
  if (!items.length) return <div className="search-empty"><p>No results for "{query}"</p></div>

  return (
    <div className="search-grid">
      {items.map((item) => (
        <button
          key={item.id}
          className="search-card"
          onClick={() => onSelect({
            id: item.id,
            title: item.title || item.name,
            name: item.name || null,
            poster: item.poster_path,
            backdrop: item.backdrop_path,
            overview: item.overview,
            date: item.release_date || item.first_air_date,
            release_date: item.release_date || null,
            first_air_date: item.first_air_date || null,
            rating: item.vote_average,
            type,
          })}
        >
          {item.poster_path ? <img src={item.poster_path} alt="" loading="lazy" /> : <div className="poster-placeholder">{(item.title || item.name || '?')[0]}</div>}
          <div className="search-card-info">
            <span className="search-card-title">{item.title || item.name}</span>
            {item.vote_average > 0 && <span className="search-card-rating">★ {item.vote_average.toFixed(1)}</span>}
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Continue Watching Row ───────────────────────────────────────
function ContinueWatchingRow({ onPlay, onInfo }) {
  const history = useHistory()
  const rowRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  useEdgeHoverScroll(rowRef)

  const updateScrollState = useCallback(() => {
    const el = rowRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 20)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 20)
  }, [])

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    return () => el.removeEventListener('scroll', updateScrollState)
  }, [history, updateScrollState])

  useHorizontalRowGestures(rowRef, history)

  const scroll = (dir) => {
    const el = rowRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' })
  }

  const removeEntry = (e, entry) => {
    e.stopPropagation()
    if (e.preventDefault) e.preventDefault()
    const prevList = loadHistory()
    const list = prevList.filter((h) =>
      !(h.title === entry.title && h.season === entry.season && h.episode === entry.episode)
    )
    saveHistory(list)
    window.dispatchEvent(new Event('wardoflix:history-updated'))
    // v1.7.9: friendly toast + Undo so right-click removals aren't
    // a permanent surprise. The existing hover-× button calls this
    // too, so both interaction paths benefit from the safety net.
    toast(`Removed "${entry.title}${entry.season ? ` S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}` : ''}" from Continue Watching`, 'info', {
      title: 'Hidden',
      action: {
        label: 'Undo',
        onClick: () => {
          saveHistory(prevList)
          window.dispatchEvent(new Event('wardoflix:history-updated'))
        },
      },
    })
  }

  // Dedupe TV-show history: collapse consecutive entries of the same
  // show into one card (showing the LATEST episode watched). For movies
  // and one-off TV plays, this is a no-op. Otherwise a binge-watching
  // session of "The Boys S01E01..S01E08" used to fill the entire
  // Continue Watching row with eight near-identical posters; now it
  // shows as one card labelled "S01E08" (the most recent), and the
  // resume position points at that episode. Keep oldest seen-first
  // ordering by collapsing rather than sorting.
  const dedupedHistory = useMemo(() => {
    const out = []
    const seenTitles = new Set()
    for (const h of history) {
      const key = h.id ? `id:${h.id}` : `title:${h.title}`
      if (h.season || h.episode) {
        if (seenTitles.has(key)) continue
        seenTitles.add(key)
      }
      out.push(h)
    }
    return out
  }, [history])

  if (!dedupedHistory.length) return null

  return (
    <div className="content-row">
      <h3 className="row-title">Continue Watching</h3>
      <div className="row-container">
        {canScrollLeft && (
          <button className="row-arrow row-arrow--left" onClick={() => scroll(-1)} aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        )}
        <div className="row-posters" ref={rowRef}>
          {dedupedHistory.map((entry, i) => (
            <button
              key={`${entry.title}-${entry.season || ''}-${entry.episode || ''}-${i}`}
              className="row-poster history-poster"
              onClick={() => onPlay(entry)}
              onContextMenu={(e) => removeEntry(e, entry)}
              title={`${entry.title}${entry.season ? ` S${entry.season}` : ''}${entry.episode ? `E${entry.episode}` : ''} · Right-click to hide`}
            >
              {entry.poster ? (
                <img src={entry.poster} alt="" loading="lazy" />
              ) : (
                <div className="poster-placeholder">{(entry.title || '?')[0]}</div>
              )}
              <div className="history-overlay">
                <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
              </div>
              <button
                className="history-remove"
                onClick={(e) => removeEntry(e, entry)}
                title="Remove"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              {/* Resume-progress bar — Netflix/Hulu-style red band at the
                  bottom of the card showing how far you got last time.
                  Read directly from the resume map by the same key the
                  player uses, so the displayed % matches what the
                  player will actually resume to. */}
              {(() => {
                try {
                  const map = loadResumeMap()
                  const k = resumeKey({ id: entry.id, title: entry.title, season: entry.season, episode: entry.episode })
                  const r = k && map[k]
                  if (!r || !r.t || !r.d) return null
                  const pct = Math.min(100, Math.max(0, (r.t / r.d) * 100))
                  return (
                    <div className="row-poster-progress" aria-hidden="true">
                      <div className="row-poster-progress-bar" style={{ width: `${pct}%` }} />
                    </div>
                  )
                } catch { return null }
              })()}
              <div className="row-poster-info">
                <span className="row-poster-title">{entry.title}</span>
                {entry.season && entry.episode && (
                  <span className="row-poster-rating">S{String(entry.season).padStart(2,'0')}E{String(entry.episode).padStart(2,'0')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
        {canScrollRight && (
          <button className="row-arrow row-arrow--right" onClick={() => scroll(1)} aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ── Profile UI ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Circular avatar with initial or emoji. Used on the picker screen,
// the topbar switcher, and inside the editor.
function ProfileAvatar({ profile, size = 96, onClick, className = '' }) {
  if (!profile) return null
  const initial = (profile.name || '?').trim().charAt(0).toUpperCase()
  const style = {
    width: size,
    height: size,
    background: `radial-gradient(circle at 30% 28%, ${profile.color}ee 0%, ${profile.color}aa 50%, ${profile.color}55 100%)`,
    borderColor: `${profile.color}88`,
    fontSize: Math.round(size * 0.42),
  }
  return (
    <button
      type="button"
      className={`wf-avatar ${onClick ? 'wf-avatar--clickable' : ''} ${className}`}
      style={style}
      onClick={onClick}
      aria-label={profile.name}
      title={profile.name}
    >
      <span className="wf-avatar-emoji" aria-hidden="true">{profile.emoji || initial}</span>
    </button>
  )
}

// Full-screen "Who's watching?" picker. Covers the whole app while
// no active profile is set, so history + recommendations always tie
// back to a known user.
function ProfileGate({ profiles, onPick, onManage }) {
  const [creating, setCreating] = useState(profiles.length === 0)
  // Auto-open the creator on first run — no profiles means we can't
  // show a picker anyway, and jumping straight to "make one" is less
  // friction than staring at an empty screen with a single button.
  return (
    <div className="wf-profile-gate">
      <div className="wf-profile-gate-inner">
        <h1 className="wf-profile-gate-title">Who's watching?</h1>
        <p className="wf-profile-gate-sub">Pick a profile to continue — your watch history and For You rail travel with it.</p>
        <div className="wf-profile-picker-grid">
          {profiles.map((p) => (
            <div key={p.id} className="wf-profile-pick">
              <ProfileAvatar profile={p} size={120} onClick={() => onPick(p.id)} />
              <div className="wf-profile-pick-name">{p.name}</div>
            </div>
          ))}
          {profiles.length < PROFILE_MAX && (
            <div className="wf-profile-pick">
              <button
                type="button"
                className="wf-avatar wf-avatar--add"
                style={{ width: 120, height: 120 }}
                onClick={() => setCreating(true)}
                aria-label="Add profile"
              >
                <span className="wf-avatar-plus" aria-hidden="true">+</span>
              </button>
              <div className="wf-profile-pick-name">Add profile</div>
            </div>
          )}
        </div>
        {profiles.length > 0 && (
          <button type="button" className="wf-profile-manage-btn" onClick={onManage}>Manage profiles</button>
        )}
      </div>
      {creating && (
        <ProfileEditor
          onClose={() => setCreating(false)}
          onSave={(data) => {
            const p = createProfile(data)
            setActiveProfileId(p.id)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

// Create/edit modal. Name, emoji, color, and favourite-genre picks
// per type. Genres are fetched from the same /api/catalog/genres
// endpoint the sidebar uses, so the list mirrors what the user
// sees when they browse.
function ProfileEditor({ profile, onClose, onSave, onDelete }) {
  const [name, setName] = useState(profile?.name || '')
  const [emoji, setEmoji] = useState(profile?.emoji || PROFILE_EMOJIS[0])
  const [color, setColor] = useState(profile?.color || PROFILE_COLORS[0])
  const [movieGenres, setMovieGenres] = useState(profile?.favoriteGenres?.movies || [])
  const [tvGenres, setTvGenres] = useState(profile?.favoriteGenres?.tv || [])
  const [allMovieGenres, setAllMovieGenres] = useState([])
  const [allTvGenres, setAllTvGenres] = useState([])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/catalog/genres/movies').then((r) => r.json()).catch(() => ({ genres: [] })),
      fetch('/api/catalog/genres/tv').then((r) => r.json()).catch(() => ({ genres: [] })),
    ]).then(([m, t]) => {
      if (cancelled) return
      setAllMovieGenres(m.genres || [])
      setAllTvGenres(t.genres || [])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleGenre = (list, setList, id) => {
    if (list.includes(id)) setList(list.filter((g) => g !== id))
    else if (list.length < 8) setList([...list, id])
  }

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave({
      name: trimmed,
      emoji,
      color,
      favoriteGenres: { movies: movieGenres, tv: tvGenres },
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wf-profile-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div className="modal-body">
          <h2 className="wf-profile-modal-title">{profile ? 'Edit profile' : 'New profile'}</h2>

          <div className="wf-profile-preview-row">
            <ProfileAvatar profile={{ name, emoji, color }} size={96} />
            <input
              className="wf-profile-name-input"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 24))}
              placeholder="Profile name"
              maxLength={24}
              autoFocus
            />
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">Avatar</div>
            <div className="wf-emoji-grid">
              {PROFILE_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`wf-emoji-chip ${e === emoji ? 'selected' : ''}`}
                  onClick={() => setEmoji(e)}
                >{e}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">Color</div>
            <div className="wf-color-grid">
              {PROFILE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`wf-color-chip ${c === color ? 'selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">
              Favourite movie genres <span className="wf-profile-section-hint">pick up to 8</span>
            </div>
            <div className="wf-genre-chip-grid">
              {allMovieGenres.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`wf-genre-chip ${movieGenres.includes(g.id) ? 'selected' : ''}`}
                  onClick={() => toggleGenre(movieGenres, setMovieGenres, g.id)}
                  disabled={!movieGenres.includes(g.id) && movieGenres.length >= 8}
                >{g.name}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-section">
            <div className="wf-profile-section-label">
              Favourite series genres <span className="wf-profile-section-hint">pick up to 8</span>
            </div>
            <div className="wf-genre-chip-grid">
              {allTvGenres.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`wf-genre-chip ${tvGenres.includes(g.id) ? 'selected' : ''}`}
                  onClick={() => toggleGenre(tvGenres, setTvGenres, g.id)}
                  disabled={!tvGenres.includes(g.id) && tvGenres.length >= 8}
                >{g.name}</button>
              ))}
            </div>
          </div>

          <div className="wf-profile-actions">
            {onDelete && profile && (
              <button className="btn btn-danger" onClick={() => {
                if (confirm(`Delete profile "${profile.name}"? This removes its watch history and resume positions.`)) onDelete()
              }}>Delete profile</button>
            )}
            <div className="wf-profile-actions-right">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" onClick={handleSave} disabled={!name.trim()}>
                {profile ? 'Save' : 'Create profile'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Topbar switcher — avatar button + dropdown to change or edit
// profiles. Clicking the gear-row item opens the editor for the
// current profile; "Switch profile" returns to the gate.
// ═══════════════════════════════════════════════════════════════
// ── Auto-updater ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
//
// `window.wardoflixUpdater` is exposed by electron/preload.cjs and only
// exists in the packaged app. In the browser preview the hook returns
// `hasApi: false` and the indicator renders nothing — clean no-op.
//
// The main process drives all state transitions; we just mirror them
// and offer two actions: trigger a check, or install once downloaded.

function useUpdater() {
  const hasApi = typeof window !== 'undefined' && !!window.wardoflixUpdater
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!hasApi) return
    const api = window.wardoflixUpdater
    let cancelled = false

    // Hydrate — the main process may have fired events before we mounted.
    Promise.resolve(api.getStatus?.())
      .then((s) => { if (!cancelled && s) setStatus(s) })
      .catch(() => {})

    const unsub = api.onStatus?.((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => { cancelled = true; try { unsub?.() } catch {} }
  }, [hasApi])

  const check = useCallback(async () => {
    if (!hasApi) return
    try { await window.wardoflixUpdater.check() } catch {}
  }, [hasApi])

  const install = useCallback(async () => {
    if (!hasApi) return
    try { await window.wardoflixUpdater.install() } catch {}
  }, [hasApi])

  return { status, check, install, hasApi }
}

// "What's New" modal (v1.8.1) — surfaces the changelog entries for
// every version installed since the user last saw it. Fires on the
// first launch after an upgrade; dismissing it marks the current
// version as seen so it won't return until the NEXT upgrade.
//
// Renders nothing on a fresh install (readLastSeenVersion bootstraps
// the localStorage value to the current version, so there are zero
// entries newer than "now").
function ChangelogModal({ entries, currentVersion, onDismiss }) {
  // Esc dismisses.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onDismiss() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDismiss])
  if (!entries?.length) return null
  return (
    <div className="changelog-overlay" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
      <div className="changelog-card">
        <header className="changelog-header">
          <span className="changelog-eyebrow">What's new</span>
          <h2 id="changelog-title" className="changelog-title">
            Updated to v{currentVersion}
          </h2>
          {entries.length > 1 && (
            <p className="changelog-sub">
              {entries.length} updates since you last opened the app
            </p>
          )}
        </header>
        <div className="changelog-body">
          {entries.map((e) => (
            <section key={e.version} className="changelog-entry">
              <div className="changelog-entry-head">
                <span className="changelog-entry-version">v{e.version}</span>
                {e.title && <span className="changelog-entry-title">{e.title}</span>}
              </div>
              <ul className="changelog-list">
                {e.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <footer className="changelog-footer">
          <button className="changelog-dismiss" onClick={onDismiss} autoFocus>
            Got it
          </button>
        </footer>
      </div>
    </div>
  )
}

// Central update modal — appears when an update has finished
// downloading. Replaces the previous "small badge in the corner"
// flow with something the user actually notices. One button installs
// + relaunches; the second dismisses for this session (it'll come
// back next launch if the update is still pending). Designed to be
// non-blocking — it's centered and modal-like but the user can
// click outside or hit Esc to defer.
function UpdateAvailableModal() {
  const { status, install } = useUpdater()
  const [dismissed, setDismissed] = useState(false)
  // Reset dismissal when a NEW update arrives (state goes from
  // downloaded with version A → downloaded with version B). Without
  // this, dismissing 1.5.23 would silently mute 1.5.24's prompt.
  const lastVersionRef = useRef(null)
  useEffect(() => {
    if (status?.state === 'downloaded' && status.version !== lastVersionRef.current) {
      lastVersionRef.current = status.version
      setDismissed(false)
    }
  }, [status?.state, status?.version])
  // Esc dismisses for this session.
  useEffect(() => {
    if (dismissed || status?.state !== 'downloaded') return
    const onKey = (e) => { if (e.key === 'Escape') setDismissed(true) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissed, status?.state])

  if (status?.state !== 'downloaded') return null
  if (dismissed) return null
  return (
    <div className="wf-update-backdrop" onClick={() => setDismissed(true)}>
      <div className="wf-update-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Update v${status.version || ''} ready`}>
        <div className="wf-update-icon">
          <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </div>
        <h2 className="wf-update-title">Update ready</h2>
        <p className="wf-update-version">WardoFlix v{status.version || '?'} is downloaded and ready to install.</p>
        <p className="wf-update-blurb">The app will restart and pick up exactly where you are. Your library, history, and resume positions all carry over.</p>
        <div className="wf-update-actions">
          <button
            className="wf-update-btn wf-update-btn--primary"
            onClick={() => { install() }}
          >
            Install &amp; restart
          </button>
          <button
            className="wf-update-btn"
            onClick={() => setDismissed(true)}
          >
            Later
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Privacy Mode toggle (v1.9.0) ───────────────────────────────
// Topbar button that flips the per-profile privacy flag. When ON:
//   - new history entries are dropped (Continue Watching freezes)
//   - resume positions don't save (every replay restarts at 0)
//   - Discord Rich Presence sends clearActivity instead of titles
//   - watched flag writes are suppressed
// Visual: open-eye icon (off) → crossed-eye icon (on). Tooltip
// explains the effect so it isn't a mystery button.
function PrivacyModeToggle() {
  const on = usePrivacyMode()
  return (
    <button
      className={`privacy-toggle ${on ? 'is-on' : ''}`}
      onClick={() => savePrivacyMode(!on)}
      title={on
        ? 'Privacy Mode is ON — history, resume, and Rich Presence suspended. Click to turn off.'
        : 'Privacy Mode is OFF — click to suspend history, resume, and Discord Rich Presence for this session.'}
      aria-label={on ? 'Disable Privacy Mode' : 'Enable Privacy Mode'}
      aria-pressed={on}
    >
      {on ? (
        // crossed-out eye
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        // open eye
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
      {on && <span className="privacy-toggle-label">Private</span>}
    </button>
  )
}

function UpdaterIndicator() {
  const { status, check, install, hasApi } = useUpdater()
  const [open, setOpen] = useState(false)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!hasApi) return null

  const state = status?.state || 'idle'
  const version = status?.version
  const current = status?.currentVersion
  const progress = status?.progress
  const message = status?.message
  const hasNews = state === 'available' || state === 'downloading' || state === 'downloaded' || state === 'error'

  const hover = (() => {
    switch (state) {
      case 'checking': return 'Checking for updates…'
      case 'available': return `Update available: v${version || ''}`
      case 'not-available': return "You're up to date"
      case 'downloading': return `Downloading v${version || ''} — ${Math.round(progress?.percent || 0)}%`
      case 'downloaded': return `v${version || ''} ready — click to install`
      case 'error': return 'Update check failed'
      case 'disabled': return 'Updates disabled in dev'
      default: return 'Check for updates'
    }
  })()

  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)))

  return (
    <div className="wf-updater" ref={panelRef} data-state={state}>
      <button
        className="wf-updater-btn"
        type="button"
        title={hover}
        aria-label={hover}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className={`wf-updater-icon ${state === 'checking' || state === 'downloading' ? 'is-spinning' : ''}`}
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {state === 'downloaded' ? (
            <>
              <polyline points="20 6 9 17 4 12" />
            </>
          ) : (
            <>
              <path d="M21 12a9 9 0 1 1-3.55-7.15" />
              <polyline points="21 3 21 9 15 9" />
            </>
          )}
        </svg>
        {hasNews && <span className="wf-updater-dot" />}
      </button>

      {open && (
        <div className="wf-updater-panel">
          <div className="wf-updater-panel-head">
            <div className="wf-updater-panel-title">
              {state === 'downloaded'
                ? `Update ready: v${version || ''}`
                : state === 'available' || state === 'downloading'
                ? `Update ${version ? `v${version} ` : ''}in progress`
                : state === 'checking'
                ? 'Looking for updates'
                : state === 'error'
                ? 'Update check failed'
                : state === 'disabled'
                ? 'Updates disabled'
                : 'WardoFlix is up to date'}
            </div>
            <div className="wf-updater-panel-sub">
              {message || `Running version ${current || ''}`}
            </div>
          </div>

          {state === 'downloading' && (
            <div className="wf-updater-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="wf-updater-progress-bar" style={{ width: `${pct}%` }} />
              <div className="wf-updater-progress-label">
                <span>{pct}%</span>
                {progress?.bytesPerSecond > 0 && (
                  <span>{formatSpeed(progress.bytesPerSecond)}</span>
                )}
              </div>
            </div>
          )}

          {state === 'error' && status?.error && (
            <div className="wf-updater-error" title={status.error}>
              {status.error}
            </div>
          )}

          <div className="wf-updater-actions">
            {state === 'downloaded' ? (
              <button
                type="button"
                className="wf-updater-action primary"
                onClick={() => { setOpen(false); install() }}
              >
                Restart &amp; install
              </button>
            ) : (
              <button
                type="button"
                className="wf-updater-action"
                disabled={state === 'checking' || state === 'downloading' || state === 'disabled'}
                onClick={() => { check() }}
              >
                {state === 'checking'
                  ? 'Checking…'
                  : state === 'downloading'
                  ? 'Downloading…'
                  : state === 'disabled'
                  ? 'Unavailable'
                  : 'Check now'}
              </button>
            )}
          </div>

          <div className="wf-updater-foot">
            <span>Current: v{current || '—'}</span>
            {version && version !== current && (
              <span className="wf-updater-foot-new">New: v{version}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileSwitcher({ profiles, activeProfile }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null) // profile object being edited, or null
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!activeProfile) return null

  return (
    <div className="wf-profile-switcher" ref={menuRef}>
      <ProfileAvatar
        profile={activeProfile}
        size={34}
        onClick={() => setOpen((v) => !v)}
        className="wf-profile-switcher-avatar"
      />
      {open && (
        <div className="wf-profile-switcher-menu">
          <div className="wf-profile-switcher-header">
            <ProfileAvatar profile={activeProfile} size={40} />
            <div className="wf-profile-switcher-ident">
              <div className="wf-profile-switcher-name">{activeProfile.name}</div>
              <div className="wf-profile-switcher-sub">Active profile</div>
            </div>
          </div>
          <div className="wf-profile-switcher-divider" />
          {profiles.filter((p) => p.id !== activeProfile.id).map((p) => (
            <button
              key={p.id}
              className="wf-profile-switcher-row"
              onClick={() => { setActiveProfileId(p.id); setOpen(false) }}
            >
              <ProfileAvatar profile={p} size={28} />
              <span>Switch to {p.name}</span>
            </button>
          ))}
          <button
            className="wf-profile-switcher-row"
            onClick={() => { setEditing(activeProfile); setOpen(false) }}
          >
            <span className="wf-profile-switcher-icon" aria-hidden="true">✎</span>
            <span>Edit profile</span>
          </button>
          <button
            className="wf-profile-switcher-row"
            onClick={() => { setActiveProfileId(null); setOpen(false) }}
          >
            <span className="wf-profile-switcher-icon" aria-hidden="true">⇄</span>
            <span>Switch profile…</span>
          </button>
        </div>
      )}
      {editing && (
        <ProfileEditor
          profile={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => { updateProfile(editing.id, patch); setEditing(null) }}
          onDelete={() => { deleteProfile(editing.id); setEditing(null) }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ── For You ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Pill row at the top of the For You page. Mood selection is stored
// on the active profile (so it persists between sessions) and folds
// into the recommendation weights.
function MoodPicker({ activeMood, onChange }) {
  return (
    <div className="wf-mood-row">
      <span className="wf-mood-label">What's the mood?</span>
      <div className="wf-mood-pills">
        <button
          className={`wf-mood-pill ${!activeMood ? 'active' : ''}`}
          onClick={() => onChange(null)}
        >Any</button>
        {Object.entries(MOODS).map(([key, m]) => (
          <button
            key={key}
            className={`wf-mood-pill ${activeMood === key ? 'active' : ''}`}
            onClick={() => onChange(key)}
            title={m.label}
          >
            <span className="wf-mood-pill-emoji" aria-hidden="true">{m.emoji}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// Combine signals into per-type genre weights. Returns { movies:
// [{id, weight}, ...], tv: [...] }, each sorted high→low.
function computeGenreWeights(profile, history) {
  const movies = {}
  const tv = {}
  const bump = (map, id, amount) => { map[id] = (map[id] || 0) + amount }
  // (1) Favourite genres = the strongest manual signal.
  for (const id of (profile?.favoriteGenres?.movies || [])) bump(movies, id, 5)
  for (const id of (profile?.favoriteGenres?.tv || [])) bump(tv, id, 5)
  // (2) History-derived — each watched entry contributes to its
  // type's map. We don't have TMDB genre_ids on history entries,
  // but we DO know the type; this alone biases the type mix even
  // without per-genre details, and the history-resolver below
  // fills in the genre side via cached details.
  for (const h of (history || [])) {
    const tType = inferType(h)
    // The per-entry genre contribution is best-effort — we patched
    // addToHistory to carry genre_ids when they were available at
    // stream time (see App render). Older entries lack them and
    // fall through to the type bias only.
    const ids = Array.isArray(h.genreIds) ? h.genreIds : []
    const map = tType === 'tv' ? tv : movies
    for (const id of ids) bump(map, id, 2)
  }
  // (3) Mood overlay — light nudge on top of the manual+history mix.
  const mood = profile?.mood ? MOODS[profile.mood] : null
  if (mood) {
    for (const id of mood.movieGenres) bump(movies, id, 3)
    for (const id of mood.tvGenres) bump(tv, id, 3)
  }
  const rank = (obj) => Object.entries(obj)
    .map(([id, weight]) => ({ id: Number(id), weight }))
    .sort((a, b) => b.weight - a.weight)
  return { movies: rank(movies), tv: rank(tv) }
}

// Pull a genre-ID → name map, used to label the rows.
function useGenreNames() {
  const [names, setNames] = useState({ movies: {}, tv: {} })
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/catalog/genres/movies').then((r) => r.json()).catch(() => ({ genres: [] })),
      fetch('/api/catalog/genres/tv').then((r) => r.json()).catch(() => ({ genres: [] })),
    ]).then(([m, t]) => {
      if (cancelled) return
      const mm = {}; for (const g of (m.genres || [])) mm[g.id] = g.name
      const tt = {}; for (const g of (t.genres || [])) tt[g.id] = g.name
      setNames({ movies: mm, tv: tt })
    })
    return () => { cancelled = true }
  }, [])
  return names
}

function ForYou({ profile, onSelect, onPlayHistory }) {
  const history = useHistory()
  const genreNames = useGenreNames()
  const [mood, setMood] = useState(profile?.mood || null)

  // Persist mood back onto the profile so it survives a reload/session.
  const handleMood = (m) => {
    setMood(m)
    if (profile) updateProfile(profile.id, { mood: m })
  }

  const weights = useMemo(
    () => computeGenreWeights({ ...profile, mood }, history),
    [profile, mood, history]
  )

  // Pick top 3 per type — enough rows to feel personalised without
  // dragging the page out. If the user hasn't picked any favourites
  // and has no history, we fall through to generic trending below.
  const topMovieGenres = weights.movies.slice(0, 3)
  const topTvGenres = weights.tv.slice(0, 3)
  const hasAnySignal = topMovieGenres.length > 0 || topTvGenres.length > 0

  // "Because you watched X" — take the most-recent *distinct title*
  // from history and render its TMDB 'similar' list. We use the
  // existing /api/details endpoint so the request is cached server-
  // side and coexists with the detail modal's fetch.
  const lastWatched = history.find((h) => h.id) || null

  return (
    <>
      <div className="wf-foryou-header">
        <div className="wf-foryou-greet">
          <span className="wf-foryou-greet-emoji" aria-hidden="true">{profile?.emoji || '👋'}</span>
          <div>
            <h2 className="wf-foryou-title">For {profile?.name || 'You'}</h2>
            <p className="wf-foryou-sub">Picks blended from your favourites, your watch history and today's mood.</p>
          </div>
        </div>
        <MoodPicker activeMood={mood} onChange={handleMood} />
      </div>

      <div className="rows-section">
        <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelect} />

        {lastWatched && (
          <BecauseYouWatchedRow entry={lastWatched} onSelect={onSelect} />
        )}

        {topMovieGenres.map((g) => (
          <ContentRow
            key={`fy-m-${g.id}`}
            title={`${genreNames.movies[g.id] || 'Recommended'} · Movies`}
            url={`/api/catalog/movies?genre=${g.id}`}
            type="movies"
            onSelect={onSelect}
          />
        ))}
        {topTvGenres.map((g) => (
          <ContentRow
            key={`fy-t-${g.id}`}
            title={`${genreNames.tv[g.id] || 'Recommended'} · Series`}
            url={`/api/catalog/tv?genre=${g.id}`}
            type="tv"
            onSelect={onSelect}
          />
        ))}

        {/* Fallback when we have no signal yet — still gives the
            user something to click so the page doesn't look empty
            on a brand-new profile before they've picked anything. */}
        {!hasAnySignal && (
          <>
            <ContentRow title="Top 10 Movies This Week" url={`/api/catalog/movies?category=trending`} type="movies" onSelect={onSelect} showRanking />
            <ContentRow title="Top 10 Series This Week" url={`/api/catalog/tv?category=trending`} type="tv" onSelect={onSelect} showRanking />
          </>
        )}
      </div>
    </>
  )
}

// Library view — Stremio-style "saved for later" grid. Subscribed to
// the live useLibrary() hook so add/remove from the DetailModal
// reflects immediately. Empty state is a friendly nudge to use the
// bookmark button in the modal so the feature is discoverable.
function LibraryView({ onSelect }) {
  const items = useLibrary()
  const history = useHistory()
  // v1.8.1 — derive a per-item watched status so cards can show a
  // badge (Netflix-style "Resume" vs "Played" vs unstarted). Three
  // states per item:
  //   'watched'   → movies: in the watched map; TV: marked-watched
  //                 OR final episode finished (clearResumePosition
  //                 fires markWatched at -60s of the runtime).
  //   'started'   → there's a resume position OR any history entry
  //                 for the title (TV shows often have many history
  //                 entries — one per episode).
  //   null        → never played.
  // For TV shows, since "watched the whole series" is non-trivial to
  // detect (we'd need to iterate every episode against the watched
  // map), we render any TV show with at least one history entry as
  // 'started' — that matches user expectations (a partially-watched
  // series stays "Continue" until it's manually cleared).
  const statusOf = useMemo(() => {
    const watchedMap = loadWatchedMap()
    const resumeMap = loadResumeMap()
    const historyByKey = new Map()
    for (const h of history) {
      const id = h.id ?? h.title
      if (!id) continue
      historyByKey.set(`${id}`, true)
    }
    return (entry) => {
      const id = entry.id ?? entry.title
      if (!id) return null
      const isTv = (entry.type === 'tv' || entry.type === 'series')
      // Movie path — single key
      if (!isTv) {
        if (watchedMap[`${id}|0|0`]) return 'watched'
        if (resumeMap[`${id}|0|0`]) return 'started'
        if (historyByKey.has(`${id}`)) return 'started'
        return null
      }
      // TV path — scan keys for `id|...`
      const prefix = `${id}|`
      const anyResume = Object.keys(resumeMap).some((k) => k.startsWith(prefix))
      if (anyResume) return 'started'
      if (historyByKey.has(`${id}`)) return 'started'
      const anyWatched = Object.keys(watchedMap).some((k) => k.startsWith(prefix))
      if (anyWatched) return 'started'  // partial — never auto-promotes to 'watched' for TV
      return null
    }
  }, [history])

  if (!items.length) {
    return (
      <div className="search-empty">
        <p>Your library is empty. Click the <strong>Add to library</strong> button on any movie or series detail page to save it here.</p>
      </div>
    )
  }
  return (
    <div className="search-grid">
      {items.map((entry) => {
        const status = statusOf(entry)
        return (
          <button
            key={entry.id}
            className={`search-card library-card library-card--${status || 'fresh'}`}
            onClick={() => onSelect({
              id: entry.id,
              title: entry.title,
              poster: entry.poster,
              backdrop: entry.backdrop,
              type: entry.type,
              rating: entry.rating || 0,
              genre_ids: entry.genreIds || [],
            })}
          >
            {entry.poster ? <img src={entry.poster} alt="" loading="lazy" />
              : <div className="poster-placeholder">{(entry.title || '?')[0]}</div>}
            {/* Watched/started badge — top-right corner of the
                card. Hidden for never-played items so the badge isn't
                visual noise for a fresh library. */}
            {status && (
              <span className={`library-badge library-badge--${status}`} aria-label={status === 'watched' ? 'Watched' : 'In progress'}>
                {status === 'watched' ? (
                  <>
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                    Watched
                  </>
                ) : 'In progress'}
              </span>
            )}
            <div className="search-card-info">
              <span className="search-card-title">{entry.title}</span>
              {entry.rating > 0 && <span className="search-card-rating">★ {entry.rating.toFixed(1)}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// One-off row that pulls TMDB 'similar' items off the details
// endpoint. Shown when the user has at least one history entry
// with an id — otherwise TMDB can't resolve it.
function BecauseYouWatchedRow({ entry, onSelect }) {
  const [items, setItems] = useState([])
  const [loaded, setLoaded] = useState(false)
  const rowRef = useRef(null)
  useHorizontalRowGestures(rowRef, items)
  useEffect(() => {
    if (!entry?.id) { setLoaded(true); return }
    let cancelled = false
    const t = inferType(entry)
    fetch(`/api/details/${t}/${entry.id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) { setLoaded(true); return }
        setItems((d.similar || []).slice(0, 20))
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [entry?.id])

  if (!loaded || items.length === 0) return null

  return (
    <div className="content-row">
      <h3 className="row-title">Because you watched {entry.title}</h3>
      <div className="row-container">
        <div className="row-posters" ref={rowRef}>
          {items.map((s) => (
            <button
              key={s.id}
              className="row-poster"
              onClick={() => onSelect({
                id: s.id,
                title: s.title,
                type: s.type,
                date: s.year ? `${s.year}-01-01` : null,
                rating: s.rating,
                poster: s.poster,
                backdrop: s.poster,
              })}
            >
              {s.poster ? <img src={s.poster} alt="" loading="lazy" /> : <div className="poster-placeholder">{s.title?.[0] || '?'}</div>}
              <div className="row-poster-info">
                <span className="row-poster-title">{s.title}</span>
                {s.rating > 0 && <span className="row-poster-rating">★ {s.rating.toFixed(1)}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Surprise Me button ─────────────────────────────────────────
// Picks a random title from the user's library OR a random page of
// trending/popular catalog and opens its detail modal. Netflix's
// "Play Something" reimagined as a pre-play discovery moment so the
// user gets to decide if the surprise is actually appealing before
// the stream starts — vs Netflix's pure auto-play which often felt
// disrespectful of the user's time.
//
// Random-mix logic:
//   - 30% draw from library (if non-empty) → familiar comfort picks
//   - 70% draw from a random catalog category → real surprises
//   - Fall back to category-only when library is empty
function SurpriseMeButton({ onSelectTitle }) {
  const [busy, setBusy] = useState(false)
  const handleSurprise = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Library shortcut — but only if it has content AND the dice
      // say "go familiar". Most clicks should still pull from the
      // wider catalog so the feature feels like discovery, not
      // re-shuffling the user's bookmarks.
      const lib = (() => { try { return loadLibrary() } catch { return [] } })()
      if (lib.length > 0 && Math.random() < 0.3) {
        const pick = lib[Math.floor(Math.random() * lib.length)]
        onSelectTitle(pick)
        return
      }
      // Catalog draw: random type × random category. Each combination
      // resolves to a different TMDB endpoint with different titles,
      // so two clicks rarely land in the same pool.
      const types = ['movies', 'tv']
      const cats = ['trending', 'popular', 'top', 'new']
      const type = types[Math.floor(Math.random() * types.length)]
      const cat = cats[Math.floor(Math.random() * cats.length)]
      const r = await fetch(`/api/catalog/${type}?category=${cat}`)
      const d = await r.json().catch(() => ({}))
      const items = (d.results || []).filter((it) => it.id && (it.poster_path || it.backdrop_path))
      if (!items.length) {
        toast('No surprises right now — TMDB is taking a moment. Try again?', 'warning')
        return
      }
      const pick = items[Math.floor(Math.random() * items.length)]
      onSelectTitle({
        id: pick.id,
        title: pick.title || pick.name,
        name: pick.name || null,
        poster: pick.poster_path,
        backdrop: pick.backdrop_path,
        overview: pick.overview,
        date: pick.release_date || pick.first_air_date,
        release_date: pick.release_date || null,
        first_air_date: pick.first_air_date || null,
        rating: pick.vote_average,
        type,
        genre_ids: pick.genre_ids || [],
      })
    } catch (e) {
      console.error('[surprise]', e)
      toast('Surprise pick failed — server hiccuped', 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, onSelectTitle])

  return (
    <button
      className={`surprise-btn ${busy ? 'is-busy' : ''}`}
      onClick={handleSurprise}
      disabled={busy}
      title="Pick something for me"
      aria-label="Surprise me — pick a random title"
    >
      {/* Sparkle/dice icon — three dots arranged like a die's "3" face,
          plus a sparkle to suggest randomness without being literally
          a die (which reads as "gambling" to some users). */}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4L12 3z" fill="currentColor" />
        <path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7L19 14z" fill="currentColor" />
        <path d="M5 14l.7 1.8L7.5 16.5l-1.8.7L5 19l-.7-1.8L2.5 16.5l1.8-.7L5 14z" fill="currentColor" />
      </svg>
      <span>{busy ? 'Picking…' : 'Surprise me'}</span>
    </button>
  )
}

// ── "Because You Watched X" rows (v1.7.6) ──────────────────────
// Pulls TMDB's recommendations for the user's most-recently-played
// titles and renders one ContentRow per source title. Caps at 2 rows
// so the home screen doesn't become an endless wall of recs (and so
// duplicates between sources are less likely). Falls through silently
// if the user has no history or all their recent titles are in the
// same recommendation pool.
function BecauseYouWatchedRows({ onSelectTitle }) {
  const history = useHistory()
  // Pick up to 2 distinct most-recent titles. dedupe by id so the
  // user doesn't see "Because you watched The Office" twice when
  // they binged 12 episodes of it.
  const seeds = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const entry of history) {
      if (!entry?.id) continue
      const key = `${entry.type || 'movies'}:${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: entry.id,
        type: entry.type || 'movies',
        title: entry.title,
      })
      if (out.length >= 2) break
    }
    return out
  }, [history])

  if (!seeds.length) return null
  return (
    <>
      {seeds.map((seed) => (
        <ContentRow
          key={`because-${seed.type}-${seed.id}`}
          title={`Because you watched ${seed.title}`}
          url={`/api/recommendations/${seed.type}/${seed.id}`}
          type={seed.type}
          onSelect={onSelectTitle}
        />
      ))}
    </>
  )
}

// ── Browse Page ─────────────────────────────────────────────────
// Layout: Stremio-style left sidebar (Home / Movies / Series / genres)
// + main content area. View state:
//   - view === 'foryou' → personalised For You rows (default when a
//                         profile has any signal — favourites/history)
//   - view === 'home'  → trending movies + trending series rails
//   - view === 'movies' / 'tv' → full rails (trending/popular/top/new) + genre rails
//   - view === 'genre' → single genre grid for current type
function Browse({ onSelectTitle, onPlayHistory, activeProfile }) {
  // Default to 'foryou' when we have a profile to personalise for —
  // matches the mental model the user has (Netflix opens on your
  // personalised rail, not a generic catalogue). Falls through to
  // 'home' when there is no active profile (shouldn't happen in
  // practice since the gate blocks render until one is picked, but
  // it keeps the component resilient in isolation).
  const [view, setView] = useState(activeProfile ? 'foryou' : 'home') // 'foryou' | 'home' | 'movies' | 'tv' | 'genre'
  const [type, setType] = useState('movies')      // active type (drives top pills & genre sidebar)
  const [activeGenre, setActiveGenre] = useState(null) // { id, name } when view === 'genre'
  const [searchQuery, setSearchQuery] = useState('')
  const [genres, setGenres] = useState([])
  const [heroItems, setHeroItems] = useState([])

  const debouncedSearch = useDebounce(searchQuery, 400)

  useEffect(() => { setSearchQuery('') }, [view, type])

  // Listen for cross-component search triggers — currently fired by
  // clicking a cast member in the DetailModal. Setting the query
  // through this path also flips the view away from any sidebar
  // category so the search results aren't masked.
  useEffect(() => {
    const onTrigger = (e) => {
      const q = e?.detail?.query
      if (typeof q !== 'string') return
      setSearchQuery(q)
      setView('home')
      setActiveGenre(null)
    }
    window.addEventListener('wardoflix:search-for', onTrigger)
    return () => window.removeEventListener('wardoflix:search-for', onTrigger)
  }, [])

  // Fetch genres for the current type (drives sidebar list).
  // Retries twice if the first response is empty — covers the case where
  // TMDB was momentarily unresponsive while the stream was warming up.
  useEffect(() => {
    let cancelled = false
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(`/api/catalog/genres/${type}`)
        const d = await r.json().catch(() => ({}))
        const list = d.genres || []
        if (cancelled) return
        if (list.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
          return
        }
        setGenres(list)
      } catch {
        if (!cancelled && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
        }
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [type])

  // Hero items: trending of the active type (or movies on home).
  // Same retry strategy so the hero banner doesn't disappear after streaming.
  useEffect(() => {
    let cancelled = false
    const heroType = view === 'home' ? 'movies' : type
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(`/api/catalog/${heroType}?category=trending`)
        const d = await r.json().catch(() => ({}))
        const withBackdrop = (d.results || []).filter((i) => i.backdrop_path)
        if (cancelled) return
        if (withBackdrop.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
          return
        }
        setHeroItems(withBackdrop.slice(0, 5))
      } catch {
        if (!cancelled && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 700 * (attempts + 1))
        }
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [type, view])

  const isSearching = debouncedSearch.trim().length > 0

  // Sidebar nav handlers
  const goForYou = () => { setView('foryou'); setActiveGenre(null) }
  const goHome = () => { setView('home'); setActiveGenre(null) }
  const goType = (t) => { setType(t); setView(t); setActiveGenre(null) }
  const goGenre = (g) => { setActiveGenre(g); setView('genre') }

  return (
    <div className="browse">
      <aside className="sidebar">
        <div className="sidebar-section">
          {activeProfile && (
            <button
              className={`sidebar-item ${view === 'foryou' ? 'active' : ''}`}
              onClick={goForYou}
              title="For You"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l2.39 5.9L20 9l-4.5 3.9L17 19l-5-3-5 3 1.5-6.1L4 9l5.61-1.1z"/></svg>
              <span>For You</span>
            </button>
          )}
          <button
            className={`sidebar-item ${view === 'home' ? 'active' : ''}`}
            onClick={goHome}
            title="Home"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/></svg>
            <span>Home</span>
          </button>
          <button
            className={`sidebar-item ${view === 'library' ? 'active' : ''}`}
            onClick={() => { setView('library'); setActiveGenre(null); setSearchQuery('') }}
            title="Your Library"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3a2 2 0 0 0-2 2v17l9-4 9 4V5a2 2 0 0 0-2-2H5z"/></svg>
            <span>Library</span>
          </button>
          <button
            className={`sidebar-item ${view === 'movies' ? 'active' : ''}`}
            onClick={() => goType('movies')}
            title="Movies"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 13h4M3 17h4M17 9h4M17 13h4M17 17h4"/></svg>
            <span>Movies</span>
          </button>
          <button
            className={`sidebar-item ${view === 'tv' ? 'active' : ''}`}
            onClick={() => goType('tv')}
            title="Series"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
            <span>Series</span>
          </button>
        </div>

        <div className="sidebar-divider" />

        <div className="sidebar-section sidebar-scroll">
          <div className="sidebar-label">
            {type === 'movies' ? 'Movie Genres' : 'Series Genres'}
          </div>
          {genres.map((g) => (
            <button
              key={g.id}
              className={`sidebar-item sidebar-item--sub ${activeGenre?.id === g.id ? 'active' : ''}`}
              onClick={() => goGenre(g)}
            >
              <span>{g.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="browse-main">
        <div className="browse-nav">
          <div className="search-box">
            <svg className="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search titles..."
              aria-label="Search"
            />
          </div>
          {/* Surprise Me — Netflix's "Play Something" reimagined: pick
              a random title from the user's library OR a fresh page of
              trending/popular catalog and open its detail modal. Useful
              when the user can't decide what to watch (a real, common
              problem) — one click away in the browse-nav so it's always
              reachable. */}
          <SurpriseMeButton onSelectTitle={onSelectTitle} />
        </div>

        {isSearching ? (
          <SearchResults type={type} query={debouncedSearch} onSelect={onSelectTitle} />
        ) : view === 'library' ? (
          <LibraryView onSelect={onSelectTitle} />
        ) : view === 'foryou' && activeProfile ? (
          <ForYou profile={activeProfile} onSelect={onSelectTitle} onPlayHistory={onPlayHistory} />
        ) : view === 'home' ? (
          <>
            <HeroBanner items={heroItems} type="movies" onSelect={onSelectTitle} />
            <div className="rows-section">
              <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelectTitle} />
              {/* Personalised recommendations — Netflix-style "Because
                  you watched X" rows pulled from TMDB recs for the
                  user's most recently-played titles. Renders nothing
                  on a fresh install (no history); fades in as soon as
                  the user has watched anything. */}
              <BecauseYouWatchedRows onSelectTitle={onSelectTitle} />
              <ContentRow title="Top 10 Movies This Week" url={`/api/catalog/movies?category=trending`} type="movies" onSelect={onSelectTitle} showRanking />
              <ContentRow title="Top 10 Series This Week" url={`/api/catalog/tv?category=trending`} type="tv" onSelect={onSelectTitle} showRanking />
              <ContentRow title="Popular Movies" url={`/api/catalog/movies?category=popular`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Popular Series" url={`/api/catalog/tv?category=popular`} type="tv" onSelect={onSelectTitle} />
              <ContentRow title="Top Rated Movies" url={`/api/catalog/movies?category=top`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Top Rated Series" url={`/api/catalog/tv?category=top`} type="tv" onSelect={onSelectTitle} />
              {/* Themed franchise rows — Disney+ / HBO-style hubs.
                  Each pulls a TMDB collection by id; sorted newest-
                  first within the franchise so users see the latest
                  release at the front of the row. */}
              <ContentRow title="Marvel Cinematic Universe" url={`/api/collection/86311`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="The Lord of the Rings & The Hobbit" url={`/api/collection/119`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Star Wars Saga" url={`/api/collection/10`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="Mission: Impossible" url={`/api/collection/87359`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="The Dark Knight Trilogy" url={`/api/collection/263`} type="movies" onSelect={onSelectTitle} />
              <ContentRow title="John Wick" url={`/api/collection/404609`} type="movies" onSelect={onSelectTitle} />
            </div>
          </>
        ) : view === 'genre' && activeGenre ? (
          <>
            <div className="browse-heading">
              <h2>{activeGenre.name}</h2>
              <p className="browse-heading-sub">{type === 'movies' ? 'Movies' : 'Series'}</p>
            </div>
            <GenreGrid type={type} genreId={activeGenre.id} onSelect={onSelectTitle} />
          </>
        ) : (
          <>
            <HeroBanner items={heroItems} type={type} onSelect={onSelectTitle} />
            <div className="rows-section">
              <ContinueWatchingRow onPlay={onPlayHistory} onInfo={onSelectTitle} />
              <ContentRow title="Trending Now" url={`/api/catalog/${type}?category=trending`} type={type} onSelect={onSelectTitle} />
              <ContentRow title="Popular" url={`/api/catalog/${type}?category=popular`} type={type} onSelect={onSelectTitle} />
              <ContentRow title="Top Rated" url={`/api/catalog/${type}?category=top`} type={type} onSelect={onSelectTitle} />
              <ContentRow title={type === 'movies' ? 'Now Playing' : 'On The Air'} url={`/api/catalog/${type}?category=new`} type={type} onSelect={onSelectTitle} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Paginated grid for a single genre selection from the sidebar.
function GenreGrid({ type, genreId, onSelect }) {
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef(null)

  useEffect(() => {
    setItems([]); setPage(1); setTotalPages(1)
  }, [type, genreId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/catalog/${type}?genre=${genreId}&page=${page}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (cancelled) return
        setItems((prev) => page === 1 ? (d.results || []) : [...prev, ...(d.results || [])])
        setTotalPages(d.total_pages || 1)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [type, genreId, page])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && page < totalPages) {
        setPage((p) => p + 1)
      }
    }, { rootMargin: '400px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [loading, page, totalPages])

  return (
    <div className="genre-grid-wrap">
      <div className="poster-grid">
        {items.map((item) => (
          <button
            key={item.id}
            className="poster-card"
            // Normalize the item shape the modal expects — raw TMDB
            // payloads don't carry a `type` field, and without this
            // mapping a TV-genre click landed in DetailModal with
            // `type === undefined` and rendered as a flat movie list.
            onClick={() => onSelect({
              id: item.id,
              title: item.title || item.name,
              name: item.name || null,
              poster: item.poster_path,
              backdrop: item.backdrop_path,
              overview: item.overview,
              date: item.release_date || item.first_air_date,
              release_date: item.release_date || null,
              first_air_date: item.first_air_date || null,
              rating: item.vote_average,
              type,
            })}
          >
            {item.poster_path ? (
              <img src={item.poster_path} alt={item.title || item.name} loading="lazy" />
            ) : (
              <div className="poster-card-fallback">{item.title || item.name}</div>
            )}
            <div className="poster-card-title">{item.title || item.name}</div>
          </button>
        ))}
      </div>
      {page < totalPages && (
        <div ref={sentinelRef} className="scroll-sentinel">
          <span className="spinner large" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">No results found.</div>
      )}
    </div>
  )
}


// ── Detail Modal ────────────────────────────────────────────────
// Extracted to ./components/DetailModal.jsx in v1.8.0. Imported
// at the top of this file.


// formatTime now lives in src/lib/util.js


// ── Player Controls ─────────────────────────────────────────────
// Extracted to ./components/PlayerControls.jsx in v1.8.0. Imported
// at the top of this file.

// Given playingMetadata that includes a `playlist` from the detail modal,
// find the next episode after (currentSeason, currentEpisode). Skips forward
// through seasons if the current season has no more episodes.
function findNextEpisode(meta) {
  if (!meta?.playlist?.bySeason) return null
  const { bySeason, seasons } = meta.playlist
  const curS = String(meta.season ?? '')
  const curE = Number(meta.episode ?? 0)
  if (!curS) return null

  // Return magnet when we have it, otherwise null — handleStream() will
  // resolve it via the on-demand Torrentio endpoint.
  // Season is emitted as a Number (not String) so downstream consumers
  // — history keys, resume storage, next-episode lookups — can't stringly-
  // compare "1" against 1 and end up with two separate cache entries for
  // the same season.
  const inSeason = (bySeason[curS] || [])
    .filter((t) => typeof t.episode === 'number' && t.episode > curE)
    .sort((a, b) => a.episode - b.episode)
  if (inSeason.length) return { magnet: inSeason[0].magnet || null, season: Number(curS), episode: inSeason[0].episode }

  const seasonList = (seasons || []).filter((s) => s !== '0').map(String).sort((a, b) => Number(a) - Number(b))
  const idx = seasonList.indexOf(curS)
  if (idx === -1 || idx === seasonList.length - 1) return null
  for (let i = idx + 1; i < seasonList.length; i++) {
    const eps = (bySeason[seasonList[i]] || []).filter((t) => typeof t.episode === 'number').sort((a, b) => a.episode - b.episode)
    if (eps.length) return { magnet: eps[0].magnet || null, season: Number(seasonList[i]), episode: eps[0].episode }
  }
  return null
}

// Toast / Shortcuts / Debug overlays now live in src/components/Overlays.jsx

// ── Next-Episode Countdown (v1.7.6) ─────────────────────────────
// Netflix-style overlay that appears in the bottom-right when an
// episode ends. Shows a 8-second visual progress ring + the next
// episode's label, with Cancel / Play-now buttons. Auto-fires
// onConfirm when the timer expires.
//
// Designed to be cancellable in EVERY axis: click Cancel, press
// Escape, click anywhere outside the card. The Esc handler is
// scoped to the overlay so it doesn't fight the player's own.
function NextEpisodeCountdown({ info, onCancel, onConfirm }) {
  const { next, meta, startedAt, duration } = info
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [])
  // Fire onConfirm exactly once when the timer expires.
  const fired = useRef(false)
  useEffect(() => {
    const elapsed = now - startedAt
    if (elapsed >= duration && !fired.current) {
      fired.current = true
      onConfirm()
    }
  }, [now, startedAt, duration, onConfirm])
  // Escape cancels.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConfirm() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm])

  const elapsed = Math.min(duration, now - startedAt)
  const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000))
  const pct = Math.min(100, (elapsed / duration) * 100)
  const epLabel = `S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')}`

  return (
    <div className="next-ep-overlay" role="dialog" aria-label="Next episode">
      <div className="next-ep-card">
        <div className="next-ep-thumb" aria-hidden="true">
          {/* Show ring — visual countdown that drains as time
              passes. Pure SVG so it renders crisp at any size. */}
          <svg viewBox="0 0 64 64" width="56" height="56">
            <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(248, 238, 211, 0.18)" strokeWidth="3" />
            <circle
              cx="32" cy="32" r="28" fill="none"
              stroke="var(--accent, #e8a838)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 28}`}
              strokeDashoffset={`${2 * Math.PI * 28 * (1 - pct / 100)}`}
              transform="rotate(-90 32 32)"
              style={{ transition: 'stroke-dashoffset 0.1s linear' }}
            />
            <text x="32" y="38" textAnchor="middle" fill="var(--text)" fontSize="20" fontWeight="700" fontFamily="var(--font-display, Syne)">{remaining}</text>
          </svg>
        </div>
        <div className="next-ep-info">
          <span className="next-ep-label">Next episode in {remaining}s</span>
          <span className="next-ep-title">
            {meta?.title ? `${meta.title} · ${epLabel}` : epLabel}
          </span>
        </div>
        <div className="next-ep-actions">
          <button className="next-ep-btn next-ep-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="next-ep-btn next-ep-btn--accent" onClick={onConfirm}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21" /></svg>
            Play now
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Still Watching? prompt (v1.7.6) ─────────────────────────────
// After 3 consecutive auto-plays, gate the next one behind a full
// "are you still watching" confirmation. Netflix's binge guard —
// prevents bandwidth burn when the user fell asleep.
function StillWatchingPrompt({ info, onCancel, onConfirm }) {
  const { next, meta, consecutive } = info
  const cardRef = useRef(null)
  // v1.7.9: trap focus inside the modal so Tab can't escape to the
  // dimmed page below. Keyboard users get a predictable cycle
  // (Tab → I'm done → Continue → I'm done → …) and Esc/Enter to
  // dismiss. Focus restores to wherever the user was before this
  // modal opened.
  useFocusTrap(cardRef, true)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm])
  const epLabel = `S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')}`
  return (
    <div className="still-watching-overlay" role="dialog" aria-modal="true" aria-labelledby="still-watching-title">
      <div className="still-watching-card" ref={cardRef} tabIndex={-1}>
        <h2 className="still-watching-title" id="still-watching-title">Still watching?</h2>
        <p className="still-watching-body">
          You've auto-played <strong>{consecutive}</strong> episodes in a row.
          {meta?.title && <> Up next is <strong>{meta.title} · {epLabel}</strong>.</>}
        </p>
        <div className="still-watching-actions">
          <button className="still-watching-btn still-watching-btn--ghost" onClick={onCancel}>
            I'm done
          </button>
          <button className="still-watching-btn still-watching-btn--accent" onClick={onConfirm}>
            Continue watching
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Auto-pick single profile (v1.7.9) ────────────────────────────
// When the user has exactly one profile, skip the "Who's watching?"
// picker and just select it. Showing a chooser with one face on it
// is performative UX — the answer is always "that one". As a
// component (not a hook in App) so the effect runs early in the
// commit phase, before <ProfileGate> would otherwise render.
function AutoPickSingleProfile({ profiles, activeProfile }) {
  useEffect(() => {
    if (activeProfile) return
    if (profiles.length === 1 && profiles[0]?.id) {
      setActiveProfileId(profiles[0].id)
    }
  }, [profiles, activeProfile])
  return null
}

// ── App ─────────────────────────────────────────────────────────
function App() {
  const [tab, setTab] = useState('browse')
  const [input, setInput] = useState('')
  const [source, _setSourceRaw] = useState(null)
  // All setSource calls funnel through toAbsStreamUrl so a stray relative
  // URL can never reach <video src> and trip MEDIA_ERR_SRC_NOT_SUPPORTED
  // in packaged (file://) builds. See toAbsStreamUrl's comment for why.
  const setSource = useCallback((url) => _setSourceRaw(toAbsStreamUrl(url)), [])
  const [sourceType, setSourceType] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailItem, setDetailItem] = useState(null)
  const [playingMetadata, setPlayingMetadata] = useState(null)
  const [streamWarning, setStreamWarning] = useState('')
  // Next-episode auto-play UX. Replaces v1.7.5's "silently switch to
  // next episode" behaviour with a Netflix-style countdown overlay
  // and (after 3 in a row) a "Still Watching?" gate.
  //   nextEpCountdown   = { next, meta, startedAt, duration } | null
  //   stillWatching     = { next, meta, consecutive } | null
  //   autoplayCountRef  = number of consecutive auto-plays this
  //                       session (reset on user-initiated stream)
  const [nextEpCountdown, setNextEpCountdown] = useState(null)
  const [stillWatching, setStillWatching] = useState(null)
  const autoplayCountRef = useRef(0)
  const [streamProgress, setStreamProgress] = useState(null)
  const [availableSubs, setAvailableSubs] = useState([])
  const [subOffset, setSubOffset] = useState(0)
  // Persist sub offset whenever it changes during playback. The
  // restore happens in the player effect via readSubOffset(playingMetadata)
  // when a new source loads. The skip is for the implicit setSubOffset(0)
  // that fires on source change before the restore — without it we'd
  // immediately wipe the user's saved offset for that title.
  const subOffsetSaveTimerRef = useRef(null)
  useEffect(() => {
    if (!playingMetadata) return
    if (subOffsetSaveTimerRef.current) clearTimeout(subOffsetSaveTimerRef.current)
    subOffsetSaveTimerRef.current = setTimeout(() => saveSubOffset(playingMetadata, subOffset), 600)
  }, [subOffset, playingMetadata])
  const [subPanelOpen, setSubPanelOpen] = useState(false)
  // Subtitle styling — size%, vertical-position%, weight, background.
  // Loaded from localStorage on mount, persisted on every change.
  // Applied via injected <style> rules targeting video.js's text-track
  // cue elements, so it lives outside React's render cycle but always
  // reflects the latest pref.
  const [subStyle, setSubStyle] = useState(() => loadSubStyle())
  useEffect(() => { saveSubStyle(subStyle) }, [subStyle])
  const [audioTracks, setAudioTracks] = useState([])
  const [activeAudioIdx, setActiveAudioIdx] = useState(null)
  const [streamInfoHash, setStreamInfoHash] = useState(null)
  const [streamDuration, setStreamDuration] = useState(null)
  // Mirror streamDuration into a ref so the player's 'ended' handler
  // (registered once per source) can read the latest value without
  // closure staleness.
  const streamDurationRef = useRef(null)
  useEffect(() => { streamDurationRef.current = streamDuration }, [streamDuration])
  const [streamBaseUrl, setStreamBaseUrl] = useState(null)
  const [playbackError, setPlaybackError] = useState(null) // { code, message } | null — surfaced when video.js emits 'error' mid-playback
  // Probed video codec reported by /api/tracks (e.g. 'h264', 'hevc', 'av1').
  // Surfaced in the debug overlay so we can tell from a screenshot whether
  // a given decode failure was Chromium-unsupported (hevc/av1) vs. genuinely
  // broken bytes (ffmpeg didn't recognise the stream, vcodec === null).
  const [probedVcodec, setProbedVcodec] = useState(null)
  // Ctrl+Shift+D toggles a developer overlay — when a user reports a
  // decode error, the overlay shows the exact source URL, remux stage,
  // probed codec, info-hash, and recent playback error so we can
  // diagnose from a screenshot instead of guessing.
  const [debugOpen, setDebugOpen] = useState(false)
  // `?` toggles the keyboard shortcut cheat-sheet. Discoverable without
  // having to hunt through a settings menu for power-user keybinds.
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [showIntro, setShowIntro] = useState(false)
  const [castState, setCastState] = useState('unavailable') // unavailable | available | connecting | connected
  const [dlnaDevices, setDlnaDevices] = useState([])
  const [dlnaActive, setDlnaActive] = useState(null) // device id or null
  const [playerReady, setPlayerReady] = useState(0) // increments each time a new player is created; used to re-run child effects that attach listeners
  // Show the WardoFlix intro on every fresh launch. Runs once when the app
  // module first mounts — not again on hot-reloads or tab switches.
  const [showStartupIntro, setShowStartupIntro] = useState(true)

  // Multi-profile support. The gate covers the app any time no profile
  // is active — on first boot, or after the user explicitly clicked
  // "Switch profile…". Once the gate dismisses (via onPick), the rest
  // of the app reads through the active profile automatically because
  // history/resume/volume helpers all resolve against it.
  const { profiles, activeProfile } = useProfiles()
  // "Manage" mode from the gate opens an empty editor so the user can
  // add a fresh profile even when the picker already has some.
  const [manageCreate, setManageCreate] = useState(false)

  // App version & backend health — both polled from /api/health. The dot in
  // the topbar turns amber/red when the backend stops responding so a user
  // knows to retry (or restart the app) instead of thinking the UI is frozen.
  const [appVersion, setAppVersion] = useState(null)
  const [serverHealthy, setServerHealthy] = useState(null) // null = unknown, true/false after first probe
  // v1.8.1: "What's New" changelog modal. Holds the array of entries
  // to show (empty until appVersion arrives). When appVersion lands,
  // compare to last-seen-version stored in localStorage; if newer,
  // populate this state with the new entries. Dismissing the modal
  // saves the current version as last-seen.
  const [changelogToShow, setChangelogToShow] = useState([])
  useEffect(() => {
    if (!appVersion) return
    const lastSeen = readLastSeenVersion(appVersion)
    const entries = changelogEntriesNewerThan(lastSeen)
    if (entries.length > 0) setChangelogToShow(entries)
  }, [appVersion])

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        if (!r.ok) throw new Error(`status ${r.status}`)
        const j = await r.json()
        if (cancelled) return
        if (j.version) setAppVersion(j.version)
        setServerHealthy(true)
      } catch {
        if (!cancelled) setServerHealthy(false)
      }
    }
    probe()
    // Cheap liveness check every 30s — the dot flips red if the server dies.
    const id = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Mouse-parallax for the cinematic backdrop. We write two CSS vars
  // on <html> — --wf-mx / --wf-my, each in [-1, 1] — and the aurora
  // layer in App.css reads them via calc() to shift a few px per axis.
  // Throttled through rAF so it stays on the compositor thread and
  // never fires more than once per frame. Also respects prefers-
  // reduced-motion so accessibility-minded users get a static frame.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const root = document.documentElement
    let rafId = 0
    let targetX = 0, targetY = 0
    let curX = 0, curY = 0
    const onMove = (e) => {
      targetX = (e.clientX / window.innerWidth) * 2 - 1   // -1..1
      targetY = (e.clientY / window.innerHeight) * 2 - 1
      if (!rafId) rafId = requestAnimationFrame(tick)
    }
    const tick = () => {
      // Ease toward the target — lerp at 0.08/frame gives a pleasant
      // ~8–12 frame trail so the aurora drifts rather than snaps.
      curX += (targetX - curX) * 0.08
      curY += (targetY - curY) * 0.08
      root.style.setProperty('--wf-mx', curX.toFixed(3))
      root.style.setProperty('--wf-my', curY.toFixed(3))
      if (Math.abs(curX - targetX) > 0.001 || Math.abs(curY - targetY) > 0.001) {
        rafId = requestAnimationFrame(tick)
      } else {
        rafId = 0
      }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Developer overlay toggle. Ctrl+Shift+D (or Cmd+Shift+D on macOS)
  // flips a fixed-position diagnostic panel showing the current stream
  // URL, remux stage, probed codec, info-hash and recent playback error.
  // Escape closes it. Hidden by default — zero cost when closed.
  // `?` (shift+/) brings up the keyboard shortcut cheat-sheet.
  useEffect(() => {
    const onKey = (e) => {
      // Don't capture when the user is typing into a field.
      const target = e.target
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setDebugOpen((v) => !v)
      } else if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if (e.key === 'Escape') {
        if (debugOpen) setDebugOpen(false)
        if (shortcutsOpen) setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [debugOpen, shortcutsOpen])

  // While the intro plays, lock page scroll and hide the scrollbar so the
  // ugly default Windows scrollbar doesn't flash over the animation.
  useEffect(() => {
    if (!showStartupIntro) return
    document.documentElement.classList.add('wf-intro-lock')
    document.body.classList.add('wf-intro-lock')
    return () => {
      document.documentElement.classList.remove('wf-intro-lock')
      document.body.classList.remove('wf-intro-lock')
    }
  }, [showStartupIntro])
  const videoContainerRef = useRef(null)
  const playerContainerRef = useRef(null)
  const playerRef = useRef(null)
  const playerSectionRef = useRef(null)
  const progressRef = useRef(null)
  const castSessionRef = useRef(null)
  const playingMetadataRef = useRef(null)
  const handleStreamRef = useRef(null)
  // AbortControllers for in-flight fetches that otherwise race with the
  // next handleStream() and corrupt state (e.g. stale audio tracks).
  const tracksAbortRef = useRef(null)
  const subsAbortRef = useRef(null)
  // Also abort the main /api/stream POST so a slow torrent announce
  // (the 25s budget on the server side) can't resolve into stale UI
  // state long after the user navigated away or started another title.
  const streamAbortRef = useRef(null)
  // Mirror of streamProgress state so the peer-watchdog loop inside
  // handleStream can read the latest SSE data without re-rendering.
  const streamProgressRef = useRef(null)
  // Flag the fallback loop checks each tick: goes false when the user
  // clears the player or starts a different stream, so a stale retry
  // can't spawn a zombie request against the backend.
  const streamAliveRef = useRef(false)
  // Escalation stage for the auto-remux fallback. On decode errors
  // (MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED) we walk through:
  //   0 → /stream/...               (direct WebTorrent HTTP)
  //   1 → /remux/...?transcode=1    (ffmpeg + libx264)
  //   2 → /remux/...?transcode=1&fresh=<ts>  (re-probe, bust meta cache)
  //   ≥3 → give up, show the user-facing error dialog
  // Reset to 0 each time a new stream starts via handleStream.
  const remuxFallbackRef = useRef(0)
  // Set by the /remux seek handler when a user seek outside the buffered
  // region is about to trigger a URL reload with ?t=<target>. The decode-
  // error handler checks this ref and skips the stage-1/2 escalation in
  // that window — otherwise the native <video> seek fires a decode error
  // (byte-range refused by our Accept-Ranges:none server → immediate
  // error) BEFORE our debounced reload fires, the error handler wipes
  // the URL to re-run transcode from 0, and the final reload lands on a
  // torn-down player and plays from the start. Root cause of "±10s
  // restarts the whole show" in 1.4.9.
  const seekReloadPendingRef = useRef(false)
  // How many seconds into the *original* movie the current /remux
  // stream represents. Set every time seekRemuxAware performs a
  // URL-based reload with ?t=<sec>. Used so the progress UI can show
  // real-movie time rather than stream-local time; not currently
  // wired through to PlayerControls, but the ref is kept so the
  // reload path has somewhere to record the offset for future use.
  const remuxTimeOffsetRef = useRef(0)
  useEffect(() => { playingMetadataRef.current = playingMetadata }, [playingMetadata])

  // Discord Rich Presence — push the playing metadata up to the main
  // process whenever it changes. Cleared when the player teardown sets
  // playingMetadata back to null. Pure fire-and-forget; the bridge
  // gracefully no-ops when Discord isn't running or no application id
  // is configured.
  // v1.9.0 — also suppressed while Privacy Mode is on. Discord
  // Rich Presence broadcasts "Watching X" to anyone friended on
  // Discord; private viewing should NOT leak that.
  const privacyOn = usePrivacyMode()
  useEffect(() => {
    try {
      if (playingMetadata && source && !privacyOn) {
        window.wardoflixDiscord?.setActivity?.({
          title: playingMetadata.title || '',
          season: playingMetadata.season || null,
          episode: playingMetadata.episode || null,
          type: playingMetadata.type || null,
        })
      } else {
        window.wardoflixDiscord?.clearActivity?.()
      }
    } catch {}
  }, [playingMetadata, source, privacyOn])

  useEffect(() => {
    return () => {
      if (playerRef.current && !playerRef.current.isDisposed()) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!source || sourceType !== 'url' || !videoContainerRef.current) return

    if (playerRef.current && !playerRef.current.isDisposed()) {
      playerRef.current.dispose()
      playerRef.current = null
    }

    const videoEl = document.createElement('video')
    videoEl.className = 'video-js vjs-big-play-centered vjs-fluid'
    videoEl.setAttribute('playsinline', '')
    videoContainerRef.current.innerHTML = ''
    videoContainerRef.current.appendChild(videoEl)

    const player = videojs(videoEl, {
      controls: false,
      autoplay: false,  // we control play() manually after intro
      preload: 'auto',
      fluid: true,
      responsive: true,
      inactivityTimeout: 0,
    })
    playerRef.current = player
    // Signal to child components (PlayerControls) that the player ref is populated.
    // Their effects depend on this bump so they re-run after the ref is assigned.
    setPlayerReady((n) => n + 1)

    // Trigger intro only when the video is actually ready to play
    let introTriggered = false
    const triggerIntro = () => {
      if (introTriggered) return
      introTriggered = true
      try { player.pause() } catch {}
      setShowIntro(true)
    }
    player.one('canplay', triggerIntro)
    player.one('loadeddata', triggerIntro)
    // Safety fallback: if neither fires within 20s, just start playing without intro
    const introFallback = setTimeout(() => {
      if (!introTriggered) { introTriggered = true; try { player.play() } catch {} }
    }, 20000)
    player.one('dispose', () => clearTimeout(introFallback))

    // ── Surface playback errors mid-stream (network drop, ffmpeg
    // exit, corrupt container). Without this the screen just freezes
    // on the last rendered frame with no feedback.
    player.on('error', () => {
      try {
        const err = player.error()
        if (!err) return
        // MEDIA_ERR_ABORTED=1 fires on user-initiated dispose — ignore it.
        if (err.code === 1) return
        // If a /remux seek-reload is already scheduled, a decode error
        // here is almost certainly the native seek hitting our Accept-
        // Ranges:none server. Don't escalate; the seek handler will
        // rebuild the URL with ?t=<target> in ~120ms. Escalating here
        // would wipe ?t= and restart the show from 0 — the exact bug
        // user reported for ±10s buttons.
        if (seekReloadPendingRef.current) return

        // ── Auto-remux fallback ────────────────────────────────────
        // MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4)
        // almost always mean the browser choked on a codec it can't
        // handle natively — HEVC/x265 in an MP4 is the classic case.
        // The server has an ffmpeg-backed /remux endpoint that emits
        // fragmented MP4 with H.264 + AAC, so transparently swap the
        // source and reload instead of making the user click Retry
        // (which would just try the same unplayable URL again).
        //
        // Implementation note: the player useEffect is keyed on [source],
        // so setSource() will dispose THIS player and create a fresh one.
        // That means any listener we attach here (e.g. the old code's
        // player.one('loadedmetadata') for the seek restore) would fire
        // on an orphan. Instead, we bank the current position into the
        // per-title resume store — the new player's existing resume
        // handler picks it up automatically when it loads.
        const decodeLike = err.code === 3 || err.code === 4
        // React source state is the canonical URL; player.currentSrc()
        // can be empty if the error fired before the HTTP request even
        // opened (e.g. unsupported-source on first probe).
        const currentUrl = source || ''
        // Two-stage escalation:
        //   stage 0 → /stream/... (direct WebTorrent HTTP, fast path)
        //   stage 1 → /remux/...?transcode=1 (libx264 via ffmpeg)
        //   stage 2 → /remux/...?transcode=1&fresh=<ts> (cache-buster +
        //             forces the server to re-probe the codec, in case
        //             the cached probe was stale or lied)
        const stage = remuxFallbackRef.current || 0
        const onStream = currentUrl.includes('/stream/')
        const onSoftRemux = currentUrl.includes('/remux/') && !/[?&]fresh=/.test(currentUrl)
        const canEscalate = decodeLike && (
          (stage === 0 && onStream) ||
          (stage < 2 && onSoftRemux)
        )
        if (canEscalate) {
          const nextStage = stage + 1
          remuxFallbackRef.current = nextStage
          const pos = (() => { try { return player.currentTime() || 0 } catch { return 0 } })()
          const dur = (() => { try { return player.duration() || 0 } catch { return 0 } })()
          if (pos > 0 && playingMetadataRef.current) {
            try { saveResumePosition(playingMetadataRef.current, pos, dur) } catch {}
          }
          let newUrl
          if (onStream) {
            const swapped = currentUrl.replace('/stream/', '/remux/')
            const sep = swapped.includes('?') ? '&' : '?'
            newUrl = `${swapped}${sep}transcode=1`
          } else {
            // Already on /remux — force a fresh probe + transcode by
            // busting the server's meta cache with ?fresh=<timestamp>.
            const sep = currentUrl.includes('?') ? '&' : '?'
            newUrl = `${currentUrl}${sep}fresh=${Date.now()}`
          }
          setStreamWarning(
            nextStage === 1
              ? 'Original codec unsupported — transcoding on the fly…'
              : 'Transcode stalled — restarting with a fresh probe…'
          )
          setStreamBaseUrl(newUrl.split('?')[0])
          setSource(newUrl)
          setSourceType('url')
          setTimeout(() => setStreamWarning(''), 3500)
          return
        }

        const codeMap = {
          2: 'Network error while loading the stream.',
          3: 'Video decode error — the file may be corrupted or use an unsupported codec.',
          4: 'Source not supported (the browser refused the container/codec).',
        }
        setPlaybackError({
          code: err.code,
          message: codeMap[err.code] || err.message || 'Playback interrupted.',
        })
      } catch {}
    })

    // (previous `seeking` event interceptor removed — it ran AFTER the
    // native browser had already started a seek which, under our
    // Accept-Ranges:none /remux contract, caused Chromium to issue a
    // fresh GET from byte 0 and play forward from the start. Seek
    // handling now lives upstream in seekRemuxAware (see App), which
    // is invoked by PlayerControls BEFORE the native seek fires.)

    // ── Autoplay next episode when current one finishes ─────────
    //
    // Guard against premature 'ended' events. ffmpeg's fragmented-MP4
    // output (frag_keyframe + empty_moov) carries no master duration in
    // the moov box; each fragment contributes its own. video.js can
    // briefly read duration === currentTime in the gap between fragments
    // arriving and fire 'ended' even though the movie is nowhere near
    // over. Without this guard, TV episodes would auto-jump to the next
    // episode 10-20s in (which the user saw as "the stream jumps to the
    // next torrent" because handleStream re-runs the fallback chain).
    //
    // Real-end criteria, ALL must hold:
    //   1. We've been playing for at least 60s — protects against the
    //      first-fragment race entirely.
    //   2. The player's reported currentTime is within 8s of the
    //      ffprobe-reported duration (which is the AUTHORITATIVE total,
    //      not the remux output's stutter-prone duration).
    //   3. The remux time offset + currentTime is also within 8s of the
    //      ffprobe duration, in case the user seeked.
    const playStartTs = Date.now()
    player.on('ended', () => {
      const meta = playingMetadataRef.current
      const elapsedSec = (Date.now() - playStartTs) / 1000
      const realDuration = streamDurationRef.current || 0
      const cur = (() => { try { return player.currentTime() } catch { return 0 } })()
      const offset = remuxTimeOffsetRef.current || 0
      const absPos = cur + offset
      // If we have a real (ffprobe) duration, gate on proximity to it.
      // If we DON'T (probe failed → realDuration is 0), gate on the
      // PLAYER's own duration as a fallback — but only when it's a
      // sane number (not Infinity, not NaN, not 0). Without this,
      // probe-failed TV episodes were auto-jumping to the next ep
      // because reachedEnd defaulted to false → the !reachedEnd
      // path was taken → guard skipped because "no real duration"
      // logic was inverted in some readings.
      const playerDur = (() => {
        try {
          const d = player.duration?.()
          return Number.isFinite(d) && d > 60 ? d : 0
        } catch { return 0 }
      })()
      const refDur = realDuration > 0 ? realDuration : playerDur
      const reachedEnd = refDur > 0 && (absPos >= refDur - 8 || cur >= refDur - 8)
      const playedLongEnough = elapsedSec > 60
      if (!reachedEnd || !playedLongEnough) {
        // Fragmented-MP4 false alarm — ignore and let the player keep
        // streaming. Logged via the local debug-log endpoint so we
        // can see this happening if a user complains.
        try {
          fetch('/api/debug-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tag: 'ended-guard',
              msg: `ignored 'ended' — elapsed=${elapsedSec.toFixed(0)}s cur=${cur.toFixed(1)} offset=${offset} realDur=${realDuration} reachedEnd=${reachedEnd} playedLongEnough=${playedLongEnough}`,
            }),
          }).catch(() => {})
        } catch {}
        return
      }
      // Genuine end-of-show — clear resume mark, flag watched, queue
      // the next episode behind a Netflix-style countdown.
      try { clearResumePosition(meta) } catch {}
      try { markWatched(meta) } catch {}
      const next = findNextEpisode(meta)
      if (!next || !handleStreamRef.current) return
      // v1.7.6: instead of immediately auto-playing, surface the
      // countdown overlay so the user can cancel before the next
      // episode pulls in (saves bandwidth + respects the user's
      // "I'm done for tonight" intent). After 3 consecutive
      // auto-plays we escalate to a full "Still Watching?" prompt
      // that requires explicit confirmation — Netflix's binge guard.
      const consecutive = (autoplayCountRef.current || 0) + 1
      if (consecutive >= 3) {
        // Show the still-watching modal; the modal's "Continue"
        // button is what triggers the actual stream.
        setStillWatching({
          next,
          meta,
          consecutive,
        })
      } else {
        // Show countdown overlay; on expiry it fires handleStream.
        setNextEpCountdown({
          next,
          meta,
          startedAt: Date.now(),
          duration: 8000, // 8s — enough to dismiss casually, short
                          // enough to feel auto-pilot for binge mode
        })
      }
    })

    // ── Restore volume/mute pref (so the next session starts where
    // the viewer left the slider) ──────────────────────────────────
    try {
      const pref = loadVolumePref()
      if (pref) {
        player.volume(pref.volume)
        player.muted(pref.muted)
      }
    } catch {}
    // Persist on change, debounced via rAF so dragging the volume slider
    // doesn't thrash localStorage.
    let volSaveScheduled = false
    player.on('volumechange', () => {
      if (volSaveScheduled) return
      volSaveScheduled = true
      requestAnimationFrame(() => {
        volSaveScheduled = false
        try { saveVolumePref(player.volume(), player.muted()) } catch {}
      })
    })

    // ── Resume position: seek to saved time once metadata is loaded,
    // and save current time every few seconds while playing ─────────
    let resumeApplied = false
    player.on('loadedmetadata', () => {
      if (resumeApplied) return
      resumeApplied = true
      const meta = playingMetadataRef.current
      const t = readResumePosition(meta)
      if (t > 0) {
        try {
          const d = player.duration()
          // Don't resume if we're within 60s of the end — treat as finished.
          if (!isFinite(d) || d <= 0 || t < d - 60) {
            player.currentTime(t)
          }
        } catch {}
      }
    })
    // Throttle resume-save to once every ~5 seconds.
    let lastResumeSave = 0
    player.on('timeupdate', () => {
      const now = Date.now()
      if (now - lastResumeSave < 5000) return
      lastResumeSave = now
      const meta = playingMetadataRef.current
      const t = player.currentTime() || 0
      const d = player.duration()
      saveResumePosition(meta, t, isFinite(d) ? d : 0)
    })

    const guessType = (url) => {
      const lower = url.toLowerCase()
      if (lower.includes('.m3u8')) return 'application/x-mpegURL'
      if (lower.includes('.webm')) return 'video/webm'
      if (lower.includes('.ogv') || lower.includes('.ogg')) return 'video/ogg'
      if (lower.includes('.mkv')) return 'video/mp4' // browsers can't play MKV natively, try mp4 container compat
      return 'video/mp4'
    }
    player.src({ type: guessType(source), src: source })
    playerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Restore the per-title playback rate if the user previously set
    // one for this show/movie. Default 1.0 if no preference. Applied
    // on loadedmetadata so video.js doesn't reset it during the
    // source-change tear-up.
    const savedRate = readPlaybackRate(playingMetadata?.id)
    if (savedRate && savedRate !== 1) {
      const applyRate = () => {
        try { player.playbackRate(savedRate) } catch {}
      }
      player.one('loadedmetadata', applyRate)
      // Belt and suspenders — some video.js versions reset rate on
      // canplay even after we set it on loadedmetadata.
      player.one('canplay', applyRate)
    }

    // Restore the persisted per-title sub offset — falls back to the
    // show-wide offset, falls back to 0. So switching episodes within
    // a show keeps your offset by default.
    setSubOffset(readSubOffset(playingMetadata))
    setAvailableSubs([])
    setSubPanelOpen(false)

    if (playingMetadata?.id && playingMetadata?.type) {
      const subParams = new URLSearchParams({ tmdbId: playingMetadata.id, type: playingMetadata.type })
      if (playingMetadata.season) subParams.set('season', playingMetadata.season)
      if (playingMetadata.episode) subParams.set('episode', playingMetadata.episode)
      try { subsAbortRef.current?.abort() } catch {}
      const subCtl = new AbortController()
      subsAbortRef.current = subCtl
      fetch(`/api/subtitles?${subParams}`, { signal: subCtl.signal })
        .then((r) => r.json().catch(() => ({ subtitles: [] })))
        .then((data) => {
          if (subCtl.signal.aborted) return
          const subs = (data.subtitles || []).filter((s) => s.url)
          // Guard every interaction with playerRef — by the time this fetch
          // resolves the user may have hit Back and disposed the player.
          if (!playerRef.current || playerRef.current.isDisposed()) return
          setAvailableSubs(subs)
          // Auto-enable user's preferred subtitle language. Stored at
          // wardoflix:sub-lang-pref; the value is set whenever the
          // user picks a language from the subs menu. Falls back to
          // 'en' (most users who don't speak Dutch want English) if
          // nothing is set. Sentinel value 'off' means the user
          // explicitly turned subtitles off — respect that and do
          // not auto-enable any track.
          let preferredLang = null
          try { preferredLang = localStorage.getItem('wardoflix:sub-lang-pref') } catch {}
          if (!preferredLang) preferredLang = 'en'
          // Pick the first subtitle whose lang matches preferred. Fall
          // back to first available if nothing matches. If 'off' was
          // stored, skip auto-enable entirely.
          const preferredSub = preferredLang === 'off'
            ? null
            : (subs.find((s) => (s.lang || 'en') === preferredLang) || subs[0])
          subs.forEach((s) => {
            if (playerRef.current && !playerRef.current.isDisposed()) {
              try {
                // Route through toAbsStreamUrl — native <track> elements
                // bypass our window.fetch patch in main.jsx, so a bare
                // /api/... path resolves against file:// in packaged
                // builds and 404s. (This is the v1.7.0 subs-don't-show
                // bug fix.)
                const isPreferred = preferredSub && s === preferredSub
                playerRef.current.addRemoteTextTrack({
                  kind: 'subtitles',
                  src: toAbsStreamUrl(`/api/subtitles/proxy?url=${encodeURIComponent(s.url)}`),
                  srclang: s.lang || 'en',
                  label: s.langName || s.lang || 'Unknown',
                  default: isPreferred,
                }, false)
              } catch {}
            }
          })
          // video.js doesn't always honour `default:true` on remote
          // tracks added after the player initialised — it depends on
          // the load order. Force-enable the preferred track ourselves
          // a beat later, when the textTracks list is populated.
          if (preferredSub) {
            setTimeout(() => {
              try {
                const p = playerRef.current
                if (!p || p.isDisposed()) return
                const tracks = p.textTracks()
                for (let i = 0; i < tracks.length; i++) {
                  if (tracks[i].language === (preferredSub.lang || 'en')) {
                    tracks[i].mode = 'showing'
                    break
                  }
                }
              } catch {}
            }, 200)
          }
        })
        .catch(() => {})
    }
  }, [source, sourceType, playingMetadata])

  // ── Subtitle offset: reload tracks with shifted timestamps ─────
  // When subOffset changes, remove existing tracks and re-add them with the
  // ?offset=N query param so the proxy serves time-shifted VTT.
  useEffect(() => {
    const player = playerRef.current
    if (!player || player.isDisposed() || !availableSubs.length) return

    // Remember which track was active so we can restore it
    const tracks = player.textTracks()
    let activeLang = null
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].mode === 'showing') { activeLang = tracks[i].language; break }
    }

    // Remove all current remote text tracks
    const remoteEls = player.remoteTextTracks()
    const toRemove = []
    for (let i = 0; i < remoteEls.length; i++) toRemove.push(remoteEls[i])
    toRemove.forEach((t) => player.removeRemoteTextTrack(t))

    // Re-add with offset. Same toAbsStreamUrl fix as the initial-load
    // path above — bare /api/... bypasses the window.fetch patch
    // because <track> elements use native resource loading.
    availableSubs.forEach((s) => {
      const params = new URLSearchParams({ url: s.url })
      if (subOffset) params.set('offset', String(subOffset))
      const track = player.addRemoteTextTrack({
        kind: 'subtitles',
        src: toAbsStreamUrl(`/api/subtitles/proxy?${params}`),
        srclang: s.lang || 'en',
        label: s.langName || s.lang || 'Unknown',
        default: false,
      }, false)
      if (activeLang && (s.lang || 'en') === activeLang && track?.track) {
        // Restore previous selection on next tick (after the track is ready)
        setTimeout(() => { try { track.track.mode = 'showing' } catch {} }, 100)
      }
    })
  }, [subOffset, availableSubs])

  // ── Google Cast initialization ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let initialized = false // guard: both the polled init() and the
                            // __onGCastApiAvailable callback try to init
    let ctxRef = null
    let listener = null
    const init = () => {
      if (cancelled || initialized) return
      if (!window.chrome?.cast || !window.cast?.framework) {
        setTimeout(init, 500)
        return
      }
      initialized = true
      const context = window.cast.framework.CastContext.getInstance()
      ctxRef = context
      context.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      })
      listener = () => {
        const s = context.getCastState()
        if (s === 'NO_DEVICES_AVAILABLE') setCastState('unavailable')
        else if (s === 'NOT_CONNECTED') setCastState('available')
        else if (s === 'CONNECTING') setCastState('connecting')
        else if (s === 'CONNECTED') {
          setCastState('connected')
          castSessionRef.current = context.getCurrentSession()
        }
      }
      listener()
      context.addEventListener(
        window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
        listener,
      )
    }
    window['__onGCastApiAvailable'] = (isAvailable) => { if (isAvailable) init() }
    init()
    return () => {
      cancelled = true
      // Remove the cast state listener so repeated mounts don't stack up
      // duplicate handlers (fires setCastState N times per event).
      try {
        if (ctxRef && listener) {
          ctxRef.removeEventListener(
            window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
            listener,
          )
        }
      } catch {}
    }
  }, [])

  // Guess a usable MIME from a stream URL. Cast receivers + many DLNA TVs
  // refuse media when the advertised Content-Type doesn't match the actual
  // container — hardcoding 'video/mp4' for an .mkv fails silently on LG/Samsung.
  const guessMime = useCallback((url) => {
    if (!url) return 'video/mp4'
    const clean = url.split('?')[0].toLowerCase()
    if (clean.endsWith('.m3u8')) return 'application/x-mpegURL'
    if (clean.endsWith('.mpd')) return 'application/dash+xml'
    if (clean.endsWith('.mkv')) return 'video/x-matroska'
    if (clean.endsWith('.webm')) return 'video/webm'
    if (clean.endsWith('.avi')) return 'video/x-msvideo'
    if (clean.endsWith('.mov')) return 'video/quicktime'
    if (clean.endsWith('.ts')) return 'video/mp2t'
    return 'video/mp4'
  }, [])

  // Resolve the current stream into an absolute URL the TV can actually reach.
  // In packaged Electron and dev, window.location.hostname is `localhost`,
  // which a Chromecast/TV on the LAN can't resolve — fetch our LAN IP from
  // the server and rewrite.
  //
  // `forceRemux` rewrites /stream/HASH/file.mkv → /remux/HASH/file.mp4 so
  // ffmpeg repackages into fragmented MP4 (stream-copy video + AAC audio).
  // Most DLNA TVs refuse MKV with protocol error 701; MP4 is near-universal.
  const buildCastUrl = useCallback(async ({ forceRemux = false } = {}) => {
    if (!source) return null
    let path = source
    if (forceRemux && /^\/stream\//.test(path)) {
      path = path.replace(/^\/stream\//, '/remux/').replace(/\.(mkv|avi|mov|webm|ts|wmv|flv)(\?|$)/i, '.mp4$2')
    }
    let mediaUrl = path.startsWith('http')
      ? path
      : `${window.location.protocol}//${window.location.hostname}:3000${path}`
    try {
      const devRes = await fetch('/api/dlna/devices')
      const devData = await devRes.json().catch(() => ({}))
      const lanIp = devData.lanIp
      if (lanIp && lanIp !== '127.0.0.1') {
        mediaUrl = mediaUrl
          .replace(/\/\/localhost(?=[:/])/g, `//${lanIp}`)
          .replace(/\/\/127\.0\.0\.1(?=[:/])/g, `//${lanIp}`)
      }
    } catch {}
    return mediaUrl
  }, [source])

  const handleCast = useCallback(async () => {
    if (!source || !window.cast?.framework) return
    const context = window.cast.framework.CastContext.getInstance()
    // Build the LAN-reachable URL BEFORE requesting session so we can bail
    // early if we can't resolve a routable address.
    const absoluteUrl = await buildCastUrl()
    if (!absoluteUrl) return
    try {
      await context.requestSession()
      const session = context.getCurrentSession()
      if (!session) return
      castSessionRef.current = session
      const mime = guessMime(absoluteUrl)
      const mediaInfo = new window.chrome.cast.media.MediaInfo(absoluteUrl, mime)
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata()
      mediaInfo.metadata.title = playingMetadata?.title || 'WardoFlix'
      // HLS needs the streamType hint so the receiver picks the right player
      if (mime === 'application/x-mpegURL') {
        mediaInfo.hlsSegmentFormat = 'ts'
        mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED
      }
      const request = new window.chrome.cast.media.LoadRequest(mediaInfo)
      request.currentTime = playerRef.current?.currentTime?.() || 0
      await session.loadMedia(request).then(
        () => { try { playerRef.current?.pause() } catch {} },
        (err) => {
          console.error('Cast load failed:', err)
          toast(
            `Chromecast refused the stream (${err?.code || 'unknown'}). Your TV may not support ${mime}.`,
            'error',
            { title: 'Cast failed' }
          )
        },
      )
    } catch (err) {
      // user dismissed picker — not an error
      if (err !== 'cancel' && err?.code !== 'cancel') {
        console.error('Cast session error:', err)
      }
    }
  }, [source, playingMetadata, buildCastUrl, guessMime])

  const stopCasting = useCallback(() => {
    const context = window.cast?.framework?.CastContext?.getInstance?.()
    context?.endCurrentSession?.(true)
    castSessionRef.current = null
  }, [])

  // ── DLNA (Samsung / LG / Sony Smart TVs) ──────────────────────
  const refreshDlna = useCallback(async () => {
    try {
      await fetch('/api/dlna/refresh', { method: 'POST' })
      // short delay so SSDP replies arrive
      await new Promise((r) => setTimeout(r, 1200))
      const res = await fetch('/api/dlna/devices')
      const data = await res.json().catch(() => ({}))
      setDlnaDevices(data.devices || [])
    } catch {}
  }, [])

  // Initial & periodic discovery while streaming
  useEffect(() => {
    refreshDlna()
    const id = setInterval(refreshDlna, 30_000)
    return () => clearInterval(id)
  }, [refreshDlna])

  // ── DLNA disconnect detection ──────────────────────────────────
  // While we have an active cast target, poll once every 10s to verify
  // the device is still online. If a TV reboots, drops off the LAN, or
  // the user pulls the plug mid-stream, the dlnaActive flag would
  // otherwise stay set forever and the UI would keep claiming "casting"
  // until the user manually hit Stop. Watching the discovered-devices
  // list against the active id covers all of those (rebooted TV
  // disappears from SSDP responses; offline TV times out; remote-quit
  // user clears it via the device's own remote → next refresh sees
  // it no longer claims the stream).
  useEffect(() => {
    if (!dlnaActive) return
    const id = setInterval(() => {
      fetch('/api/dlna/devices').then((r) => r.json()).then((d) => {
        const stillThere = (d.devices || []).some((dev) => dev.id === dlnaActive)
        if (!stillThere) {
          setDlnaActive(null)
          toast('Cast device disconnected', 'warning', { title: 'DLNA' })
        }
      }).catch(() => {})
    }, 10_000)
    return () => clearInterval(id)
  }, [dlnaActive])

  const castDlna = useCallback(async (device) => {
    if (!source || !device?.id) return
    // Preemptively remux for DLNA when the source isn't an MP4. Most older
    // Samsung/LG/Medion TVs return DLNA error 701 ("incompatible protocol info")
    // on MKV/AVI, so we route through /remux → fMP4 by default.
    const sourceIsMp4 = /\.mp4(\?|$)/i.test(source)
    const shouldRemux = !sourceIsMp4

    const tryOnce = async (forceRemux) => {
      const mediaUrl = await buildCastUrl({ forceRemux })
      if (!mediaUrl) throw new Error('Could not build stream URL')
      const mime = guessMime(mediaUrl)
      const r = await fetch('/api/dlna/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: device.id,
          url: mediaUrl,
          title: playingMetadata?.title,
          type: mime,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(data.error || 'Cast failed')
        err.mime = mime
        throw err
      }
      return { mime }
    }

    try {
      const { mime } = await tryOnce(shouldRemux)
      setDlnaActive(device.id)
      try { playerRef.current?.pause() } catch {}
      console.log(`DLNA cast OK (${mime})${shouldRemux ? ' via remux' : ''}`)
    } catch (e) {
      // Error 701 = incompatible protocol info; retry through remux if we
      // weren't already using it. This catches TVs that accept MP4 but not
      // e.g. a stray AVI or WebM source.
      const is701 = /701/.test(e.message) || /protocol info/i.test(e.message)
      if (is701 && !shouldRemux) {
        try {
          const { mime } = await tryOnce(true)
          setDlnaActive(device.id)
          try { playerRef.current?.pause() } catch {}
          console.log(`DLNA cast OK after remux (${mime})`)
          return
        } catch (e2) {
          toast(
            `DLNA cast failed even after remux: ${e2.message}. Your TV may be offline or on a different network.`,
            'error',
            { title: 'DLNA cast failed' }
          )
          return
        }
      }
      toast(
        `DLNA cast failed: ${e.message}. If this keeps happening, try a different source from the list.`,
        'error',
        { title: 'DLNA cast failed' }
      )
    }
  }, [source, playingMetadata, buildCastUrl, guessMime])

  const stopDlna = useCallback(async () => {
    if (!dlnaActive) return
    try {
      await fetch('/api/dlna/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dlnaActive }),
      })
    } catch {}
    setDlnaActive(null)
  }, [dlnaActive])

  const startProgress = useCallback((url) => {
    const match = url?.match(/\/(?:stream|remux)\/([a-f0-9]{40})\//i)
    const dbg = (msg) => fetch('/api/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'sse', msg }),
    }).catch(() => {})
    if (!match) { dbg(`no hash match in url: ${url?.slice(0, 120)}`); return }
    if (progressRef.current) progressRef.current.close()
    streamProgressRef.current = null
    let firstMessage = true
    try {
      const es = new EventSource(`/api/stream/progress/${match[1]}`)
      progressRef.current = es
      dbg(`opened ${match[1].slice(0, 8)}`)
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data)
          streamProgressRef.current = d
          setStreamProgress(d)
          if (firstMessage) {
            firstMessage = false
            dbg(`first msg ${match[1].slice(0, 8)}: peers=${d.peers} dl=${d.downloaded} ready=${d.ready}`)
          }
        } catch {}
      }
      es.onerror = (e) => {
        dbg(`error ${match[1].slice(0, 8)}: readyState=${es.readyState}`)
        es.close()
        progressRef.current = null
      }
    } catch (e) {
      dbg(`constructor threw: ${e?.message || String(e)}`)
    }
  }, [])

  const handleStream = async (urlOrMagnet, metadata) => {
    let trimmed = (urlOrMagnet || input).trim()
    // Snapshot the active profile at stream-start so the history commit
    // (fired 15s+ later when the peer-watchdog clears) lands under the
    // profile that launched the stream, even if the user has since
    // switched profiles. Without this snapshot, addToHistory reads the
    // *current* active profile at write time, which is the wrong one.
    const streamProfileId = getActiveProfileId()

    // Reset autoplay-counter on USER-initiated streams. Anything tagged
    // with `__autoplay: true` is the next-episode countdown firing —
    // those increment instead. Without this gate, the "Still Watching"
    // prompt would never show because the counter would reset every
    // time a new ep loaded (regardless of who triggered it).
    if (metadata?.__autoplay) {
      autoplayCountRef.current = (autoplayCountRef.current || 0) + 1
    } else {
      autoplayCountRef.current = 0
    }
    // Always clear any pending countdown / still-watching prompts —
    // a fresh stream supersedes whatever was queued.
    setNextEpCountdown(null)
    setStillWatching(null)

    // Stremio-style flow: if we were handed episode metadata but no magnet
    // (e.g. autoplay-next-episode on an unavailable slot), resolve it via
    // Torrentio on demand.
    if (!trimmed && metadata?.season && metadata?.episode && (metadata.id || metadata.title)) {
      try {
        setTab('stream')
        setLoading(true)
        const params = new URLSearchParams({
          title: metadata.title || '',
          season: String(metadata.season),
          episode: String(metadata.episode),
        })
        if (metadata.id) params.set('tmdbId', String(metadata.id))
        if (metadata.imdbId) params.set('imdbId', metadata.imdbId)
        const r = await fetch(`/api/torrent-episode?${params}`)
        // Distinguish "backend is down / network" from "no torrents found"
        // so the user sees an actionable message, not a confusing "no
        // source" when really the server crashed.
        if (!r.ok) {
          setError(`Episode lookup failed (HTTP ${r.status}) — the backend may be unreachable.`)
          setLoading(false); return
        }
        const j = await r.json().catch(() => null)
        if (!j || !Array.isArray(j.torrents)) {
          setError('Episode lookup returned an invalid response from the indexer.')
          setLoading(false); return
        }
        const best = j.torrents[0]
        if (!best?.magnet) { setError(`No source found for S${metadata.season}E${metadata.episode}`); setLoading(false); return }
        trimmed = best.magnet
      } catch (err) {
        // TypeError: fetch failed = network error (DNS, offline, backend down)
        const isNetwork = err?.name === 'TypeError'
        setError(isNetwork
          ? 'Could not reach the backend to look up the episode. Is the server running?'
          : `Lookup failed: ${err.message}`)
        setLoading(false); return
      }
    }

    if (!trimmed) { setError('Please paste a URL or magnet link'); return }

    setTab('stream')
    setError('')
    setStreamWarning('')
    setLoading(true)
    setSource(null)
    setSourceType(null)
    setDetailItem(null)
    setPlayingMetadata(metadata || null)
    setShowIntro(false)  // will be triggered when player emits canplay
    setStreamProgress(null)
    setAudioTracks([])
    setActiveAudioIdx(null)
    setStreamInfoHash(null)
    setStreamBaseUrl(null)
    setStreamDuration(null)
    setProbedVcodec(null)
    setPlaybackError(null)
    if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
    streamProgressRef.current = null
    // Flip alive: any previous fallback-loop iterations will see the
    // flag change and bail before firing another /api/stream request.
    streamAliveRef.current = false
    // Next microtask, the new handleStream run is in charge — re-arm.
    queueMicrotask(() => { streamAliveRef.current = true })
    // Kill any in-flight background fetches from the previous stream so
    // their late results can't clobber the new one.
    try { tracksAbortRef.current?.abort() } catch {}
    try { subsAbortRef.current?.abort() } catch {}
    try { streamAbortRef.current?.abort() } catch {}
    const streamCtl = new AbortController()
    streamAbortRef.current = streamCtl

    if (isMagnetLink(trimmed)) {
      // ── Build the fallback chain ──────────────────────────────────
      // Queue = [user's pick, ...pre-sorted alternatives]. We retry down
      // the list on 4xx/5xx from /api/stream OR when the peer watchdog
      // fires (0 peers + 0 bytes after 15s on a supposedly-live stream).
      // This is the core of the "no more 'no stream found' dead-ends"
      // promise — if ANY source in the chain is alive, we play it.
      const altList = Array.isArray(metadata?.alternatives) ? metadata.alternatives : []
      const queue = [
        { magnet: trimmed, quality: metadata?.quality || '', seeds: metadata?.seeds, size: metadata?.size || '' },
        ...altList,
      ]

      let success = false
      let lastErr = null
      for (let i = 0; i < queue.length; i++) {
        const candidate = queue[i]
        if (!candidate?.magnet) continue
        // Surface "trying alternate source" to the user so a 20-second
        // silence doesn't feel like the app froze.
        if (i > 0) {
          const q = candidate.quality || 'source'
          const s = typeof candidate.seeds === 'number' ? ` · ${candidate.seeds} listed seeds` : ''
          // Don't say "no seeders" — that's a half-truth; the source may
          // have seeders but we couldn't reach them within the timeout
          // window. Saying "no peers reached" is more accurate and
          // doesn't make the user mistrust the seeder counts (which
          // are coming from Torrentio's tracker scrape and are usually
          // correct, just stale or unreachable from this network).
          setStreamWarning(`Couldn't reach peers on the previous source. Trying ${i + 1} of ${queue.length} (${q}${s})…`)
        }
        try {
          const res = await fetch('/api/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Pass fileIdx when Torrentio told us which file in a
            // multi-episode pack matches the episode the user clicked.
            // Without this, pickBestVideoFile just picks the largest
            // video and we play "S2E7" when the user asked for "S1E1" —
            // reproducing every time a pack covers multiple episodes.
            body: JSON.stringify({
              magnet: candidate.magnet,
              fileIdx: typeof candidate.fileIdx === 'number' ? candidate.fileIdx : undefined,
              season: playingMetadata?.season,
              episode: playingMetadata?.episode,
              titleHint: playingMetadata?.title,
            }),
            signal: streamCtl.signal,
          })
          // If the user started a different stream (or handleClear ran)
          // while this request was in flight, bail now — the new run has
          // already set up its own state and we'd corrupt it.
          if (streamCtl.signal.aborted) throw new Error('stream request aborted')
          const data = await res.json().catch(() => { throw new Error('Backend not responding. Run: npm start') })
          if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
          if (!data.url) throw new Error('No stream URL returned')

          const abs = (window.__API_BASE__ || '') + data.url
          // New stream → reset the remux-escalation stage to 0 so we're
          // allowed to walk the full /stream/ → /remux/ → /remux/&fresh
          // ladder if this new source misbehaves.
          remuxFallbackRef.current = 0
          setSource(abs)
          setSourceType('url')
          setStreamWarning(data.warning || '')
          setStreamInfoHash(data.infoHash || null)
          setStreamBaseUrl(data.isRemuxed ? abs : null)
          startProgress(abs)

          // ── Stream-liveness watchdog (v1.7.2 rewrite) ───────────
          //
          // The previous watchdog declared a stream "alive" the moment
          // the video element fired `loadeddata` or `progress` — but
          // those events fire as soon as Chromium has *any* bytes,
          // including the few KB of MP4 header that WebTorrent yanked
          // from a single flaky peer before the swarm went silent. The
          // user got stuck on "1 peer / 0 peers" forever because the
          // watchdog had committed to the candidate after 200ms of
          // metadata grab, even though no actual video data was ever
          // going to flow. Reproducible on cold popular-show torrents
          // (The Boys S01E01, lots of others) where Torrentio reports
          // healthy seed counts that turn out to be stale.
          //
          // The new contract: bytes must KEEP flowing. We track the
          // END of the buffered range every second; if it doesn't
          // advance by at least 0.5s of content within 30 seconds
          // (and we haven't seen 3+ seconds of buffer growth, which
          // unambiguously means data is flowing), the stream is dead
          // and we move to the next alternative.
          //
          // Buffer-end is the right signal because:
          //   - It comes directly from the media element — no SSE race
          //   - It only advances when actual decodable bytes land
          //   - "Stalled" video without buffer growth is exactly the
          //     failure mode the user experiences
          //   - It still ALIVE-flags fast on healthy streams (typical
          //     buffered.end > 3s within ~5–8s of the click)
          //
          // SSE is kept as a parallel weak signal: if the server
          // reports >1 peer + > 1MB downloaded, we extend the stall
          // deadline another 30s — the bytes are en route, the player
          // just hasn't decoded enough to grow the buffered range yet.
          const WATCHDOG_FIRST_BUFFER_MS  = 30000  // 30s to see ANY buffer growth
          const WATCHDOG_STALL_MS         = 25000  // 25s after first growth, no more growth = dead
          const WATCHDOG_HARD_MAX_MS      = 60000  // ultimate ceiling
          const HEALTHY_BUFFER_SECONDS    = 3.0    // buffered range > 3s = unambiguously alive

          const deadChain = await new Promise((resolve) => {
            let decided = false
            const startedAt = Date.now()
            let lastBufferedEnd = 0
            let lastGrowthAt = startedAt
            let attachedPlayer = null

            const finish = (dead, why) => {
              if (decided) return
              decided = true
              try {
                const p = streamProgressRef.current
                fetch('/api/debug-log', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    tag: 'watchdog',
                    msg: `${dead ? 'DEAD' : 'ALIVE'} via=${why} bufEnd=${lastBufferedEnd.toFixed(2)} sse=${JSON.stringify(p)}`,
                  }),
                }).catch(() => {})
              } catch {}
              cleanup()
              resolve(dead)
            }

            const checkBuffered = () => {
              const p = playerRef.current
              if (!p || p.isDisposed?.()) return 0
              try {
                const buf = p.buffered?.()
                if (!buf || !buf.length) return 0
                let maxEnd = 0
                for (let i = 0; i < buf.length; i++) {
                  const end = buf.end(i)
                  if (end > maxEnd) maxEnd = end
                }
                return maxEnd
              } catch { return 0 }
            }

            const tryAttachPlayer = () => {
              const p = playerRef.current
              if (!p || p.isDisposed?.() || attachedPlayer) return
              attachedPlayer = p
            }
            const playerAttachId = setInterval(tryAttachPlayer, 200)
            tryAttachPlayer()

            const tick = setInterval(() => {
              const now = Date.now()

              // User explicitly aborted (back button, switched titles).
              if (!streamAliveRef.current) return finish(false, 'aborted')

              // Hard ceiling — no matter what, decide by 60s.
              if (now - startedAt > WATCHDOG_HARD_MAX_MS) {
                return finish(lastBufferedEnd < HEALTHY_BUFFER_SECONDS, 'hard-max-60s')
              }

              const bufEnd = checkBuffered()
              if (bufEnd > lastBufferedEnd + 0.5) {
                // Buffer is growing — bytes are flowing.
                lastBufferedEnd = bufEnd
                lastGrowthAt = now
                if (bufEnd >= HEALTHY_BUFFER_SECONDS) {
                  return finish(false, `healthy-${bufEnd.toFixed(1)}s-buffered`)
                }
              }

              const sinceLastGrowth = now - lastGrowthAt
              const sse = streamProgressRef.current

              // Phase 1: nothing's grown yet. Allow up to FIRST_BUFFER_MS.
              if (lastBufferedEnd === 0) {
                if (now - startedAt > WATCHDOG_FIRST_BUFFER_MS) {
                  // Even with no buffer growth, give it a tiny grace if
                  // SSE says peers + bytes are flowing — the player
                  // just hasn't decoded the first frame yet.
                  if ((sse?.peers || 0) > 1 && (sse?.downloaded || 0) > 2 * 1024 * 1024) {
                    // 2MB+ downloaded but Chromium still not buffering
                    // means a codec/container the demuxer is choking on
                    // → /remux fallback handles it; keep the stream.
                    return finish(false, 'sse-bytes-flowing-no-buffer')
                  }
                  return finish(true, 'no-first-buffer-30s')
                }
                return
              }

              // Phase 2: started buffering, then stalled.
              if (sinceLastGrowth > WATCHDOG_STALL_MS) {
                // Last-chance: if the server reports a recent download
                // jump even though our buffer didn't grow, the bytes
                // are flowing into ffmpeg's remux pipe and a fresh
                // moov atom will land any second. Extend stall deadline
                // another 15s once.
                if ((sse?.peers || 0) > 1 && (sse?.downloaded || 0) > lastBufferedEnd * 100000) {
                  // (heuristic: downloaded bytes > 100KB per buffered
                  // second = there's pipeline progress not yet decoded)
                  lastGrowthAt = now - WATCHDOG_STALL_MS + 15000
                  return
                }
                return finish(true, `stalled-${Math.round(sinceLastGrowth / 1000)}s`)
              }
            }, 1000)

            function cleanup() {
              try { clearInterval(tick) } catch {}
              try { clearInterval(playerAttachId) } catch {}
            }
          })

          if (deadChain && i < queue.length - 1) {
            // Try the next source. Clean up this attempt first.
            if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
            // Tell the server to destroy the dead torrent immediately
            // instead of letting it sit around for the 2h auto-prune.
            // Otherwise after 8 dead candidates we have 8 zombie torrents
            // each retrying tracker/DHT — wasteful and counts toward our
            // own outbound bandwidth budget.
            const deadHash = data?.infoHash
            if (deadHash) {
              fetch('/api/stream/dead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ infoHash: deadHash }),
              }).catch(() => {})
            }
            setSource(null)
            setSourceType(null)
            setStreamInfoHash(null)
            setStreamBaseUrl(null)
            lastErr = new Error(`Source ${i + 1} had no active peers`)
            continue
          }

          // Save to history once we've committed to a source that
          // actually has peers. Recording every dead attempt would spam
          // the list with broken entries.
          if (metadata?.title) {
            // Carry TMDB genre_ids through so For You's genre-weight
            // algorithm has real per-entry signal, not just type bias.
            // DetailModal's onStream spreads ...item into metadata, so
            // any TMDB field (genre_ids, name/title, *_date) rides along.
            const gids = Array.isArray(metadata.genre_ids)
              ? metadata.genre_ids
              : Array.isArray(metadata.genreIds) ? metadata.genreIds : []
            addToHistory({
              title: metadata.title,
              poster: metadata.poster || null,
              type: metadata.type || inferType(metadata) || null,
              id: metadata.id || null,
              season: metadata.season || null,
              episode: metadata.episode || null,
              magnet: candidate.magnet,
              genreIds: gids,
            }, streamProfileId)
            window.dispatchEvent(new Event('wardoflix:history-updated'))
          }

          // Fetch audio tracks + duration + vcodec. See comment on
          // tracksAbortRef for why we cancel the previous fetch.
          //
          // We also use this response to PROACTIVELY upgrade /stream/ URLs
          // to /remux/?transcode=1 whenever the probed vcodec isn't one
          // Chromium can decode natively. This eliminates the common race
          // where the player fires a decode error before the error-handler
          // swap has a chance to run (especially on slow torrents where
          // the first keyframe arrives before /api/tracks returns).
          if (data.infoHash) {
            try { tracksAbortRef.current?.abort() } catch {}
            const ctl = new AbortController()
            tracksAbortRef.current = ctl
            fetch(`/api/tracks/${data.infoHash}`, { signal: ctl.signal })
              .then((r) => r.json().catch(() => ({ audioTracks: [] })))
              .then((d) => {
                if (ctl.signal.aborted) return
                if (d.audioTracks?.length > 0) {
                  setAudioTracks(d.audioTracks)
                  // Auto-pick the user's preferred audio language if any
                  // of the available tracks matches. Falls back to track
                  // 0 if no preference matches. The audio picker still
                  // lets you switch manually after.
                  const prefIdx = pickPreferredAudioTrack(d.audioTracks, loadAudioPref())
                  setActiveAudioIdx(prefIdx ?? d.audioTracks[0].index)
                  // If we picked something other than track 0 AND it's
                  // a /remux URL, re-issue with ?audio=N so ffmpeg maps
                  // that track. Otherwise the player would still get
                  // the default audio with no easy way to switch on
                  // copy-mode streams.
                  if (prefIdx != null && prefIdx !== d.audioTracks[0].index && data.url?.includes('/remux/')) {
                    try {
                      const urlObj = new URL((window.__API_BASE__ || '') + data.url)
                      urlObj.searchParams.set('audio', String(prefIdx))
                      setSource(urlObj.toString())
                    } catch {}
                  }
                }
                if (d.duration && d.duration > 0) setStreamDuration(d.duration)
                // Record the probed codec for the debug overlay.
                if (d.vcodec) setProbedVcodec(d.vcodec)
                // Codec-aware URL upgrade. Only acts on /stream/ URLs that
                // the server also hasn't already forced to /remux.
                const upgraded = upgradeStreamUrlForCodec(data.url, d.vcodec)
                if (upgraded !== data.url) {
                  setStreamWarning(d.vcodec
                    ? `Codec ${d.vcodec} isn't browser-playable — transcoding on the fly…`
                    : "Couldn't detect codec — transcoding for compatibility…")
                  // Prefix the API base the same way the initial setSource
                  // at the play site does. Without this, in packaged
                  // (file://) builds the relative `/remux/…` URL resolves
                  // against file:// and the <video> element throws
                  // MEDIA_ERR_SRC_NOT_SUPPORTED, which surfaces to the
                  // user as the "codec" error we were trying to avoid.
                  const absUpgraded = (window.__API_BASE__ || '') + upgraded
                  setStreamBaseUrl(absUpgraded.split('?')[0])
                  setSource(absUpgraded)
                  setTimeout(() => setStreamWarning(''), 3500)
                }
              })
              .catch(() => {})
          }
          // Clear the "trying source N…" notice now that we're actually playing.
          setStreamWarning(data.warning || '')
          success = true
          break
        } catch (err) {
          lastErr = err
          // Fall through to the next iteration — the loop will try the
          // next alternative, or raise the last error after all are spent.
        }
      }

      setLoading(false)
      if (!success) {
        // ── Auto-next dead-source skip ─────────────────────────
        // If we just exhausted every source for an EPISODE (not a
        // movie) AND we got here via auto-next-episode (i.e. the
        // metadata indicates a TV show with playlist context), try
        // one episode further before giving up. Limits to one skip
        // per failure so a fully-dead season can't ladder forever.
        // The marker `__autoSkipped` on metadata means "this is
        // already the auto-skipped attempt, don't ladder again."
        const meta = playingMetadataRef.current
        const canAutoSkip = meta?.season && meta?.episode && !meta.__autoSkipped && handleStreamRef.current
        if (canAutoSkip) {
          const next = findNextEpisode(meta)
          if (next) {
            toast(`S${meta.season}E${meta.episode} couldn't connect to any source. Skipping to S${next.season}E${next.episode}…`, 'warning', { title: 'Dead episode' })
            handleStreamRef.current(next.magnet, {
              ...meta,
              season: next.season,
              episode: next.episode,
              __autoSkipped: true,
            })
            return
          }
        }
        setError(
          queue.length > 1
            ? `None of ${queue.length} sources connected within ${30}s each. Either your network is blocking BitTorrent (firewall/ISP), or the swarms are genuinely cold right now. Try a different title or wait a few minutes.`
            : (lastErr?.message || 'Stream failed')
        )
      }
    } else if (isDirectUrl(trimmed)) {
      setSource(trimmed)
      setSourceType('url')
      setLoading(false)
    } else {
      setError('Enter a valid URL or magnet link')
      setLoading(false)
    }
  }

  // Keep a ref to handleStream so the player's 'ended' listener
  // (registered once per source) can trigger the latest version.
  useEffect(() => { handleStreamRef.current = handleStream })

  // GPS-enriched telemetry ping.
  //
  // The main-process ping fires from electron/main.js on app-ready and
  // captures IP-derived geo via Cloudflare's request.cf object. That's
  // coarse — every Belgian user lands on "Brussels" because CF's MaxMind
  // DB snaps residential ISPs to the nearest metro. This effect fires a
  // SECOND ping from the renderer, with real GPS coordinates pulled from
  // navigator.geolocation (backed by Windows Location Services on Win10+).
  //
  // Permission is auto-granted in main.js's setPermissionRequestHandler,
  // so no prompt is shown to the user. If Windows Location Services is
  // off, getCurrentPosition errors out and we silently don't send the
  // second ping — the Worker keeps the coarse IP-derived coords from
  // the first ping. Either way, no UX impact on the user.
  //
  // Runs once per app session. Telemetry URL comes from access.json's
  // telemetry.url field (fetched by main.js at startup, relayed here).
  useEffect(() => {
    let cancelled = false
    // Helper: log to the local Express server, which writes to wardoflix.log.
    // Much easier than asking the user to open DevTools.
    const dbg = (tag, msg) => fetch('/api/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, msg }),
    }).catch(() => {})
    ;(async () => {
      dbg('geo', 'useEffect fired')
      const info = await window.wardoflixAccess?.getInfo?.().catch((e) => {
        dbg('geo', 'getInfo threw: ' + (e?.message || String(e)))
        return null
      })
      dbg('geo', `info: installId=${info?.installId || 'null'} telemetryUrl=${info?.telemetryUrl || 'null'} disabled=${info?.telemetryDisabled}`)
      if (!info?.installId || !info.telemetryUrl || info.telemetryDisabled) {
        dbg('geo', 'early return — no installId/url or disabled')
        return
      }
      // Shared helper so success AND failure both ping, just with
      // different bodies. The failure ping is a diagnostic: it records
      // WHY geolocation failed (code + message) into the Worker so the
      // owner dashboard can show the real reason — otherwise a silent
      // catch leaves us staring at a pin in Brussels with no clue why
      // the GPS path didn't run.
      const ping = (extra) => fetch(info.telemetryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installId: info.installId,
          version: info.appVersion,
          platform: info.platform,
          osUser: info.osUser || null,
          friendlyName: info.friendlyName || null,
          ...extra,
        }),
      }).catch((e) => {
        dbg('geo', 'worker fetch threw: ' + (e?.message || String(e)))
        return null
      })

      // Manual coordinate override has highest priority — skip Google
      // entirely. Useful when a user dropped manual-coords.txt because
      // Google's geolocation gave them a useless 75km-accuracy guess.
      if (info.manualCoords && typeof info.manualCoords.lat === 'number' && typeof info.manualCoords.lon === 'number') {
        dbg('geo', `manual coords override: ${info.manualCoords.lat}, ${info.manualCoords.lon}`)
        const r = await ping({
          lat: info.manualCoords.lat,
          lon: info.manualCoords.lon,
          source: 'manual',
        })
        dbg('geo', 'worker ping (manual) response: ' + (r?.status || 'network-error'))
        return
      }
      if (!navigator.geolocation) {
        dbg('geo', 'no navigator.geolocation object')
        const r = await ping({ geoError: 'no navigator.geolocation' })
        dbg('geo', 'worker ping (no-geo) response: ' + (r?.status || 'network-error'))
        return
      }
      dbg('geo', 'calling getCurrentPosition')
      try {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 7 * 24 * 60 * 60 * 1000,
          })
        })
        if (cancelled) return
        dbg('geo', `got position: lat=${pos.coords.latitude} lon=${pos.coords.longitude} acc=${pos.coords.accuracy}`)
        const r = await ping({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: 'gps',
        })
        dbg('geo', 'worker ping (gps) response: ' + (r?.status || 'network-error'))
      } catch (err) {
        const code = err?.code ?? '?'
        const tag = code === 1 ? 'denied' : code === 2 ? 'unavailable' : code === 3 ? 'timeout' : `code-${code}`
        dbg('geo', `getCurrentPosition failed: code=${code} tag=${tag} msg=${err?.message || ''}`)
        const r = await ping({ geoError: `${tag}:${err?.message || ''}`.slice(0, 200) })
        dbg('geo', 'worker ping (fail) response: ' + (r?.status || 'network-error'))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Seek that's aware of the /remux "Accept-Ranges: none" contract.
  //
  // Previously we let the native <video>.currentTime() setter handle
  // seeks, and bolted a `seeking` event listener on top to intercept
  // out-of-buffer targets and reload the URL with ?t=<target>. That
  // lost races three different ways:
  //   1. currentTime() inside the seeking handler could return 0 if
  //      the decode-error ladder tore down the player between set
  //      and read.
  //   2. The 120ms debounce still occasionally lost to the error
  //      handler's synchronous escalation.
  //   3. The server's /remux produces a stream whose internal time
  //      starts at 0 regardless of `-ss`, so even when the seek-
  //      reload landed correctly, the player's UI showed 0:00
  //      and felt like a restart.
  //
  // Fix: every seek trigger in the PlayerControls (±10s, seekbar
  // click, seekbar drag release, number-key shortcut) calls this
  // function instead of `player.currentTime(target)`. If we're on a
  // /remux URL and the target is outside the buffered region, we
  // skip the native seek entirely — just rebuild the URL with
  // ?t=<target> and swap the source. The new player comes up at
  // time 0 in its own coordinates, but ffmpeg's output represents
  // the video starting at `target`, so what the user sees on screen
  // is the correct content from their chosen point.
  const seekRemuxAware = useCallback((target) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    // target is an ABSOLUTE position in the original movie (from
    // PlayerControls). The player's local time axis starts at 0 at the
    // current segment's beginning — so local = absolute - remuxOffset.
    const currentSrc = source || ''
    const currentOffset = (() => {
      try {
        const qs = new URLSearchParams(currentSrc.split('?')[1] || '')
        const t = parseFloat(qs.get('t') || '0')
        return Number.isFinite(t) && t > 0 ? t : 0
      } catch { return 0 }
    })()
    const localTarget = target - currentOffset
    // Non-remux URLs (direct /stream, magnet-to-HTTP, arbitrary user
    // URLs) handle byte ranges natively. No offset in play; target
    // already is the player's local time.
    if (!currentSrc.includes('/remux/')) {
      try { p.currentTime(Math.max(0, target)) } catch {}
      return
    }
    // Check buffered in LOCAL coordinates (buffered() returns local
    // ranges) — if localTarget is inside it, native seek works and is
    // instant (no transcode respawn). Only reload when we have to.
    try {
      const buf = p.buffered()
      for (let i = 0; i < buf.length; i++) {
        if (localTarget >= buf.start(i) - 0.5 && localTarget <= buf.end(i) + 0.5) {
          p.currentTime(Math.max(0, localTarget))
          return
        }
      }
    } catch {}
    // Clamp to ABSOLUTE duration (source total) so we don't seek past
    // the end of the movie.
    const dur = (() => { try { return p.duration() + currentOffset } catch { return 0 } })()
    const clamped = Math.max(0, dur > 0 ? Math.min(dur - 1, target) : target)
    // Out of buffer on /remux — rebuild URL with ?t= and reload.
    // Critically: we do NOT call player.currentTime() here, so the
    // browser never fires a native seek that would then trip
    // Accept-Ranges:none into a decode error. Clean swap, no race.
    const base = currentSrc.split('?')[0]
    const qs = new URLSearchParams(currentSrc.split('?')[1] || '')
    qs.delete('t'); qs.delete('fresh')
    qs.set('t', String(Math.max(0, Math.floor(clamped))))
    // Save the target so the new player can display the correct
    // progress the moment it loads (we read it back in the
    // `loadedmetadata` handler to shift the UI's time axis).
    remuxTimeOffsetRef.current = Math.max(0, Math.floor(clamped))
    // Mute the decode-error ladder during the player teardown +
    // rebuild window. Without this guard, the old player fires
    // error code 4 during dispose (pending fetch got cancelled,
    // browser surfaces it as MEDIA_ERR_SRC_NOT_SUPPORTED) and the
    // error handler escalates → wipes our fresh ?t= from the URL
    // → show restarts from 0. The 2-second auto-clear below is a
    // safety net in case setSource throws before mount.
    seekReloadPendingRef.current = true
    setTimeout(() => { seekReloadPendingRef.current = false }, 2000)
    // Reset the remux escalation counter so a real decode error on
    // the new segment gets fresh chances to escalate. Without this,
    // a user who had already cascaded to stage 2 once per stream
    // would get permanently stuck in the "give up" state after a
    // single subsequent seek.
    remuxFallbackRef.current = 0
    const reloaded = `${base}?${qs.toString()}`
    setSource(reloaded)
    setStreamBaseUrl(base)
  }, [source])

  const handleAudioChange = useCallback((audioIdx) => {
    if (!streamInfoHash) return
    setActiveAudioIdx(audioIdx)
    // Reset the remux-escalation counter AND clear any pending seek-
    // reload guard. An audio track switch is a fresh start — the old
    // stream's escalation history shouldn't limit the new stream's
    // error recovery, and a leftover seekReloadPendingRef would make
    // the error handler ignore a real decode error on the new URL.
    remuxFallbackRef.current = 0
    seekReloadPendingRef.current = false
    const currentPos = playerRef.current && !playerRef.current.isDisposed()
      ? playerRef.current.currentTime() || 0
      : 0
    // Resolve the remux base URL. The direct /stream endpoint serves
    // raw WebTorrent bytes and has no notion of audio-track selection —
    // only /remux can honour `?audio=N` because it re-muxes through
    // ffmpeg. So if the current source is a direct /stream URL we
    // transparently upgrade to /remux here. When the underlying codec
    // is H.264 the server will still `-c:v copy`, so there's no
    // transcode cost — just an audio-only re-mix.
    let remuxBase
    if (streamBaseUrl) {
      remuxBase = streamBaseUrl.split('?')[0]
    } else if (source && source.includes('/stream/')) {
      remuxBase = source.replace('/stream/', '/remux/').split('?')[0]
    } else {
      return
    }
    const newUrl = `${remuxBase}?audio=${audioIdx}`
    setSource(null)
    setStreamBaseUrl(newUrl)
    setTimeout(() => {
      // If the user clicked Clear / Back / started a different stream
      // during the 50ms dispose-settle wait, streamAliveRef flips to
      // false and we must NOT rearm source — otherwise we ghost-launch
      // the audio track of a stream the user already dismissed, which
      // manifests as "clicked back, then the player re-appeared with
      // the old episode's Spanish dub." Check before doing anything.
      if (!streamAliveRef.current) return
      setSource(newUrl)
      setSourceType('url')
      // Seek back to saved position once player is ready
      const waitForPlayer = setInterval(() => {
        if (!streamAliveRef.current) { clearInterval(waitForPlayer); return }
        const p = playerRef.current
        if (p && !p.isDisposed()) {
          p.ready(() => {
            if (currentPos > 0) p.currentTime(currentPos)
            clearInterval(waitForPlayer)
          })
        }
      }, 100)
      // Safety cleanup
      setTimeout(() => clearInterval(waitForPlayer), 10000)
    }, 50)
  }, [streamBaseUrl, streamInfoHash, source])

  // Retry the current stream after a playback error. We keep the existing
  // player but re-issue src() and try to seek back to where we were — if
  // the error was a transient network hiccup, this picks up cleanly.
  const handleRetryPlayback = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed() || !source) { setPlaybackError(null); return }
    const pos = (() => { try { return p.currentTime() || 0 } catch { return 0 } })()
    setPlaybackError(null)
    try {
      const currentSrc = source
      p.src({ type: currentSrc.toLowerCase().includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4', src: currentSrc })
      p.one('loadedmetadata', () => {
        if (pos > 0) { try { p.currentTime(pos) } catch {} }
        try { p.play() } catch {}
      })
    } catch {}
  }, [source])

  // Tab-switch teardown. When the user clicks Browse (or the logo)
  // while a stream is playing, the {tab === 'stream' && ...} JSX
  // unmounts and the <video> element gets removed from the DOM.
  // BUT: the videojs player instance lives on in playerRef, and
  // Chromium happily keeps a detached <video> element playing
  // audio in the background until pause()/dispose() is called. The
  // user hears phantom audio while they scroll Browse for the next
  // thing. Fix: when tab leaves 'stream', tear the stream down the
  // same way the explicit Clear button does. Side benefit — no
  // half-loaded ffmpeg pipe lingering on the server side either.
  useEffect(() => {
    if (tab === 'stream') return
    if (!source && !playerRef.current) return
    // Defer one tick so we don't fight a setSource()-triggered
    // re-render that's still in flight.
    queueMicrotask(() => {
      try {
        if (playerRef.current && !playerRef.current.isDisposed()) {
          // Persist resume position before disposing — same
          // best-effort save handleClear does.
          try {
            const t = playerRef.current.currentTime() || 0
            const d = playerRef.current.duration()
            if (playingMetadataRef.current && t > 0) {
              saveResumePosition(playingMetadataRef.current, t, isFinite(d) ? d : 0)
            }
          } catch {}
          playerRef.current.pause?.()
          playerRef.current.dispose()
          playerRef.current = null
        }
      } catch {}
      // Clear the rest of the stream state. Mirrors handleClear's
      // setters but skips setTab(...) — the user already chose a
      // tab, we're just catching up.
      setSource(null)
      setSourceType(null)
      setPlayingMetadata(null)
      setStreamProgress(null)
      setStreamWarning('')
      setError('')
      setAvailableSubs([])
      setSubOffset(0)
      setSubPanelOpen(false)
      setAudioTracks([])
      setActiveAudioIdx(null)
      setStreamInfoHash(null)
      setStreamBaseUrl(null)
      setStreamDuration(null)
      setProbedVcodec(null)
      setPlaybackError(null)
      try { tracksAbortRef.current?.abort() } catch {}
      try { streamAbortRef.current?.abort() } catch {}
      try { subsAbortRef.current?.abort() } catch {}
      streamAliveRef.current = false
      streamProgressRef.current = null
      if (progressRef.current) {
        try { progressRef.current.close() } catch {}
        progressRef.current = null
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const handleClear = useCallback(() => {
    // Exit fullscreen first — otherwise the viewer ends up staring at a
    // black/grey fullscreen canvas after the <video> is disposed below.
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      try { document.exitFullscreen() } catch {}
    }
    setInput('')
    setSource(null)
    setSourceType(null)
    setError('')
    setStreamWarning('')
    setPlayingMetadata(null)
    setStreamProgress(null)
    setAvailableSubs([])
    setSubOffset(0)
    setSubPanelOpen(false)
    setAudioTracks([])
    setActiveAudioIdx(null)
    setStreamInfoHash(null)
    setStreamBaseUrl(null)
    setStreamDuration(null)
    setProbedVcodec(null)
    setPlaybackError(null)
    try { tracksAbortRef.current?.abort() } catch {}
    try { streamAbortRef.current?.abort() } catch {}
    try { subsAbortRef.current?.abort() } catch {}
    // Tell any running fallback loop to stop before it fires another request.
    streamAliveRef.current = false
    streamProgressRef.current = null
    // Send the user back to Browse — that's where they almost certainly
    // came from (DetailModal → handleStream auto-switched to 'stream').
    // Landing on the empty Stream tab after closing a movie is a dead-end UX.
    setTab('browse')
    if (progressRef.current) { progressRef.current.close(); progressRef.current = null }
    if (playerRef.current && !playerRef.current.isDisposed()) {
      playerRef.current.dispose()
      playerRef.current = null
    }
  }, [])

  return (
    <div className="app">
      {/* Cinematic startup intro — plays once on app launch, full-viewport
          overlay. Uses the same component as the pre-stream intro so the
          sound + animation are identical. */}
      {showStartupIntro && (
        <div className="wf-startup-intro-layer">
          <WardoFlixIntro onComplete={() => setShowStartupIntro(false)} />
        </div>
      )}
      {/* Profile gate — renders after the startup intro fades. The
          render is gated on (!showStartupIntro) so the "Who's
          watching?" screen doesn't flash through behind the intro
          (which is briefly translucent during its own fade-out).
          v1.7.9: if there's exactly ONE profile, skip the picker
          entirely and auto-select. Showing a "Who's watching?"
          screen with one face on it is performative — the answer
          is always "that one". The picker still shows when there
          are 2+ profiles (real choice) or 0 profiles (creation
          flow). */}
      <AutoPickSingleProfile profiles={profiles} activeProfile={activeProfile} />
      {!showStartupIntro && !activeProfile && profiles.length !== 1 && (
        <ProfileGate
          profiles={profiles}
          onPick={(id) => setActiveProfileId(id)}
          onManage={() => setManageCreate(true)}
        />
      )}
      {/* Manage-mode creator opened from the gate's "Manage profiles"
          button. Lives outside ProfileGate so its lifecycle isn't
          tied to the gate being mounted. */}
      {manageCreate && (
        <ProfileEditor
          onClose={() => setManageCreate(false)}
          onSave={(data) => {
            const p = createProfile(data)
            setActiveProfileId(p.id)
            setManageCreate(false)
          }}
        />
      )}
      <header className="topbar">
        <h1 className="logo" onClick={() => setTab('browse')}>
          <span className="logo-mark">W</span>
          <span>Wardo<span className="logo-flix">Flix</span></span>
        </h1>
        <nav className="topbar-nav">
          <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>Browse</button>
          <button className={tab === 'stream' ? 'active' : ''} onClick={() => setTab('stream')}>Stream</button>
        </nav>
        {appVersion && (
          <div
            className="topbar-version"
            title={serverHealthy === false ? 'Backend unreachable' : `WardoFlix v${appVersion}`}
            data-healthy={serverHealthy !== false ? 'yes' : 'no'}
          >
            <span className="topbar-version-dot" />
            v{appVersion}
          </div>
        )}
        {/* v1.9.0 — Privacy Mode toggle. When ON: history, resume
            positions, Discord RPC, and telemetry are all suspended.
            Click toggles; the eye icon flips between open (off) and
            crossed-out (on). Per-profile so a privacy-conscious
            profile co-exists with a regular one. */}
        <PrivacyModeToggle />
        {/* Auto-updater indicator. Renders null outside Electron (browser
            preview) because window.wardoflixUpdater is only exposed by the
            preload script in the packaged app. */}
        <UpdaterIndicator />
        {/* Active-profile avatar + dropdown. Only renders once the
            user has picked a profile — otherwise the gate covers the
            whole app anyway, so there's nothing to switch. */}
        <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} />
        {/* Window controls — Windows-style minimize + close, flush
            with the top-right corner of the topbar. The app launches
            in Electron fullscreen by default and there's no native
            title bar, so these synthetic buttons are the only way to
            send the app to the taskbar or quit without a keyboard
            shortcut. Both route through preload IPC; outside Electron
            (browser preview) we fall back to the no-op / window.close
            paths so nothing crashes. */}
        <div className="topbar-window-controls" aria-label="Window controls">
          <button
            className="topbar-winbtn topbar-minimize"
            onClick={() => {
              // Drop out of HTML5 fullscreen first — minimizing while
              // the video element holds fullscreen leaves a black
              // overlay on restore.
              try { if (document.fullscreenElement) document.exitFullscreen() } catch {}
              try {
                if (window.wardoflixWindow?.minimize) {
                  window.wardoflixWindow.minimize()
                }
              } catch {}
            }}
            title="Minimize"
            aria-label="Minimize WardoFlix"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="2" y1="6.5" x2="10" y2="6.5" />
            </svg>
          </button>
          <button
            className="topbar-winbtn topbar-exit"
            onClick={() => {
              try {
                // Best-effort graceful persist before we die
                if (playerRef.current && !playerRef.current.isDisposed()) {
                  const t = playerRef.current.currentTime() || 0
                  const d = playerRef.current.duration()
                  saveResumePosition(playingMetadataRef.current, t, isFinite(d) ? d : 0)
                }
              } catch {}
              try {
                // Leave HTML5 fullscreen first so the close call isn't
                // swallowed by the fullscreen layer.
                if (document.fullscreenElement) document.exitFullscreen()
              } catch {}
              // Prefer the IPC path inside Electron — main.js drops
              // out of native fullscreen before quitting, which avoids
              // a flicker on the next launch. Fall back to window.close
              // for the browser preview.
              try {
                if (window.wardoflixWindow?.close) {
                  window.wardoflixWindow.close()
                } else {
                  window.close()
                }
              } catch {}
            }}
            title="Exit WardoFlix"
            aria-label="Exit WardoFlix"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
        </div>
      </header>

      <main className="main">
        {tab === 'browse' && (
          <Browse
            activeProfile={activeProfile}
            onSelectTitle={(item) => setDetailItem(item)}
            onPlayHistory={(entry) => handleStream(entry.magnet, {
              title: entry.title,
              poster: entry.poster,
              type: entry.type,
              id: entry.id,
              season: entry.season,
              episode: entry.episode,
            })}
          />
        )}

        {tab === 'stream' && (
          <div className="stream-page">
            <div className="stream-input-bar">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStream()}
                placeholder="Paste video URL or magnet link..."
                disabled={loading}
                autoFocus
                ref={(el) => {
                  // Focus on tab-switch even after the first mount: autoFocus only
                  // fires once. Re-select() puts the caret on any previous value so
                  // the user can paste over it immediately.
                  if (el && tab === 'stream' && !source && !loading) {
                    try { el.focus({ preventScroll: true }); if (input) el.select() } catch {}
                  }
                }}
              />
              <button onClick={() => handleStream()} disabled={loading} className="btn btn-accent">
                {loading ? <><span className="spinner" /> Connecting...</> : 'Stream'}
              </button>
              {(source || input) && (
                <button onClick={handleClear} className="btn btn-ghost">Clear</button>
              )}
            </div>

            {error && <div className="stream-error">{error}</div>}
            {streamWarning && !error && <div className="stream-warning">{streamWarning}</div>}

            <div className="player-section" ref={playerSectionRef}>
              {source ? (
                <>
                  <div className="player-container" ref={playerContainerRef}>
                    <div className="player-wrapper" data-vjs-player ref={videoContainerRef} />
                    {showIntro && (
                      <WardoFlixIntro
                        fullscreenTarget={playerContainerRef.current}
                        onComplete={() => {
                          setShowIntro(false)
                          const p = playerRef.current
                          if (!p || p.isDisposed()) return
                          // v1.7.8 black-screen fix: when the player
                          // is paused at currentTime=0 during the
                          // intro, Chromium's MSE decoder sometimes
                          // idles without producing a first video
                          // frame. play() then resumes audio while
                          // video stays black until enough additional
                          // bytes arrive — manifesting as "stream
                          // starts but screen is black" on first try.
                          // Going back + Continue Watching worked
                          // because the second player saw a populated
                          // buffer immediately.
                          //
                          // Fix: nudge currentTime by a frame's worth
                          // (33ms ≈ 1 frame at 30fps) right before
                          // play(). The seek forces the decoder to
                          // flush and render a frame, so video and
                          // audio start in lockstep when play() runs.
                          try {
                            const t = p.currentTime() || 0
                            p.currentTime(Math.max(0, t + 0.033))
                          } catch {}
                          // requestAnimationFrame ensures the seek
                          // commits to Chromium before play() — without
                          // this the two calls can coalesce and the
                          // seek effectively becomes a no-op.
                          requestAnimationFrame(() => {
                            try {
                              if (!p.isDisposed()) p.play()
                            } catch {}
                          })
                        }}
                      />
                    )}
                    {/* Floating exit button — lives inside the player-container
                        so it stays visible when the container is taken
                        fullscreen via the HTML5 Fullscreen API (where
                        the page's topbar would otherwise be hidden). */}
                    <button
                      className="player-exit"
                      onClick={() => {
                        try {
                          if (playerRef.current && !playerRef.current.isDisposed()) {
                            const t = playerRef.current.currentTime() || 0
                            const d = playerRef.current.duration()
                            saveResumePosition(playingMetadataRef.current, t, isFinite(d) ? d : 0)
                          }
                        } catch {}
                        try { if (document.fullscreenElement) document.exitFullscreen() } catch {}
                        try { window.close() } catch {}
                      }}
                      title="Exit WardoFlix"
                      aria-label="Exit WardoFlix"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </button>
                    {playbackError && (
                      <div className="playback-error-overlay" role="alert">
                        <div className="playback-error-card">
                          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="13" />
                            <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
                          </svg>
                          <h3>Playback interrupted</h3>
                          <p>{playbackError.message}</p>
                          <div className="playback-error-actions">
                            <button className="btn btn-accent" onClick={handleRetryPlayback}>Retry</button>
                            <button className="btn btn-ghost" onClick={handleClear}>Back</button>
                          </div>
                        </div>
                      </div>
                    )}
                    <PlayerControls
                      playerRef={playerRef}
                      playerReady={playerReady}
                      containerRef={playerContainerRef}
                      metadata={playingMetadata}
                      availableSubs={availableSubs}
                      subOffset={subOffset}
                      setSubOffset={setSubOffset}
                      streamProgress={streamProgress}
                      castState={castState}
                      onCast={handleCast}
                      onStopCast={stopCasting}
                      onBack={handleClear}
                      audioTracks={audioTracks}
                      activeAudioIdx={activeAudioIdx}
                      onAudioChange={handleAudioChange}
                      knownDuration={streamDuration}
                      dlnaDevices={dlnaDevices}
                      dlnaActive={dlnaActive}
                      onDlnaCast={castDlna}
                      onDlnaStop={stopDlna}
                      onDlnaRefresh={refreshDlna}
                      onSeek={seekRemuxAware}
                      remuxTimeOffset={(() => {
                        // The player's local time axis starts at 0 for every
                        // remux respawn. When ?t=N is set in the URL, the
                        // content actually starts at N seconds of the source,
                        // so add N to every displayed time so the seekbar
                        // doesn't lie. Parsed from the current source URL
                        // here rather than stored in state, so it stays in
                        // sync with whatever's actually playing.
                        if (!source || !source.includes('/remux/')) return 0
                        try {
                          const qs = new URLSearchParams(source.split('?')[1] || '')
                          const t = parseFloat(qs.get('t') || '0')
                          return Number.isFinite(t) && t > 0 ? t : 0
                        } catch { return 0 }
                      })()}
                      subStyle={subStyle}
                      setSubStyle={setSubStyle}
                    />
                  </div>
                </>
              ) : loading ? (
                <div className="player-empty">
                  <span className="spinner large" />
                  <p>Connecting to peers...</p>
                </div>
              ) : (
                /* v1.7.9 — replaced the bare "paste a URL" placeholder
                   with a discoverable card that explains what the
                   Stream tab actually does and offers shortcuts to
                   the more common path (Browse). For users who land
                   here by accident, "what is this?" used to require
                   a guess. */
                <div className="player-empty player-empty--rich">
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
                    <rect x="2" y="4" width="20" height="14" rx="2" />
                    <polygon points="10,8 16,11 10,14" fill="currentColor" opacity="0.6" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="18" x2="12" y2="21" />
                  </svg>
                  <h2 className="player-empty-title">Direct Stream</h2>
                  <p className="player-empty-body">
                    Paste a <strong>magnet link</strong> or <strong>direct video URL</strong> in
                    the box above to stream it. Or skip this entirely
                    and pick something from <button className="player-empty-link" onClick={() => setTab('browse')}>Browse</button>.
                  </p>
                  <div className="player-empty-tips">
                    <div className="player-empty-tip">
                      <kbd>magnet:?</kbd>
                      <span>WebTorrent magnet — paste and press Enter</span>
                    </div>
                    <div className="player-empty-tip">
                      <kbd>https://</kbd>
                      <span>Direct .mp4 / .mkv / .m3u8 URL</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {detailItem && (
        <DetailModal
          item={detailItem}
          onClose={() => setDetailItem(null)}
          onStream={(url, meta) => handleStream(url, meta)}
          onSelectItem={(nextItem) => setDetailItem(nextItem)}
        />
      )}

      <UpdateAvailableModal />
      {/* v1.8.1 "What's New" modal. Renders entries newer than the
          user's last-seen version. Dismissing marks the current
          version as seen so it doesn't return until the next upgrade. */}
      {changelogToShow.length > 0 && appVersion && (
        <ChangelogModal
          entries={changelogToShow}
          currentVersion={appVersion}
          onDismiss={() => {
            markVersionSeen(appVersion)
            setChangelogToShow([])
          }}
        />
      )}
      <ToastHost />

      {/* Next-episode countdown overlay (v1.7.6) — Netflix-style:
          when an episode ends and there's a next, show a 8-second
          countdown with "Cancel" + "Play now" buttons. Cancel keeps
          the user on the finished frame; Play now skips the wait;
          letting the timer expire fires handleStream with the
          autoplay flag set. */}
      {nextEpCountdown && (
        <NextEpisodeCountdown
          info={nextEpCountdown}
          onCancel={() => setNextEpCountdown(null)}
          onConfirm={() => {
            const { next, meta } = nextEpCountdown
            setNextEpCountdown(null)
            handleStream(next.magnet, {
              ...meta,
              season: next.season,
              episode: next.episode,
              __autoplay: true,
            })
          }}
        />
      )}

      {/* Still-watching prompt (v1.7.6) — fires after 3 consecutive
          auto-plays. No auto-expire: requires explicit confirmation
          to continue. Same modal layer as the detail modal so it's
          unmissable. */}
      {stillWatching && (
        <StillWatchingPrompt
          info={stillWatching}
          onCancel={() => {
            // User confirmed they're done. Reset the autoplay counter
            // so a future user-initiated stream starts fresh.
            autoplayCountRef.current = 0
            setStillWatching(null)
          }}
          onConfirm={() => {
            const { next, meta } = stillWatching
            setStillWatching(null)
            handleStream(next.magnet, {
              ...meta,
              season: next.season,
              episode: next.episode,
              __autoplay: true,
            })
          }}
        />
      )}

      {/* Subtitle style sheet — applied globally so video.js text-track
          cue elements pick up size/position/background overrides. The
          CSS variables let one declaration drive every cue rendered
          anywhere in the app. */}
      {/* Subtitle styling — applied globally so video.js TextTrack
          cues pick it up everywhere. v1.7.5 rewrite: switched from
          percentage-based font-size (which compounds onto video.js's
          already-tiny intrinsic baseline — 140% of "tiny" is still
          "tiny") to PIXEL-BASED sizing scaled from a 22px baseline.
          So `subStyle.size` 100 → 22px, 140 → 30.8px, 200 → 44px.
          22px is roughly the Netflix/Stremio default size at 1080p
          viewing distance — readable for everyone, including users
          with low-vision presets, without an obvious "huge subtitle"
          look at the top of the slider. */}
      <style>{`
        .vjs-text-track-cue,
        .vjs-text-track-cue * {
          font-size: calc(22px * ${subStyle.size} / 100) !important;
          line-height: 1.25 !important;
          font-weight: ${subStyle.weight === 'bold' ? '700' : '500'} !important;
          ${subStyle.bg === 'box'
            ? 'background-color: rgba(0,0,0,0.78) !important; padding: 0.15em 0.5em !important; border-radius: 4px !important; text-shadow: none !important;'
            : subStyle.bg === 'none'
              ? 'background-color: transparent !important; text-shadow: none !important;'
              : /* shadow (default) — heavier, sharper outline so
                   subs read against bright/light backdrops */
                'background-color: transparent !important; text-shadow: 0 0 4px rgba(0,0,0,0.95), 1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9), 1px -1px 2px rgba(0,0,0,0.9), -1px 1px 2px rgba(0,0,0,0.9) !important;'}
        }
        .vjs-text-track-display {
          bottom: ${subStyle.position}% !important;
        }
      `}</style>

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {debugOpen && (
        <DebugOverlay
          source={source}
          sourceType={sourceType}
          streamInfoHash={streamInfoHash}
          streamDuration={streamDuration}
          streamBaseUrl={streamBaseUrl}
          probedVcodec={probedVcodec}
          remuxStage={remuxFallbackRef.current || 0}
          playbackError={playbackError}
          streamWarning={streamWarning}
          appVersion={appVersion}
          serverHealthy={serverHealthy}
          audioTracks={audioTracks}
          activeAudioIdx={activeAudioIdx}
          streamProgress={streamProgress}
          onClose={() => setDebugOpen(false)}
        />
      )}
    </div>
  )
}

export default App
