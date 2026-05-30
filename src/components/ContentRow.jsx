// Horizontal-scrolling poster row with a header and (optional) Top-10
// ranking numerals. Fetches its own catalog data from the URL prop;
// retries up to 3 times with exponential backoff to ride out a slow
// server boot. Renders nothing if the fetch turns up empty after
// retries — keeps the page clean instead of showing skeletons forever.
//
// Extracted from App.jsx in v1.7.0.

import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { PosterCard } from './PosterCard.jsx'
import { useHorizontalRowGestures } from '../lib/hooks.js'

// v1.7.9: wrapped in React.memo at the bottom of this file. Same
// rationale as PosterCard — the home page has 12+ rows on screen
// and each row was re-rendering on every parent state change.
function ContentRowInner({ title, url, type, onSelect, showRanking = false }) {
  const [items, setItems] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0) // bump to force refetch (currently unused but cheap to keep)
  const rowRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  // v1.13.0 — removed a duplicate useEdgeHoverScroll(rowRef) here;
  // useHorizontalRowGestures (below) already includes it. Two calls
  // meant two rAF scroll loops per row.

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    // Retry up to 3 times with exponential backoff. Covers the case
    // where the server was still chewing on a stream request and the
    // first catalog fetch came back empty.
    const tryFetch = async (attempts = 0) => {
      try {
        const r = await fetch(url)
        const d = await r.json().catch(() => ({}))
        const results = d.results || []
        if (cancelled) return
        if (results.length === 0 && attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 600 * (attempts + 1))
          return
        }
        setItems(results)
        setLoaded(true)
      } catch {
        if (cancelled) return
        if (attempts < 2) {
          setTimeout(() => { if (!cancelled) tryFetch(attempts + 1) }, 600 * (attempts + 1))
          return
        }
        setLoaded(true)
      }
    }
    tryFetch(0)
    return () => { cancelled = true }
  }, [url, attempt])

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
  }, [items, updateScrollState])

  useHorizontalRowGestures(rowRef, items)

  const scroll = (dir) => {
    const el = rowRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' })
  }

  if (!loaded || items.length === 0) return null

  // When the row is ranked (Top 10), cap to 10 — the numeral wouldn't
  // mean anything past that.
  const displayItems = showRanking ? items.slice(0, 10) : items

  return (
    <div className={`content-row ${showRanking ? 'content-row--ranked' : ''}`}>
      <h3 className="row-title">{title}</h3>
      <div className="row-container">
        {canScrollLeft && (
          <button className="row-arrow row-arrow--left" onClick={() => scroll(-1)} aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        )}
        <div className="row-posters" ref={rowRef}>
          {displayItems.map((item, i) => (
            <PosterCard
              key={item.id}
              item={item}
              type={type}
              onSelect={onSelect}
              rank={showRanking ? i + 1 : null}
            />
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

// Custom comparator — only re-render if the URL, title, type, or
// ranking flag changed. onSelect is recreated per parent render but
// is structurally equivalent (always (item) => setDetailItem(item)),
// so we don't compare it.
export const ContentRow = memo(ContentRowInner, (prev, next) => {
  if (prev.url !== next.url) return false
  if (prev.title !== next.title) return false
  if (prev.type !== next.type) return false
  if (prev.showRanking !== next.showRanking) return false
  return true
})
