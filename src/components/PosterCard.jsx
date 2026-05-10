// Single poster card. Renders an image; on hover (with a 1.2s dwell
// gate), fetches the title's YouTube trailer key and shows a larger
// floating preview popup with the trailer at proper 16:9 aspect ratio
// + closed captions on. Optional rank prop renders a giant Netflix-
// style numeral behind the card; optional progress prop adds a
// Continue Watching strip across the bottom.
//
// v1.7.7: replaced the v1.7.0 in-card iframe overlay (which squashed
// the 16:9 trailer into the 2:3 poster shape, producing big black
// bars) with a fixed-position popup portaled to <body>. Always muted,
// captions auto-enabled, sized to fit the trailer's natural aspect
// ratio. Removed the per-session preview-audio toggle — silent is
// the only mode now.

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

// Preview popup geometry. 480×270 = 16:9 at a comfortable size for a
// hover preview — large enough to actually see what's happening, small
// enough that it doesn't dominate the page or block the rest of the
// row from being browsed mid-preview.
const PREVIEW_W = 480
const PREVIEW_H = 270   // 480 × 9/16 = 270 — exact, no black bars
const PREVIEW_PAD = 12  // gap between poster and popup
const HIDE_DELAY_MS = 220 // grace period when mouse leaves poster, so
                          // the user can travel into the popup card
                          // (and back) without losing the preview

export function PosterCard({ item, type, onSelect, rank, progress }) {
  const [hover, setHover] = useState('idle') // idle | pending | playing
  const [trailerKey, setTrailerKey] = useState(null)
  const [popupRect, setPopupRect] = useState(null)
  const dwellRef = useRef(null)
  const hideTimerRef = useRef(null)
  const buttonRef = useRef(null)

  const apiBase = (typeof window !== 'undefined' && window.__API_BASE__) || ''

  // Cancel any pending hide. Called when the cursor enters the poster
  // OR the popup — both keep the preview alive.
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  // Schedule a hide after a grace period. Called when the cursor
  // leaves either the poster or the popup. The grace lets the user
  // travel between the two without flicker.
  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimerRef.current = setTimeout(() => {
      setHover('idle')
      if (dwellRef.current) {
        clearTimeout(dwellRef.current)
        dwellRef.current = null
      }
    }, HIDE_DELAY_MS)
  }, [cancelHide])

  const enter = useCallback(() => {
    cancelHide()
    if (hover === 'playing' || hover === 'pending') return
    setHover('pending')
    dwellRef.current = setTimeout(async () => {
      // Already fetched in this card's lifetime? Skip the network
      // roundtrip and just play.
      if (trailerKey) { setHover('playing'); return }
      try {
        // Prefix with __API_BASE__ — required in packaged Electron
        // where the renderer runs from file:// and a bare /api/...
        // path resolves to file:///api/... and 404s.
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
  }, [hover, trailerKey, apiBase, type, item.id, cancelHide])

  // Cleanup on unmount so a card scrolling out mid-dwell doesn't fire
  // a fetch (or a hide) into a dead component.
  useEffect(() => () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }, [])

  // Compute the popup's fixed-coordinate position relative to the
  // poster button. Re-runs on scroll/resize so the popup follows the
  // poster as the user scrubs through the row.
  useEffect(() => {
    if (hover !== 'playing' || !buttonRef.current) {
      setPopupRect(null)
      return
    }
    const compute = () => {
      const el = buttonRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Center horizontally on the poster, then clamp inside the
      // viewport with an 8px margin so the popup never bleeds off
      // the screen edge on the far left/right of a row.
      const centerX = r.left + r.width / 2
      const left = Math.max(8, Math.min(vw - PREVIEW_W - 8, centerX - PREVIEW_W / 2))
      // Prefer above the poster (cleaner — doesn't push the row
      // out of view). If there isn't enough room above the viewport
      // edge, fall through to below. If neither fits, prefer above
      // and let it be partially clipped (rare — only happens on
      // very short windows).
      const above = r.top - PREVIEW_H - PREVIEW_PAD
      const below = r.bottom + PREVIEW_PAD
      const top = above >= 8
        ? above
        : (below + PREVIEW_H <= vh - 8 ? below : Math.max(8, above))
      setPopupRect({ left, top })
    }
    compute()
    // Listen to scroll on every ancestor (capture: true) so the popup
    // tracks the poster while the row scrolls horizontally.
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [hover])

  // The poster button itself. We render it inside a wrapper when ranked
  // so the giant Top-10 numeral can live as a SIBLING (not a child) —
  // .row-poster has overflow:hidden for image rounding, which would
  // otherwise clip the numeral despite its negative left offset.
  const card = (
    <button
      ref={buttonRef}
      className={`row-poster ${hover === 'playing' ? 'row-poster--previewing' : ''}`}
      onMouseEnter={enter}
      onMouseLeave={scheduleHide}
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

  // Floating preview popup. Portaled to <body> so it escapes the
  // .row-poster overflow:hidden and the .row-posters horizontal-
  // scroll container. position:fixed with computed coordinates so
  // it tracks the poster on scroll/resize.
  //
  // YouTube embed flags:
  //   autoplay=1   — required for the preview to start without click
  //   mute=1       — silent always (user requirement, no toggle)
  //   controls=0   — hide the YT control chrome
  //   modestbranding=1 — minimise YouTube branding
  //   playsinline=1 — keep inline on mobile, no iOS fullscreen
  //   cc_load_policy=1 — auto-show captions when available
  //   hl=en        — interface + caption language preference
  //   cc_lang_pref=en — CC track language preference
  //   rel=0        — don't show "related videos" overlay at end
  const previewPopup = (hover === 'playing' && trailerKey && popupRect &&
    typeof document !== 'undefined') ? createPortal(
      <div
        className="poster-preview-popup"
        style={{
          left: popupRect.left,
          top: popupRect.top,
          width: PREVIEW_W,
          height: PREVIEW_H,
        }}
        // Keep the preview alive while the cursor is over the
        // popup — otherwise moving the mouse off the poster to
        // look at the trailer better would tear it down.
        onMouseEnter={cancelHide}
        onMouseLeave={scheduleHide}
        role="dialog"
        aria-label={`Trailer preview for ${item.title || item.name}`}
      >
        <iframe
          className="poster-preview-iframe"
          src={`${apiBase}/trailer?v=${trailerKey}&autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&cc_load_policy=1&hl=en&cc_lang_pref=en&rel=0`}
          title="Trailer preview"
          allow="autoplay; encrypted-media"
          loading="lazy"
        />
        {/* Title overlay at the bottom of the popup — sets context
            so the user knows what they're previewing without having
            to look back at the poster. Translucent so the trailer
            stays the focus. */}
        <div className="poster-preview-meta">
          <span className="poster-preview-title">{item.title || item.name}</span>
          {item.vote_average > 0 && (
            <span className="poster-preview-rating">★ {item.vote_average.toFixed(1)}</span>
          )}
        </div>
      </div>,
      document.body
  ) : null

  if (!rank) {
    return (
      <>
        {card}
        {previewPopup}
      </>
    )
  }
  // Top-10 row: wrap the button so the numeral can sit OUTSIDE the
  // button's clipped box. Keeps the poster's natural 2:3 aspect ratio
  // intact; the numeral peeks out to the left, classic Netflix look.
  return (
    <>
      <div className="row-poster-cell row-poster-cell--ranked">
        <span className="row-poster-rank" aria-hidden="true">{rank}</span>
        {card}
      </div>
      {previewPopup}
    </>
  )
}
