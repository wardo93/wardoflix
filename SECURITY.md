# Security & op-sec notes

What's exposed in the shipped app, and what's not, plus what to do about it.

## What's NOT exposed

- ✅ **Source code is clean** of personal-name references in comments. No "by Ward", no email addresses, no full-name signatures.
- ✅ **`owner-dashboard/`** (Cloudflare Worker code, dashboard HTML) is **not** packaged into the installer. It's only in the public GitHub repo.
- ✅ **`access.json`** is **not** packaged — it's fetched fresh from GitHub raw on every launch. Edits propagate to all clients within minutes.
- ✅ **`manual-coords.txt`** is owner-machine-only. Lives in `%APPDATA%\WardoFlix\` and never leaves the machine.
- ✅ **`DASHBOARD_KEY`** secret is server-side on Cloudflare. The dashboard.html embeds its own copy locally on your machine. The shipped app has no idea this key exists.
- ✅ **`google_maps_api_key`** is in `access.json` (live-fetched, not packaged in the binary). Restrict it to the Geolocation API in Google Cloud Console so a leak can only be abused for free geolocation requests, not Maps/Places/etc.

## What IS exposed in the packaged installer

Anyone can unpack the asar (a few seconds with `npx asar extract`) and read these:

### Necessary structural exposures

These power core features and can't be removed without re-architecting:

| Where | What | Why it has to be there |
|-------|------|------------------------|
| `electron/access-control.js` | Hard-coded URL `https://raw.githubusercontent.com/wardo93/wardoflix/main/access.json` | Clients fetch the access policy from this URL at startup. Without it, no kill-switch. |
| `package.json` `build.publish` | `owner: "wardo93", repo: "wardoflix"` | electron-updater needs to know where to look for new releases. Without it, no auto-updates. |
| Network traffic | Any client launching makes HTTPS requests to `github.com/wardo93/...` and `wardoflix-telemetry.wardgeys93.workers.dev` | Discoverable by anyone running Wireshark or a local proxy |

These all leak the GitHub username `wardo93` and the Cloudflare account handle `wardgeys93`.

### Low-value exposures

| Where | What | Risk level |
|-------|------|-----------|
| `.env` | `TMDB_API_KEY` | Low. TMDB keys are free for anyone to obtain. Stolen key just means slightly more rate-limit pressure on yours; rotate at https://www.themoviedb.org/settings/api if it's ever abused. |
| `package.json` | `productName: "WardoFlix"`, `appId: "com.ward.wardoflix"` | Low. The appId contains "ward" but it's a Windows COM-style identifier — non-discoverable except by people inspecting the installer's Windows registry entries. |

## How to harden further (only if you actually need to)

Each of these is real work — none are tiny patches.

### 1. Move to a generic-named GitHub repo (~30 min)

The cleanest fix for `wardo93/wardoflix`. Steps:
1. Create a fresh GitHub account with no real-name connection (e.g. `streaming-vault-app`)
2. Push the repo there
3. Update `package.json` → `build.publish.owner` and `electron/access-control.js` → `ACCESS_POLICY_URL` to point at the new account
4. Build a final 1.x release on the OLD repo whose only change is updating the auto-update endpoint to the new repo (so existing clients can migrate)
5. Issue 2.0 from the new repo
6. Eventually take the old repo private or delete it

Caveat: any existing clients that don't run the migration version stay on the old endpoint forever. That's a one-shot migration — get the timing right.

### 2. Move the Worker to a generic-named CF account (~10 min)

The Cloudflare account name (`wardgeys93`) appears in your `*.workers.dev` subdomain.
1. Create a fresh Cloudflare account with a generic email
2. Re-deploy `owner-dashboard/worker.js` there
3. Update `access.json` → `telemetry.url` to the new URL
4. Commit and push — clients pick it up on next launch

Even easier: buy a cheap throwaway domain (~€10/year) and bind it to the worker as `telemetry.example.com`. Then nobody sees the underlying account.

### 3. Use a custom domain for the access policy (~30 min)

To hide `raw.githubusercontent.com/wardo93/...` even from network sniffers:
1. Set up a Cloudflare Worker on a generic domain that proxies to the GitHub raw URL
2. Update `electron/access-control.js` → `ACCESS_POLICY_URL` to point at that worker

This adds latency (one hop) but completely decouples the visible URL from your GitHub identity.

### 4. Rotate the TMDB key periodically (~5 min, recurring)

If you're paranoid about a leaked key being abused:
1. Get a fresh TMDB key
2. Update `.env`
3. Build and ship a new release
4. Revoke the old key in the TMDB dashboard

Old clients will lose Browse functionality until they update — that's the social pressure to keep clients current.

## Realistic recommendation

For your stated threat model ("don't want strangers tracing back to me, but I'm not actively being attacked"):

- ✅ Done in v1.5.8: stripped "Ward" from the visible package metadata.
- ⚠️ The biggest remaining leak is the `wardgeys93` in your worker URL. **Do step #2** above when you have 10 minutes — it's the highest-impact fix per minute of effort.
- ⏸️ Step #1 (rename repo) is good hygiene but disruptive. Worth doing eventually.
- ⏸️ Step #3 is overkill unless someone is actively trying to deanonymise you.
- ⏸️ Step #4 only matters if your TMDB key actually gets abused.

Anyone unpacking the asar to dig for personal info is already suspicious. The realistic threat is a casual leak — your friend's friend's friend running a binary, looking at the icon, maybe reading the description in the Windows app properties. v1.5.8 closes those visible-name leaks. The harder leaks (network-level) require the migrations above.
