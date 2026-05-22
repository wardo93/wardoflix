// v1.11.0 — React error boundary.
//
// Without this, an unhandled render error in ANY component crashes
// the entire renderer process (Chromium remounts the root element to
// an empty <div> and you're staring at a black screen with no UI).
// Wrapping the app — plus a few high-risk subtrees — means one bad
// API response or component bug surfaces an inline retry card instead
// of bricking the session.
//
// Class component is mandatory: error boundaries are not yet
// available via hooks. Keep it minimal — no styling deps, no router
// deps, no third-party error reporter. If we add Sentry later, hook
// into componentDidCatch().

import { Component } from 'react'

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    // Log to the renderer console; main.js mirrors console.error
    // into wardoflix.log so the bug report includes the stack.
    // Don't crash the boundary itself — wrap in try/catch.
    try {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', this.props.label || 'unlabeled', error, errorInfo)
    } catch {}
  }

  handleReset = () => {
    // Best-effort recovery: clear the error and let React try to
    // remount the subtree. If the underlying state is still bad,
    // the boundary will catch again on the next render.
    this.setState({ error: null })
    // Call the optional onReset prop so the parent can also reset
    // any state that caused the crash (e.g. close a modal).
    try { this.props.onReset?.() } catch {}
  }

  render() {
    if (!this.state.error) return this.props.children

    // Fallback UI. Keep it inline-styled so the boundary survives
    // CSS-loading failures (which would themselves trigger the
    // boundary in a chicken-and-egg loop otherwise).
    const fallback = this.props.fallback
    if (typeof fallback === 'function') {
      try { return fallback(this.state.error, this.handleReset) } catch {}
    }

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 32px',
          margin: '24px auto',
          maxWidth: 520,
          background: 'rgba(20, 22, 28, 0.85)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 16,
          color: '#e8eaef',
          fontFamily: 'Sora, system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#f59f00" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="0.6" fill="#f59f00" />
        </svg>
        <h3 style={{ margin: '16px 0 4px', fontWeight: 600, fontSize: 18 }}>
          Something broke here
        </h3>
        <p style={{ margin: '0 0 20px', opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>
          {this.props.label
            ? `The ${this.props.label} ran into an error and stopped rendering.`
            : 'A component ran into an error and stopped rendering.'}
          {' '}The rest of the app should still work.
        </p>
        {/* Tiny details disclosure for the user to paste into a bug report. */}
        <details style={{ marginBottom: 20, fontSize: 12, opacity: 0.6, maxWidth: 460 }}>
          <summary style={{ cursor: 'pointer' }}>Error details</summary>
          <pre style={{
            marginTop: 8,
            padding: 8,
            background: 'rgba(0,0,0,0.3)',
            borderRadius: 6,
            overflow: 'auto',
            textAlign: 'left',
            fontSize: 11,
            maxHeight: 200,
          }}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
        </details>
        <button
          onClick={this.handleReset}
          style={{
            padding: '10px 22px',
            background: '#d4a373',
            color: '#1a1814',
            border: 'none',
            borderRadius: 999,
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    )
  }
}
