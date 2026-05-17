# WardoFlix Android — Standalone APK Roadmap

**Goal:** ship a true standalone Android APK that does what desktop WardoFlix does — torrenting + transcoding + playback — entirely on-device. No PC dependency, no LAN dependency.

**Estimated effort:** 3–5 weeks of focused work, split across the phases below. Each phase is independently shippable (or at least testable) so we don't carry a 5-week branch.

**Architecture choice:** *embedded local API server*. The Android app embeds a Java HTTP server (NanoHttpd) on `localhost:8888` that re-implements every Express endpoint the renderer relies on (`/api/*`, `/stream/*`, `/remux/*`). The renderer (React, loaded into a WebView) is **byte-identical** to desktop — it makes the same `fetch('/api/...')` calls, gets the same response shapes. This means ~95% of the codebase stays unchanged; the entire mobile effort is reimplementing the server in Kotlin against native libraries.

---

## Phase 0 — Owner prerequisites (you, one-time)

These are things only you can do because they involve installing software, accepting licenses, and creating signing keys.

### 0.1 Install Android Studio (~3 GB)

1. Download from https://developer.android.com/studio
2. Run the installer. Accept the default install location.
3. During first launch, it'll offer to download "SDK Components" — accept the defaults. This pulls:
   - Android SDK Platform (most recent)
   - Android SDK Build-Tools
   - Android Emulator (we won't use it; testing on a real phone is more representative)
   - Android SDK Platform-Tools (includes `adb`)

### 0.2 Install JDK 17 (Android requires it)

1. Download Temurin 17 (free OpenJDK build): https://adoptium.net/temurin/releases?version=17
2. Pick "Windows x64" → `.msi` installer
3. Run it; default install location is fine. Tick "Set JAVA_HOME" if asked.

### 0.3 Set environment variables (Windows User scope)

Admin PowerShell, once:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Eclipse Adoptium\jdk-17.0.11.9-hotspot", "User")
# adjust the JDK path if you installed a different version
```

Close + reopen a PowerShell. Verify:

```powershell
echo $env:ANDROID_HOME    # should print the SDK path
echo $env:JAVA_HOME       # should print the JDK path
adb version               # should print Android Debug Bridge version
```

### 0.4 Enable Developer Mode on your phone

On the phone:

1. Settings → About phone → tap "Build number" 7 times → unlocks Developer Options
2. Settings → Developer Options → enable "USB debugging"
3. Plug the phone into your PC via USB. Phone will prompt "Allow USB debugging?" — accept.

Verify from PC:

```powershell
adb devices    # should list your phone with status "device"
```

### 0.5 Generate a signing keystore (once — for production APKs)

```powershell
keytool -genkey -v -keystore "$env:USERPROFILE\.wardoflix-android.keystore" -alias wardoflix -keyalg RSA -keysize 2048 -validity 10000
```

It'll ask for a password (pick something strong, save it somewhere safe — keystore + password is the only way to publish updates of the SAME app), then a few identity fields (CN/OU/etc — values don't matter for sideload-only).

---

## Phase 1 — Capacitor scaffold (next session, ~1 day)

**Goal:** boot the existing React renderer inside an Android WebView. No torrenting, no transcoding yet — just prove the renderer renders. At end of phase, we have an APK that opens to the WardoFlix UI but every catalog call fails (no server running yet).

Steps:
1. `npm install @capacitor/core @capacitor/cli @capacitor/android` (already done in v1.10.0 — this is the foundation commit)
2. `npx cap init wardoflix com.wardoflix.app --web-dir=dist`
3. `npx cap add android` — generates `android/` folder
4. Edit `android/app/src/main/AndroidManifest.xml`:
   - Add INTERNET permission
   - Add FOREGROUND_SERVICE permission (we'll need it for ongoing torrent downloads)
5. `npm run build` then `npx cap sync android`
6. Open `android/` in Android Studio → Build → Make Project → Run on phone

**Deliverable:** WardoFlix logo + intro plays on your phone. Catalog rows show errors. That's expected.

---

## Phase 2 — Local API server in Kotlin (~3 days)

**Goal:** the renderer's catalog rows light up. Trending movies appear. Detail modals work. No torrenting yet.

Build the `WardoflixServer` Kotlin module:

- Embedded NanoHttpd server on `localhost:8888`
- Routes (initially): `/api/catalog/*`, `/api/details/*`, `/api/trailer-key/*`, `/api/recommendations/*`, `/api/health`
- TMDB calls done from Kotlin (OkHttp client, just port the `tmdbFetch` logic)
- Cache layer (SQLite, since we already need it for history later)
- Renderer's `fetch('/api/...')` rewriter (in `main.jsx`) detects Android via Capacitor and points at `http://localhost:8888` instead of the desktop `http://localhost:3000`

**Deliverable:** browsing works end-to-end on the phone. Hero banner, rows, detail modals, trailers (via YouTube iframe — same as desktop). Watchlist + library local-only.

---

## Phase 3 — Torrent engine via libtorrent4j (~5 days, hardest phase)

**Goal:** click a magnet → torrent downloads to phone storage → file is served via local HTTP to the player.

- Add `libtorrent4j` Gradle dependency
- Create `TorrentSession` Kotlin class that wraps the libtorrent C++ session
  - `addMagnet(magnetUri: String): Torrent`
  - `getFiles(infoHash: String): List<TorrentFile>`
  - `selectFile(torrent, fileIdx)` — prioritize that file's pieces
  - `getPiece(torrent, pieceIdx): ByteArray` — for streaming
- Implement `/api/stream` POST route in NanoHttpd:
  - Validates magnet
  - Adds to session
  - Returns `{ url: '/stream/<hash>/<encoded-path>' }`
- Implement `/stream/<hash>/<path>` route:
  - Resolves to the file in the torrent
  - Streams bytes via libtorrent's range API (request-byte-range → piece-by-piece read)
  - Sets `Content-Type: video/mp4` etc
- Add a foreground notification ("WardoFlix is downloading 5 GB") so Android doesn't kill the process

**Deliverable:** click a movie → it plays. Browser-native codecs only (H.264, AAC, MP4 container). MKV / HEVC / AV1 → "format not supported" because no transcoder yet. That's Phase 4.

---

## Phase 4 — FFmpegKit transcode pipe (~3 days)

**Goal:** every codec the desktop transcodes (HEVC, AV1, 10-bit, FLV, MKV, etc) also plays on phone.

- Add `com.arthenica:ffmpeg-kit-full:6.0-2` (or the maintained fork — see compat notes in `docs/android-deps.md` if it gets archived again)
- Port the desktop `/remux/:hash/*?transcode=1` route logic into Kotlin:
  - On request, spawn an FFmpegKit `executeAsync` with the same args as desktop (`-hwaccel auto -c:v libx264 -preset ultrafast` etc)
  - Pipe ffmpeg's stdout into the NanoHttpd response stream (chunked transfer-encoding)
- Wire the same codec-detection upgrade path (`/stream/*` → `/remux/*?transcode=1` based on probed vcodec)

**Decision: native codec first.** Many 2020+ phones can play HEVC/AV1 natively via MediaCodec without transcoding — better battery, better quality. Check `MediaCodecList` for hardware decoders; if present, skip the transcode for those codecs even on the server side. Falls back to FFmpegKit transcode only when the device truly can't decode.

**Deliverable:** every title that plays on desktop plays on phone. Battery life takes a hit for transcoded content (~3-4h vs 6-8h natively).

---

## Phase 5 — ExoPlayer integration (~3 days)

**Goal:** swap the renderer's video.js HTML5 video element for native ExoPlayer. Big battery + quality + scrubbing win on mobile.

- Capacitor plugin `WardoflixPlayer` with methods:
  - `play(url: string, posX, posY, w, h): void` — embeds ExoPlayer at given screen coords
  - `pause()` / `resume()` / `seek(seconds)` / `setVolume(0..1)`
  - `getCurrentTime(): float`
  - `setSubtitleTrack(track)`, `setAudioTrack(idx)`
- Renderer keeps the same `PlayerControls.jsx` UI; the underlying video bridge changes from `<video src=...>` to the native plugin
- Picture-in-picture support (Android API)
- Background audio support (foreground service while screen off)

**Deliverable:** mobile-grade player. Hardware-accelerated decode, smooth seeking, PiP, locks the screen orientation, handles audio focus when calls come in.

---

## Phase 6 — Storage migration + parity (~2 days)

**Goal:** profiles, history, library, resume positions, sub style — all work on phone, sync-able to desktop via export/import.

- Replace `localStorage` calls in `src/lib/storage.js` with a thin wrapper that detects Capacitor and uses SQLite there, localStorage on desktop
- Add Export → JSON file (phone's Downloads folder) and Import flows
- Profile photos / friendly names migrate cleanly

**Deliverable:** start a movie on the phone, finish it on desktop. (Sync is manual export/import for now; cloud sync is a future Phase 7+.)

---

## Phase 7 — Polish, packaging, sideload distribution (~2 days)

- Splash screen (Capacitor handles this; just need the asset)
- App icon set (1024px source → all density variants)
- Sign with the keystore from Phase 0.5
- Build a release APK
- Test sideload flow (USB → `adb install`, plus AirDroid / cloud-share for friends)
- Document install steps for friends

**Deliverable:** `WardoFlix-1.x.x.apk` (~80-100 MB) that you can sideload via USB or share via Drive/AirDrop. Auto-update via the same GitHub Releases mechanism we use on desktop (electron-updater equivalent for Android: in-app version check + download + install prompt).

---

## What this session ships (v1.10.0 Android foundation)

We stop short of anything that needs Android Studio. Deliverables:

- This roadmap document
- Capacitor config files ready for Phase 1
- A reserved `android-native/` folder with stub Kotlin module specs (the source files for Phase 2's NanoHttpd server, written as specifications to be implemented when Android Studio is ready)
- Setup checklist (Phase 0 above) so you can do the installs offline

Next session, after you've completed Phase 0: we run `npx cap add android` together and you see the renderer running on your phone.

---

## Things that will surprise us along the way

- libtorrent4j updates lag behind upstream libtorrent — version pinning matters
- FFmpegKit was archived in 2024 (legal issues around GPL); there's a maintained fork (`@bytedeco/javacv` or community forks). We'll pick the one with the most recent commits at Phase 4 time.
- Some HEVC content uses 10-bit + Main10 profile that even modern phones can't decode — transcode is unavoidable for those
- TVs reachable on the LAN via DLNA / Chromecast: not supported by our Android client out of the box; Phase 8+ if there's demand
- iOS: not on this roadmap. Apple's sideload restrictions + WebTorrent / native player landscape is harder than Android. The architecture above is iOS-portable if we ever need it (Capacitor supports iOS), but a real iOS ship is its own 3-5 week project.
