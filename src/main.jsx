import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ── App error boundary ─────────────────────────────────────────
// React errors during render bubble all the way to the root. Without
// a boundary, the whole tree unmounts and the user sees a blank page.
// Wrap <App/> so any uncaught throw becomes a friendly recovery screen
// with the stack trace visible (copyable) and a Reload button.
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // Persist a copy so the Electron log keeps a record even when the
    // renderer gets torn down and reloaded.
    try {
      console.error('[AppErrorBoundary]', error, info?.componentStack)
    } catch {}
    this.setState({ error, info })
  }
  handleReload = () => {
    try { window.location.reload() } catch {}
  }
  handleReset = () => {
    // Soft reset: clear the error state and force a re-render. Useful
    // when the error was a transient state bug and the user wants to
    // try again without losing their torrent cache.
    this.setState({ error: null, info: null })
  }
  handleCopy = async () => {
    const { error, info } = this.state
    const payload = [
      `WardoFlix error — ${new Date().toISOString()}`,
      `Message: ${error?.message || String(error)}`,
      '',
      'Stack:',
      error?.stack || '(no stack)',
      '',
      'Component stack:',
      info?.componentStack || '(no component stack)',
    ].join('\n')
    try { await navigator.clipboard?.writeText(payload) } catch {}
  }
  render() {
    if (!this.state.error) return this.props.children
    const { error, info } = this.state
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0b0d12',
        color: '#ecefe4',
        fontFamily: 'system-ui, Segoe UI, sans-serif',
        padding: '48px 32px',
        boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h1 style={{ color: '#c9a96e', fontWeight: 600, marginBottom: 8 }}>
            WardoFlix hit an unexpected error
          </h1>
          <p style={{ color: '#b8bcc4', lineHeight: 1.55, marginBottom: 24 }}>
            Something threw while rendering. The app is still running, but this
            view is frozen until you reload. Your cache, history, and profiles
            are unaffected.
          </p>
          <div style={{
            background: '#151821',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 8,
            padding: '14px 16px',
            marginBottom: 20,
            fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
            fontSize: 12,
            color: '#8fa3b8',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 360,
            overflow: 'auto',
          }}>
            <strong style={{ color: '#f5a562' }}>{error?.message || String(error)}</strong>
            {error?.stack ? '\n\n' + error.stack : ''}
            {info?.componentStack ? '\n\nComponent:' + info.componentStack : ''}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={this.handleReload} style={btnStyle(true)}>Reload app</button>
            <button onClick={this.handleReset} style={btnStyle(false)}>Try again</button>
            <button onClick={this.handleCopy} style={btnStyle(false)}>Copy error</button>
          </div>
        </div>
      </div>
    )
  }
}

function btnStyle(primary) {
  return {
    background: primary ? '#c9a96e' : 'transparent',
    color: primary ? '#0b0d12' : '#ecefe4',
    border: '1px solid ' + (primary ? '#c9a96e' : 'rgba(255,255,255,0.12)'),
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  }
}

// ── Packaged-app URL rewriting ────────────────────────────────────
// In dev, Vite serves the UI at http://localhost:5173 and proxies /api,
// /stream, /remux to the API server on :3000. Under packaged Electron the
// UI loads over file:// so those relative paths 404. Patch fetch and
// EventSource to prefix them with http://localhost:3000, and expose
// window.__API_BASE__ for direct <video> src assignments.
;(() => {
  const isFile = typeof window !== 'undefined' && window.location.protocol === 'file:'
  const API_BASE = isFile ? 'http://localhost:3000' : ''
  window.__API_BASE__ = API_BASE
  if (!isFile) return

  const REWRITE = /^\/(api|stream|remux)(\/|\?|$)/
  const rewrite = (url) => {
    if (typeof url !== 'string') return url
    return REWRITE.test(url) ? API_BASE + url : url
  }

  const origFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (typeof input === 'string') return origFetch(rewrite(input), init)
    if (input instanceof Request && REWRITE.test(input.url.replace(/^[^/]*\/\/[^/]+/, ''))) {
      // Rare — Request object with a relative-ish URL. Reconstruct.
      const path = input.url.replace(/^[^/]*\/\/[^/]+/, '')
      return origFetch(rewrite(path), init)
    }
    return origFetch(input, init)
  }

  const OrigES = window.EventSource
  if (OrigES) {
    window.EventSource = function PatchedEventSource(url, opts) {
      return new OrigES(rewrite(url), opts)
    }
    window.EventSource.prototype = OrigES.prototype
  }
})()

// Load the Chromecast SDK only when we're on http(s). Under file:// the
// SDK's own internal protocol-relative URLs resolve to file:// and spam
// the console; DLNA covers casting in packaged mode.
;(() => {
  if (typeof window === 'undefined') return
  if (window.location.protocol === 'file:') return
  const s = document.createElement('script')
  s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
  s.async = true
  document.head.appendChild(s)
})()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
