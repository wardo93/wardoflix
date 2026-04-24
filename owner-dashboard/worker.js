/**
 * WardoFlix telemetry Worker — Cloudflare edge.
 *
 * Two endpoints:
 *
 *   POST /ping
 *     Called by every WardoFlix client on launch. Body is JSON:
 *       { installId, version, platform, ts }
 *     We enrich with request.cf geolocation (country, city, lat/lon)
 *     and upsert into KV. Idempotent per install ID: firstSeen stays,
 *     lastSeen updates, launches++.
 *
 *   GET /list
 *     Owner-only. Requires header `x-dashboard-key: <DASHBOARD_KEY>`.
 *     Returns every stored install as a JSON array for the dashboard.
 *
 * Bindings required (set in Cloudflare dashboard):
 *   - PINGS          KV namespace binding
 *   - DASHBOARD_KEY  secret (any long random string — protects /list)
 */

const CORS_HEADERS = {
  // The client POSTs from within Electron (renderer or main process),
  // but we also allow `*` so the static dashboard.html file loaded
  // from your local filesystem (file://) can GET /list without a CORS
  // preflight failing.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Key',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (request.method === 'POST' && url.pathname === '/ping') {
      return handlePing(request, env)
    }

    if (request.method === 'GET' && url.pathname === '/list') {
      return handleList(request, env)
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({ ok: true, service: 'wardoflix-telemetry' })
    }

    return jsonResponse({ error: 'not found' }, 404)
  },
}

async function handlePing(request, env) {
  let body
  try { body = await request.json() } catch { return jsonResponse({ error: 'bad json' }, 400) }
  const installId = String(body.installId || '').trim()
  if (!/^[a-f0-9-]{10,64}$/i.test(installId)) {
    return jsonResponse({ error: 'bad installId' }, 400)
  }

  const version = String(body.version || '').slice(0, 32)
  const platform = String(body.platform || '').slice(0, 32)

  // request.cf is attached automatically by Cloudflare on every incoming
  // request when accessed from a Worker. Gives us coarse geolocation
  // (city-level) without any third-party lookup or storing raw IPs.
  const cf = request.cf || {}
  const geo = {
    country: cf.country || null,
    city: cf.city || null,
    region: cf.region || null,
    lat: typeof cf.latitude === 'string' ? parseFloat(cf.latitude) : (typeof cf.latitude === 'number' ? cf.latitude : null),
    lon: typeof cf.longitude === 'string' ? parseFloat(cf.longitude) : (typeof cf.longitude === 'number' ? cf.longitude : null),
    timezone: cf.timezone || null,
  }

  const now = Date.now()
  let record = null
  try {
    const existing = await env.PINGS.get(installId, { type: 'json' })
    if (existing && typeof existing === 'object') record = existing
  } catch {}

  if (!record) {
    record = {
      installId,
      firstSeen: now,
      lastSeen: now,
      launches: 1,
      version,
      platform,
      ...geo,
    }
  } else {
    record.lastSeen = now
    record.launches = (record.launches || 0) + 1
    record.version = version || record.version
    record.platform = platform || record.platform
    // Refresh geo (the user may have moved / changed networks)
    record.country = geo.country || record.country
    record.city    = geo.city    || record.city
    record.region  = geo.region  || record.region
    record.lat     = geo.lat     ?? record.lat
    record.lon     = geo.lon     ?? record.lon
    record.timezone = geo.timezone || record.timezone
  }

  // Index in a short list so /list can iterate without a list_keys call
  // (list_keys is rate-limited and opaque for cold starts).
  try {
    await env.PINGS.put(installId, JSON.stringify(record))
    // Also mirror into a zset-like index. We use a single key holding
    // an array of install IDs; it's fine at this scale (<1000 users).
    const indexRaw = await env.PINGS.get('__index', { type: 'json' })
    const index = Array.isArray(indexRaw) ? indexRaw : []
    if (!index.includes(installId)) {
      index.push(installId)
      // Cap index at 5000 just as a safety — if we ever get that big
      // something has gone very wrong.
      if (index.length <= 5000) {
        await env.PINGS.put('__index', JSON.stringify(index))
      }
    }
  } catch (e) {
    return jsonResponse({ error: 'storage failed', detail: String(e) }, 500)
  }

  return jsonResponse({ ok: true, launches: record.launches })
}

async function handleList(request, env) {
  const key = request.headers.get('x-dashboard-key') || ''
  if (!env.DASHBOARD_KEY || key !== env.DASHBOARD_KEY) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let index
  try {
    const raw = await env.PINGS.get('__index', { type: 'json' })
    index = Array.isArray(raw) ? raw : []
  } catch {
    index = []
  }

  // Fetch all records in parallel (KV reads are cheap and the free tier
  // allows 1000 per day per install, which at <1000 clients is fine).
  const records = []
  await Promise.all(index.map(async (id) => {
    try {
      const rec = await env.PINGS.get(id, { type: 'json' })
      if (rec) records.push(rec)
    } catch {}
  }))

  records.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  return jsonResponse({ count: records.length, records })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}
