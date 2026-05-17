# android-native/ — Kotlin module specs

This directory holds the **specifications** for the native Kotlin modules
that will live under `android/app/src/main/java/com/wardoflix/app/`
once Phase 1 (Capacitor scaffold) generates the `android/` project.

Files here are **design documents** — they look like Kotlin but they
won't compile yet. Each file documents the surface area and key design
decisions for one native module. When we run `npx cap add android` in
Phase 1, the actual implementation files will be copied into the
generated Android project; these stay here as the documented spec.

## Module map

| Module | Phase | Purpose |
|---|---|---|
| `wardoflixServer/Server.kt` | 2 | NanoHttpd HTTP server on localhost:8888, port of Express API |
| `wardoflixServer/TmdbClient.kt` | 2 | OkHttp-backed TMDB client (port of `tmdbFetch`) |
| `wardoflixServer/Cache.kt` | 2 | SQLite-backed key/value cache (replaces in-mem + disk cache) |
| `torrent/TorrentSession.kt` | 3 | libtorrent4j wrapper — magnet to file list to byte streams |
| `torrent/StreamRoute.kt` | 3 | `/stream/<hash>/<path>` byte-range handler |
| `ffmpeg/RemuxRoute.kt` | 4 | `/remux/<hash>/<path>` FFmpegKit transcode pipe |
| `player/WardoflixPlayer.kt` | 5 | ExoPlayer Capacitor plugin |
| `storage/Storage.kt` | 6 | SQLite-backed storage replacing localStorage |

## Why specs first

Two reasons.

1. **Phase 0 setup time**: installing Android Studio + JDK + SDK takes ~30 min of human time. Writing the specs now means when the install finishes, we can start coding immediately instead of designing.
2. **Decision freezing**: the architecture has a lot of "which library?" questions (libtorrent4j vs jlibtorrent, FFmpegKit vs ffmpeg-kit-fork-android, ExoPlayer vs Media3). Writing the spec forces those decisions now while the context is fresh, so Phase 2-7 implementation is execution, not exploration.

## See also

`docs/ANDROID-ROADMAP.md` — overall multi-phase plan, owner setup checklist.
