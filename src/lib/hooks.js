// Custom React hooks shared across components. Lifted out of App.jsx
// so each carousel / search / scrolling primitive can reach for these
// without bringing the whole 5k-line file into the import graph.

import { useState, useEffect, useRef, useCallback } from 'react'

// Debounce a value — typical "stop typing for X ms before search fires"
// pattern. Returns the latest value, but only after `delay` ms of stillness.
export function useDebounce(value, delay) {
  const [d, setD] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setD(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return d
}

// Edge-hover auto-scroll for horizontal rows. When the mouse lingers
// near the left/right edge of a scrollable row for HOVER_DELAY_MS, we
// start auto-scrolling in that direction. Scroll speed eases with
// proximity to the edge (squared curve). rAF-driven for GPU smoothness.
const HOVER_DELAY_MS = 380
const HOT_ZONE_PX = 160
const MAX_SPEED_PX = 11

export function useEdgeHoverScroll(ref) {
  const stateRef = useRef({ rafId: null, dir: 0, speed: 0 })
  const delayRef = useRef(null)

  const stop = useCallback(() => {
    if (delayRef.current) { clearTimeout(delayRef.current); delayRef.current = null }
    if (stateRef.current.rafId) { cancelAnimationFrame(stateRef.current.rafId); stateRef.current.rafId = null }
    stateRef.current.dir = 0
    stateRef.current.speed = 0
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const loop = () => {
      const node = ref.current
      const { dir, speed } = stateRef.current
      if (!node || !dir || speed <= 0) { stateRef.current.rafId = null; return }
      const atStart = node.scrollLeft <= 0
      const atEnd = node.scrollLeft >= node.scrollWidth - node.clientWidth - 1
      if ((dir < 0 && atStart) || (dir > 0 && atEnd)) {
        stateRef.current.rafId = null
        return
      }
      node.scrollLeft += dir * speed
      stateRef.current.rafId = requestAnimationFrame(loop)
    }

    const onMove = (e) => {
      const node = ref.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const x = e.clientX - rect.left
      let dir = 0
      let ratio = 0
      if (x < HOT_ZONE_PX) {
        dir = -1
        ratio = Math.max(0, 1 - x / HOT_ZONE_PX)
      } else if (x > rect.width - HOT_ZONE_PX) {
        dir = 1
        ratio = Math.max(0, 1 - (rect.width - x) / HOT_ZONE_PX)
      }
      const speed = Math.min(MAX_SPEED_PX, ratio * ratio * MAX_SPEED_PX)
      stateRef.current.dir = dir
      stateRef.current.speed = speed
      if (dir === 0) {
        if (delayRef.current) { clearTimeout(delayRef.current); delayRef.current = null }
        if (stateRef.current.rafId) { cancelAnimationFrame(stateRef.current.rafId); stateRef.current.rafId = null }
      } else if (!stateRef.current.rafId && !delayRef.current) {
        delayRef.current = setTimeout(() => {
          delayRef.current = null
          stateRef.current.rafId = requestAnimationFrame(loop)
        }, HOVER_DELAY_MS)
      }
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', stop)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', stop)
      stop()
    }
  }, [ref, stop])
}

// Wheel → horizontal scroll. Vertical mouse-wheel events on a row
// translate into horizontal scrollBy. Only intercepts when the row IS
// horizontally scrollable AND the user's vertical intent dominates
// (deltaY > deltaX) — native trackpad horizontal gestures continue to
// work normally.
export function useWheelHorizontalScroll(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e) => {
      if (el.scrollWidth <= el.clientWidth) return
      const dy = Math.abs(e.deltaY), dx = Math.abs(e.deltaX)
      if (dy <= dx) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY, behavior: 'auto' })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref])
}

// Combined gestures hook: wires both edge-hover-auto-scroll AND
// wheel-horizontal-scroll onto a single ref. Use this in every
// horizontally-scrollable row so behaviour stays consistent.
export function useHorizontalRowGestures(ref) {
  useEdgeHoverScroll(ref)
  useWheelHorizontalScroll(ref)
}
