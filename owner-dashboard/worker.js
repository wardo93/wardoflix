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
  // Optional friendly identifiers that make the dashboard list readable.
  // osUser is auto-captured from os.userInfo().username on every launch
  // (e.g. "ward", "Jan"); friendlyName is user-overridable via
  // userData/friendly-name.txt. Bounded length so a malicious client
  // can't fill KV with a huge blob.
  const osUser = body.osUser ? String(body.osUser).slice(0, 64) : null
  const friendlyName = body.friendlyName ? String(body.friendlyName).slice(0, 64) : null

  // request.cf is attached automatically by Cloudflare on every incoming
  // request when accessed from a Worker. Gives us coarse geolocation
  // (CF edge-POP, not the user's actual location — for Belgian users
  // this always lands on "Brussels" regardless of where they really
  // are). Used as a fallback when the client hasn't sent GPS coords.
  const cf = request.cf || {}
  const cfLat = typeof cf.latitude === 'string' ? parseFloat(cf.latitude) : (typeof cf.latitude === 'number' ? cf.latitude : null)
  const cfLon = typeof cf.longitude === 'string' ? parseFloat(cf.longitude) : (typeof cf.longitude === 'number' ? cf.longitude : null)

  // Client-supplied GPS coords (from navigator.geolocation in the
  // renderer, which on Windows is backed by Windows Location Services
  // and gives ~10m accuracy when enabled). Prefer these over CF's IP
  // geo when present. Accuracy is in metres; anything bigger than
  // 50km is probably a bad reading and we fall back to IP.
  const hasGps = typeof body.lat === 'number' && typeof body.lon === 'number' &&
    body.lat >= -90 && body.lat <= 90 && body.lon >= -180 && body.lon <= 180 &&
    (typeof body.accuracy !== 'number' || body.accuracy < 50000)

  const geo = {
    country: cf.country || null,
    city: cf.city || null,
    region: cf.region || null,
    lat: hasGps ? body.lat : cfLat,
    lon: hasGps ? body.lon : cfLon,
    timezone: cf.timezone || null,
    // Keep the locality metadata (country/city) from CF even when GPS
    // provides the coords — CF's country code is accurate, and the GPS
    // fix doesn't include a human-readable city name.
    geoSource: hasGps ? 'gps' : 'ip',
    gpsAccuracy: hasGps && typeof body.accuracy === 'number' ? Math.round(body.accuracy) : null,
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
      osUser,
      friendlyName,
      ...geo,
    }
  } else {
    record.lastSeen = now
    record.launches = (record.launches || 0) + 1
    record.version = version || record.version
    record.platform = platform || record.platform
    // Keep the last-reported name fields. Null incoming doesn't clobber
    // a previously-known name (main-process ping doesn't always send
    // them; renderer ping does).
    if (osUser) record.osUser = osUser
    if (friendlyName) record.friendlyName = friendlyName
    // Refresh geo (the user may have moved / changed networks). Country
    // and city come from CF; coords come from GPS if supplied, else from
    // CF. Only OVERWRITE lat/lon when the incoming source is at least
    // as good as the stored source — otherwise the main-process IP ping
    // arriving after the renderer's GPS ping would overwrite 10m-accurate
    // Moerkerke coords with 50km-accurate Brussels coords. Order of
    // arrival isn't guaranteed, hence this guard.
    record.country = geo.country || record.country
    record.city    = geo.city    || record.city
    record.region  = geo.region  || record.region
    record.timezone = geo.timezone || record.timezone
    const incomingIsGps = geo.geoSource === 'gps'
    const storedIsGps = record.geoSource === 'gps'
    if (incomingIsGps || !storedIsGps) {
      record.lat = geo.lat ?? record.lat
      record.lon = geo.lon ?? record.lon
      record.geoSource = geo.geoSource || record.geoSource || 'ip'
      record.gpsAccuracy = geo.gpsAccuracy ?? record.gpsAccuracy ?? null
    }
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
