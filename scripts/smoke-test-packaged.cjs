// v1.11.2 — Packaged-build smoke test.
//
// Wired into electron-builder's afterAllArtifactBuild hook so it runs
// AFTER the artifact is built but BEFORE publishing. If it throws
// (returns a rejected promise), electron-builder aborts the publish.
//
// The job: catch the v1.11.1 class of bug, where the dev tree imports
// a file that didn't actually make it into the asar bundle, so the
// packaged server crashes with ERR_MODULE_NOT_FOUND on every fork
// attempt and the watchdog gives up after 5 retries.
//
// How: spawn the packaged WardoFlix.exe in --no-window mode (we can't
// actually do that since we don't have a flag for it, so we spawn it
// in default mode), wait for /api/health on port 3000 to return 200
// within 25 seconds, then kill the test instance. If health never
// returns, dump the recent wardoflix.log and throw.
//
// CommonJS because "type": "module" in package.json makes .js files
// ESM, and electron-builder hooks must be CommonJS-shaped exports.

const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')

const TIMEOUT_MS = 25_000
const POLL_INTERVAL_MS = 500
const HEALTH_URL = 'http://127.0.0.1:3000/api/health'

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 800 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode === 200 && body.includes('"ok":true')) {
          resolve({ ok: true, body })
        } else {
          resolve({ ok: false, reason: `status=${res.statusCode} body=${body.slice(0, 200)}` })
        }
      })
    })
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'health-timeout' }) })
  })
}

function pollUntilHealthy(deadline) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() > deadline) {
        reject(new Error(`smoke test: /api/health never returned 200 within ${TIMEOUT_MS}ms`))
        return
      }
      const r = await probeHealth()
      if (r.ok) { resolve(r); return }
      setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  })
}

function dumpRecentLog() {
  // Try the user-data log path. On Windows that's
  // %APPDATA%\WardoFlix\wardoflix.log.
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const logPath = path.join(appData, 'WardoFlix', 'wardoflix.log')
  if (!fs.existsSync(logPath)) {
    console.error(`[smoke] no log at ${logPath}`)
    return
  }
  try {
    const buf = fs.readFileSync(logPath, 'utf8')
    const tail = buf.split('\n').slice(-40).join('\n')
    console.error('[smoke] tail of wardoflix.log:\n' + tail)
  } catch (e) {
    console.error('[smoke] could not read log:', e.message)
  }
}

async function smokeTest(context) {
  // context.artifactPaths is an array of every file electron-builder
  // produced; we want the unpacked exe in release/win-unpacked/WardoFlix.exe
  // (a sibling of the NSIS installer). electron-builder also exposes
  // context.outDir which is the release/ directory.
  const outDir = context?.outDir || path.join(__dirname, '..', 'release')
  const exePath = path.join(outDir, 'win-unpacked', 'WardoFlix.exe')

  if (!fs.existsSync(exePath)) {
    // On a non-Windows builder this path doesn't exist; skip with a
    // warning rather than failing the build.
    console.warn(`[smoke] ${exePath} not found — skipping smoke test (non-Windows build?)`)
    return
  }

  // v1.14.0 — verify the ffmpeg binary actually made it into the
  // packaged app.asar.unpacked. /api/health (checked below) does NOT
  // spawn ffmpeg, so a mis-packaged binary would pass the health gate
  // yet leave every transcode broken for users — a silent failure
  // exactly like the ones this whole safety net exists to prevent.
  // After switching @ffmpeg-installer → ffmpeg-static this guard makes
  // sure the asarUnpack glob is right and the binary is present +
  // executable.
  const unpackedRoot = path.join(outDir, 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static')
  const ffName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffPath = path.join(unpackedRoot, ffName)
  if (!fs.existsSync(ffPath)) {
    console.error(`[smoke] FAIL: bundled ffmpeg not found at ${ffPath}`)
    console.error('[smoke] The transcode pipeline would be broken for every user. Check build.asarUnpack includes node_modules/ffmpeg-static/**/*')
    throw new Error('packaged ffmpeg binary missing')
  }
  try {
    const v = require('child_process').execFileSync(ffPath, ['-version'], { encoding: 'utf8' }).split('\n')[0]
    console.log(`[smoke] bundled ffmpeg present + runnable: ${v}`)
  } catch (e) {
    console.error(`[smoke] FAIL: bundled ffmpeg present but not executable: ${e.message}`)
    throw new Error('packaged ffmpeg not executable')
  }

  console.log(`[smoke] booting packaged installer at ${exePath} (timeout ${TIMEOUT_MS}ms)`)

  // Kill anything currently listening on 3000 so the test instance can
  // bind. Tolerant: if there's nothing there, we don't care.
  try {
    const probe = await probeHealth()
    if (probe.ok) {
      console.warn('[smoke] port 3000 already in use by an existing WardoFlix — the test may be polling the WRONG instance.')
      console.warn('[smoke] Aborting to avoid false positives. Kill the existing app and rerun.')
      throw new Error('port 3000 already in use')
    }
  } catch (e) {
    if (e?.message === 'port 3000 already in use') throw e
    // health-probe errored = port is free, that's what we want.
  }

  const child = spawn(exePath, [], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let earlyExit = false
  child.on('exit', (code, signal) => {
    earlyExit = true
    console.error(`[smoke] WardoFlix.exe exited early (code=${code} signal=${signal})`)
  })

  // Give the parent Electron process up to TIMEOUT_MS to fork the server,
  // wait for it to boot, and answer /api/health.
  const deadline = Date.now() + TIMEOUT_MS
  let healthResult
  try {
    healthResult = await pollUntilHealthy(deadline)
  } catch (e) {
    console.error(`[smoke] ${e.message}`)
    if (earlyExit) {
      console.error('[smoke] WardoFlix.exe died before /api/health came up')
    }
    dumpRecentLog()
    // Best-effort cleanup
    try { child.kill() } catch {}
    // Use taskkill on Windows so the Electron parent + all renderer/
    // GPU children die together; child.kill() only signals the top-level.
    if (process.platform === 'win32') {
      try { require('child_process').execSync(`taskkill /F /IM WardoFlix.exe /T`, { stdio: 'ignore' }) } catch {}
    }
    throw new Error('packaged server failed smoke test — see log above')
  }

  console.log(`[smoke] /api/health OK: ${healthResult.body.slice(0, 120)}`)

  // Kill the test instance so it doesn't linger on the dev machine.
  try { child.kill() } catch {}
  if (process.platform === 'win32') {
    try { require('child_process').execSync(`taskkill /F /IM WardoFlix.exe /T`, { stdio: 'ignore' }) } catch {}
  }
  console.log('[smoke] packaged server boots cleanly — publish gate PASSED')
}

// electron-builder afterAllArtifactBuild hook signature: async function(context)
// that returns either nothing (success), throws (abort), or returns an array
// of extra artifact paths to upload. We never return extras; we just throw
// on failure.
module.exports = async function afterAllArtifactBuild(context) {
  try {
    await smokeTest(context)
  } catch (e) {
    // Re-throw so electron-builder aborts the publish step.
    throw e
  }
}
