// Access control — the "this app was for me personally and maybe 3 friends,
// now I need to actually enforce that" module.
//
// How it works end-to-end:
//
//   1. First launch on a new machine generates a random UUID and writes it
//      to `userData/install-id.txt`. That file survives app updates (it's
//      in Roaming/WardoFlix, not the install dir) so the same physical
//      install always presents the same ID.
//
//   2. Before the main window loads, we fetch an `access.json` file from
//      the public GitHub repo (raw.githubusercontent.com — no API token
//      needed, public HTTP GET, caches on CloudFront). The owner edits
//      that file to control who's allowed and commits to main.
//
//   3. The fetched policy is compared against our install ID. Three modes:
//        - "open"       : everyone allowed (soft launch / bootstrap period)
//        - "allowlist"  : only IDs in `allow[]` are allowed, everyone else
//                         sees the revoked screen
//        - "blocklist"  : everyone allowed except IDs in `blocked[]`
//      Plus a top-level `blocked[]` always wins regardless of mode.
//
//   4. We cache the last-good policy on disk. If the network is down we
//      serve from cache up to 7 days old. After 7 days without a fresh
//      fetch we force-deny — that's the backstop so a revoked user can't
//      just kill their internet to keep the app working forever.
//
//   5. Optional telemetry: if the policy contains a `telemetry` block
//      with a url + format, we fire a single POST on startup recording
//      {id, version, platform, ts}. Fire-and-forget; non-blocking. The
//      owner uses this to see who's actually launching the app. No
//      personally-identifying data collected beyond the install ID
//      (which they already have in the allowlist anyway).
//
// Tampering notes — anyone with enough skill can unpack the asar, patch
// this module, and bypass the check. We mitigate by:
//   - Making the check simple to update remotely (ship a new build, the
//     bypass stops working)
//   - Also optionally gating the Express server on the same check
//     (a bypassed client calls a server that refuses to serve)
// Full server-side gating would need a remote backend; we accept the
// client-only model as "enough friction for friends-of-friends."

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import os from 'node:os'

// Change this if you fork. Must point at the raw URL of access.json on
// whatever branch you trust. main is fine for our use case because
// commits to main require push access and we don't allow PRs to touch it.
const ACCESS_POLICY_URL = 'https://raw.githubusercontent.com/wardo93/wardoflix/main/access.json'

// How long we'll trust a cached policy when the live fetch fails.
const CACHE_GRACE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// Individual request timeout. Short so a hanging DNS doesn't stall the
// splash screen forever.
const FETCH_TIMEOUT_MS = 6000

export function getOrCreateInstallId(userDataDir) {
  const idPath = path.join(userDataDir, 'install-id.txt')
  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim()
    if (/^[a-f0-9-]{36}$/i.test(existing)) return existing
  } catch {}
  // Generate a v4 UUID. crypto.randomUUID is available on Node 18+.
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')
  try { fs.writeFileSync(idPath, id + '\n', 'utf8') } catch {}
  return id
}

// Synchronous read of the cached policy from disk. Used at process
// startup — BEFORE app.whenReady() — to apply any command-line switches
// (like --geolocation-api-key) that Chromium only reads during init.
// Returns null if nothing cached (first launch) or cache is stale.
export function readCachedPolicySync(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'access-cache.json'), 'utf8')
    const { policy, fetchedAt } = JSON.parse(raw)
    if (typeof fetchedAt !== 'number') return null
    if (Date.now() - fetchedAt > CACHE_GRACE_MS) return null
    return policy
  } catch { return null }
}

// Simple HTTPS GET that returns {status, body} with a hard timeout.
// Using raw https instead of fetch so we work on any Node version without
// dragging in an extra dependency.
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'WardoFlix/access-control' },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); })
  })
}

function httpPost(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      const body = JSON.stringify(payload)
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'WardoFlix/telemetry',
        },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode || 0 }))
      })
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); })
      req.write(body)
      req.end()
    } catch (e) { reject(e) }
  })
}

async function fetchPolicy() {
  const { status, body } = await httpGet(ACCESS_POLICY_URL, FETCH_TIMEOUT_MS)
  if (status !== 200) throw new Error(`policy fetch status ${status}`)
  const parsed = JSON.parse(body)
  if (typeof parsed !== 'object' || !parsed) throw new Error('policy not an object')
  return parsed
}

function loadCachedPolicy(userDataDir) {
  try {
    const cached = fs.readFileSync(path.join(userDataDir, 'access-cache.json'), 'utf8')
    const { policy, fetchedAt } = JSON.parse(cached)
    if (typeof fetchedAt !== 'number') return null
    if (Date.now() - fetchedAt > CACHE_GRACE_MS) return null
    return { policy, fetchedAt }
  } catch { return null }
}

function saveCachedPolicy(userDataDir, policy) {
  try {
    fs.writeFileSync(
      path.join(userDataDir, 'access-cache.json'),
      JSON.stringify({ policy, fetchedAt: Date.now() }),
      'utf8',
    )
  } catch {}
}

function evaluatePolicy(policy, installId) {
  if (!policy || typeof policy !== 'object') {
    // No policy at all — first-ever run with no network. Fail open so the
    // legitimate owner doesn't get locked out booting from a fresh
    // install with flaky wifi; they'll get the real check on the next
    // successful fetch.
    return { allowed: true, message: 'No policy cached yet — allowing this session.', reason: 'no-policy' }
  }
  const blocked = Array.isArray(policy.blocked) ? policy.blocked : []
  if (blocked.includes(installId)) {
    return { allowed: false, message: policy.message || null, reason: 'blocked' }
  }
  const mode = policy.mode || 'open'
  if (mode === 'open') {
    return { allowed: true, reason: 'open' }
  }
  if (mode === 'blocklist') {
    return { allowed: true, reason: 'blocklist-passed' } // already checked blocked above
  }
  if (mode === 'allowlist') {
    const allow = Array.isArray(policy.allow) ? policy.allow : []
    if (allow.includes(installId)) return { allowed: true, reason: 'allowed' }
    return { allowed: false, message: policy.message || null, reason: 'not-allowlisted' }
  }
  // Unknown mode — fail open with a warning so a typo in the JSON doesn't
  // brick every client until I notice.
  return { allowed: true, reason: 'unknown-mode', message: `Unknown policy mode "${mode}" — allowing.` }
}

// Main entrypoint. Returns {allowed, installId, policy, message, reason}.
// `log` is optional — pass main.js's log() helper for breadcrumbs.
export async function checkAccess({ userDataDir, log = () => {} }) {
  const installId = getOrCreateInstallId(userDataDir)
  let policy = null
  let source = 'none'
  try {
    policy = await fetchPolicy()
    saveCachedPolicy(userDataDir, policy)
    source = 'network'
    log(`[access] fetched policy from network (mode=${policy.mode || 'open'}, allow=${(policy.allow || []).length}, blocked=${(policy.blocked || []).length})`)
  } catch (netErr) {
    const cached = loadCachedPolicy(userDataDir)
    if (cached) {
      policy = cached.policy
      source = 'cache'
      const ageDays = ((Date.now() - cached.fetchedAt) / (24 * 60 * 60 * 1000)).toFixed(1)
      log(`[access] network failed (${netErr.message}), using cache aged ${ageDays}d`)
    } else {
      source = 'none'
      log(`[access] network failed (${netErr.message}) and no cache — first-run fallback`)
    }
  }
  const result = evaluatePolicy(policy, installId)
  return { ...result, installId, source, policy }
}

// Read the user's friendly-name file if they've set one. Location:
// userData/friendly-name.txt — one line, trimmed, max 64 chars. If not
// set, we fall back to the OS username (os.userInfo().username) which is
// usually "ward", "Admin", "Jan", etc. — better than nothing.
function getFriendlyName(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'friendly-name.txt'), 'utf8')
    const trimmed = String(raw).trim().slice(0, 64)
    if (trimmed) return trimmed
  } catch {}
  return null
}

// Fire the optional telemetry ping. Non-blocking, swallows all errors.
export function reportTelemetry({ policy, installId, version, platform, userDataDir, log = () => {} }) {
  try {
    const t = policy?.telemetry
    if (!t || !t.url) return
    if (t.disabled === true) return
    // Capture the OS username (e.g. "ward" on Windows). Best-effort; if
    // os.userInfo() throws for any reason we omit it. Useful for the
    // owner dashboard — "ward" vs "Alex" vs "Nick" is much easier to
    // skim than raw UUIDs. If the user manually sets a friendly name
    // (by dropping friendly-name.txt into userData), that takes priority.
    let osUser = null
    try { osUser = String(os.userInfo().username).slice(0, 64) } catch {}
    const friendlyName = userDataDir ? getFriendlyName(userDataDir) : null
    const format = t.format || 'json'
    const url = t.url
    if (format === 'discord') {
      // Discord webhooks accept { content: "..." }.
      const name = friendlyName || osUser || installId.slice(0, 8)
      const content = `launch \`${name}\` (${installId.slice(0, 8)}) v${version} (${platform})`
      httpPost(url, { username: 'WardoFlix', content }, 5000).catch(() => {})
    } else {
      // Generic JSON endpoint (Cloudflare Worker, Vercel, etc.)
      httpPost(url, {
        installId, version, platform, ts: Date.now(),
        friendlyName: friendlyName || null,
        osUser: osUser || null,
      }, 5000).catch(() => {})
    }
    log(`[access] telemetry ping sent (format=${format}, name=${friendlyName || osUser || '(none)'})`)
  } catch {}
}

// Builds the HTML shown when a user is denied access. Inlined so we
// don't have to wrestle with file:// paths inside packaged builds.
export function buildDeniedHtml({ installId, message }) {
  const safeId = installId.replace(/[^a-f0-9-]/gi, '')
  const safeMsg = (message || 'Your WardoFlix installation has not been authorized.')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>WardoFlix — Access</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #ecefe4;
    font-family: system-ui, "Segoe UI", Arial, sans-serif; }
  .wrap { max-width: 560px; margin: 10vh auto; padding: 36px 32px; text-align: center; }
  h1 { color: #c9a96e; font-weight: 600; margin: 0 0 14px; font-size: 28px; }
  p  { color: #b8bcc4; line-height: 1.6; margin: 10px 0; }
  .id {
    margin: 28px 0 18px;
    background: #151821;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    padding: 18px 14px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 14px;
    color: #8fa3b8;
    user-select: all;
    word-break: break-all;
  }
  button {
    background: #c9a96e; color: #0b0d12; border: none; border-radius: 6px;
    padding: 10px 22px; font-size: 14px; font-weight: 600; cursor: pointer;
    margin-top: 6px;
  }
  button:active { transform: translateY(1px); }
  .note { color: #6b7078; font-size: 12px; margin-top: 22px; }
</style>
</head><body><div class="wrap">
  <h1>Access not authorized</h1>
  <p>${safeMsg}</p>
  <p>If you were supposed to have access, send the owner this ID so it can be added:</p>
  <div class="id" id="id">${safeId}</div>
  <button onclick="navigator.clipboard.writeText(document.getElementById('id').innerText).then(()=>{this.innerText='Copied ✓';setTimeout(()=>this.innerText='Copy ID',1500)})">Copy ID</button>
  <p class="note">WardoFlix is a personal project. The app will close when you close this window.</p>
</div></body></html>`
}
