#!/usr/bin/env node
// v1.12.0 — server boot regression test.
//
// Catches the v1.11.1 class: the server crashed on every fork because
// index.js imported a file that wasn't in the asar (ERR_MODULE_NOT_FOUND).
// `node --check` does NOT catch that — it's a runtime module-resolution
// error, not a syntax error. The only way to catch it cheaply is to
// actually boot the server and confirm it answers /api/health.
//
// This runs in CI on every push (ubuntu), giving fast feedback BEFORE a
// release is ever attempted. The packaged afterAllArtifactBuild smoke
// test is the release-time backstop on Windows; this is the per-push
// early-warning. Either one alone would have caught v1.11.1.
//
// Exit 0 = server booted and answered health within the window.
// Exit 1 = crashed, hung, or never answered — prints the captured output.

const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const SERVER = path.join(__dirname, '..', 'server', 'index.js')
const HEALTH = 'http://127.0.0.1:3000/api/health'
const BOOT_TIMEOUT_MS = 25_000
const POLL_MS = 500

// Isolated cache dir so the boot test never touches the user's real cache.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-boot-test-'))

let out = ''
let err = ''
let settled = false

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, WARDOFLIX_CACHE_DIR: cacheDir, WF_BOOT_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { err += d.toString() })

function cleanup() {
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL') } catch {} }, 3000).unref?.()
  try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch {}
}

function fail(reason) {
  if (settled) return
  settled = true
  console.error(`[boot-test] FAIL: ${reason}`)
  if (out.trim()) console.error('[boot-test] server stdout (tail):\n' + out.split('\n').slice(-25).join('\n'))
  if (err.trim()) console.error('[boot-test] server stderr (tail):\n' + err.split('\n').slice(-25).join('\n'))
  cleanup()
  process.exit(1)
}

function pass() {
  if (settled) return
  settled = true
  console.log('[boot-test] PASS: server booted and answered /api/health')
  cleanup()
  process.exit(0)
}

// If the child dies before health comes up, that's the v1.11.1 signature.
child.on('exit', (code, signal) => {
  if (!settled) fail(`server process exited early (code=${code} signal=${signal}) before answering /api/health — this is the v1.11.1 crash-loop class`)
})
child.on('error', (e) => fail(`failed to spawn server: ${e.message}`))

const deadline = Date.now() + BOOT_TIMEOUT_MS
function poll() {
  if (settled) return
  if (Date.now() > deadline) return fail(`/api/health did not answer within ${BOOT_TIMEOUT_MS}ms`)
  const req = http.get(HEALTH, { timeout: 1000 }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => {
      if (res.statusCode === 200 && body.includes('"ok":true')) pass()
      else setTimeout(poll, POLL_MS)
    })
  })
  req.on('error', () => setTimeout(poll, POLL_MS))
  req.on('timeout', () => { req.destroy(); setTimeout(poll, POLL_MS) })
}
poll()
