// v1.12.0 — network helpers, extracted from server/index.js so the
// rate-limiter's loopback exemption can be unit-tested. The v1.11.6
// bug (the app rate-limited its own ~50-call stream-start burst) was
// fixed by exempting loopback IPs; this function is that exemption,
// and test/net.test.js is the regression fence that stops a future
// "tighten the rate limit" edit from re-breaking stream-start.
//
// Pure: no deps, no I/O.

/**
 * True if `ip` is a loopback address in any of the forms Node's
 * req.ip / socket.remoteAddress can produce:
 *   "::1"               IPv6 loopback
 *   "127.0.0.1" (127.*) IPv4 loopback
 *   "::ffff:127.0.0.1"  IPv4-mapped IPv6 loopback (common on Windows)
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isLoopback(ip) {
  if (!ip || typeof ip !== 'string') return false
  return ip === '::1'
      || ip === '127.0.0.1'
      || ip.startsWith('127.')
      || ip === '::ffff:127.0.0.1'
      || ip.startsWith('::ffff:127.')
}
