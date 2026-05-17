// Discord Rich Presence integration. Shows "Watching <Title>" in the
// user's Discord status bar with a small WardoFlix icon while a stream
// is active. Connects via Discord's local IPC (no internet, no token,
// just the official Discord client running on the same machine).
//
// Bring-up:
//   1. Owner creates a Discord application at
//      https://discord.com/developers/applications
//   2. Copies the Application ID from the General Information page
//   3. Pastes it into access.json under "discord_application_id"
//   4. Optional: uploads a small WardoFlix icon as a Rich Presence asset
//      named "wardoflix_logo" (used as the large image)
//
// Without an Application ID configured, this module is a no-op — the
// app runs fine, just no Discord presence.
//
// Privacy: presence is only sent to the LOCAL Discord client running
// on the user's machine. Discord then optionally surfaces the activity
// to the user's friends per the user's own privacy settings. Nothing
// touches WardoFlix's telemetry channel.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let RPC = null
try { RPC = require('discord-rpc') } catch {}

let client = null
let connected = false
let connectInFlight = false
let reconnectTimer = null
let pendingActivity = null
let currentApplicationId = null

function clearActivitySafely() {
  try { client?.clearActivity?.() } catch {}
}

function setActivitySafely(activity) {
  if (!client || !connected) return
  try {
    if (activity) client.setActivity(activity)
    else clearActivitySafely()
  } catch {}
}

// Connect to the Discord IPC socket. If Discord isn't running we
// silently fail and try again every 30s — once Discord launches the
// next attempt succeeds and any pending activity flushes through.
function ensureConnected(applicationId, log = () => {}) {
  if (!RPC) return // dependency missing
  if (!applicationId) return
  if (connected && currentApplicationId === applicationId) return
  if (connectInFlight) return
  // Application id changed → tear down + reconnect with the new id.
  if (client && currentApplicationId !== applicationId) {
    try { client.destroy() } catch {}
    client = null
    connected = false
  }
  if (!client) {
    try {
      client = new RPC.Client({ transport: 'ipc' })
      currentApplicationId = applicationId
      client.on('ready', () => {
        connected = true
        log('[discord-rpc] connected')
        if (pendingActivity) {
          setActivitySafely(pendingActivity)
          pendingActivity = null
        }
      })
      client.on('disconnected', () => {
        connected = false
        log('[discord-rpc] disconnected — will retry')
        scheduleReconnect(applicationId, log)
      })
    } catch (e) { log('[discord-rpc] client init failed:', e?.message || e); return }
  }
  connectInFlight = true
  client.login({ clientId: applicationId })
    .catch((e) => {
      log('[discord-rpc] login failed (Discord not running?):', e?.message || e)
      scheduleReconnect(applicationId, log)
    })
    .finally(() => { connectInFlight = false })
}

function scheduleReconnect(applicationId, log) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureConnected(applicationId, log)
  }, 30_000)
  reconnectTimer.unref?.()
}

// Public surface ────────────────────────────────────────────────

// Initialise the integration. `policy` is the access-control policy
// loaded at startup; we pull `discord_application_id` from it. Safe to
// call multiple times — subsequent calls update the activity / connect
// state without leaking sockets.
export function initDiscordPresence({ policy, log = () => {} }) {
  const appId = policy?.discord_application_id
  if (!appId) { log('[discord-rpc] no discord_application_id in policy — skipping'); return }
  ensureConnected(String(appId), log)
}

// Surface the currently-streaming title to Discord. Pass null/undefined
// to clear the activity (e.g. when the user closes the player).
//
// `meta` shape is whatever PlayerControls hands us: { title, season, episode, type }.
// We render:
//   - Large image: 'wardoflix_logo' (asset key in the Rich Presence
//     asset list — uploads not required, falls back gracefully if
//     missing). Tooltip: "WardoFlix".
//   - Details: title (e.g. "The Boys")
//   - State:   episode tag if TV, otherwise "Watching" / movie year
//   - Start:   timestamp now → Discord shows "elapsed XX:XX"
// v1.9.0 — sanitization. The renderer hands us a `meta` object via
// IPC; we never trust unbounded text reaching Discord (or anyone
// watching the user's profile). Strip control characters, cap
// length, sanitize season/episode to integers, and validate the
// final payload against Discord's documented per-field limits
// (128 chars). A malformed meta is silently dropped instead of
// throwing — Rich Presence is best-effort, not load-bearing.
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  const stripControl = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  const title = stripControl(meta.title || 'Untitled').slice(0, 96) || 'Untitled'
  const season = Number.isFinite(parseInt(meta.season)) ? parseInt(meta.season) : null
  const episode = Number.isFinite(parseInt(meta.episode)) ? parseInt(meta.episode) : null
  return { title, season, episode }
}

export function setStreamingActivity(meta, log = () => {}) {
  if (!RPC || !client) return // not initialised yet
  const clean = sanitizeMeta(meta)
  if (!clean) {
    pendingActivity = null
    setActivitySafely(null)
    return
  }
  const isTv = clean.season != null && clean.episode != null
  const state = isTv
    ? `S${String(clean.season).padStart(2, '0')}E${String(clean.episode).padStart(2, '0')}`
    : 'Watching'
  const activity = {
    details: `Watching ${clean.title}`.slice(0, 128),
    state: state.slice(0, 128),
    startTimestamp: Math.floor(Date.now() / 1000),
    largeImageKey: 'wardoflix_logo',
    largeImageText: 'WardoFlix',
    instance: false,
  }
  if (!connected) { pendingActivity = activity; return }
  setActivitySafely(activity)
}

export function clearStreamingActivity() {
  pendingActivity = null
  setActivitySafely(null)
}

export function teardownDiscordPresence() {
  try { client?.destroy?.() } catch {}
  client = null
  connected = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
}
