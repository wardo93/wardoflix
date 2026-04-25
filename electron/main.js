// Electron main — launches the Node stream server as a child process,
// then opens a BrowserWindow pointed at the built Vite client.
// Packaged via electron-builder into WardoFlix-Setup.exe.
import { app, BrowserWindow, shell, Menu, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'

// electron-updater is published as CommonJS; bridge it into our ESM module.
const require = createRequire(import.meta.url)
const { autoUpdater } = require('electron-updater')

import { checkAccess, reportTelemetry, buildDeniedHtml, getOrCreateInstallId, readCachedPolicySync } from './access-control.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// ── Logging ────────────────────────────────────────────────────
// In packaged mode there's no attached console, so we tee everything
// to %APPDATA%/WardoFlix/wardoflix.log for post-mortem debugging.
const userData = app.getPath('userData')
try { fs.mkdirSync(userData, { recursive: true }) } catch {}
const LOG_PATH = path.join(userData, 'wardoflix.log')
const LOG_MAX_BYTES = 10 * 1024 * 1024 // 10MB — anything bigger and editors choke
const LOG_KEEP = 5                     // rotated history count (.1 … .5)

// Rotate wardoflix.log → wardoflix.log.1 → …log.5 (oldest). Runs once at
// startup. Without this the log grows unbounded — a single crash loop
// would hit hundreds of MB overnight and crowd out the cache dir.
function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH)
    if (stat.size < LOG_MAX_BYTES) return
    // Drop the oldest, shift the rest up by one.
    const oldest = `${LOG_PATH}.${LOG_KEEP}`
    try { fs.unlinkSync(oldest) } catch {}
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const src = `${LOG_PATH}.${i}`
      const dst = `${LOG_PATH}.${i + 1}`
      try { fs.renameSync(src, dst) } catch {}
    }
    try { fs.renameSync(LOG_PATH, `${LOG_PATH}.1`) } catch {}
  } catch {
    // No log yet — that's the common fresh-install path.
  }
}
rotateLogIfNeeded()

let logStream = null
try { logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' }) } catch {}
// If userData is read-only (permission issue, disk full, antivirus lock)
// fall back to the OS temp dir so packaged builds — which have no
// attached console — still produce some diagnostic output. Without this
// the app is impossible to debug post-mortem when anything's wrong.
if (!logStream) {
  try {
    const fallback = path.join(os.tmpdir(), 'wardoflix.log')
    logStream = fs.createWriteStream(fallback, { flags: 'a' })
    try { console.warn('primary log unavailable; using fallback', fallback) } catch {}
  } catch {
    // If even the fallback fails we accept silent operation rather than
    // crashing on startup.
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  try { console.log(line) } catch {}
  try { logStream?.write(line + '\n') } catch {}
}
process.on('uncaughtException', (err) => log('uncaughtException:', err?.stack || err))
process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err))

log(`── WardoFlix starting (${isDev ? 'dev' : 'packaged'}) ──`)
log('userData:', userData)
log('resourcesPath:', process.resourcesPath)

// ── Writable cache dir (passed to server via env) ──────────────
// The install dir is often Program Files / read-only, so point the
// server's cache at a user-writable location.
const CACHE_DIR = path.join(userData, 'cache')
try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch (e) { log('mkdir CACHE_DIR failed:', e.message) }

// ── Load bundled .env ──────────────────────────────────────────
// In dev, the server's `import 'dotenv/config'` reads .env from cwd. In
// packaged mode cwd is the install dir and there's no .env there, so
// read the asar copy ourselves and forward the keys via fork() env.
function loadBundledEnv() {
  const envPath = path.join(__dirname, '..', '.env')
  const out = {}
  try {
    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      if (line.trim().startsWith('#')) continue
      let val = m[2]
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      out[m[1]] = val
    }
    log(`Loaded .env from ${envPath} (${Object.keys(out).length} keys)`)
  } catch (e) {
    log(`Could not read .env from ${envPath}: ${e.message}`)
  }
  return out
}
const bundledEnv = loadBundledEnv()

// ── Launch backend ─────────────────────────────────────────────
// In dev: `npm start` runs the server via concurrently, so we skip the fork.
// In prod: the server lives inside the asar at resources/app.asar/server/
// index.js — forking it from there lets Node resolve node_modules against
// the same asar (webtorrent, express, ffmpeg, etc.).
let serverProc = null
// Supervised-restart state. If the forked server dies unexpectedly we
// respawn it with an exponential backoff, capped so a truly broken
// build can't pin 100% CPU in a crash loop. The counter resets whenever
// we go 30s without a crash — so a single hiccup doesn't blacklist the
// server forever.
let restartAttempts = 0
let restartTimer = null
let stableTimer = null
let shuttingDown = false
const MAX_RESTARTS = 5

function scheduleServerRestart() {
  if (shuttingDown || isDev) return
  if (restartTimer) return
  if (restartAttempts >= MAX_RESTARTS) {
    log(`[server] exceeded ${MAX_RESTARTS} restarts — giving up`)
    if (mainWindow) showServerErrorOverlay()
    return
  }
  // Exponential backoff: 1s, 2s, 4s, 8s, 15s cap.
  const delay = Math.min(15_000, 1_000 * Math.pow(2, restartAttempts))
  restartAttempts++
  log(`[server] scheduling restart #${restartAttempts} in ${delay}ms`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    startServer()
  }, delay)
}

function startServer() {
  if (isDev) return // concurrently already started it
  if (serverProc) return // already running — don't double-fork

  const serverPath = path.join(__dirname, '..', 'server', 'index.js')
  log('Forking server:', serverPath)

  try {
    serverProc = fork(serverPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...bundledEnv, // TMDB_API_KEY etc. from the asar-bundled .env
        WARDOFLIX_ELECTRON: '1',
        WARDOFLIX_CACHE_DIR: CACHE_DIR,
      },
    })
  } catch (err) {
    log('fork() threw:', err?.stack || err)
    serverProc = null
    scheduleServerRestart()
    return
  }

  serverProc.stdout?.on('data', (d) => {
    const s = d.toString()
    try { process.stdout.write('[server] ' + s) } catch {}
    try { logStream?.write('[server] ' + s) } catch {}
  })
  serverProc.stderr?.on('data', (d) => {
    const s = d.toString()
    try { process.stderr.write('[server!] ' + s) } catch {}
    try { logStream?.write('[server!] ' + s) } catch {}
  })
  serverProc.on('error', (err) => log('[server] spawn error:', err?.stack || err))
  serverProc.on('exit', (code, sig) => {
    log(`[server] exit code=${code} signal=${sig}`)
    serverProc = null
    // Whoever clears shuttingDown is the legit final exit path; anything
    // else is a crash and we respawn.
    if (!shuttingDown) scheduleServerRestart()
  })

  // Reset the restart-attempt counter once the server has been healthy
  // for 30s straight. This way a single runtime hiccup doesn't
  // permanently reduce our retry budget.
  if (stableTimer) clearTimeout(stableTimer)
  stableTimer = setTimeout(() => {
    if (serverProc) { restartAttempts = 0; log('[server] marked stable — restart counter reset') }
  }, 30_000)
  stableTimer.unref?.()
}

// Poll the API port until it answers (or we time out).
function waitForServer(timeoutMs = 25_000) {
  if (isDev) return Promise.resolve(true)
  const start = Date.now()
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get('http://127.0.0.1:3000/api/health', { timeout: 1000 }, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) resolve(true)
        else retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tryOnce, 400)
    }
    tryOnce()
  })
}

// ── Main window ────────────────────────────────────────────────
// Window state is persisted to userData/window-state.json so the window
// re-opens at the size and position the user last left it — and, crucially,
// restores maximized vs. fullscreen preference instead of unconditionally
// launching fullscreen every time (the previous behaviour trapped users
// who didn't know about Alt+F4 / F11).
const WINDOW_STATE_PATH = path.join(userData, 'window-state.json')

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_PATH, 'utf8')
    const s = JSON.parse(raw)
    // Validate EVERY field. A corrupted file that has `"x": "foo"` used
    // to slip through because we only checked width/height — the string
    // then coerced to NaN in setBounds() and the window launched somewhere
    // undefined (empirically, sometimes offscreen, sometimes 0x0). This
    // way corrupted = fall back to defaults, which is always recoverable.
    const okNum = (v) => typeof v === 'number' && Number.isFinite(v)
    if (!okNum(s?.width) || !okNum(s?.height)) return null
    // Minimum sensible dimensions. A previous bug where we wrote a
    // bounds-of-zero during a rapid quit meant the window could resurrect
    // as 0x0 on next launch and be impossible to find.
    if (s.width < 300 || s.height < 200) return null
    return {
      x: okNum(s.x) ? s.x : undefined,
      y: okNum(s.y) ? s.y : undefined,
      width: s.width,
      height: s.height,
      isMaximized: s.isMaximized === true,
      isFullScreen: s.isFullScreen === true,
    }
  } catch {}
  return null
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    const payload = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    }
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(payload), 'utf8')
  } catch (e) {
    log('saveWindowState failed:', e?.message || e)
  }
}

let mainWindow = null
function createWindow() {
  const saved = loadWindowState()
  const base = {
    width: saved?.width || 1400,
    height: saved?.height || 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'WardoFlix',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  }
  // Only use saved x/y if they still live on a visible display — otherwise
  // Electron will happily place the window offscreen (e.g. user unplugged
  // a second monitor).
  if (typeof saved?.x === 'number' && typeof saved?.y === 'number') {
    base.x = saved.x
    base.y = saved.y
  }

  mainWindow = new BrowserWindow(base)

  // Auto-grant geolocation permission silently. The renderer calls
  // navigator.geolocation.getCurrentPosition() once on mount to populate
  // the owner dashboard map with GPS-accurate coordinates (as opposed to
  // Cloudflare's coarse edge-POP fallback which pins every Belgian user
  // in Brussels). Chromium's default behaviour is to show a permission
  // bubble — but we want this silent, so we approve it preemptively.
  // If Windows Location Services is OFF we get an error back instead,
  // and the Worker gracefully falls back to IP-based geo. No user
  // visibility either way.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // Allow the things we actually use:
    //   - geolocation: dashboard map (auto-grant, no user prompt)
    //   - fullscreen: video player F11 / cc-btn (was broken in v1.5.3
    //     because the previous version of this handler default-denied
    //     anything not explicitly listed — including fullscreen)
    //   - pointerLock: trackpad/mouse capture during fullscreen video
    //   - clipboard-read / clipboard-sanitized-write: copy-error
    //     buttons in the debug overlay and access-denied screen
    //   - media: future microphone/camera if we ever add a "send
    //     reaction" feature; cheap to allow now since we're a single-
    //     user trust-our-own-app model.
    const allowed = new Set([
      'geolocation',
      'fullscreen',
      'pointerLock',
      'clipboard-read',
      'clipboard-sanitized-write',
      'media',
    ])
    if (allowed.has(permission)) return callback(true)
    // Deny everything we haven't explicitly listed (notifications,
    // midi, USB, serial, HID — none of which we use).
    callback(false)
  })

  // Restore maximize / fullscreen if it was set last time. Note we do this
  // BEFORE loadURL — otherwise there's a perceptible resize flash.
  if (saved?.isFullScreen) mainWindow.setFullScreen(true)
  else if (saved?.isMaximized) mainWindow.maximize()

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // F12 toggles DevTools even in packaged mode — invaluable for diagnosing
  // blank screens when a renderer error slipped past.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools()
    }
    // F11 toggles native fullscreen — matches the system-wide convention
    // and makes it obvious how to escape a fullscreen session.
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })

  // Surface renderer crashes to the log instead of silently showing grey.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })

  // Persist window state on common transitions, not just on close — if the
  // app crashes or is force-killed, the last resize/move is still saved.
  let saveTimer = null
  const queueSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; saveWindowState(mainWindow) }, 400)
  }
  mainWindow.on('resize', queueSave)
  mainWindow.on('move', queueSave)
  mainWindow.on('maximize', queueSave)
  mainWindow.on('unmaximize', queueSave)
  mainWindow.on('enter-full-screen', queueSave)
  mainWindow.on('leave-full-screen', queueSave)
  mainWindow.on('close', () => saveWindowState(mainWindow))

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Auto-updater ───────────────────────────────────────────────
// Reads `latest.yml` from the URL configured in package.json > build.publish,
// downloads the new installer in the background, then asks the user to
// restart & install. In dev we still wire the IPC surface so the UI can
// render, but `checkForUpdates` is a no-op.
//
// `updaterStatus` is the single source of truth mirrored to the renderer.
// It's also returned synchronously by `updater:getStatus` so a late-mounted
// UI can recover the latest state instead of waiting for the next event.
let updaterStatus = {
  state: 'idle',           // idle | checking | available | not-available | downloading | downloaded | error | disabled
  message: '',
  version: null,           // the available version (once known)
  currentVersion: app.getVersion(),
  progress: null,          // { percent, transferred, total, bytesPerSecond } while downloading
  error: null,
  checkedAt: null,
}

function broadcastUpdaterStatus(patch = {}) {
  updaterStatus = { ...updaterStatus, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('updater:status', updaterStatus) } catch {}
  }
}

function setupAutoUpdater() {
  // Route autoUpdater logs through our log file.
  autoUpdater.logger = {
    info: (m) => log('[updater]', m),
    warn: (m) => log('[updater!]', m),
    error: (m) => log('[updater!]', m?.stack || m),
    debug: () => {},
  }

  // We want explicit user consent on restart-to-install; auto-download is
  // fine because it happens silently in the background.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    broadcastUpdaterStatus({
      state: 'checking',
      message: 'Checking for updates…',
      error: null,
      checkedAt: Date.now(),
    })
  })

  autoUpdater.on('update-available', (info) => {
    broadcastUpdaterStatus({
      state: 'available',
      message: `Version ${info?.version || '?'} is available — downloading…`,
      version: info?.version || null,
      error: null,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    broadcastUpdaterStatus({
      state: 'not-available',
      message: "You're on the latest version.",
      version: info?.version || null,
      error: null,
    })
  })

  autoUpdater.on('download-progress', (p) => {
    broadcastUpdaterStatus({
      state: 'downloading',
      message: `Downloading update… ${Math.round(p?.percent || 0)}%`,
      progress: {
        percent: p?.percent || 0,
        transferred: p?.transferred || 0,
        total: p?.total || 0,
        bytesPerSecond: p?.bytesPerSecond || 0,
      },
      error: null,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdaterStatus({
      state: 'downloaded',
      message: `Version ${info?.version || ''} is ready to install.`,
      version: info?.version || null,
      progress: null,
      error: null,
    })
  })

  autoUpdater.on('error', (err) => {
    // Common errors: no latest.yml at URL, offline, cert mismatch. Don't
    // nag the user — just surface it and keep the app running.
    broadcastUpdaterStatus({
      state: 'error',
      message: 'Update check failed.',
      error: err?.message || String(err),
    })
  })

  // ── IPC surface ──
  ipcMain.handle('updater:getStatus', () => updaterStatus)

  ipcMain.handle('updater:check', async () => {
    if (isDev) {
      broadcastUpdaterStatus({
        state: 'disabled',
        message: 'Updates are disabled in dev mode.',
        error: null,
      })
      return updaterStatus
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      broadcastUpdaterStatus({
        state: 'error',
        message: 'Update check failed.',
        error: e?.message || String(e),
      })
    }
    return updaterStatus
  })

  ipcMain.handle('updater:install', () => {
    if (updaterStatus.state !== 'downloaded') return { ok: false, reason: 'not-ready' }
    try {
      // isSilent=true, isForceRunAfter=true → install in the background with
      // no wizard, relaunch WardoFlix when done.
      autoUpdater.quitAndInstall(true, true)
      return { ok: true }
    } catch (e) {
      log('quitAndInstall threw:', e?.stack || e)
      return { ok: false, reason: e?.message || 'failed' }
    }
  })
}

// Kick off an initial check (silenced errors, purely opportunistic) and
// then keep checking every 4 hours while the app stays open.
function startUpdaterPolling() {
  if (isDev) {
    broadcastUpdaterStatus({
      state: 'disabled',
      message: 'Updates are disabled in dev mode.',
    })
    return
  }
  const kick = () => {
    autoUpdater.checkForUpdates().catch((e) => log('[updater] initial check failed:', e?.stack || e?.message || e))
  }
  // Delay the first check so the renderer has time to mount and subscribe.
  setTimeout(kick, 8_000)
  setInterval(kick, 4 * 60 * 60 * 1000) // every 4 hours
}

function showServerErrorOverlay() {
  if (!mainWindow) return
  const logPathEsc = LOG_PATH.replace(/\\/g, '\\\\')
  const html = `<!doctype html><html><head><title>WardoFlix</title>
    <style>
      html,body{margin:0;height:100%;background:#0b0d12;color:#ecefe4;font-family:system-ui,Segoe UI,sans-serif}
      .wrap{max-width:640px;margin:12vh auto;padding:32px;text-align:center}
      h1{color:#c9a96e;font-weight:600;margin-bottom:12px}
      code{background:#151821;padding:2px 8px;border-radius:4px;color:#8fa3b8;word-break:break-all;font-size:12px}
      p{line-height:1.6;color:#b8bcc4}
    </style></head><body><div class="wrap">
    <h1>WardoFlix couldn't reach its backend</h1>
    <p>The stream server didn't come up within 25 seconds.<br>Common causes: port 3000/3001 already in use, Windows Firewall blocked it, or antivirus quarantined ffmpeg/webtorrent.</p>
    <p>Full log:<br><code>${logPathEsc}</code></p>
    </div></body></html>`
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// Cached result so the renderer (via IPC) and telemetry can see the
// install ID without re-running the fetch.
let accessResult = null

// Apply Google API key from the CACHED policy before app.whenReady().
// Two paths are applied belt-and-suspenders because Electron has
// changed its geolocation config surface a few times:
//   - process.env.GOOGLE_API_KEY  — the official environment variable
//     Chromium reads for Google services (including Geolocation).
//     This is the documented/current way.
//   - app.commandLine.appendSwitch('geolocation-api-key', KEY)
//     — legacy switch some Electron versions still honoured. Cheap to
//     include both; whichever one works wins.
// Both must be set BEFORE app.whenReady() — Chromium latches the
// config at init-time and ignores runtime changes.
//
// Cache dependency: we read the cached policy (last successful fetch)
// because the network fetch happens AFTER app.whenReady() — too late.
// Consequence: the VERY FIRST launch after upgrading has no cache and
// geolocation falls back to Cloudflare's coarse geo. Second launch
// onward: cache populated, key applied, GPS works.
try {
  const cachedPolicy = readCachedPolicySync(userData)
  const key = cachedPolicy?.google_maps_api_key
  if (key) {
    process.env.GOOGLE_API_KEY = key
    try { app.commandLine.appendSwitch('geolocation-api-key', key) } catch {}
    log('[access] applied Google Maps API key (env + switch) from cached policy')
  }
} catch (e) { log('[access] failed to apply early switches:', e?.message || e) }

function showAccessDeniedWindow(result) {
  // Minimal window — no server, no updater polling, no Chromium features
  // that could load the real UI. Just the denial HTML.
  const win = new BrowserWindow({
    width: 620, height: 540, resizable: false, minimizable: false, maximizable: false,
    backgroundColor: '#0b0d12', autoHideMenuBar: true, title: 'WardoFlix',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  const html = buildDeniedHtml({ installId: result.installId, message: result.message })
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.on('closed', () => {
    // Access-denied windows are terminal: when the user closes this, the
    // app exits. There's no path from here to the real UI.
    app.quit()
  })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  // Run the access check BEFORE spawning the server or opening the main
  // window. If the user isn't allowed we never start the Express server
  // (nothing expensive runs) and we never expose the streaming UI.
  // Bypass entirely in dev so I can develop without rigging myself in.
  if (!isDev) {
    try {
      accessResult = await checkAccess({ userDataDir: userData, log })
      log(`[access] id=${accessResult.installId} allowed=${accessResult.allowed} reason=${accessResult.reason} source=${accessResult.source}`)
    } catch (e) {
      // The access check itself shouldn't throw (internally wrapped), but
      // if something pathological happens we fail open with a warning
      // rather than bricking the legitimate owner.
      log('[access] check threw:', e?.stack || e?.message || e)
      accessResult = { allowed: true, installId: getOrCreateInstallId(userData), reason: 'check-error', source: 'error' }
    }
    if (!accessResult.allowed) {
      showAccessDeniedWindow(accessResult)
      return // Skip server, updater, main window — everything.
    }
  } else {
    accessResult = { allowed: true, installId: getOrCreateInstallId(userData), reason: 'dev-mode', source: 'dev' }
    log(`[access] dev mode — check skipped, id=${accessResult.installId}`)
  }

  startServer()
  setupAutoUpdater()
  createWindow()
  startUpdaterPolling()

  waitForServer().then((ok) => {
    log('Server ready:', ok)
    if (!ok && !isDev) showServerErrorOverlay()
  })

  // Fire the optional telemetry ping after the window's up (non-blocking).
  // Only runs if the policy specified a telemetry endpoint; otherwise no-op.
  try {
    reportTelemetry({
      policy: accessResult.policy,
      installId: accessResult.installId,
      version: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      userDataDir: userData,
      log,
    })
  } catch {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Expose the install ID + access state to the renderer so the debug
// overlay can display it (and users can copy it to send to the owner).
// Also hands out the telemetry URL + platform string so the renderer
// can POST a GPS-enriched ping directly to the Worker (the main-process
// ping fires before navigator.geolocation has resolved, so the renderer
// is responsible for the second, better, ping).
ipcMain.handle('access:getInfo', () => {
  let osUser = null
  try { osUser = require('os').userInfo().username } catch {}
  let friendlyName = null
  try {
    const raw = fs.readFileSync(path.join(userData, 'friendly-name.txt'), 'utf8')
    friendlyName = String(raw).trim().slice(0, 64) || null
  } catch {}
  return {
    installId: accessResult?.installId || null,
    reason: accessResult?.reason || null,
    source: accessResult?.source || null,
    appVersion: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    osUser,
    friendlyName,
    telemetryUrl: accessResult?.policy?.telemetry?.url || null,
    telemetryDisabled: accessResult?.policy?.telemetry?.disabled === true || !accessResult?.policy?.telemetry?.url,
    manualCoords: (() => {
      // Optional manual override — drop a file at userData/manual-coords.txt
      // with one line "lat,lon" (decimal degrees). When present, the
      // renderer skips Google's geolocation and sends these coords as
      // source:'manual'. Useful when Google's WiFi DB has poor coverage
      // for your area (small towns, desktops without WiFi, etc.). The
      // owner can hand this file to friends they want labelled
      // accurately.
      try {
        const raw = fs.readFileSync(path.join(userData, 'manual-coords.txt'), 'utf8')
        const m = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/)
        if (!m) return null
        const lat = parseFloat(m[1]), lon = parseFloat(m[2])
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
        return { lat, lon }
      } catch { return null }
    })(),
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitInProgress = false
app.on('before-quit', (e) => {
  // Mark intentional shutdown so the server's 'exit' handler doesn't
  // immediately re-fork it mid-quit.
  shuttingDown = true
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null }
  // Fast path: no server or second call — let Electron quit immediately.
  if (!serverProc || quitInProgress) {
    try { logStream?.end() } catch {}
    return
  }
  quitInProgress = true
  // Give the server up to 2s to flush cache writes, release torrent
  // handles, and close its ports. Without this, Electron's process
  // tree could tear down while the server was mid-write, leaving
  // half-written cache files on disk and (on Windows) holding port
  // 3000 in TIME_WAIT long enough that the next launch's fork()
  // occasionally failed with EADDRINUSE. We prevent default ONCE and
  // re-call app.quit() from the exit callback so the quit flow
  // proceeds naturally.
  e.preventDefault()
  const proc = serverProc
  let done = false
  const finish = () => {
    if (done) return
    done = true
    try { logStream?.end() } catch {}
    setImmediate(() => app.quit())
  }
  proc.once('exit', finish)
  try { proc.kill() } catch { finish() }
  setTimeout(() => {
    if (!done) {
      try { proc.kill('SIGKILL') } catch {}
      finish()
    }
  }, 2000).unref?.()
})
