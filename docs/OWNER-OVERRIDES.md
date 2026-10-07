# Private owner overrides

The public access policy contains access decisions and public settings only.
It must never contain installation overrides, owner labels, coordinates or API keys.
Clients discard legacy override and API-key fields from downloaded and cached policies.

The owner dashboard source is not in this repository. Its integration must replace
the public-policy override lookup with a server-side call to
`loadOwnerOverrides` from `scripts/owner-overrides.mjs`.
Set `WARDOFLIX_OWNER_OVERRIDES_FILE` to an absolute JSON file path outside every
repository and web/static asset root. The file maps installation IDs to objects
with optional `label`, `lat`, and `lon` fields. No actual values or populated
example belong in source control. Restrict file access to the owner account.
For hosted dashboards use an authenticated owner-only backend/private database;
never fetch overrides through a public URL or bundle them into frontend assets.
Apply overrides only after owner authentication. Do not return them to ordinary clients.
The loader does not provide authentication by itself.

Existing local overrides must be moved manually to that private storage.
No exposed values are copied by this change. Until the excluded dashboard is
updated, it will show telemetry without the former public overrides.

Run `node scripts/check-public-config.cjs` before committing.
CI runs this check independently of dependency installation, plus synthetic
regression tests. It scans tracked config files and emits field categories only.

## Previously published data

Removing current files does not erase Git history, forks, caches or downloaded
copies. An owner/admin must rewrite affected history across branches and tags,
force-push the cleaned refs, coordinate fresh clones, and request GitHub cleanup
of cached views and pull-request references where applicable. Audit release
assets and deployment copies as well. Rotate any API key previously exposed;
history rewriting cannot make a published key secret again.
