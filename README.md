<div align="center">

# WardoFlix

**A premium streaming client for one person and a few close friends.**

A Netflix-style, Stremio-grade desktop app that streams torrents on demand,
with fragmented-MP4 transcoding, full subtitle/audio-track support, casting,
profiles, and history sync.

[Latest release](https://github.com/wardo93/wardoflix/releases)

</div>

---

## What it does

You open WardoFlix, browse a Netflix-style catalog (rows of movies and shows
pulled from TMDB), click a title, pick a quality, and it plays. Behind the
scenes it's downloading a torrent in real time, transcoding it on-the-fly
when needed, and feeding the bytes straight into the video player.

There's no library to manage. No pre-downloaded files. No server in your
basement. Click → 5 seconds later, you're watching.

### The headline features

- **Browse catalog** — Trending / Popular / Top Rated / New for movies and
  TV, plus genre rows, plus "For You" personalised rows, plus
  "Because You Watched X" similar-titles rows.
- **Detail modal** — synopsis, cast, trailer (embedded YouTube), similar
  titles, and a per-quality torrent picker with seed-count health.
- **TV episode picker** — every season, every episode, even if Torrentio
  doesn't have a torrent for that specific one (we fetch on click).
- **Streaming engine** — WebTorrent picks up the magnet, ffmpeg muxes/
  transcodes if the codec needs it, video.js plays the result. Codec-aware
  URL upgrade so HEVC, AV1, VP9, etc. transparently transcode without
  the user noticing. Per-stream peer watchdog so dead torrents fall over
  to the next candidate within seconds.
- **Player UX** — custom controls overlay, remux-aware seekbar that
  shows your real position in the movie even after a `?t=` reload,
  ±10s skip, hover-to-edge auto-scroll on carousels, intro/outro
  detection (manual mark, persisted per show), keyboard shortcuts
  (`?` for the cheat sheet).
- **Subtitles** — OpenSubtitles via the Stremio addon. Multi-language,
  auto-attached, drift correction (offset slider), per-style controls.
- **Audio tracks** — multi-track sources (English / Dutch / commentary)
  surfaced in a picker, preserved across seeks, downmixed to stereo
  AAC at the encoder so multi-channel sources don't break Chromium.
- **Casting** — DLNA to TVs (auto-discovered on the LAN) + Chromecast
  (when WardoFlix is loaded over http, not file://).
- **Profiles** — multi-profile setup with avatars, isolated history,
  resume positions, watched flags, and "For You" recommendations
  per profile. No account system — local only.
- **History & resume** — every play recorded with its profile,
  per-title resume positions, "Continue Watching" carousel, manual
  remove from history, auto-mark-watched at 60s before end, "✓"
  badge on watched episodes.
- **Updater** — built-in. Reads `latest.yml` from a configured local
  folder, copies the new installer over, prompts to install. No
  package managers involved.

---

## How it works (high level)

```
┌──────────────────────────────────────────────────────────┐
│                       Electron app                        │
│                                                            │
│   ┌─────────────────┐         ┌─────────────────────┐    │
│   │  Renderer (UI)  │◄────────│   Main process      │    │
│   │  React 19       │   IPC   │  - server fork      │    │
│   │  video.js       │         │  - autoupdater       │    │
│   │  custom         │         │  - permission gate   │    │
│   │  controls       │         │  - log rotation      │    │
│   └────────┬────────┘         │                      │    │
│            │  fetch            └──────────┬──────────┘    │
│            │ http://localhost:3000        │ fork          │
│            ▼                              ▼               │
│   ┌────────────────────────────────────────────────┐     │
│   │         Express server (port 3000)              │     │
│   │  ┌──────────────────────────────────────────┐  │     │
│   │  │ /api/catalog  — TMDB-backed browse rows  │  │     │
│   │  │ /api/details  — TMDB rich detail         │  │     │
│   │  │ /api/torrents — Torrentio + APIBAY + YTS │  │     │
│   │  │ /api/stream   — magnet → WebTorrent.add  │  │     │
│   │  │ /api/tracks   — ffprobe audio + codec    │  │     │
│   │  │ /api/subtitles — OpenSubs proxy          │  │     │
│   │  │ /api/stream/progress — SSE peer counts   │  │     │
│   │  │ /api/stream/dead — explicit cleanup      │  │     │
│   │  │ /stream/:hash/:path — direct WebTorrent  │  │     │
│   │  │ /remux/:hash/:path  — ffmpeg pipe        │  │     │
│   │  │ /trailer            — YouTube embed shim │  │     │
│   │  └──────────────────────────────────────────┘  │     │
│   │  ┌────────────────┐    ┌──────────────────┐    │     │
│   │  │  WebTorrent    │    │  ffmpeg children │    │     │
│   │  │  client        │    │  (per /remux)    │    │     │
│   │  └────────┬───────┘    └────────┬─────────┘    │     │
│   │           ▼                      ▼              │     │
│   │   stream-server :3001 ──────► HTTP-in pipe-out  │     │
│   └────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼  (network)
   ┌────────────┬──────────────┬────────────┐
   │   TMDB     │  Torrentio   │ OpenSubs   │
   │ (catalog)  │  (sources)   │ (subtitles)│
   └────────────┴──────────────┴────────────┘
                       │
                       ▼
            BitTorrent swarm (peers)
```

### Stream pipeline, in plain English

1. **Click** → `POST /api/stream` with the magnet
2. **WebTorrent.client.add(magnet)** → trackers + DHT find peers, swarm
   delivers metadata, torrent enters `ready` state
3. **Server returns** `{url: "/remux/HASH/file.mkv?transcode=1"}` if the
   container/codec needs help, or `/stream/HASH/file.mp4` if it's
   browser-native
4. **Renderer** loads that URL into video.js
5. **`/remux` handler** spawns `ffmpeg -i http://127.0.0.1:3001/stream/...`
   — i.e. ffmpeg reads from WebTorrent's own HTTP server — pipes the
   transcoded fragmented MP4 into the response
6. **Client decodes** via Chromium/MSE
7. **Watchdog** listens for `loadeddata`/`playing`/`progress` from the
   video element + SSE peer signals; fires fallback to next candidate
   if 45s pass with no signs of life

### The codec-aware URL upgrade

This is the most important streaming-quality detail. Naively, you'd serve
`/stream/HASH/file.mp4` directly from WebTorrent. That works for browser-
native codecs (H.264 in MP4) but explodes on HEVC, AV1, 10-bit 4:2:0,
MPEG-4 ASP, FLV, WMV, etc. — Chromium plays a few seconds, then errors.

WardoFlix probes the file headers (5MB ffprobe) when /api/tracks runs
and either:

- Emits `/stream/...` if vcodec is `h264`/`avc1` → fast path, no transcode
- Emits `/remux/...?transcode=1` otherwise → ffmpeg downconverts to
  H.264 main profile / 4.0 / yuv420p, AAC stereo, fragmented MP4. This
  is the most-compatible-Chromium-can-play tuple; if it can't play this,
  nothing will.

Plus a 3-stage error-escalation ladder (`stream → remux → remux+fresh-probe`)
for the rare cases where the probe lied.

---

## Tech stack

- **Frontend**: React 19, video.js 8, custom controls, Vite 7
- **Backend**: Node 20 + Express 4, WebTorrent 2, fluent-ffmpeg, dotenv
- **Desktop shell**: Electron 32, electron-builder 25 (NSIS installer),
  custom local-folder updater
- **External APIs**: TMDB (catalog), Torrentio + APIBAY + YTS (sources),
  OpenSubtitles (via Stremio addon)

---

## Running it

For end users: download `WardoFlix-Setup-X.Y.Z.exe` from
[Releases](https://github.com/wardo93/wardoflix/releases) and run it.
Auto-updates after that.

For development:

```bash
git clone https://github.com/wardo93/wardoflix
cd wardoflix
npm install

# Create .env with your TMDB key (free at themoviedb.org/settings/api)
echo "TMDB_API_KEY=..." > .env

# Dev: vite + server + electron, hot-reloaded
npm start

# Build & package the Windows installer
npm run dist:win
```

Dev builds bypass the access-check entirely (`isDev` short-circuit in
`electron/main.js`) — you can iterate without rigging yourself in.

---

## Where it wants to go

This is a personal app. It's not aiming to be the next Stremio. The
roadmap is whatever I want WardoFlix to feel like next.

### Near-term (likely)

- **Resume position dot on the seekbar** — show where you left off last
  time as a faint mark
- **Thumbnail preview on hover** — sprite-sheet generated by ffmpeg
  during the first 30s of playback
- **Subtitles styling** — size, font, background, position
- **Skip intro / outro** — manual mark per show, remembered for the
  whole series
- **Sub offset persisted per title** instead of per session
- **Search-as-you-type** in Browse (currently requires Enter)
- **History deduplication for TV** — collapse 6 consecutive episodes of
  one show into one card

### Architecture (necessary, less fun)

- **Decompose `App.jsx`** — currently 5,300 lines in one file. Splitting
  into modules (`DetailModal`, `VideoPlayer`, `Browse`, `ProfileSelector`,
  etc.) would unblock everything else
- **TypeScript** — typing the streamProgress / metadata / source-state
  objects would have prevented at least four real bugs
- **Test harness** — none exists. At least smoke tests for `/api/stream`,
  `/remux`, `/api/torrents`

### Long-term, possibly

- **Watch-party / sync** — multiple installs sync currentTime through
  the Worker. Wave to each other in real time. (This is the cool one.)
- **Discord Rich Presence** — show what you're watching in your Discord
  status
- **Mini-player when minimized** — playback continues in a small floating
  window
- **Per-title quality preference** — you prefer 1080p H.264 for one show
  but 4K HDR for another? Remember it
- **Per-language audio preference** — always try Dutch first, then
  English, then anything
- **Trakt.tv sync** — push/pull watch state from your Trakt account if
  you keep one

### Will not happen

- A web/mobile version. WardoFlix is a desktop app, by design. Mobile
  needs cloud transcoding infrastructure I'm not building.
- A user-account system. Profiles are local. No "sign up" flow, ever.
- A public release. This is built for a small group of people; there
  are no plans to ship it more widely.

---

## Project structure

```
streamflow/
├── electron/
│   ├── main.js              ← Electron main: server, updater
│   └── preload.cjs          ← context-bridge surface for the renderer
├── server/
│   └── index.js             ← Express + WebTorrent + ffmpeg + APIs
├── src/
│   ├── App.jsx              ← React root
│   ├── App.css              ← all styles
│   ├── main.jsx             ← root + URL/EventSource patches for file://
│   └── index.css            ← global resets
├── build/                   ← installer assets (icon)
├── release/                 ← electron-builder output (.gitignored)
└── package.json
```

---

## Operational notes

- **Logs**: `%APPDATA%\WardoFlix\wardoflix.log`. Rotates at 10 MB,
  keeps 5 generations. Includes server stdout + updater +
  renderer diagnostics.
- **Cache**: `%APPDATA%\WardoFlix\cache\` — torrent file storage,
  api-cache (TMDB / Torrentio / APIBAY / YTS responses, TTL'd).

---

## Credits

Built by Ward, with iterative help from Claude Opus across the 1.x line.
Every commit message dating roughly v1.4.5 onward is co-authored.

Streaming powered by [WebTorrent](https://webtorrent.io/),
catalog by [TMDB](https://www.themoviedb.org/),
sources via [Torrentio](https://torrentio.strem.io/),
subtitles via the OpenSubtitles Stremio addon,
maps by [CartoDB](https://carto.com/) + [OpenStreetMap](https://www.openstreetmap.org/).

This is a personal-use project. Don't redistribute.