// Three small standalone overlay components + the toast event-bus
// helper. Lifted out of App.jsx because they're entirely self-
// contained: each takes only props, none touch app-level state. Made
// it possible to drop ~250 lines from App.jsx without any wiring
// changes — App still imports them and renders them the same way.

import { useState, useEffect } from 'react'
import { BROWSER_SAFE_VCODECS } from '../lib/util.js'

// ── Toast event-bus ────────────────────────────────────────────
// `toast(msg, variant)` dispatches a CustomEvent on window;
// <ToastHost /> listens and renders a stack in the bottom-right.
// Decoupled from React context so any code in the tree can fire a
// toast without prop-drilling.
const TOAST_EVENT = 'wardoflix:toast'
let toastIdSeq = 1

export function toast(message, variant = 'info', opts = {}) {
  const detail = {
    id: toastIdSeq++,
    message: String(message ?? ''),
    variant, // 'info' | 'success' | 'warning' | 'error'
    timeoutMs: opts.timeoutMs ?? (variant === 'error' ? 8000 : 4000),
    title: opts.title || null,
  }
  try { window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail })) } catch {}
  return detail.id
}

export function ToastHost() {
  const [items, setItems] = useState([])
  useEffect(() => {
    const onAdd = (e) => {
      const d = e.detail
      if (!d) return
      setItems((cur) => [...cur, d])
      if (d.timeoutMs > 0) {
        setTimeout(() => {
          setItems((cur) => cur.filter((x) => x.id !== d.id))
        }, d.timeoutMs)
      }
    }
    window.addEventListener(TOAST_EVENT, onAdd)
    return () => window.removeEventListener(TOAST_EVENT, onAdd)
  }, [])
  const dismiss = (id) => setItems((cur) => cur.filter((x) => x.id !== id))
  if (!items.length) return null
  return (
    <div className="wf-toast-host" role="region" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="wf-toast" data-variant={t.variant} role="alert">
          <div className="wf-toast-body">
            {t.title && <div className="wf-toast-title">{t.title}</div>}
            <div className="wf-toast-msg">{t.message}</div>
          </div>
          <button className="wf-toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  )
}

// ── Keyboard shortcuts cheat-sheet ─────────────────────────────
// Opened with `?`. Documents an otherwise undiscoverable surface —
// nobody guesses Ctrl+Shift+D for the debug overlay otherwise.
export function ShortcutsOverlay({ onClose }) {
  const groups = [
    {
      title: 'Playback',
      items: [
        ['Space', 'Play / pause'],
        ['K', 'Play / pause (alt)'],
        ['← / →', 'Seek ±10 s'],
        ['J / L', 'Seek ±10 s (alt)'],
        ['↑ / ↓', 'Volume ±5%'],
        ['0 – 9', 'Jump to N × 10% of the movie'],
        ['M', 'Mute / unmute'],
        ['F', 'Fullscreen'],
        ['C', 'Toggle subtitles on/off'],
        ['< / >', 'Playback speed −/+ 0.25×'],
        ['Click middle of player', 'Play / pause'],
        ['Double-click middle', 'Toggle fullscreen'],
      ],
    },
    {
      title: 'App',
      items: [
        ['F11', 'Native fullscreen'],
        ['F12', 'Toggle DevTools'],
        ['Ctrl + Shift + D', 'Debug overlay'],
        ['?', 'This help panel'],
        ['Esc', 'Close overlays / exit fullscreen'],
      ],
    },
    {
      title: 'Subtitles',
      items: [
        ['Subs button → Timing', 'Adjust subtitle delay (±0.5 s steps)'],
        ['Apply to show', 'Save the current offset for every episode'],
        ['Sub size / position / weight', 'In Timing panel — persisted per profile'],
      ],
    },
    {
      title: 'TV shows',
      items: [
        ['Set intro start / Set intro end', 'Mark the intro range while watching — surfaces a Skip Intro button on every episode'],
        ['Set outro start', 'Marks credits — Skip Credits jumps to next episode'],
        ['Shift + click episode', 'Toggle watched (✓) without playing'],
      ],
    },
  ]
  return (
    <div className="wf-shortcuts-backdrop" onClick={onClose}>
      <div className="wf-shortcuts" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="wf-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="wf-shortcuts-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="wf-shortcuts-body">
          {groups.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([keys, desc]) => (
                  <div key={keys} className="wf-shortcut-row">
                    <dt><kbd>{keys}</kbd></dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Debug overlay (Ctrl+Shift+D) ───────────────────────────────
// Fixed-position diagnostic panel. Reads only the props it's handed
// (no app state) so a render of the overlay doesn't ripple through
// memoized children. Fields chosen specifically so a user screenshot
// tells us everything we need to triage a decode error.
export function DebugOverlay({
  source,
  sourceType,
  streamInfoHash,
  streamDuration,
  streamBaseUrl,
  probedVcodec,
  remuxStage,
  playbackError,
  streamWarning,
  appVersion,
  serverHealthy,
  audioTracks,
  activeAudioIdx,
  onClose,
}) {
  const [accessInfo, setAccessInfo] = useState(null)
  useEffect(() => {
    let cancelled = false
    try {
      window.wardoflixAccess?.getInfo?.().then((info) => {
        if (!cancelled) setAccessInfo(info)
      }).catch(() => {})
    } catch {}
    return () => { cancelled = true }
  }, [])
  const copyInstallId = async () => {
    if (!accessInfo?.installId) return
    try { await navigator.clipboard?.writeText(accessInfo.installId) } catch {}
  }
  const endpoint = (() => {
    if (!source) return '—'
    if (source.includes('/stream/')) return 'stream'
    if (source.includes('/remux/')) {
      const fresh = /[?&]fresh=/.test(source)
      const transcode = /[?&]transcode=1/.test(source)
      const audio = /[?&]audio=\d+/.test(source)
      const tags = [transcode && 'transcode', fresh && 'fresh', audio && 'audio'].filter(Boolean).join('+')
      return tags ? `remux (${tags})` : 'remux'
    }
    if (source.startsWith('http')) return 'external'
    return 'unknown'
  })()
  const codecBadge = probedVcodec
    ? (BROWSER_SAFE_VCODECS.has(probedVcodec) ? 'ok' : 'transcode')
    : 'unknown'

  const copyAll = async () => {
    const payload = {
      version: appVersion,
      serverHealthy,
      endpoint,
      sourceType,
      source,
      streamBaseUrl,
      streamInfoHash,
      streamDuration,
      probedVcodec,
      codecBadge,
      remuxStage,
      playbackError,
      streamWarning: streamWarning || null,
      audio: { count: audioTracks?.length || 0, activeIdx: activeAudioIdx },
      ts: new Date().toISOString(),
    }
    try { await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)) } catch {}
  }

  return (
    <div className="wf-debug" role="dialog" aria-label="Debug overlay">
      <div className="wf-debug-head">
        <span className="wf-debug-title">Debug</span>
        <span className="wf-debug-sub">Ctrl+Shift+D to toggle · Esc to close</span>
        <button className="wf-debug-close" type="button" onClick={onClose} aria-label="Close debug overlay">×</button>
      </div>
      <dl className="wf-debug-grid">
        <dt>App</dt><dd>v{appVersion || '?'} · server {serverHealthy === false ? 'down' : serverHealthy === true ? 'up' : '?'}</dd>
        <dt>Endpoint</dt><dd data-endpoint={endpoint.split(' ')[0]}>{endpoint}</dd>
        <dt>Remux stage</dt><dd>{remuxStage} / 2</dd>
        <dt>Codec</dt><dd data-codec={codecBadge}>{probedVcodec || '(not probed)'} <span className="wf-debug-badge">{codecBadge}</span></dd>
        <dt>Info-hash</dt><dd className="wf-debug-mono">{streamInfoHash || '—'}</dd>
        <dt>Duration</dt><dd>{streamDuration ? `${Math.floor(streamDuration / 60)}m ${Math.floor(streamDuration % 60)}s` : '—'}</dd>
        <dt>Audio</dt><dd>{(audioTracks?.length || 0)} track(s){typeof activeAudioIdx === 'number' ? ` · active #${activeAudioIdx}` : ''}</dd>
        <dt>Source type</dt><dd>{sourceType || '—'}</dd>
        <dt>Source URL</dt><dd className="wf-debug-mono wf-debug-wrap" title={source || ''}>{source || '—'}</dd>
        <dt>Base URL</dt><dd className="wf-debug-mono wf-debug-wrap">{streamBaseUrl || '—'}</dd>
        <dt>Last error</dt><dd>{playbackError ? `code ${playbackError.code}: ${playbackError.message}` : '—'}</dd>
        <dt>Warning</dt><dd>{streamWarning || '—'}</dd>
        <dt>Install ID</dt><dd className="wf-debug-mono wf-debug-wrap" title={accessInfo?.installId || ''}>{accessInfo?.installId || '—'}</dd>
      </dl>
      <div className="wf-debug-foot">
        <button type="button" className="wf-debug-btn" onClick={copyAll}>Copy as JSON</button>
        <button type="button" className="wf-debug-btn" onClick={copyInstallId} disabled={!accessInfo?.installId}>Copy install ID</button>
      </div>
    </div>
  )
}
