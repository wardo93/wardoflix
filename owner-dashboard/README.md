# Owner Dashboard — WardoFlix

Private tooling, NOT shipped with the app. This directory contains two things:

- **`worker.js`** — a Cloudflare Worker that receives launch pings from every WardoFlix client and stores them in KV along with the geolocation Cloudflare attaches at the edge.
- **`dashboard.html`** — a static HTML page that fetches the worker's data and plots every install on a world map.

Everything in here stays on your machine (and Cloudflare's edge). Nothing in the dashboard is referenced from the shipped app.

---

## One-time setup

### 1. Deploy the Worker

If you've never used Cloudflare Workers: sign up at https://dash.cloudflare.com/sign-up (free). Then:

1. Open the Cloudflare dashboard → **Workers & Pages** → **Create application** → **Create Worker**. Pick any name (e.g. `wardoflix-telemetry`). Click **Deploy**.
2. After it deploys, click **Edit code**. Delete the default snippet and paste the entire contents of `worker.js` into the editor. Click **Save and deploy**.
3. **Add a KV namespace** for storing pings:
   - Left sidebar → **Workers & Pages** → **KV** → **Create namespace**. Name it `WARDOFLIX_PINGS`.
   - Back on your Worker → **Settings** → **Variables and Secrets** → **KV Namespace Bindings** → **Add binding**. Variable name: `PINGS`, KV namespace: the one you just created. Click **Deploy**.
4. **Add a dashboard secret** so only you can read the pings:
   - Same Settings page → **Variables and Secrets** → **Secrets** → **Add secret**. Name: `DASHBOARD_KEY`. Value: any long random string (e.g. run `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` in a terminal). Save.
5. Copy the Worker's URL — something like `https://wardoflix-telemetry.your-subdomain.workers.dev`. You'll need it in the next two steps.

### 2. Enable telemetry in `access.json`

Edit `access.json` at the repo root and fill in the telemetry block:

```json
"telemetry": {
  "url": "https://wardoflix-telemetry.your-subdomain.workers.dev/ping",
  "format": "json",
  "disabled": false
}
```

Commit + push. Every client will now POST `{installId, version, platform, ts}` to `/ping` on launch, and the Worker enriches it with Cloudflare's edge-provided geolocation (country, city, lat/lon) before writing to KV. No client-side IP geolocation needed — CF does it for free.

### 3. Wire up the dashboard

Open `dashboard.html` in your editor. Find these two lines near the top of `<script>`:

```js
const WORKER_URL = 'https://wardoflix-telemetry.your-subdomain.workers.dev'
const DASHBOARD_KEY = 'paste-your-DASHBOARD_KEY-secret-here'
```

Replace with your values. Save. Open the file in your browser (double-click, or drag into Chrome). It loads Leaflet from a CDN, hits `WORKER_URL/list` with the secret in a header, and plots every install on an interactive world map.

Pins are color-coded by last-seen:
- **green** — launched within the last hour
- **yellow** — last hour to last 24 hours
- **grey** — older than 24 hours

Click a pin to see the install ID, version, platform, country, city, first/last seen timestamps, total launches. Hover over the left sidebar to filter.

---

## What gets stored

Per install ID, one KV entry:

```json
{
  "installId": "a7b3c1d0-...",
  "firstSeen": 1735067200000,
  "lastSeen": 1735090400000,
  "launches": 42,
  "version": "1.5.2",
  "platform": "win32-x64",
  "country": "BE",
  "city": "Antwerp",
  "lat": 51.22,
  "lon": 4.40
}
```

No real IP stored. No user identity. Just the UUID each client generated on install + Cloudflare's coarse city-level geo lookup.

## Costs

Cloudflare Workers free tier: 100,000 requests/day. KV free tier: 100k reads + 1k writes/day, 1 GB storage. Each launch = 1 write. Even if your app leaks to a thousand people who each launch 5× a day, that's 5k writes/day — still free.

## Revoking someone

The dashboard shows install IDs. To revoke: copy the ID from the popup, open `access.json`, paste it into `blocked[]`, commit + push. Next time they launch, the app refuses and shows the revoked screen.

(If you want a "Revoke" button right inside the dashboard that auto-opens a PR to access.json, that's a future polish. For now it's copy-paste.)
