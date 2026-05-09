// Single poster card. Renders an image; on hover (with a 1.2s dwell
// gate), fetches the title's YouTube trailer key and overlays an
// embedded preview. Optional rank prop renders a giant Netflix-style
// numeral behind the card; optional progress prop adds a Continue
// Watching strip across the bottom.
//
// Extracted from App.jsx in v1.7.0. Self-contained — depends only on
// the trailer-key API endpoint and the toAbsStreamUrl helper.

import { useState, useRef, useEffect } from 'react'

// ── Session-wide hover-trailer audio toggle ──
// Default off (most users browse silently while music plays elsewhere);
// a small speaker icon on each playing trailer lets the user flip it.
// The choice persists across reloads via localStorage. We read once at
// module-init time so there's no flash of the wrong state on first
// hover, and store as a module-level mutable so all PosterCards stay
// in sync without a cross-tree React context for what is, in the end,
// one boolean.
let _previewAudio = (() => {
  try { return localStorage.getItem('wardoflix:preview-audio') === '1' } catch { return false }
})()
const _previewAudioListeners = new Set()

function setPreviewAudio(v) {
  _previewAudio = !!v
  try { localStorage.setItem('wardoflix:preview-audio', _previewAudio ? '1' : '0') } catch {}
  for (const l of _previewAudioListeners) {
    try { l(_previewAudio) } catch {}
  }
}

function usePreviewAudio() {
  const [v, setV] = useState(_previewAudio)
  useEffect(() => {
    _previewAudioListeners.add(setV)
    return () => { _previewAudioListeners.delete(setV) }
  }, [])
  return [v, setPreviewAudio]
}

export function PosterCard({ item, type, onSelect, rank, progress }) {
  const [hover, setHover] = useState('idle') // idle | pending | playing
  const [trailerKey, setTrailerKey] = useState(null)
  const [previewAudio, setPreviewAudioState] = usePreviewAudio()
  const dwellRef = useRef(null)

  const enter = () => {
    if (hover !== 'idle') return
    setHover('pending')
    dwellRef.current = setTimeout(async () => {
      // Already fetched? Skip the network roundtrip.
      if (trailerKey) { setHover('playing'); return }
      try {
        // Prefix with __API_BASE__ — required in packaged Electron
        // where the renderer runs from file:// and a bare /api/...
        // path resolves to file:///api/... and 404s.
        const apiBase = (typeof window !== 'undefined' && window.__API_BASE__) || ''
        const r = await fetch(`${apiBase}/api/trailer-key/${type}/${item.id}`)
        const data = await r.json().catch(() => ({}))
        if (data.key) {
          setTrailerKey(data.key)
          setHover('playing')
        } else {
          setHover('idle') // no trailer for this title
        }
      } catch { setHover('idle') }
    }, 1200)
  }
  const leave = () => {
    if (dwellRef.current) { clearTimeout(dwellRef.current); dwellRef.current = null }
    setHover('idle')
  }
  // Cleanup on unmount so a card scrolling out mid-dwell doesn't fire
  // a fetch into a dead component.
  useEffect(() => () => { if (dwellRef.current) clearTimeout(dwellRef.current) }, [])

  const apiBase = (typeof window !== 'undefined' && window.__API_BASE__) || ''

  // The poster button itself. We render it inside a wrapper when ranked
  // so the giant Top-10 numeral can live as a SIBLING (not a child) —
  // .row-poster has overflow:hidden for image rounding, which would
  // otherwise clip the numeral despite its negative left offset.
  const card = (
    <button
      className={`row-poster ${hover === 'playing' ? 'row-poster--previewing' : ''}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
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
        <img src={item.poster_path} alt="" loading="lazy" />
      ) : (
        <div className="poster-placeholder">{(item.title || item.name || '?')[0]}</div>
      )}
      {/* Hover trailer overlay. autoplay is required either way; mute
          is toggled by the per-session preview-audio setting. The
          iframe gets a key tied to the audio state so toggling forces
          a remount with the new mute parameter; YouTube doesn't expose
          a postMessage API on the nocookie embed so we can't flip mute
          without reloading. Brief flicker is acceptable for a feature
          the user explicitly invoked. */}
      {hover === 'playing' && trailerKey && (
        <iframe
          key={previewAudio ? 'on' : 'off'}
          className="row-poster-trailer"
          src={`${apiBase}/trailer?v=${trailerKey}&autoplay=1&mute=${previewAudio ? 0 : 1}&controls=0&modestbranding=1&playsinline=1`}
          title="Trailer preview"
          allow="autoplay; encrypted-media"
          loading="lazy"
        />
      )}
      {/* Floating mute toggle — only visible while a trailer is
          actively playing. role="button" + tabIndex on a span instead
          of a real <button> because nesting buttons is invalid HTML
          (the parent .row-poster is itself a button). stopPropagation
          prevents the toggle from also opening the detail modal. */}
      {hover === 'playing' && trailerKey && (
        <span
          role="button"
          tabIndex={0}
          aria-label={previewAudio ? 'Mute trailer preview' : 'Unmute trailer preview'}
          title={previewAudio ? 'Mute preview audio' : 'Unmute preview audio'}
          className="row-poster-trailer-audio"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setPreviewAudioState(!previewAudio)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              setPreviewAudioState(!previewAudio)
            }
          }}
        >
          {previewAudio ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          )}
        </span>
      )}
      {typeof progress === 'number' && progress > 0 && (
        <div className="row-poster-progress" aria-hidden="true">
          <div className="row-poster-progress-bar" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
      <div className="row-poster-info">
        <span className="row-poster-title">{item.title || item.name}</span>
        {item.vote_average > 0 && <span className="row-poster-rating">★ {item.vote_average.toFixed(1)}</span>}
      </div>
    </button>
  )

  if (!rank) return card
  // Top-10 row: wrap the button so the numeral can sit OUTSIDE the
  // button's clipped box. Keeps the poster's natural 2:3 aspect ratio
  // intact; the numeral peeks out to the left, classic Netflix look.
  return (
    <div className="row-poster-cell row-poster-cell--ranked">
      <span className="row-poster-rank" aria-hidden="true">{rank}</span>
      {card}
    </div>
  )
}
