# Access Control

You can control who runs WardoFlix from a single file in this repo: `access.json`. Every launch of the app fetches this file from GitHub raw. If the client's install ID isn't allowed, the app refuses to open.

## The moving parts

- **`access.json`** — at the repo root. Commit changes to `main`, push, done.
- **Each install has a unique ID** — a UUID generated on first launch, stored in `%APPDATA%/WardoFlix/install-id.txt` (Windows) or the equivalent userData dir on macOS/Linux. Visible to the user in the debug overlay (Ctrl+Shift+D, bottom).
- **Client fetches `access.json` on every launch** from `https://raw.githubusercontent.com/wardo93/wardoflix/main/access.json`. No auth needed (public file).
- **If GitHub is unreachable**, the client uses a cached copy up to 7 days old, then fails closed.
- **Dev builds bypass the check** (`isDev` in `electron/main.js`). Production/packaged builds enforce it.

## Collecting existing users' IDs first (the bootstrap)

Before you flip `mode` to `allowlist`, you need every legitimate user's install ID, otherwise you'll lock them out. The soft rollout:

1. Ship a build with `access.json` set to `mode: "open"` — no-one is blocked. This ships v1.5.1.
2. Have each friend relaunch (auto-updater will download 1.5.1), then open Ctrl+Shift+D, hit **Copy install ID**, send it to you.
3. Collect all IDs into `access.json` → `allow[]`.
4. Commit + push. (No new build needed — the running client will re-fetch on next launch.)
5. Flip `mode` to `"allowlist"`. Commit + push.

From that point forward, only IDs in `allow[]` can launch the app. Everyone else gets the access-denied screen with their ID displayed for them to send to you.

## Daily operations

### Add a new user

1. Ask them for their install ID (Ctrl+Shift+D → Copy install ID)
2. Edit `access.json`, add the ID to `allow[]`
3. `git commit -am "access: allowlist <name>" && git push`
4. Their next launch (or the next time their cache refreshes) grants access

### Revoke a user

Two options depending on urgency:

**Fast (takes effect within 7 days even if they lose internet):** add their ID to `blocked[]`. This trumps `allow[]` and applies in every mode.

**Clean (takes effect next live fetch):** remove their ID from `allow[]` under `mode: "allowlist"`.

In both cases: `git commit -am "access: revoke <name>" && git push`. Their next launch blocks them.

Note: the cache window means a revoked user with no internet can keep launching for up to 7 days after revocation. Shortening that requires a separate online check each launch (currently we only fall back to cache if the live fetch fails).

### Kill everyone at once

Set `mode: "allowlist"` and empty `allow[]`. Everyone including you gets blocked. Reverse by adding your own ID back.

### See who's actually launching the app

`access.json` has an optional `telemetry` block. If you set a URL, every launch POSTs `{installId, version, platform, ts}` to it. Options:

1. **Discord webhook** — fastest, free. Create a webhook in a private Discord channel (Server Settings → Integrations → Webhooks → New Webhook → Copy URL), then:
   ```json
   "telemetry": {
     "url": "https://discord.com/api/webhooks/AAA/BBB",
     "format": "discord"
   }
   ```
   Every launch posts `launch <uuid> v1.5.1 (win32-x64)` as a message. You scroll the channel to see who launched when.

2. **Cloudflare Worker** (recommended if you want a dashboard) — free tier, 100k requests/day. A minimal worker that writes to KV and serves a counter page is ~30 lines. Not wired up here; let me know if you want me to scaffold it.

3. **Leave it disabled** — that's the current default (`"disabled": true`).

## Security notes

- The allowlist file is **public**. Anyone can see which IDs are allowed. That's fine — knowing an allowed ID doesn't help them get access because they can't put it in their local install (the client generates its own).
- **The client-side check can be bypassed** by someone willing to unpack the ASAR, patch the JS, and repack. Realistically: your close-friends-of-friends group won't do this. If it becomes a real concern, the hardening path is a remote server that gates Torrentio lookups — big architecture change, not currently in scope.
- The install ID is just a random UUID — no personal info. Knowing it tells you nothing about the user besides "this specific installation."

## Quick reference

```
Path                       Contents
%APPDATA%/WardoFlix/
  install-id.txt           Client's UUID (one line)
  access-cache.json        Last-good fetch of access.json + timestamp
  wardoflix.log            Includes [access] lines for debugging
```

Repo file → commit → every launch of every client fetches it → done.
