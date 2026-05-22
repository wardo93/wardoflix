// v1.11.1 — path-safety helpers. Pure JS, no Node-specific deps, no
// DOM. Server imports from here AND the renderer can if it ever needs
// the same validation client-side. Lives in src/lib because that's
// where shared pure-JS utilities live (util.js, url.js); the server
// imports them via relative path too.

/**
 * Decode a URL path repeatedly until stable. Handles double- and
 * triple-encoded inputs that a naive single-pass decodeURIComponent
 * would miss. Capped at 4 passes — beyond that an attacker is
 * intentionally constructing pathological nested encoding, which
 * almost certainly indicates malicious intent regardless of what
 * the eventual decode would produce.
 *
 * @param {string} path - the raw path string to decode
 * @returns {string} the fully decoded string
 * @throws {URIError} when the path contains malformed % escapes
 */
export function deepDecodePath(path) {
  let decoded = path
  for (let i = 0; i < 4; i++) {
    const next = decodeURIComponent(decoded)
    if (next === decoded) return decoded
    decoded = next
  }
  return decoded
}

/**
 * Returns true if `path` contains a `..` segment that would resolve
 * upward when used as a URL path. Decodes percent-escapes first so
 * mixed encoding (e.g. `%2e.`, `.%2e`) is caught. Legitimate
 * filenames like `..foo` or `foo..bar` pass through — only the
 * full `..` segment between slashes (or path-start/end) is rejected.
 *
 * @param {string} path - the path to check (raw, pre-decode)
 * @returns {boolean} true if the path contains traversal
 */
export function hasPathTraversal(path) {
  if (typeof path !== 'string') return false
  let decoded
  try { decoded = deepDecodePath(path) } catch { return true /* malformed encoding is also a fail */ }
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(decoded)
}
