// WardoFlix intro — synthesized cinematic sting + animated logo.
// Extracted from App.jsx as part of the god-file split.

import { useState, useEffect, useRef } from 'react'

// ── Piracy quote database ─────────────────────────────────────
// Shown under the logo during the intro. Rotates randomly each intro so
// the app feels alive — half inside-joke for the pirate crowd, half wink
// at the "premium streaming" positioning. Kept one-liner short so the
// tagline slot doesn't overflow.
const PIRACY_QUOTES = [
  // ── Movie-reference twists ─────────────────────────────────────
  "I'm gonna make him an offer his CDN can't refuse.",
  "Frankly, my dear, I don't give a DRM.",
  "You had me at magnet:?xt=urn:btih:",
  "Here's looking at you, seeder.",
  "Say hello to my little tracker.",
  "They may take our wallets, but they'll never take our BANDWIDTH.",
  "One does not simply pay for nine streaming services.",
  "I see dead services. They don't know they're dead.",
  "Toto, I've a feeling we're not on Netflix anymore.",
  "E.T. phone home — over port 6881.",
  "These aren't the files you're looking for.",
  "Show me the magnet.",
  "Houston, we have a torrent.",
  "Nobody puts Wardo in a buffer.",
  "Why so serious? It's just a copy.",
  "I'll be back — with a better seed ratio.",
  "I feel the need — the need for seed.",
  "The first rule of Seed Club: you do not talk about ratio.",
  "Keep your friends close, and your seedboxes closer.",
  "Life finds a way. So do torrents.",
  "Do or do not — there is no DRM.",

  // ── Dry one-liners ─────────────────────────────────────────────
  "Premium streaming, at peasant prices.",
  "The subscription you cancel is the subscription that frees you.",
  "If it's on a server, it's on our server.",
  "We don't have regional restrictions. We have regional suggestions.",
  "Owning is for suckers. Having a copy is for winners.",
  "Your library, your rules, your bandwidth.",
  "Hollywood sends regards. The regards bounced.",
  "Buffering is a skill issue, and we have skill.",
  "Rated arrr, for all audiences.",

  // ── Deadpan cinephile ──────────────────────────────────────────
  "A film critic with zero expense reports.",
  "Every seeder is a small act of film preservation.",
  "The Criterion Collection wishes it had your hit-rate.",
  "Cinema belongs to whoever queues it up tonight.",
  "We ship the movies the algorithm forgot.",
  "Canon is decided by who still has a copy.",
  "The director's cut is the one that's seeded.",
  "Remember when renting a movie was an adventure? Still is.",

  // ── Tech-flavored ──────────────────────────────────────────────
  "ffmpeg is our priest. webtorrent is our congregation.",
  "The codec was inside you all along.",
  "We speak HTTP, BitTorrent, and zero legalese.",
  "Powered by caffeine, RAM, and moral flexibility.",
  "If the license won't scale, the peer swarm will.",
  "Lossless in principle. Seedless in fact.",

  // ── Wry aphorisms ──────────────────────────────────────────────
  "If buying isn't owning, downloading isn't stealing.",
  "Property is nine-tenths of the torrent.",
  "The best things in life are seeded.",
  "They can raise the price, but they can't raise our ratio.",
  "A gentleman's agreement with Hollywood: we watch, they cope.",
  "Somewhere between Robin Hood and your router.",
]

export function pickPiracyQuote() {
  return PIRACY_QUOTES[Math.floor(Math.random() * PIRACY_QUOTES.length)]
}

// ── WardoFlix Intro (Netflix-style, with synthesized cinematic sting) ──
// The sound is generated with the Web Audio API (no asset file needed).
// Architecture: rising sub-whoosh → impact hit → minor-key chord bloom
// with detuned saw brass → shimmering cymbal tail. Stereo-widened for depth.
// Timing lines up with the visual beat: impact lands at ~1.1 s.
//
// Props:
//   onComplete: fired when intro finishes (or is clicked / Escape pressed)
//   quote:      optional pre-picked quote (stable across re-renders). If
//               omitted, a fresh random quote is picked on mount.
//   fullscreenTarget: optional element to auto-requestFullscreen on mount.
//               Used by the pre-stream intro so clicking Play jumps into
//               cinematic mode without a second click.
export function WardoFlixIntro({ onComplete, quote, fullscreenTarget }) {
  const [phase, setPhase] = useState('playing') // playing | fading
  const audioRef = useRef(null)
  // Pick once and freeze for the lifetime of this intro instance so the
  // quote doesn't reshuffle if React re-renders mid-animation.
  const quoteRef = useRef(quote || pickPiracyQuote())

  // Stash props in refs so the setup effect can run exactly once on mount
  // without a stale-closure problem. Previously this effect had
  // [onComplete, fullscreenTarget] in its deps, so any parent re-render
  // (which happens constantly during stream loading because of SSE
  // progress ticks) would re-create the inline onComplete, invalidate
  // the deps, tear down the audio context, and re-fire the sting — plus
  // reset the completion timers so the intro never ended. That's the
  // "audio loops + intro hangs while streams load" bug.
  const onCompleteRef = useRef(onComplete)
  const fullscreenTargetRef = useRef(fullscreenTarget)
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => { fullscreenTargetRef.current = fullscreenTarget }, [fullscreenTarget])

  useEffect(() => {
    // Play the intro sound once on mount. Audio context creation has to
    // happen in a click/event handler in some browsers, but we're inside
    // a component that's mounted *because* the user clicked play, so the
    // page has user gesture.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        audioRef.current = ctx
        const now = ctx.currentTime

        // ── Master bus with a touch of dynamics control ──
        const master = ctx.createGain()
        master.gain.value = 0.32
        // Subtle compressor so the impact + chord stack don't clip even
        // when everything peaks together at t≈1.2s.
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = -14
        comp.ratio.value = 4
        comp.attack.value = 0.003
        comp.release.value = 0.25
        master.connect(comp).connect(ctx.destination)

        // Helpers — build a stereo pair by running a mono source through
        // two panners with a small delay so it widens without smearing.
        const panLeft = ctx.createStereoPanner(); panLeft.pan.value = -0.6
        const panRight = ctx.createStereoPanner(); panRight.pan.value = 0.6
        panLeft.connect(master); panRight.connect(master)

        // ── 1. Pre-swell whoosh (0 → 1.1s) ──
        // Bandpass-swept white noise rising in pitch. Builds tension like
        // the reel spin before an old-Hollywood title card.
        const noiseBufSize = ctx.sampleRate * 3
        const noiseBuf = ctx.createBuffer(2, noiseBufSize, ctx.sampleRate)
        for (let ch = 0; ch < 2; ch++) {
          const d = noiseBuf.getChannelData(ch)
          for (let i = 0; i < noiseBufSize; i++) d[i] = (Math.random() * 2 - 1) * 0.55
        }
        const whoosh = ctx.createBufferSource()
        whoosh.buffer = noiseBuf
        const whooshFilter = ctx.createBiquadFilter()
        whooshFilter.type = 'bandpass'
        whooshFilter.Q.value = 1.4
        whooshFilter.frequency.setValueAtTime(400, now)
        whooshFilter.frequency.exponentialRampToValueAtTime(7500, now + 1.05)
        whooshFilter.frequency.exponentialRampToValueAtTime(1200, now + 2.2)
        const whooshGain = ctx.createGain()
        whooshGain.gain.setValueAtTime(0.0001, now)
        whooshGain.gain.exponentialRampToValueAtTime(0.28, now + 1.0)
        whooshGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.3)
        whoosh.connect(whooshFilter).connect(whooshGain).connect(master)
        whoosh.start(now)
        whoosh.stop(now + 2.5)

        // ── 2. Impact transient (1.1s) ──
        // Sharp triangle pitch-drop that gives the hit its body and click.
        const impact = ctx.createOscillator()
        const impactGain = ctx.createGain()
        impact.type = 'triangle'
        impact.frequency.setValueAtTime(220, now + 1.05)
        impact.frequency.exponentialRampToValueAtTime(32, now + 1.25)
        impactGain.gain.setValueAtTime(0.0001, now + 1.05)
        impactGain.gain.exponentialRampToValueAtTime(0.85, now + 1.11)
        impactGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55)
        impact.connect(impactGain).connect(master)
        impact.start(now + 1.05)
        impact.stop(now + 1.6)

        // ── 3. Sub-bass tonic (1.1s → 2.8s) — 55 Hz A1 ──
        const sub = ctx.createOscillator()
        const subGain = ctx.createGain()
        sub.type = 'sine'
        sub.frequency.setValueAtTime(55, now + 1.1)
        subGain.gain.setValueAtTime(0.0001, now + 1.08)
        subGain.gain.exponentialRampToValueAtTime(1.0, now + 1.18)
        subGain.gain.exponentialRampToValueAtTime(0.35, now + 1.9)
        subGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.8)
        sub.connect(subGain).connect(master)
        sub.start(now + 1.08)
        sub.stop(now + 2.9)

        // ── 4. Minor-key brass chord bloom (1.2s → 2.6s) ──
        // A minor triad (A2=110, C3=130.8, E3=164.8) with detuned saws
        // stacked for "analog brass" richness. Each note gets its own
        // subtle stereo position to create width.
        const chordNotes = [
          { freq: 110.0,  detune: -6, pan: -0.35, start: 1.20, gain: 0.32 },
          { freq: 110.0,  detune: +6, pan:  0.35, start: 1.20, gain: 0.32 },
          { freq: 130.81, detune: -4, pan: -0.15, start: 1.28, gain: 0.26 },
          { freq: 130.81, detune: +4, pan:  0.15, start: 1.28, gain: 0.26 },
          { freq: 164.81, detune: 0,  pan:  0.00, start: 1.36, gain: 0.22 },
        ]
        // Single warm lowpass to tame the saw fizz into brass body.
        const brassFilter = ctx.createBiquadFilter()
        brassFilter.type = 'lowpass'
        brassFilter.frequency.setValueAtTime(800, now + 1.20)
        brassFilter.frequency.exponentialRampToValueAtTime(2400, now + 1.50)
        brassFilter.frequency.exponentialRampToValueAtTime(900, now + 2.4)
        brassFilter.Q.value = 0.9
        brassFilter.connect(master)
        for (const n of chordNotes) {
          const osc = ctx.createOscillator()
          osc.type = 'sawtooth'
          osc.frequency.setValueAtTime(n.freq, now + n.start)
          osc.detune.value = n.detune
          const g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, now + n.start)
          g.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.18)
          g.gain.exponentialRampToValueAtTime(n.gain * 0.5, now + n.start + 0.7)
          g.gain.exponentialRampToValueAtTime(0.0001, now + 2.5)
          const p = ctx.createStereoPanner()
          p.pan.value = n.pan
          osc.connect(g).connect(p).connect(brassFilter)
          osc.start(now + n.start)
          osc.stop(now + 2.6)
        }

        // ── 5. Bright harmonic bell (1.22s) ──
        // Clean sine high above the chord — lends a rose-gold shimmer
        // that feels expensive.
        const bell = ctx.createOscillator()
        const bellGain = ctx.createGain()
        bell.type = 'sine'
        bell.frequency.setValueAtTime(659.25, now + 1.22) // E5
        bellGain.gain.setValueAtTime(0.0001, now + 1.22)
        bellGain.gain.exponentialRampToValueAtTime(0.18, now + 1.34)
        bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.7)
        bell.connect(bellGain).connect(master)
        bell.start(now + 1.22)
        bell.stop(now + 2.75)

        // ── 6. Cymbal tail (1.15s → 3.0s) ──
        // Stereo white-noise through a high bandpass, long exponential
        // decay for that "sparkle" shimmer after the hit.
        const cymBuf = ctx.createBuffer(2, noiseBufSize, ctx.sampleRate)
        for (let ch = 0; ch < 2; ch++) {
          const d = cymBuf.getChannelData(ch)
          for (let i = 0; i < noiseBufSize; i++) d[i] = (Math.random() * 2 - 1) * 0.5
        }
        const cym = ctx.createBufferSource()
        cym.buffer = cymBuf
        const cymFilter = ctx.createBiquadFilter()
        cymFilter.type = 'bandpass'
        cymFilter.frequency.value = 6800
        cymFilter.Q.value = 1.6
        const cymGain = ctx.createGain()
        cymGain.gain.setValueAtTime(0.0001, now + 1.10)
        cymGain.gain.exponentialRampToValueAtTime(0.22, now + 1.22)
        cymGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.0)
        cym.connect(cymFilter).connect(cymGain).connect(master)
        cym.start(now + 1.10)
        cym.stop(now + 3.05)

        // Fade master out at the end so we don't click on context close
        master.gain.setValueAtTime(master.gain.value, now + 2.6)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 3.2)

        // Suppress the unused-panner lint — we keep the stereo pair wired
        // so any future source can pick left/right without rebuilding.
        void panLeft; void panRight
      }
    } catch {}

    // Total intro length = fadeTimer + 800ms fade out. Bumped to accommodate
    // the longer cinematic sting (impact now lands at 1.1s instead of 0.35s).
    const fadeTimer = setTimeout(() => setPhase('fading'), 3700)
    const doneTimer = setTimeout(() => onCompleteRef.current?.(), 4500)

    // The intro overlay covers the video with z-index: 50, which hid the
    // PlayerControls' fullscreen button. Rather than poke pointer-events
    // holes, we: (a) auto-request fullscreen on the provided target so the
    // common case "user clicked Play, wanted cinema" just works, and
    // (b) listen for F / F11 / Escape / Enter / Space during the intro so
    // the user can take control without waiting for it to finish.
    const fsTarget = fullscreenTargetRef.current
    if (fsTarget && typeof document !== 'undefined' && !document.fullscreenElement) {
      // requestFullscreen needs a user gesture. It *is* one (the click/keypress
      // that set showIntro=true), but the browser sometimes rejects it when
      // fired from inside a useEffect. Swallow rejection silently — the user
      // can still press F in the handler below.
      try { fsTarget.requestFullscreen?.().catch(() => {}) } catch {}
    }

    const onKey = (ev) => {
      if (ev.key === 'f' || ev.key === 'F' || ev.key === 'F11') {
        ev.preventDefault()
        const t = fullscreenTargetRef.current
        if (t && !document.fullscreenElement) {
          try { t.requestFullscreen?.() } catch {}
        } else if (document.fullscreenElement) {
          try { document.exitFullscreen() } catch {}
        }
        // Skip the rest of the intro so the user isn't staring at the logo
        // after going fullscreen.
        onCompleteRef.current?.()
      } else if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        onCompleteRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(doneTimer)
      window.removeEventListener('keydown', onKey)
      try { audioRef.current?.close?.() } catch {}
    }
    // Empty deps — setup happens exactly once per mount. Callbacks read
    // through refs above so they stay fresh without re-triggering setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`wf-intro ${phase === 'fading' ? 'wf-intro--fade' : ''}`} onClick={() => onComplete()}>
      {/* Soft radial vignette + deep-space gradient backdrop */}
      <div className="wf-intro-vignette" aria-hidden="true" />

      <div className="wf-intro-content">
        {/* Expanding concentric rings — clean, not stripey */}
        <div className="wf-intro-rings" aria-hidden="true">
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--1" />
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--2" />
          <div className="wf-intro-ring-pulse wf-intro-ring-pulse--3" />
        </div>

        {/* Glowing orb that swells at the "tudum" beat */}
        <div className="wf-intro-orb" aria-hidden="true" />

        {/* Particle sparks drifting outward from the center */}
        <div className="wf-intro-sparks" aria-hidden="true">
          {[...Array(16)].map((_, i) => (
            <div
              key={i}
              className="wf-intro-spark"
              style={{
                '--angle': `${(360 / 16) * i}deg`,
                '--delay': `${0.2 + (i % 4) * 0.08}s`,
                '--distance': `${38 + (i % 5) * 6}vmin`,
              }}
            />
          ))}
        </div>

        <div className="wf-intro-logo">
          <span className="wf-intro-w">W</span>
          <div className="wf-intro-ring" aria-hidden="true" />
        </div>
        <div className="wf-intro-text">
          {'WARDOFLIX'.split('').map((ch, i) => (
            <span key={i} className="wf-intro-char" style={{ animationDelay: `${1.05 + i * 0.05}s` }}>{ch}</span>
          ))}
        </div>
        <div className="wf-intro-tagline wf-intro-tagline--quote">{quoteRef.current}</div>
      </div>

      {/* Bright flash at the "tudum" beat */}
      <div className="wf-intro-flash" />
    </div>
  )
}
