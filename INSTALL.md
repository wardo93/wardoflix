# Installing WardoFlix

## Windows (your friend)

From a fresh clone with Node 20+ installed:

```bash
npm install
npm run dist:win
```

This runs `vite build` then `electron-builder`. The installer lands at:

```
release/WardoFlix-Setup-1.0.0.exe
```

That's the file to send. It's a standard NSIS installer — double-click, pick
an install folder, Desktop + Start Menu shortcuts are created automatically.

**First launch**: WardoFlix starts the stream server on `localhost:3001` and
the API on `localhost:3000`, then opens a window pointed at the bundled UI.
Both ports must be free.

**Firewall**: Windows will prompt to allow network access on first launch —
approve it on Private networks so DLNA casting to TVs works.

**ffmpeg**: bundled via `@ffmpeg-installer/ffmpeg`; nothing extra to install.

**Troubleshooting grey window**: if the app window opens but nothing loads,
the backend failed to start. Check the log at:

```
%APPDATA%\WardoFlix\wardoflix.log
```

(Paste that path into Explorer.) The last few lines will show why the
server crashed — most commonly ports 3000/3001 are already in use or
Windows Firewall blocked the first launch. After 25s without a response
the app now swaps to an explicit error screen instead of staying grey.

## iPad / iPhone (as a PWA)

iOS won't let anyone sideload apps without a paid Apple Developer account +
Xcode. The realistic path is a **Progressive Web App**:

1. Host WardoFlix somewhere your iPad can reach — either:
   - Run it on your PC and open `http://<your-pc-lan-ip>:5173` in Safari, or
   - Deploy the built `dist/` to any web host
2. On the iPad, open the URL in **Safari** (Chrome on iOS won't offer this).
3. Tap the **Share** icon → **Add to Home Screen** → confirm.
4. A "WardoFlix" icon appears on your home screen. Tap it — it launches
   fullscreen like a native app, no Safari chrome.

The manifest (`public/manifest.webmanifest`), theme colors, and apple-touch
icons are already wired up. iOS will pick them up automatically.

**Limitation**: the torrent streaming backend must be reachable over the
network — WebTorrent can't run natively on iOS. So the iPad PWA is a thin
client against your PC (or a hosted server running the backend).

## Cast to a Samsung / LG / Sony TV

Chromecast support is preserved. For older Smart TVs (Samsung ~2016–2020 etc.)
that don't have Chromecast:

1. Ensure PC and TV are on the **same Wi-Fi / LAN**.
2. Make sure the TV's DLNA / "External Device Manager" / "Screen Mirroring
   → DLNA" is turned on (varies by model).
3. Click the cast button in the player — the picker lists both Chromecast
   devices and DLNA renderers.

If nothing shows up, hit **Refresh** inside the picker (it re-runs SSDP
discovery). Windows Firewall blocking UDP 1900 (SSDP) is the usual culprit.

## Developer: running from source

```bash
npm install
npm run start         # dev: starts server + vite with auto-open
npm run electron:dev  # dev: runs it inside an Electron window
npm run dist:win      # build the Windows installer
```
