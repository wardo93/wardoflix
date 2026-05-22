// React + storage / util / overlay imports the modal needs at runtime.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  isInLibrary, addToLibrary, removeFromLibrary,
  isWatched, markWatched, unmarkWatched,
  readQualityPref, saveQualityPref, sortByQualityPref,
  resumeKey, loadResumeMap,
} from '../lib/storage.js'
import { inferType, seedHealth, seedHealthLabel } from '../lib/util.js'
import { toast } from './Overlays.jsx'

// ── Detail Modal ────────────────────────────────────────────────
export function DetailModal({ item, onClose, onStream, onSelectItem }) {
  const [input, setInput] = useState('')
  const [torrents, setTorrents] = useState([])
  const [bySeason, setBySeason] = useState({})
  const [seasons, setSeasons] = useState([])
  const [selectedSeason, setSelectedSeason] = useState('1')
  const [episodeStills, setEpisodeStills] = useState({})
  const [torrentsLoading, setTorrentsLoading] = useState(true)
  // Rich details: trailer, cast, similar titles (Stremio-parity)
  const [details, setDetails] = useState(null)
  const [showTrailer, setShowTrailer] = useState(false)
  // Live "is this item in the library" flag, recalculated whenever the
  // library list mutates (via the broadcast event) so the bookmark
  // button toggles instantly without a remount.
  const [libraryEntryPresent, setLibraryEntryPresent] = useState(() => isInLibrary(item))
  useEffect(() => {
    const sync = () => setLibraryEntryPresent(isInLibrary(item))
    sync()
    window.addEventListener('wardoflix:library-updated', sync)
    return () => window.removeEventListener('wardoflix:library-updated', sync)
  }, [item])
  // Detect TV with a heuristic fallback so a missing `type` field can't
  // silently downgrade a series into a movie (which renders a flat
  // torrent list instead of the episode picker). Regression fix for
  // "click series from homepage, see movie-style sources" — the prop
  // chain is correct but defence-in-depth covers similar-cards, genre
  // grid, and stale history entries where the field sometimes drops.
  const itemType = inferType(item)
  const isTv = itemType === 'tv'

  // Episode thumbnails (still images + name + air date) per selected
  // season. Fetched from /api/episodes/:tmdbId/:season on demand —
  // server-side cached for 6h so changing season is fast after the
  // first hit. Indexed by episode number for O(1) lookup in the
  // existing episode-button render loop. Declared AFTER isTv so the
  // effect's deps array doesn't TDZ at module evaluation (which is
  // exactly the bug v1.6.0 shipped with — black screen on every
  // launch because this useEffect ran before isTv was initialised).
  useEffect(() => {
    if (!isTv || !item?.id || !selectedSeason) { setEpisodeStills({}); return }
    let cancelled = false
    fetch(`/api/episodes/${item.id}/${selectedSeason}`)
      .then((r) => r.ok ? r.json() : { episodes: [] })
      .then((d) => {
        if (cancelled) return
        const map = {}
        for (const e of (d.episodes || [])) map[e.number] = e
        setEpisodeStills(map)
      })
      .catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, selectedSeason, isTv])

  // Watched flags live in localStorage and change out-of-band (when
  // the player hits the end of an episode). Bump a tick on the
  // broadcast event so isWatched() reads below re-evaluate without
  // having to mirror the whole watched map into React state.
  const [watchedTick, setWatchedTick] = useState(0)
  useEffect(() => {
    const onTick = () => setWatchedTick((v) => v + 1)
    window.addEventListener('wardoflix:watched-updated', onTick)
    return () => window.removeEventListener('wardoflix:watched-updated', onTick)
  }, [])
  // Touch the tick so lint knows the dep tracks, and so future
  // refactors don't accidentally elide the re-render trigger.
  void watchedTick

  useEffect(() => {
    if (!item) return
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (showTrailer) setShowTrailer(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [item, onClose, showTrailer])

  // v1.11.0 — abort controller stored on ref so loadTorrents can cancel
  // any in-flight previous fetch. Without this, a rapid item-switch
  // (user clicks one title, then another before the first /api/torrents
  // call returns) would let the older request's resolution overwrite
  // the newer item's torrents — manifesting as "wrong torrents for
  // the title I clicked." Same class of bug as the profile-switch
  // AbortController gap flagged in the audit.
  const torrentsAbortRef = useRef(null)

  // Extracted so "retry" button can re-fire the exact same request.
  const loadTorrents = useCallback(() => {
    if (!item) return
    try { torrentsAbortRef.current?.abort() } catch {}
    const ctl = new AbortController()
    torrentsAbortRef.current = ctl
    setTorrents([])
    setBySeason({})
    setSeasons([])
    setSelectedSeason('1')
    setTorrentsLoading(true)

    // Use the inferred type (not raw item.type) so the server searches
    // the right catalog when the field is missing — otherwise a TV
    // show without an explicit `type` would trigger a movie torrent
    // lookup and mask the bug we just fixed at the UI layer.
    const params = new URLSearchParams({ title: item.title, type: itemType })
    if (item.date) params.set('year', item.date?.slice?.(0, 4) || '')
    if (item.id) params.set('tmdbId', String(item.id))
    fetch(`/api/torrents?${params}`, { signal: ctl.signal })
      .then((r) => r.json().catch(() => ({ torrents: [] })))
      .then((data) => {
        if (ctl.signal.aborted) return
        // Apply the user's per-title quality preference. The server
        // returns torrents sorted by seed count; we re-sort so the
        // preferred quality bubbles to the top, but ties (no
        // preference, or preference doesn't match anything) preserve
        // the seed-count ordering.
        const pref = readQualityPref(item.id)
        setTorrents(sortByQualityPref(data.torrents || [], pref))
        setBySeason(data.bySeason || {})
        const s = data.seasons || []
        setSeasons(s)
        if (s.length && !s.includes(selectedSeason)) setSelectedSeason(String(s[0]))
      })
      .catch((err) => {
        // AbortError is expected on rapid switches — don't clobber state.
        if (err?.name === 'AbortError') return
        setTorrents([])
      })
      .finally(() => {
        if (!ctl.signal.aborted) setTorrentsLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item])

  useEffect(() => {
    if (!item) return
    setDetails(null)
    setShowTrailer(false)
    loadTorrents()

    // Parallel: TMDB details (trailer + cast + similar). Best-effort —
    // if TMDB is down or the endpoint fails, the modal still works.
    // v1.11.1 — gated by an AbortController so a quick close
    // doesn't trigger setState-on-unmounted warnings or leak the
    // resolution onto a dead component.
    const detailsCtl = new AbortController()
    if (item.id) {
      // Use the inferred type so details (trailer/cast/similar) hit
      // the right TMDB endpoint even when `item.type` is missing.
      fetch(`/api/details/${itemType}/${item.id}`, { signal: detailsCtl.signal })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d && !detailsCtl.signal.aborted) setDetails(d) })
        .catch(() => {})
    }

    // v1.11.1 — unmount cleanup. Without this, the loadTorrents call
    // above (which goes through torrentsAbortRef) would keep
    // resolving onto a torn-down component when the user closes the
    // modal mid-fetch. Aborting on unmount turns that .then()
    // continuation into an AbortError which the catch swallows.
    return () => {
      try { torrentsAbortRef.current?.abort() } catch {}
      try { detailsCtl.abort() } catch {}
    }
  }, [item, loadTorrents])

  const [resolvingEpisode, setResolvingEpisode] = useState(null) // "s:e" string

  // Gather the fallback chain for the magnet the user clicked. We pass
  // this to the outer handleStream so that if the chosen torrent has no
  // seeders, the player can silently retry the next-best source instead
  // of stranding the user at "no stream found". For TV the alternatives
  // are all torrents matching that specific season/episode, sorted by
  // seeds desc; for movies it's every known torrent for the title.
  const buildAlternatives = useCallback((pickedMagnet, episodeMeta) => {
    if (!pickedMagnet) return []
    let pool = torrents || []
    if (isTv && episodeMeta?.season != null && episodeMeta?.episode != null) {
      const s = Number(episodeMeta.season)
      const e = Number(episodeMeta.episode)
      pool = pool.filter((t) => Number(t.season) === s && Number(t.episode) === e)
    }
    return pool
      .filter((t) => t?.magnet && t.magnet !== pickedMagnet)
      .sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
      .slice(0, 8) // cap the chain so we don't loop forever on truly dead titles
      .map((t) => ({
        magnet: t.magnet,
        quality: t.quality || '',
        seeds: t.seeds || 0,
        size: t.size || '',
      }))
  }, [torrents, isTv])

  const handleStream = (urlOrMagnet, episodeMeta) => {
    const t = (urlOrMagnet || input).trim()
    if (t) {
      // Pass the whole episode list so the player can autoplay the next one.
      // Only attach for TV titles (otherwise it's just dead weight).
      const playlist = isTv && Object.keys(bySeason).length
        ? { bySeason, seasons }
        : null
      // TMDB runtime (minutes) — used by the player as a duration fallback
      // until ffprobe resolves, so the scrubber shows the real length
      // instead of just the buffered portion.
      const runtime = isTv
        ? (details?.episode_run_time?.[0] || details?.runtime || null)
        : (details?.runtime || null)
      const alternatives = buildAlternatives(t, episodeMeta)
      onStream(t, { ...item, ...episodeMeta, playlist, runtime, alternatives })
      onClose()
    }
  }

  // On-demand search for a single episode — fired when the user clicks an
  // episode that didn't have a torrent in the initial sweep. Stremio-style:
  // list every episode always, find the stream when clicked. Retries once
  // automatically on empty result (Torrentio occasionally rate-limits).
  const handleUnavailableEpisode = async (ep) => {
    const key = `${ep.season}:${ep.episode}`
    if (resolvingEpisode) return
    setResolvingEpisode(key)
    try {
      const params = new URLSearchParams({
        title: item.title,
        season: String(ep.season),
        episode: String(ep.episode),
      })
      if (item.imdbId) params.set('imdbId', item.imdbId)
      if (item.id) params.set('tmdbId', String(item.id))

      const tryFetch = async () => {
        const r = await fetch(`/api/torrent-episode?${params}`)
        if (!r.ok) {
          console.error(`[episode] /api/torrent-episode returned ${r.status}`)
          return null
        }
        const j = await r.json().catch(() => null)
        return j
      }

      let j = await tryFetch()
      // Retry once if empty — Torrentio sometimes drops the first hit
      if (!j || !(j.torrents || []).length) {
        console.warn(`[episode] empty result, retrying S${ep.season}E${ep.episode}`)
        await new Promise((r) => setTimeout(r, 1200))
        j = await tryFetch()
      }

      const found = (j?.torrents || []).filter((t) => t?.magnet)
      // Sort the discovered list by seeds desc and pass the full tail as
      // a fallback chain. If the "best" one turns out to be dead, the
      // player can silently retry the next-best without a user round-trip.
      found.sort((a, b) => (b.seeds || 0) - (a.seeds || 0))
      const best = found[0]
      if (best && best.magnet) {
        console.log(`[episode] S${ep.season}E${ep.episode} → ${best.quality} ${best.seeds}s ${best.size} (+ ${Math.max(0, found.length - 1)} fallbacks)`)
        // Overlay into bySeason so subsequent autoplay works
        const sKey = String(ep.season)
        const newBy = { ...bySeason }
        newBy[sKey] = (newBy[sKey] || []).map((x) =>
          x.episode === ep.episode ? { ...best, unavailable: false } : x
        )
        setBySeason(newBy)
        const alternatives = found.slice(1, 9).map((t) => ({
          magnet: t.magnet,
          quality: t.quality || '',
          seeds: t.seeds || 0,
          size: t.size || '',
        }))
        const playlist = isTv && Object.keys(bySeason).length ? { bySeason: newBy, seasons } : null
        const runtime = isTv
          ? (details?.episode_run_time?.[0] || details?.runtime || null)
          : (details?.runtime || null)
        onStream(best.magnet, { ...item, season: ep.season, episode: ep.episode, playlist, runtime, alternatives })
        onClose()
      } else {
        console.error(`[episode] No sources for S${ep.season}E${ep.episode}. Response:`, j)
        toast(
          `No source found for S${ep.season}E${ep.episode}. Torrentio may be rate-limiting — wait 30 s and try again.`,
          'warning',
          { title: 'No sources yet' }
        )
      }
    } catch (err) {
      console.error(`[episode] fetch failed:`, err)
      toast(`Could not reach the stream source server: ${err.message}`, 'error', { title: 'Source lookup failed' })
    } finally {
      setResolvingEpisode(null)
    }
  }

  // Episode list = the union of (a) torrent placeholders the server seeded
  // from `tv/{id}.seasons[].episode_count` and (b) actual episodes TMDB
  // returned for this specific season at /api/episodes/{id}/{season}.
  // The summary count is sometimes stale (TMDB reports e.g. "8 episodes"
  // when the per-season endpoint actually has 10 — common during ongoing
  // shows or when a season's metadata was just refreshed). v1.7.2 fix:
  // fill any gap so every episode TMDB knows about is clickable. Missing
  // entries get an `unavailable: true` placeholder; the per-click
  // /api/torrent-episode lookup will still find sources for them.
  const episodeList = useMemo(() => {
    if (!isTv || !seasons.length) return []
    const placeholders = bySeason[selectedSeason] || []
    const stillsKeys = Object.keys(episodeStills).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    const maxStillEp = stillsKeys.length ? Math.max(...stillsKeys) : 0
    const maxPlaceholderEp = placeholders.length
      ? Math.max(...placeholders.map((p) => Number(p.episode) || 0))
      : 0
    const total = Math.max(maxStillEp, maxPlaceholderEp, placeholders.length)
    if (total === 0) return placeholders

    // Build a map from episode number to the existing placeholder, so we
    // can keep any data the server already attached (quality, magnet,
    // unavailable flag) and only synthesise the truly missing slots.
    const byEp = new Map()
    for (const p of placeholders) {
      const n = Number(p.episode)
      if (Number.isFinite(n) && n > 0) byEp.set(n, p)
    }

    const out = []
    for (let e = 1; e <= total; e++) {
      const existing = byEp.get(e)
      if (existing) { out.push(existing); continue }
      // Synthesised placeholder for an episode the server's bySeason
      // didn't include. The user can still click it; the per-episode
      // torrent lookup runs at click-time, no different from any
      // unavailable slot the server seeded itself.
      out.push({
        season: Number(selectedSeason),
        episode: e,
        quality: `S${String(selectedSeason).padStart(2, '0')}E${String(e).padStart(2, '0')}`,
        seeds: 0,
        size: '',
        magnet: null,
        unavailable: true,
      })
    }
    return out
  }, [bySeason, selectedSeason, episodeStills, isTv, seasons])
  // Only fall through to "flat torrent list" for actual movies. A TV show
  // with no seasons yet is still a TV show — show a loading/retry state,
  // not the single-source movie layout. Fixes "Game of Thrones shows like
  // a movie" when the TMDB tv/ meta fetch was slow/rate-limited.
  const showFlatList = !isTv
  const showEpisodesLoading = isTv && !seasons.length

  if (!item) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {item.backdrop && (
          <div className="modal-hero">
            <img src={item.backdrop} alt="" />
            <div className="modal-hero-gradient" />
          </div>
        )}
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div className="modal-body">
          <div className="modal-header">
            <h2>{item.title}</h2>
            <div className="modal-meta-row">
              {item.rating > 0 && <span className="modal-rating">★ {item.rating.toFixed(1)}</span>}
              {item.date && <span className="modal-year">{String(item.date).split('-')[0]}</span>}
              {details?.runtime && <span className="modal-year">{details.runtime} min</span>}
              {details?.genres?.slice(0, 3).map((g) => (
                <span key={g} className="modal-genre">{g}</span>
              ))}
              {details?.videos?.[0] && (
                <button className="modal-trailer-btn" onClick={() => setShowTrailer(true)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  Watch Trailer
                </button>
              )}
              {/* Library toggle — Stremio-style "save for later". State
                  reflects in real time via the wardoflix:library-updated
                  event broadcast from add/remove. */}
              <button
                className={`modal-trailer-btn ${libraryEntryPresent ? 'is-in-library' : ''}`}
                onClick={() => {
                  if (libraryEntryPresent) removeFromLibrary(item)
                  else addToLibrary(item)
                }}
                title={libraryEntryPresent ? 'Remove from your library' : 'Save to your library'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  {libraryEntryPresent
                    ? <path d="M5 3a2 2 0 0 0-2 2v17l9-4 9 4V5a2 2 0 0 0-2-2H5z" />
                    : <path d="M5 3a2 2 0 0 0-2 2v17l9-4 9 4V5a2 2 0 0 0-2-2H5zm0 2h14v15.07l-7-3.11-7 3.11V5z" />}
                </svg>
                {libraryEntryPresent ? 'In your library' : 'Add to library'}
              </button>
              {/* Random Episode — Popcorn-Time-style discovery for
                  long-running shows where any episode is a good
                  watch (Simpsons, Family Guy, Seinfeld, sitcoms in
                  general). Picks a uniformly random season+episode
                  from the loaded bySeason map and resolves its source
                  through the same handleUnavailableEpisode flow as a
                  manual click — so it doesn't matter whether the
                  picked episode had a torrent in the initial sweep. */}
              {isTv && Object.keys(bySeason).length > 0 && (
                <button
                  className="modal-trailer-btn modal-random-ep"
                  onClick={() => {
                    const validSeasons = Object.keys(bySeason)
                      .filter((s) => s !== '0' && (bySeason[s]?.length || 0) > 0)
                    if (!validSeasons.length) return
                    const sNum = validSeasons[Math.floor(Math.random() * validSeasons.length)]
                    const eps = bySeason[sNum] || []
                    if (!eps.length) return
                    const ep = eps[Math.floor(Math.random() * eps.length)]
                    if (!ep) return
                    // If the episode already has a magnet from the
                    // server-side sweep, stream it directly. Otherwise
                    // route through the on-demand resolver.
                    if (ep.magnet) {
                      if (item?.id && ep.quality) saveQualityPref(item.id, ep.quality)
                      handleStream(ep.magnet, { season: ep.season, episode: ep.episode })
                    } else {
                      handleUnavailableEpisode({ season: Number(ep.season), episode: Number(ep.episode) })
                    }
                  }}
                  title="Pick a random episode for me"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M3 3h6v6H3V3zm0 12h6v6H3v-6zm12 0h6v6h-6v-6zM15 3h6v6h-6V3z" />
                    <circle cx="6" cy="6" r="1.4" fill="var(--bg-deep, #120a04)" />
                    <circle cx="18" cy="6" r="1.4" fill="var(--bg-deep, #120a04)" />
                    <circle cx="6" cy="18" r="1.4" fill="var(--bg-deep, #120a04)" />
                    <circle cx="18" cy="18" r="1.4" fill="var(--bg-deep, #120a04)" />
                  </svg>
                  Random Episode
                </button>
              )}
            </div>
            {details?.tagline && <p className="modal-tagline">"{details.tagline}"</p>}
            {item.overview && <p className="modal-overview">{item.overview}</p>}
            {details?.crew?.length > 0 && (
              <p className="modal-credits">
                {details.crew.slice(0, 3).map((c) => (
                  <span key={c.id}><strong>{c.job}:</strong> {c.name}</span>
                ))}
              </p>
            )}
          </div>

          <div className="modal-streams">
            <h3>{isTv ? 'Episodes' : 'Available Sources'}</h3>
            {torrentsLoading ? (
              <div className="torrents-loading"><span className="spinner" /><span>Searching for sources...</span></div>
            ) : isTv && seasons.length > 0 ? (
              <>
                <div className="season-selector">
                  <select value={selectedSeason} onChange={(e) => setSelectedSeason(e.target.value)} className="season-select">
                    {seasons.filter((s) => s !== '0').map((s) => <option key={s} value={s}>Season {s}</option>)}
                    {seasons.includes('0') && <option value="0">Other</option>}
                  </select>
                </div>
                <div className="episodes-list">
                  {episodeList.length > 0 ? episodeList.map((t, i) => {
                    const epNum = t.episode || i + 1
                    const epKey = `${t.season || selectedSeason}:${epNum}`
                    const isResolving = resolvingEpisode === epKey
                    const hasMagnet = !!t.magnet
                    // Watched flag is scoped by the containing show +
                    // season/episode, so we build a minimal meta that
                    // matches resumeKey()'s expectations.
                    const watched = isWatched({ id: item?.id, title: item?.title, season: Number(t.season || selectedSeason), episode: epNum })
                    const epMeta = { id: item?.id, title: item?.title, season: Number(t.season || selectedSeason), episode: epNum }
                    return (
                      <button
                        key={i}
                        className={`source-btn ${watched ? 'source-btn--watched' : ''}`}
                        data-watched={watched ? 'yes' : 'no'}
                        title={watched ? 'Watched — Shift+click to unmark' : 'Click to play · Shift+click to mark watched'}
                        onClick={(e) => {
                          // Shift+click toggles watched state without
                          // playing — discoverable via the title tooltip
                          // and the keyboard-shortcuts panel.
                          if (e.shiftKey) {
                            e.preventDefault()
                            if (watched) unmarkWatched(epMeta)
                            else markWatched(epMeta)
                            return
                          }
                          if (isResolving) return
                          // Save quality pref keyed on the SHOW id so
                          // every episode picker remembers the same
                          // preference for the series.
                          if (item?.id && t.quality) saveQualityPref(item.id, t.quality)
                          if (hasMagnet) handleStream(t.magnet, { season: selectedSeason, episode: epNum })
                          else handleUnavailableEpisode({ season: Number(t.season || selectedSeason), episode: epNum })
                        }}
                      >
                        {/* Episode still — TMDB-provided thumbnail.
                            Falls back to a gradient placeholder when
                            the episode hasn't aired yet (no still
                            published) or the show is too obscure. */}
                        {episodeStills[epNum]?.still ? (
                          <img className="source-ep-still" src={episodeStills[epNum].still} alt="" loading="lazy" />
                        ) : (
                          <div className="source-ep-still source-ep-still--placeholder" />
                        )}
                        <div className="source-ep-meta">
                          <span className="source-ep">E{String(epNum).padStart(2, '0')}</span>
                          {/* Always render a name. TMDB sometimes returns
                              an episode without a `name` (placeholder),
                              and synthesised slots from the v1.7.2
                              episode-list-fill have no entry in
                              episodeStills at all. Fall through to a
                              generic "Episode N" so the row never
                              renders just a still + number with no
                              human-readable label. */}
                          <span className="source-ep-name">
                            {episodeStills[epNum]?.name || `Episode ${epNum}`}
                          </span>
                          {watched && (
                            <span className="source-watched" title="Watched" aria-label="Watched">
                              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                          {hasMagnet && <span className="source-quality">{t.quality}</span>}
                          {hasMagnet && (
                            <span
                              className={`source-seeds source-seeds--${seedHealth(t.seeds)}`}
                              title={seedHealthLabel(t.seeds)}
                            >
                              <span className="source-seeds-dot" />
                              {t.seeds || 0} seeds
                            </span>
                          )}
                          {hasMagnet && t.size && <span className="source-size">{t.size}</span>}
                          {!hasMagnet && !isResolving && <span className="source-quality source-quality--ghost">Click to play</span>}
                          {isResolving && <span className="source-quality source-quality--ghost">Finding source…</span>}
                        </div>
                      </button>
                    )
                  }) : <p className="no-sources">No episodes for this season.</p>}
                </div>
              </>
            ) : showFlatList && torrents.length > 0 ? (
              <div className="sources-list">
                {torrents.slice(0, 12).map((t, i) => (
                  <button key={i} className="source-btn" onClick={() => {
                    // Remember this quality so next time we open this
                    // title, the picker pre-sorts to it.
                    if (item?.id && t.quality) saveQualityPref(item.id, t.quality)
                    handleStream(t.magnet)
                  }}>
                    <span className="source-quality">{t.quality}</span>
                    <span
                      className={`source-seeds source-seeds--${seedHealth(t.seeds)}`}
                      title={seedHealthLabel(t.seeds)}
                    >
                      <span className="source-seeds-dot" />
                      {t.seeds || 0} seeds
                    </span>
                    {t.size && <span className="source-size">{t.size}</span>}
                  </button>
                ))}
              </div>
            ) : showEpisodesLoading ? (
              // TV show with empty season list — the TMDB tv/ meta fetch
              // failed or was rate-limited. Show a retry button rather than
              // silently falling through to the flat movie layout.
              <div className="episodes-empty">
                <p className="no-sources">Couldn't load the episode list for this show. Retry?</p>
                <button className="btn btn-accent" onClick={loadTorrents}>Retry</button>
              </div>
            ) : (
              <p className="no-sources">No sources found. Paste a magnet link below.</p>
            )}

            {/* Manual-stream input — fallback for when auto-discovery
                turns up nothing. Hidden when the modal already has
                playable sources (TV episodes or movie torrents),
                otherwise it crowds the cast row with a redundant input
                bar that the user never wanted to see. Still surfaces
                during loading-failure ("retry?" branch) so a frustrated
                user has an immediate manual escape hatch. */}
            {!torrentsLoading
              && !(isTv && seasons.length > 0)
              && !(showFlatList && torrents.length > 0) && (
              <div className="manual-stream">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleStream()}
                  placeholder="Paste magnet link or URL..."
                />
                <button className="btn btn-accent" onClick={() => handleStream()}>Stream</button>
              </div>
            )}
          </div>

          {details?.cast?.length > 0 && (
            <div className="modal-cast">
              <h3>Cast</h3>
              <div className="cast-rail">
                {details.cast.map((c) => (
                  <button
                    key={c.id}
                    className="cast-card"
                    title={`Search for other titles with ${c.name}`}
                    onClick={() => {
                      // Click an actor → trigger a search for their
                      // name. The Browse page reads the global search
                      // query and renders matching titles, so this
                      // surfaces every co-starring movie/show TMDB has
                      // for the actor without a dedicated filmography
                      // endpoint. Closes the current modal so the
                      // search results aren't hidden behind it.
                      window.dispatchEvent(new CustomEvent('wardoflix:search-for', { detail: { query: c.name } }))
                      onClose()
                    }}
                  >
                    <div className="cast-avatar">
                      {c.profile
                        ? <img src={c.profile} alt={c.name} loading="lazy" />
                        : <span className="cast-avatar-placeholder">{c.name?.[0] || '?'}</span>}
                    </div>
                    <div className="cast-name">{c.name}</div>
                    <div className="cast-char">{c.character}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {details?.similar?.length > 0 && (
            <div className="modal-similar">
              <h3>More Like This</h3>
              <div className="similar-rail">
                {details.similar.map((s) => (
                  <button
                    key={s.id}
                    className="similar-card"
                    onClick={() => {
                      if (onSelectItem) {
                        // Rebuild a full item object for the next modal
                        onSelectItem({
                          id: s.id,
                          title: s.title,
                          type: s.type,
                          date: s.year,
                          rating: s.rating,
                          poster: s.poster,
                          backdrop: s.poster, // no backdrop from similar
                        })
                      }
                    }}
                  >
                    {s.poster
                      ? <img src={s.poster} alt={s.title} loading="lazy" />
                      : <div className="similar-poster-placeholder">{s.title}</div>}
                    <div className="similar-meta">
                      <div className="similar-title">{s.title}</div>
                      <div className="similar-sub">
                        {s.year && <span>{s.year}</span>}
                        {s.rating > 0 && <span>★ {s.rating.toFixed(1)}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Trailer overlay — YouTube embed via our own /trailer wrapper.
            Under packaged Electron the renderer runs from file:// and YouTube
            refuses to embed (null origin). Routing the iframe through the
            local http server gives it a real http parent so the embed works. */}
        {showTrailer && details?.videos?.[0] && (
          <div className="trailer-overlay" onClick={() => setShowTrailer(false)}>
            <button className="trailer-close" onClick={() => setShowTrailer(false)} aria-label="Close trailer">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div className="trailer-frame" onClick={(e) => e.stopPropagation()}>
              <iframe
                src={`${window.__API_BASE__ || ''}/trailer?v=${encodeURIComponent(details.videos[0].key)}`}
                title={details.videos[0].name}
                frameBorder="0"
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
