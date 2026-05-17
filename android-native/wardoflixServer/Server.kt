/**
 * DESIGN SPEC — not yet implemented. Will land in android/app/src/main/java/com/wardoflix/app/
 * after Phase 1 (Capacitor scaffold).
 *
 * WardoflixServer
 * ────────────────
 *
 * Embedded HTTP server that replicates the Express API for the WebView-
 * loaded renderer. Listens on 127.0.0.1:8888 (loopback only — no LAN
 * exposure on Android because there's no DLNA cast on the phone client).
 *
 * Lifecycle:
 *   - Started in MainActivity.onCreate() before the WebView loads
 *   - Stopped in MainActivity.onDestroy()
 *   - Survives configuration changes via the ViewModel pattern (keeps
 *     active torrent sessions across screen rotations)
 *
 * Why NanoHttpd: zero-dep, ~50KB, no Netty/Jetty bloat. Async I/O via
 * its own thread pool. Fine for our throughput (typical: 1 active
 * stream, 5-10 small JSON catalog calls per second during browsing).
 */

package com.wardoflix.app.wardoflixServer

import fi.iki.elonen.NanoHTTPD

class WardoflixServer(
  port: Int = 8888,
  // Injected so the Capacitor plugin layer can lazy-create torrent
  // sessions, ffmpeg pools, etc. and pass them down here.
  private val tmdbClient: TmdbClient,
  private val cache: Cache,
  // Phase 3+ — start as nullable; routes that need them return 503 if
  // they haven't been wired yet during a partial-phase build.
  private val torrentSession: TorrentSession? = null,
  private val ffmpegPool: FFmpegPool? = null,
) : NanoHTTPD("127.0.0.1", port) {

  override fun serve(session: IHTTPSession): Response {
    val uri = session.uri
    val method = session.method

    // Routes are organised by phase so partial builds work:
    //   Phase 2 = catalog + details (TMDB)
    //   Phase 3 = stream (torrent)
    //   Phase 4 = remux (ffmpeg)

    return when {
      uri == "/api/health" -> handleHealth()
      uri == "/api/version" -> handleVersion()
      uri.startsWith("/api/catalog/") -> handleCatalog(uri, session)
      uri.startsWith("/api/details/") -> handleDetails(uri)
      uri.startsWith("/api/collection/") -> handleCollection(uri)
      uri.startsWith("/api/trailer-key/") -> handleTrailerKey(uri)
      uri.startsWith("/api/recommendations/") -> handleRecommendations(uri)
      uri.startsWith("/api/episodes/") -> handleEpisodes(uri)
      uri == "/api/torrents" -> handleTorrents(session)
      uri == "/api/torrent-episode" -> handleTorrentEpisode(session)
      uri == "/api/stream" && method == Method.POST -> handleStream(session)
      uri.startsWith("/stream/") -> handleStreamRoute(uri, session)
      uri.startsWith("/remux/") -> handleRemuxRoute(uri, session)
      uri == "/api/subtitles" -> handleSubtitles(session)
      uri == "/api/subtitles/proxy" -> handleSubtitleProxy(session)
      uri.startsWith("/trailer") -> handleTrailerWrapper(session)
      else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", """{"error":"not found"}""")
    }
  }

  // ── Phase 2 routes ─────────────────────────────────────────────

  private fun handleHealth(): Response {
    val json = """{"ok":true,"version":"1.10.0","platform":"android","cache":"sqlite"}"""
    return jsonResponse(json)
  }

  private fun handleCatalog(uri: String, session: IHTTPSession): Response {
    // Parse /api/catalog/movies?category=trending → TMDB /trending/movie/week
    // Port of server/index.js:519 (app.get('/api/catalog/:type', ...))
    // TmdbClient handles the actual HTTP call + caching.
    TODO("Phase 2: port from server/index.js")
  }

  private fun handleDetails(uri: String): Response {
    // /api/details/<type>/<tmdbId>
    TODO("Phase 2")
  }

  private fun handleCollection(uri: String): Response { TODO("Phase 2") }
  private fun handleTrailerKey(uri: String): Response { TODO("Phase 2") }
  private fun handleRecommendations(uri: String): Response { TODO("Phase 2") }
  private fun handleEpisodes(uri: String): Response { TODO("Phase 2") }

  // ── Phase 3 routes ─────────────────────────────────────────────

  private fun handleTorrents(session: IHTTPSession): Response {
    if (torrentSession == null) return notReady("torrent")
    TODO("Phase 3: port from server/index.js:883")
  }

  private fun handleTorrentEpisode(session: IHTTPSession): Response {
    if (torrentSession == null) return notReady("torrent")
    TODO("Phase 3")
  }

  private fun handleStream(session: IHTTPSession): Response {
    if (torrentSession == null) return notReady("torrent")
    // Magnet validation: same regex as desktop (isWellFormedMagnet)
    // Add to libtorrent session, return { url: "/stream/<hash>/<path>" }
    TODO("Phase 3")
  }

  private fun handleStreamRoute(uri: String, session: IHTTPSession): Response {
    if (torrentSession == null) return notReady("torrent")
    // Byte-range serving from libtorrent's piece picker
    TODO("Phase 3")
  }

  // ── Phase 4 routes ─────────────────────────────────────────────

  private fun handleRemuxRoute(uri: String, session: IHTTPSession): Response {
    if (ffmpegPool == null) return notReady("ffmpeg")
    // Spawn FFmpegKit transcode, pipe stdout to response body
    TODO("Phase 4")
  }

  // ── Other ──────────────────────────────────────────────────────

  private fun handleSubtitles(session: IHTTPSession): Response { TODO("Phase 2") }
  private fun handleSubtitleProxy(session: IHTTPSession): Response { TODO("Phase 2") }
  private fun handleTrailerWrapper(session: IHTTPSession): Response {
    // Static HTML page that embeds YouTube — same wrapper as desktop's
    // server/index.js:476 (app.get('/trailer', ...))
    TODO("Phase 2")
  }

  private fun handleVersion(): Response {
    return jsonResponse("""{"version":"1.10.0"}""")
  }

  // ── Helpers ────────────────────────────────────────────────────

  private fun jsonResponse(json: String): Response {
    val r = newFixedLengthResponse(Response.Status.OK, "application/json", json)
    r.addHeader("Access-Control-Allow-Origin", "*")
    return r
  }

  private fun notReady(component: String): Response {
    val r = newFixedLengthResponse(
      Response.Status.SERVICE_UNAVAILABLE,
      "application/json",
      """{"error":"$component module not wired in this build"}"""
    )
    return r
  }
}
