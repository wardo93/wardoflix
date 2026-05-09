// Local-folder updater. Drop-in replacement for `electron-updater` that
// reads update info from a local directory on disk instead of GitHub
// releases. Used while the GitHub publish flow is on pause — the build
// script (`npm run dist:win`) drops `WardoFlix-Setup-X.Y.Z.exe`,
// `.exe.blockmap`, and `latest.yml` into `release/`, and this updater
// notices the new version and offers the install.
//
// Mirrors the bits of the electron-updater event API we actually use,
// so it slots in without touching the existing IPC plumbing or the
// renderer's UpdaterIndicator component:
//
//   .logger                                       (set by main.js)
//   .autoDownload, .autoInstallOnAppQuit, .allowDowngrade  (toggles)
//   .on('checking-for-update', cb)
//   .on('update-available',     cb)               with { version, ... }
//   .on('update-not-available', cb)               with { version, ... }
//   .on('download-progress',    cb)               with { percent, transferred, total, bytesPerSecond }
//   .on('update-downloaded',    cb)               with { version, ... }
//   .on('error',                cb)
//   .checkForUpdates()                            → Promise<UpdateCheckResult>
//   .quitAndInstall(silent, forceRunAfter)
//
// "Download" is a file copy from the configured path to userData. On
// install we spawn the .exe with NSIS silent flags so it replaces the
// install directory and re-launches the new version automatically.
//
// On a friend's machine the configured local path won't exist, so the
// check fails silently (state: 'error', message: bubbled up to the UI
// but non-fatal). They just don't auto-update — which is exactly the
// behaviour the owner asked for during the GitHub-publish hiatus.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'

class LocalUpdater extends EventEmitter {
  constructor() {
    super()
    this.localPath = null
    // The .exe we copied into userData and that quitAndInstall will
    // execute. Cleared after a successful check that finds no update,
    // so a stale pending file doesn't stick around forever.
    this.pendingInstaller = null
    // electron-updater compat flags. `autoDownload=false` is honoured
    // — checkForUpdates() returns the metadata but doesn't copy the
    // installer, mirroring electron-updater's contract. autoInstallOnAppQuit
    // we accept but never act on: we don't wire into 'before-quit'
    // because the app's existing before-quit handler in main.js is
    // already complex (server teardown, log flush) and we'd rather not
    // race it. The user always installs explicitly via the UI button.
    this.autoDownload = true
    this.autoInstallOnAppQuit = true
    this.allowDowngrade = false
    // Plain console fallback so failures show up even if main.js
    // forgot to wire .logger. main.js overwrites this immediately.
    this.logger = console
    // De-dupe concurrent checks. The 4-hour poll could fire while
    // a previous check is still running on a slow disk; without this
    // the renderer would see double `checking-for-update` events.
    this._checking = false
  }

  setLocalPath(p) {
    this.localPath = p && typeof p === 'string' ? p : null
    try { this.logger.info?.(`[local-updater] localPath set to ${this.localPath || '(none)'}`) } catch {}
  }

  async checkForUpdates() {
    if (this._checking) {
      try { this.logger.info?.('[local-updater] check already in progress, skipping') } catch {}
      return
    }
    this._checking = true
    this.emit('checking-for-update')

    try {
      if (!this.localPath) {
        // Friend builds will hit this — the .env var isn't set, the
        // path is null. Don't spam errors; just say "no updates" so
        // the UI shows a clean "you're on the latest version" state.
        this.emit('update-not-available', { version: app.getVersion() })
        return
      }

      const ymlPath = path.join(this.localPath, 'latest.yml')
      if (!fs.existsSync(ymlPath)) {
        // Same fallback as no-localPath. The owner has a release/ dir
        // but might have wiped it; treat as "nothing to update to".
        try { this.logger.info?.(`[local-updater] no latest.yml at ${ymlPath}`) } catch {}
        this.emit('update-not-available', { version: app.getVersion() })
        return
      }

      const yml = fs.readFileSync(ymlPath, 'utf8')
      const info = parseLatestYml(yml)
      if (!info?.version || !info?.fileName) {
        const msg = `Malformed latest.yml at ${ymlPath} — missing version or file name`
        try { this.logger.warn?.('[local-updater]', msg) } catch {}
        this.emit('error', new Error(msg))
        return
      }

      const installerPath = path.join(this.localPath, info.fileName)
      if (!fs.existsSync(installerPath)) {
        const msg = `Installer referenced by latest.yml is missing on disk: ${installerPath}`
        try { this.logger.warn?.('[local-updater]', msg) } catch {}
        this.emit('error', new Error(msg))
        return
      }

      const currentVersion = app.getVersion()
      const cmp = compareSemver(info.version, currentVersion)
      // We're on a newer or equal version → nothing to do, unless the
      // user explicitly enabled allowDowngrade.
      if (cmp <= 0 && !this.allowDowngrade) {
        try { this.logger.info?.(`[local-updater] latest=${info.version} <= current=${currentVersion}; nothing to do`) } catch {}
        // Clear any stale pending file so a half-finished previous
        // check doesn't trick the UI into showing "ready to install".
        this.pendingInstaller = null
        this.emit('update-not-available', { version: info.version, currentVersion })
        return
      }

      try { this.logger.info?.(`[local-updater] update available: ${currentVersion} → ${info.version}`) } catch {}
      this.emit('update-available', {
        version: info.version,
        currentVersion,
        releaseDate: info.releaseDate || null,
        path: info.fileName,
      })

      if (this.autoDownload) {
        await this._copy(installerPath, info)
      }
    } catch (e) {
      try { this.logger.error?.('[local-updater] check failed:', e?.stack || e?.message || e) } catch {}
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    } finally {
      this._checking = false
    }
  }

  async _copy(srcInstaller, info) {
    try {
      const userData = app.getPath('userData')
      const pendingDir = path.join(userData, 'pending-updates')
      try { fs.mkdirSync(pendingDir, { recursive: true }) } catch {}

      // Wipe older pending files so we don't accumulate gigabytes of
      // stale installers if the user updates often. Keep it simple:
      // delete every .exe under pending-updates that isn't the one
      // we're about to write.
      const dest = path.join(pendingDir, path.basename(srcInstaller))
      try {
        for (const name of fs.readdirSync(pendingDir)) {
          if (name === path.basename(dest)) continue
          if (name.toLowerCase().endsWith('.exe') || name.toLowerCase().endsWith('.exe.blockmap')) {
            try { fs.unlinkSync(path.join(pendingDir, name)) } catch {}
          }
        }
      } catch {}

      const total = fs.statSync(srcInstaller).size
      // Emit a 0% before any data flows so the UI can show the bar
      // immediately instead of waiting for the first chunk to land.
      this.emit('download-progress', { percent: 0, transferred: 0, total, bytesPerSecond: 0 })

      await new Promise((resolve, reject) => {
        const reader = fs.createReadStream(srcInstaller)
        const writer = fs.createWriteStream(dest)
        let transferred = 0
        let lastEmitAt = 0
        const startedAt = Date.now()

        reader.on('data', (chunk) => {
          transferred += chunk.length
          const now = Date.now()
          // Emit at most every 100ms so we don't flood the IPC channel.
          // Always emit the last tick so the UI lands on 100%.
          if (now - lastEmitAt > 100 || transferred === total) {
            const elapsed = (now - startedAt) / 1000
            const bps = elapsed > 0 ? transferred / elapsed : 0
            this.emit('download-progress', {
              percent: total > 0 ? (transferred / total) * 100 : 100,
              transferred,
              total,
              bytesPerSecond: bps,
            })
            lastEmitAt = now
          }
        })

        reader.on('error', reject)
        writer.on('error', reject)
        writer.on('finish', resolve)
        reader.pipe(writer)
      })

      this.pendingInstaller = dest
      try { this.logger.info?.(`[local-updater] installer copied to ${dest}`) } catch {}
      this.emit('update-downloaded', {
        version: info.version,
        releaseDate: info.releaseDate || null,
        path: dest,
      })
    } catch (e) {
      try { this.logger.error?.('[local-updater] copy failed:', e?.stack || e?.message || e) } catch {}
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }

  // electron-updater contract: silent=true skips the wizard, forceRunAfter
  // re-launches the app once install completes. NSIS supports both via
  // command-line flags.
  quitAndInstall(silent = true, forceRunAfter = true) {
    if (!this.pendingInstaller) {
      throw new Error('No pending installer to run. Did checkForUpdates() resolve with an update?')
    }
    if (!fs.existsSync(this.pendingInstaller)) {
      throw new Error(`Pending installer no longer exists: ${this.pendingInstaller}`)
    }

    // NSIS silent install:
    //   /S          — fully silent, no UI
    //   --force-run — custom flag that the NSIS shortcut helpers honour
    //                 to re-launch after install. electron-builder's NSIS
    //                 template wires this up automatically when the user
    //                 doesn't pass /D=...
    const args = []
    if (silent) args.push('/S')
    if (forceRunAfter) args.push('--force-run')

    try { this.logger.info?.(`[local-updater] launching ${this.pendingInstaller} ${args.join(' ')}`) } catch {}

    try {
      const child = spawn(this.pendingInstaller, args, {
        detached: true,
        stdio: 'ignore',
      })
      // Detach so the installer outlives our process — we're about to
      // quit ourselves so it can replace files in our install dir.
      child.unref()
    } catch (e) {
      try { this.logger.error?.('[local-updater] spawn failed:', e?.stack || e?.message || e) } catch {}
      throw e
    }

    // Let the installer get its hooks in before we exit. A 200ms delay
    // is enough on every Windows version to avoid the "file in use"
    // race against our own .exe — the NSIS uninstaller has its own
    // wait-loop too, but starting it cleanly is faster.
    setTimeout(() => {
      try { app.quit() } catch {}
    }, 200)
  }
}

// Tiny YAML parser for electron-builder's latest.yml. We only need
// `version` and the file URL — pulling in `js-yaml` for two fields
// would be silly (and the format is dead simple). Tolerant of the two
// shapes electron-builder emits depending on whether `differentialPackage`
// is enabled:
//
//   version: 1.6.3
//   files:
//     - url: WardoFlix-Setup-1.6.3.exe
//       sha512: ...
//       size: ...
//   path: WardoFlix-Setup-1.6.3.exe
//   sha512: ...
//   releaseDate: '2026-04-27T20:43:39.258Z'
//
// We prefer the `files[].url` (newer format) and fall back to top-level
// `path` (older format).
function parseLatestYml(yml) {
  const out = {}
  const versionMatch = yml.match(/^\s*version:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m)
  if (versionMatch) out.version = versionMatch[1].trim()

  // Prefer files[0].url. Match the first occurrence; trim whitespace
  // and a leading dash so list-form lines parse the same as plain ones.
  const fileMatch = yml.match(/^\s*-?\s*url:\s*['"]?([^'"\r\n]+?\.exe)['"]?\s*$/m)
    || yml.match(/^\s*path:\s*['"]?([^'"\r\n]+?\.exe)['"]?\s*$/m)
  if (fileMatch) out.fileName = fileMatch[1].trim()

  const dateMatch = yml.match(/^\s*releaseDate:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m)
  if (dateMatch) out.releaseDate = dateMatch[1].trim()

  return out
}

// Strict semver-major.minor.patch comparison, ignoring pre-release tags.
// Returns 1, 0, or -1. Anything that doesn't parse as three integers is
// treated as 0 — i.e. "no update" — so a corrupt latest.yml never offers
// a downgrade by mistake.
function compareSemver(a, b) {
  const pa = String(a || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0
    const bi = pb[i] || 0
    if (ai > bi) return 1
    if (ai < bi) return -1
  }
  return 0
}

// Singleton — main.js imports this and treats it just like
// `require('electron-updater').autoUpdater`.
export const autoUpdater = new LocalUpdater()
