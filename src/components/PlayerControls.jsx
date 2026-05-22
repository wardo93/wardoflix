// React + storage / util / overlay imports the controls need at runtime.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  readResumePosition,
  saveSubOffset,
  readIntroMark, saveIntroMark,
  savePlaybackRate,
} from '../lib/storage.js'
import { formatAudioTrackLabel, formatSpeed, formatTime } from '../lib/util.js'
import { toast } from './Overlays.jsx'

// ── Custom Player Controls (Stremio-style) ──────────────────────
export function PlayerControls({
  playerRef, playerReady, containerRef, metadata, availableSubs, subOffset, setSubOffset,
  streamProgress, castState, onCast, onStopCast, onBack,
  audioTracks, activeAudioIdx, onAudioChange, knownDuration,
  dlnaDevices, dlnaActive, onDlnaCast, onDlnaStop, onDlnaRefresh,
  onSeek, remuxTimeOffset = 0, subStyle, setSubStyle,
}) {
  // remuxTimeOffset: seconds into the ORIGINAL movie that the current
  // /remux stream starts at. ffmpeg's `-ss N -i ...` resets output
  // timestamps to start at 0, so player.currentTime() returns 0 at the
  // beginning of the current segment — but the user's actual position
  // in the movie is `remuxTimeOffset + player.currentTime()`. Every
  // UI display of time (seekbar position, time readout, hover preview)
  // must add this offset. Every user-initiated seek targets ABSOLUTE
  // time and is translated back (target − offset) for in-buffer checks.
  //
  // Without this, clicking the middle of the seekbar after a previous
  // seek displays "0:00" again and the user (correctly) perceives the
  // show as having restarted, even though the content is progressing
  // from the right point internally. This was the "±10s restarts the
  // show" complaint — it wasn't really restarting, the seekbar was
  // just lying about the position.
  // Route every seek through the parent's `onSeek` handler instead of
  // calling player.currentTime(target) directly. The parent knows
  // whether the current source is a /remux stream (Accept-Ranges: none)
  // and will either run a native seek (in-buffer, fast) or a URL
  // reload with ?t=<target> (out-of-buffer — respawns ffmpeg at the
  // new offset). Calling currentTime() directly on an out-of-buffer
  // /remux target makes Chromium issue a new GET from byte 0 to read
  // forward until it hits the target, which the user perceives as
  // "the movie restarted from the start." That's the bug this
  // indirection fixes.
  const doSeek = (t) => { if (typeof onSeek === 'function') onSeek(t); else { try { playerRef.current?.currentTime(t) } catch {} } }
  const [castPanelOpen, setCastPanelOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  // Hover position on the seek bar — used to show a "time at this point"
  // tooltip + a hover-shadow on the bar. null when the cursor isn't over
  // the seek bar.
  const [hoverPct, setHoverPct] = useState(null)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [visible, setVisible] = useState(true)
  const [activeSub, setActiveSub] = useState(null)
  const [subsMenuOpen, setSubsMenuOpen] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const hideTimer = useRef(null)
  const seekBarRef = useRef(null)
  const volumeBarRef = useRef(null)
  const seekingRef = useRef(false)
  const menusRef = useRef({ subs: false, timing: false, audio: false })
  menusRef.current = { subs: subsMenuOpen, timing: timingOpen, audio: audioMenuOpen }

  const showControls = useCallback(() => {
    setVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!menusRef.current.subs && !menusRef.current.timing && !menusRef.current.audio) setVisible(false)
    }, 3500)
  }, [])

  useEffect(() => {
    showControls()
    return () => clearTimeout(hideTimer.current)
  }, [showControls])

  // Keep menus from auto-hiding controls
  useEffect(() => {
    if (subsMenuOpen || timingOpen || audioMenuOpen) {
      clearTimeout(hideTimer.current)
      setVisible(true)
    }
  }, [subsMenuOpen, timingOpen, audioMenuOpen])

  // Helper: get a safe seekable duration (handles Infinity from remuxed streams)
  // Priority: knownDuration (ffprobe, seconds) > TMDB runtime > player.duration()
  // > buffered.end(). TMDB runtime arrives with the metadata object — using it
  // as a fallback means the scrubber shows the real length even before the
  // ffprobe round-trip completes, instead of tracking the buffered edge.
  const metaRuntimeSec = useMemo(() => {
    const r = metadata?.runtime
    if (!r || !isFinite(r) || r <= 0) return 0
    // TMDB returns runtime in minutes for both movies and TV episodes.
    return r * 60
  }, [metadata])
  const getSafeDuration = useCallback(() => {
    if (knownDuration && knownDuration > 0) return knownDuration
    const p = playerRef.current
    if (p && !p.isDisposed()) {
      const d = p.duration()
      if (d && isFinite(d) && d > 0) return d
    }
    if (metaRuntimeSec > 0) return metaRuntimeSec
    if (p && !p.isDisposed()) {
      const buf = p.buffered()
      return buf?.length ? buf.end(buf.length - 1) : 0
    }
    return 0
  }, [playerRef, knownDuration, metaRuntimeSec])

  // Sync state from video.js player
  useEffect(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    // Throttle timeupdate so PlayerControls (heavy component — seek
    // bar, time display, menus) doesn't re-render on every <video>
    // frame.
    //
    // v1.11.0 set this to 250ms (4Hz). On reflection that's too
    // coarse: the "01:23 / 45:67" time display visibly jumps every
    // quarter-second, which the user perceives as the whole UI being
    // laggy. v1.11.4 bumps to 100ms (10Hz) — still much cheaper than
    // the native 30-60Hz cadence but smooth enough to feel real. On
    // a transcoded stream this is ~6 extra setState calls per second
    // compared to v1.11.3, but each one is bounded and the seek bar
    // animation finally looks like Netflix's.
    let lastTimeUpdateAt = 0
    const onTime = () => {
      if (seekingRef.current) return
      const now = Date.now()
      if (now - lastTimeUpdateAt < 100) return
      lastTimeUpdateAt = now
      setCurrentTime(p.currentTime() || 0)
      const d = getSafeDuration()
      setDuration(d)
      const buf = p.buffered()
      if (buf?.length) setBuffered(buf.end(buf.length - 1))
    }
    const onVolChange = () => {
      setVolume(p.volume())
      setMuted(p.muted())
    }
    const onWait = () => setWaiting(true)
    const onCanPlay = () => setWaiting(false)
    const onDuration = () => setDuration(getSafeDuration())
    p.on('play', onPlay)
    p.on('pause', onPause)
    p.on('timeupdate', onTime)
    p.on('volumechange', onVolChange)
    p.on('loadedmetadata', onDuration)
    p.on('durationchange', onDuration)
    p.on('waiting', onWait)
    p.on('canplay', onCanPlay)
    p.on('playing', onCanPlay)
    // Init
    setPlaying(!p.paused())
    setVolume(p.volume())
    setMuted(p.muted())
    setDuration(getSafeDuration())
    return () => {
      if (!p.isDisposed()) {
        p.off('play', onPlay); p.off('pause', onPause)
        p.off('timeupdate', onTime); p.off('volumechange', onVolChange)
        p.off('loadedmetadata', onDuration); p.off('durationchange', onDuration)
        p.off('waiting', onWait); p.off('canplay', onCanPlay); p.off('playing', onCanPlay)
      }
    }
  }, [playerRef, playerReady, getSafeDuration])

  // Track active subtitle
  useEffect(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const checkSubs = () => {
      const tracks = p.textTracks()
      for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].mode === 'showing') { setActiveSub(tracks[i].language); return }
      }
      setActiveSub(null)
    }
    const tracks = p.textTracks()
    tracks.addEventListener('change', checkSubs)
    return () => tracks.removeEventListener('change', checkSubs)
  }, [playerRef, playerReady, availableSubs])

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    p.paused() ? p.play() : p.pause()
  }, [playerRef])

  const seekTo = useCallback((e) => {
    const p = playerRef.current
    const bar = seekBarRef.current
    if (!p || p.isDisposed() || !bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const d = getSafeDuration()
    if (d > 0) doSeek(pct * d)
    showControls()
  }, [playerRef, getSafeDuration, showControls])

  const startSeek = useCallback((e) => {
    seekingRef.current = true
    const bar = seekBarRef.current
    if (!bar) return
    const p = playerRef.current
    const d = getSafeDuration()

    const onMove = (ev) => {
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      setCurrentTime(pct * d)
    }
    const onUp = (ev) => {
      seekingRef.current = false
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      if (p && !p.isDisposed() && d > 0) doSeek(pct * d)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    // Immediate feedback
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setCurrentTime(pct * d)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [playerRef, getSafeDuration])

  const changeVolume = useCallback((e) => {
    const p = playerRef.current
    const bar = volumeBarRef.current
    if (!p || p.isDisposed() || !bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    p.volume(pct)
    p.muted(pct === 0)
    showControls()
  }, [playerRef, showControls])

  const toggleMute = useCallback(() => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    p.muted(!p.muted())
  }, [playerRef])

  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef?.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen().catch(() => {})
    }
    showControls()
  }, [containerRef, showControls])

  const skip = useCallback((sec) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    // Compute the ABSOLUTE current position so the jump lands on the
    // right spot in the movie. Without adding remuxTimeOffset here,
    // skip(+10) would add 10 to the player's local time (which starts
    // fresh at 0 after every remux respawn) — so every "+10s" click
    // after a seek would jump to 00:10 of the current segment instead
    // of 10 seconds forward from where the user really is.
    const absCur = (p.currentTime() || 0) + (remuxTimeOffset || 0)
    const d = getSafeDuration()
    const target = Math.max(0, d > 0 ? Math.min(d, absCur + sec) : absCur + sec)
    doSeek(target)
    showControls()
  }, [playerRef, getSafeDuration, showControls, remuxTimeOffset])

  const selectSub = (lang) => {
    const p = playerRef.current
    if (!p || p.isDisposed()) return
    const tracks = p.textTracks()
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = (lang && tracks[i].language === lang) ? 'showing' : 'disabled'
    }
    setActiveSub(lang)
    setSubsMenuOpen(false)
    // Persist the user's pick as their default language for next time —
    // pairs with the auto-enable on track-load (subs effect in App body)
    // so picking English once means every subsequent title silently
    // shows English subs without another menu click. Storing 'off' as a
    // sentinel for explicit no-subs preference.
    try {
      if (lang) localStorage.setItem('wardoflix:sub-lang-pref', lang)
      else localStorage.setItem('wardoflix:sub-lang-pref', 'off')
    } catch {}
  }

  // Keyboard shortcuts — Stremio/YouTube-style
  useEffect(() => {
    const handler = (e) => {
      // Full in-field guard. Previously this only looked at INPUT/TEXTAREA
      // which missed: contentEditable fields, native SELECT dropdowns, and
      // form controls inside the detail-modal dialog. Triggering play/pause
      // while the user is typing in the Stream tab's URL box or picking a
      // genre dropdown was confusing; this matches the guard the other
      // (top-level) shortcut handler already uses.
      const t = e.target
      if (t) {
        const tag = t.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (t.isContentEditable) return
      }
      const p = playerRef.current
      if (!p || p.isDisposed()) return
      // Number keys 0-9: jump to N*10% of the video (YouTube/Stremio parity)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        const n = Number(e.key)
        const d = getSafeDuration()
        if (d > 0) {
          e.preventDefault()
          doSeek(d * (n / 10))
          showControls()
        }
        return
      }
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); togglePlay(); showControls(); break
        case 'ArrowLeft': e.preventDefault(); skip(-10); break
        case 'ArrowRight': e.preventDefault(); skip(10); break
        case 'j': e.preventDefault(); skip(-10); break    // YouTube-style
        case 'l': e.preventDefault(); skip(10); break     // YouTube-style
        case 'ArrowUp': e.preventDefault(); p.volume(Math.min(1, p.volume() + 0.1)); showControls(); break
        case 'ArrowDown': e.preventDefault(); p.volume(Math.max(0, p.volume() - 0.1)); showControls(); break
        case 'f': toggleFullscreen(); break
        case 'm': toggleMute(); showControls(); break
        case 'c': {
          // Toggle subtitles (cycle: first track ↔ off, Stremio-style quick toggle)
          const tt = p.textTracks?.()
          if (tt && tt.length) {
            let anyShowing = false
            for (let i = 0; i < tt.length; i++) if (tt[i].mode === 'showing') { anyShowing = true; break }
            for (let i = 0; i < tt.length; i++) {
              if (i === 0 && !anyShowing) tt[i].mode = 'showing'
              else tt[i].mode = 'disabled'
            }
            showControls()
          }
          break
        }
        case ',':
        case '<': {
          e.preventDefault()
          const rate = Math.max(0.25, (p.playbackRate() || 1) - 0.25)
          p.playbackRate(rate)
          // Persist per title so the next play of the same show
          // remembers your speed (Stremio-style).
          if (metadata?.id) savePlaybackRate(metadata.id, rate)
          showControls()
          break
        }
        case '.':
        case '>': {
          e.preventDefault()
          const rate = Math.min(3, (p.playbackRate() || 1) + 0.25)
          p.playbackRate(rate)
          if (metadata?.id) savePlaybackRate(metadata.id, rate)
          showControls()
          break
        }
        case 'Escape': {
          // If a menu is open, close it. If fullscreen is on, let the
          // browser handle it (exit fullscreen). Otherwise, back out of
          // the player entirely — this is the keyboard equivalent of
          // clicking the back arrow.
          if (menusRef.current.subs || menusRef.current.timing || menusRef.current.audio) {
            setSubsMenuOpen(false); setTimingOpen(false); setAudioMenuOpen(false)
          } else if (document.fullscreenElement) {
            // Browser handles Escape automatically; nothing to do.
          } else {
            e.preventDefault()
            onBack?.()
          }
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePlay, skip, toggleFullscreen, toggleMute, showControls, getSafeDuration, onBack])

  // Apply the remux-offset when computing what to display. The state
  // `currentTime` and `buffered` are in the player's LOCAL time axis
  // (the ffmpeg output stream starts at 0); the user cares about the
  // ABSOLUTE position in the original movie, which is local + offset.
  const absCurrent = currentTime + (remuxTimeOffset || 0)
  const absBuffered = buffered + (remuxTimeOffset || 0)
  const progress = duration > 0 ? Math.min(100, (absCurrent / duration) * 100) : 0
  const bufferPct = duration > 0 ? Math.min(100, (absBuffered / duration) * 100) : 0

  const title = metadata?.title || ''
  const episodeLabel = metadata?.season && metadata?.episode
    ? `S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}`
    : ''

  // Skip Intro button visibility: show when the user is inside a
  // marked intro range. Reads the per-show intro mark from localStorage.
  // Outro mark is supported the same way for the end credits.
  const introMark = useMemo(() => readIntroMark(metadata?.id), [metadata?.id])
  const inIntroRange = introMark?.introStart != null && introMark?.introEnd != null
    && absCurrent >= introMark.introStart - 0.5 && absCurrent < introMark.introEnd
  const inOutroRange = introMark?.outroStart != null && duration > 0
    && absCurrent >= introMark.outroStart - 0.5 && absCurrent < duration - 5

  return (
    <div
      className={`custom-controls ${visible ? 'visible' : ''}`}
      onMouseMove={showControls}
      onClick={(e) => { if (e.target === e.currentTarget) togglePlay() }}
    >
      {/* Skip Intro / Skip Outro overlay button — only visible inside
          the marked range. Uses doSeek (the remux-aware seek helper)
          so the jump works on /remux URLs without restarting the show. */}
      {(inIntroRange || inOutroRange) && (
        <button
          className="cc-skip-overlay"
          onClick={(e) => {
            e.stopPropagation()
            if (inIntroRange) doSeek(introMark.introEnd)
            else if (inOutroRange) doSeek(duration - 1) // jump to end → triggers ended → next ep
          }}
        >
          {inIntroRange ? 'Skip Intro' : 'Skip Credits'} ↓
        </button>
      )}
      {/* Top gradient + title */}
      <div className="cc-top" onClick={(e) => e.stopPropagation()}>
        <button className="cc-back" onClick={onBack} title="Back">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div className="cc-title">
          <span className="cc-title-main">{title}</span>
          {episodeLabel && <span className="cc-title-ep">{episodeLabel}</span>}
        </div>
        {streamProgress && streamProgress.peers >= 0 && (
          <div className="cc-stats">
            <span>{streamProgress.peers} peers</span>
            <span>{formatSpeed(streamProgress.speed)}</span>
            {streamProgress.progress > 0 && streamProgress.progress < 100 && (
              <span>{streamProgress.progress}%</span>
            )}
          </div>
        )}
      </div>

      {/* Center play/loading indicator */}
      <div className="cc-center" onClick={togglePlay} onDoubleClick={(e) => { e.stopPropagation(); toggleFullscreen() }}>
        {waiting ? (
          <div className="cc-spinner" />
        ) : !playing ? (
          <button className="cc-play-big">
            <svg viewBox="0 0 24 24" width="56" height="56" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
        ) : null}
      </div>

      {/* Bottom controls */}
      <div className="cc-bottom" onClick={(e) => e.stopPropagation()}>
        {/* Seek bar */}
        <div
          className="cc-seek"
          ref={seekBarRef}
          onMouseDown={startSeek}
          onMouseMove={(e) => {
            const bar = seekBarRef.current
            if (!bar) return
            const rect = bar.getBoundingClientRect()
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
            setHoverPct(pct)
          }}
          onMouseLeave={() => setHoverPct(null)}
        >
          <div className="cc-seek-buffer" style={{ width: `${bufferPct}%` }} />
          <div className="cc-seek-progress" style={{ width: `${progress}%` }} />
          {/* Hover preview — a faint vertical line at the cursor x and a
              floating time tooltip above. When the hover point is
              already buffered we use a stronger color to hint that
              clicking will be instant; otherwise it'll respawn ffmpeg
              via the seek-reload path (which has a brief black flash). */}
          {hoverPct != null && duration > 0 && (
            <>
              <div
                className={`cc-seek-hover ${hoverPct * 100 <= bufferPct ? 'in-buffer' : 'out-buffer'}`}
                style={{ left: `${hoverPct * 100}%` }}
              />
              <div
                className="cc-seek-hover-time"
                style={{ left: `${hoverPct * 100}%` }}
              >
                {formatTime(hoverPct * duration)}
              </div>
            </>
          )}
          {/* Resume dot — shows where you left off last time, faint so
              it doesn't compete with the playhead. Hidden once you've
              played past it. Read once at mount; the value doesn't
              change during a session because we cleared the resume
              entry on the previous play's exit. */}
          {(() => {
            try {
              const resumeAt = readResumePosition(metadata)
              if (!resumeAt || !duration || duration <= 0) return null
              const pct = Math.min(100, Math.max(0, (resumeAt / duration) * 100))
              if (absCurrent > resumeAt + 5) return null
              return <div className="cc-seek-resume" style={{ left: `${pct}%` }} title={`Resume from ${formatTime(resumeAt)}`} />
            } catch { return null }
          })()}
          {/* Skip-intro/outro markers if user has set them for this show */}
          {(() => {
            try {
              const mark = readIntroMark(metadata?.id)
              if (!mark || !duration) return null
              const range = (start, end, cls) => {
                if (start == null || end == null || end <= start) return null
                const a = Math.max(0, Math.min(100, (start / duration) * 100))
                const b = Math.max(0, Math.min(100, (end / duration) * 100))
                return <div className={cls} style={{ left: `${a}%`, width: `${b - a}%` }} />
              }
              return <>
                {range(mark.introStart, mark.introEnd, 'cc-seek-intro')}
                {mark.outroStart != null && range(mark.outroStart, duration, 'cc-seek-intro')}
              </>
            } catch { return null }
          })()}
          <div className="cc-seek-thumb" style={{ left: `${progress}%` }} />
        </div>

        <div className="cc-bar">
          <div className="cc-bar-left">
            <button className="cc-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
              )}
            </button>
            <button className="cc-btn" onClick={() => skip(-10)} title="Rewind 10s">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12.5 8c-3.6 0-6.5 2.9-6.5 6.5s2.9 6.5 6.5 6.5 6.5-2.9 6.5-6.5H17c0 2.5-2 4.5-4.5 4.5S8 17 8 14.5 10 10 12.5 10V8z"/><polygon points="12.5,5 9,8.5 12.5,12"/><text x="11" y="16.5" fontSize="6" fontWeight="700" textAnchor="middle" fill="white">10</text></svg>
            </button>
            <button className="cc-btn" onClick={() => skip(10)} title="Forward 10s">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M11.5 8c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5S5 18.1 5 14.5H7c0 2.5 2 4.5 4.5 4.5S16 17 16 14.5 14 10 11.5 10V8z"/><polygon points="11.5,5 15,8.5 11.5,12"/><text x="13" y="16.5" fontSize="6" fontWeight="700" textAnchor="middle" fill="white">10</text></svg>
            </button>
            <div className="cc-volume-group">
              <button className="cc-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2"/><line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54 8.46a5 5 0 010 7.07" fill="none" stroke="white" strokeWidth="1.5"/>{volume > 0.5 && <path d="M19.07 4.93a10 10 0 010 14.14" fill="none" stroke="white" strokeWidth="1.5"/>}</svg>
                )}
              </button>
              <div className="cc-volume-slider" ref={volumeBarRef} onClick={changeVolume}>
                <div className="cc-volume-level" style={{ width: `${muted ? 0 : volume * 100}%` }} />
              </div>
            </div>
            <span className="cc-time">
              {formatTime(absCurrent)} / {formatTime(duration)}
            </span>
          </div>

          <div className="cc-bar-right">
            {/* Subtitles button */}
            {availableSubs.length > 0 && (
              <div className="cc-sub-wrap">
                <button
                  className={`cc-btn ${activeSub ? 'cc-btn-active' : ''}`}
                  onClick={() => { setSubsMenuOpen((v) => !v); setTimingOpen(false); setAudioMenuOpen(false) }}
                  title="Subtitles"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="1.5">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <line x1="6" y1="10" x2="10" y2="10"/>
                    <line x1="12" y1="10" x2="18" y2="10"/>
                    <line x1="6" y1="14" x2="14" y2="14"/>
                  </svg>
                </button>
                {subsMenuOpen && (
                  <div className="cc-subs-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="cc-subs-header">
                      <span>Subtitles</span>
                      <button className="cc-subs-timing-btn" onClick={() => { setTimingOpen(true); setSubsMenuOpen(false) }}>
                        Timing {subOffset !== 0 ? `(${subOffset > 0 ? '+' : ''}${subOffset.toFixed(1)}s)` : ''}
                      </button>
                    </div>
                    <button
                      className={`cc-sub-option ${!activeSub ? 'active' : ''}`}
                      onClick={() => selectSub(null)}
                    >Off</button>
                    {availableSubs.map((s) => (
                      <button
                        key={s.lang}
                        className={`cc-sub-option ${activeSub === (s.lang || 'en') ? 'active' : ''}`}
                        onClick={() => selectSub(s.lang || 'en')}
                      >{s.langName || s.lang}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Timing panel */}
            {timingOpen && (
              <div className="cc-timing-panel" onClick={(e) => e.stopPropagation()}>
                <div className="cc-timing-row">
                  <span className="cc-timing-label">Subtitle delay</span>
                  <button className="cc-timing-btn" onClick={() => setSubOffset((v) => Math.round((v - 0.5) * 10) / 10)}>−0.5s</button>
                  <span className="cc-timing-value">{subOffset > 0 ? '+' : ''}{subOffset.toFixed(1)}s</span>
                  <button className="cc-timing-btn" onClick={() => setSubOffset((v) => Math.round((v + 0.5) * 10) / 10)}>+0.5s</button>
                  {subOffset !== 0 && (
                    <button className="cc-timing-btn" onClick={() => {
                      // Apply the current offset to ALL episodes of this
                      // show — useful when the whole series shares a
                      // sub-timing issue.
                      saveSubOffset(metadata, subOffset, true)
                    }}>Apply to show</button>
                  )}
                  {subOffset !== 0 && <button className="cc-timing-reset" onClick={() => setSubOffset(0)}>Reset</button>}
                </div>
                {metadata?.id && (
                  <div className="cc-timing-row">
                    <span className="cc-timing-label">Skip-intro marks</span>
                    <button className="cc-timing-btn" onClick={() => {
                      // Mark the START of the intro at the current time.
                      const mark = readIntroMark(metadata.id) || {}
                      saveIntroMark(metadata.id, { ...mark, introStart: Math.floor(absCurrent) })
                    }}>Set intro start</button>
                    <button className="cc-timing-btn" onClick={() => {
                      // Mark the END of the intro at the current time.
                      const mark = readIntroMark(metadata.id) || {}
                      saveIntroMark(metadata.id, { ...mark, introEnd: Math.floor(absCurrent) })
                    }}>Set intro end</button>
                    <button className="cc-timing-btn" onClick={() => {
                      const mark = readIntroMark(metadata.id) || {}
                      saveIntroMark(metadata.id, { ...mark, outroStart: Math.floor(absCurrent) })
                    }}>Set outro start</button>
                    {introMark && (
                      <button className="cc-timing-reset" onClick={() => saveIntroMark(metadata.id, null)}>Clear all</button>
                    )}
                  </div>
                )}
                {setSubStyle && (
                  <>
                    {/* Whole-style presets (v1.7.6). One click sets
                        size + bg + weight together. Most users never
                        need the granular controls; they just want
                        "Netflix-like" or "Cinema" and to be done. */}
                    <div className="cc-timing-row">
                      <span className="cc-timing-label">Style preset</span>
                      <button
                        className="cc-timing-btn"
                        onClick={() => setSubStyle({ size: 140, position: 0, weight: 'normal', bg: 'shadow' })}
                        title="Default — medium, drop shadow"
                      >Default</button>
                      <button
                        className="cc-timing-btn"
                        onClick={() => setSubStyle({ size: 160, position: 0, weight: 'bold', bg: 'shadow' })}
                        title="Netflix — large, bold, drop shadow"
                      >Netflix</button>
                      <button
                        className="cc-timing-btn"
                        onClick={() => setSubStyle({ size: 180, position: 8, weight: 'normal', bg: 'shadow' })}
                        title="Cinema — extra large, lifted off the bottom edge"
                      >Cinema</button>
                      <button
                        className="cc-timing-btn"
                        onClick={() => setSubStyle({ size: 130, position: 0, weight: 'normal', bg: 'box' })}
                        title="Caption Box — medium, with translucent black background"
                      >Caption</button>
                      <button
                        className="cc-timing-btn"
                        onClick={() => setSubStyle({ size: 170, position: 0, weight: 'bold', bg: 'box' })}
                        title="High Contrast — large bold text with solid box (best for low-vision)"
                      >High Contrast</button>
                    </div>
                    <div className="cc-timing-row">
                      <span className="cc-timing-label">Sub size</span>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: Math.max(60, (s.size || 140) - 10) }))}>−</button>
                      <span className="cc-timing-value">
                        {subStyle?.size || 140}% · {Math.round((subStyle?.size || 140) * 0.22)}px
                      </span>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: Math.min(260, (s.size || 140) + 10) }))}>+</button>
                      {/* Quick presets so the user doesn't have to ten-step
                          their way to a comfortable size. */}
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: 100 }))} title="Small (22px)">S</button>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: 140 }))} title="Medium (31px) — default">M</button>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: 180 }))} title="Large (40px)">L</button>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, size: 220 }))} title="X-Large (48px)">XL</button>
                    </div>
                    <div className="cc-timing-row">
                      <span className="cc-timing-label">Position</span>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, position: Math.max(0, (s.position || 0) - 5) }))}>↓</button>
                      <span className="cc-timing-value">{subStyle?.position || 0}%</span>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, position: Math.min(40, (s.position || 0) + 5) }))}>↑</button>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, bg: s.bg === 'shadow' ? 'box' : s.bg === 'box' ? 'none' : 'shadow' }))}>
                        BG: {subStyle?.bg || 'shadow'}
                      </button>
                      <button className="cc-timing-btn" onClick={() => setSubStyle((s) => ({ ...s, weight: s.weight === 'bold' ? 'normal' : 'bold' }))}>
                        {subStyle?.weight === 'bold' ? 'Bold' : 'Regular'}
                      </button>
                    </div>
                  </>
                )}
                <div className="cc-timing-row">
                  <button className="cc-timing-done" onClick={() => setTimingOpen(false)}>Done</button>
                </div>
              </div>
            )}

            {/* Audio tracks */}
            {audioTracks.length > 0 && (
              <div className="cc-audio-wrap">
                <button
                  className={`cc-btn ${activeAudioIdx != null ? 'cc-btn-active' : ''}`}
                  onClick={() => { setAudioMenuOpen((v) => !v); setSubsMenuOpen(false); setTimingOpen(false) }}
                  title="Audio track"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                </button>
                {audioMenuOpen && (
                  <div className="cc-audio-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="cc-subs-header"><span>Audio</span></div>
                    {audioTracks.map((t) => (
                      <button
                        key={t.index}
                        className={`cc-sub-option ${(activeAudioIdx ?? audioTracks[0]?.index) === t.index ? 'active' : ''}`}
                        onClick={() => { if (t.index !== activeAudioIdx) onAudioChange(t.index); setAudioMenuOpen(false) }}
                      >
                        {formatAudioTrackLabel(t)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Cast (Chromecast + DLNA picker) */}
            <div className="cc-cast-wrap">
              <button
                className={`cc-btn ${(castState === 'connected' || dlnaActive) ? 'cc-btn-active' : ''}`}
                onClick={() => {
                  if (dlnaActive) { onDlnaStop?.(); return }
                  if (castState === 'connected') { onStopCast?.(); return }
                  setCastPanelOpen((o) => !o)
                  onDlnaRefresh?.()
                }}
                title={dlnaActive ? 'Stop casting (DLNA)' : castState === 'connected' ? 'Stop casting' : 'Cast to TV'}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/>
                </svg>
              </button>
              {castPanelOpen && !dlnaActive && castState !== 'connected' && (
                <div className="cc-cast-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="cc-cast-panel-title">Cast to device</div>
                  {castState !== 'unavailable' && (
                    <button
                      className="cc-cast-device"
                      onClick={() => { setCastPanelOpen(false); onCast?.() }}
                    >
                      <span className="cc-cast-device-dot" />
                      <span className="cc-cast-device-name">Chromecast…</span>
                      <span className="cc-cast-device-type">Chromecast</span>
                    </button>
                  )}
                  {(dlnaDevices || []).length === 0 && castState === 'unavailable' && (
                    <div className="cc-cast-empty">No devices found on your network.</div>
                  )}
                  {(dlnaDevices || []).map((d) => (
                    <button
                      key={d.id}
                      className="cc-cast-device"
                      onClick={() => { setCastPanelOpen(false); onDlnaCast?.(d) }}
                    >
                      <span className="cc-cast-device-dot" />
                      <span className="cc-cast-device-name">{d.name}</span>
                      <span className="cc-cast-device-type">DLNA</span>
                    </button>
                  ))}
                  <button className="cc-cast-refresh" onClick={onDlnaRefresh}>Refresh</button>
                </div>
              )}
            </div>

            {/* Open in external player (VLC / OS default). Hits the
                server's /api/external-url to get a LAN URL pointed at
                /remux for the current torrent, then asks the main
                process to launch it. Useful for HDR passthrough,
                Atmos audio, or just because you prefer mpv/VLC over
                Chromium's video element. */}
            <button
              className="cc-btn"
              title="Open in VLC / external player"
              onClick={async () => {
                try {
                  const src = playerRef.current?.currentSrc?.() || ''
                  const m = src.match(/\/remux\/([a-f0-9]{40})\/([^?#]+)/i)
                  if (!m) {
                    try { window.dispatchEvent(new CustomEvent('wardoflix:toast', { detail: { id: Date.now(), message: 'External player only available for transcoded streams', variant: 'warning', timeoutMs: 4000 } })) } catch {}
                    return
                  }
                  const r = await fetch(`/api/external-url/${m[1]}/${m[2]}`)
                  const data = await r.json()
                  if (!data.url) throw new Error('No URL')
                  const result = await window.wardoflixExternal?.openInPlayer?.(data.url)
                  if (result?.ok) {
                    try { window.dispatchEvent(new CustomEvent('wardoflix:toast', { detail: { id: Date.now(), message: `Opened in ${result.player === 'vlc' ? 'VLC' : 'default player'}. The in-app stream stays running so you can use either.`, variant: 'success', title: 'External player', timeoutMs: 5000 } })) } catch {}
                  } else {
                    try { window.dispatchEvent(new CustomEvent('wardoflix:toast', { detail: { id: Date.now(), message: 'Couldn\'t launch external player: ' + (result?.reason || 'unknown'), variant: 'error', timeoutMs: 5000 } })) } catch {}
                  }
                } catch (e) {
                  try { window.dispatchEvent(new CustomEvent('wardoflix:toast', { detail: { id: Date.now(), message: 'External player failed: ' + (e?.message || ''), variant: 'error', timeoutMs: 5000 } })) } catch {}
                }
              }}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2">
                <path d="M14 3h7v7" />
                <path d="M21 3 11 13" />
                <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
            </button>

            {/* Mini-player (Picture-in-Picture). Browser-native PiP
                pops the video out into a floating always-on-top window
                that survives Alt+Tab — perfect for keeping a show
                running while you do something else. video.js exposes
                the API on the underlying tech element via
                requestPictureInPicture / exitPictureInPicture. Falls
                back gracefully if the browser refuses (Chromium
                always supports it; some Electron builds need a flag). */}
            <button
              className="cc-btn"
              title="Mini-player (Picture-in-Picture)"
              onClick={async () => {
                try {
                  const p = playerRef.current
                  if (!p || p.isDisposed?.()) return
                  const el = p.tech?.()?.el?.() || p.el?.().querySelector('video')
                  if (!el) return
                  if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture().catch(() => {})
                  } else if (typeof el.requestPictureInPicture === 'function') {
                    await el.requestPictureInPicture()
                  }
                  showControls?.()
                } catch (e) {
                  // Non-fatal — just inform the user.
                  try { window.dispatchEvent(new CustomEvent('wardoflix:toast', { detail: { id: Date.now(), message: 'Picture-in-Picture not available: ' + (e?.message || 'unknown'), variant: 'warning', timeoutMs: 4000 } })) } catch {}
                }
              }}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <rect x="13" y="11" width="6" height="6" rx="1" fill="white" />
              </svg>
            </button>

            {/* Fullscreen */}
            <button className="cc-btn" onClick={toggleFullscreen} title="Fullscreen">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2">
                <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                <polyline points="21 3 14 10"/><polyline points="3 21 10 14"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
