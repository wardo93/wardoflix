// v1.11.2 — path-safety helpers. Pure JS, no Node-specific deps, no
// DOM. Server imports from here.
//
// v1.11.1 originally put this at src/lib/path-safety.js so unit tests
// in test/path-safety.test.js could share it with the renderer. That
// was a mistake: src/ is NOT included in electron-builder's build.files
// (only dist/, electron/, server/ are), so the packaged asar never
// contained the file and the server crashed with ERR_MODULE_NOT_FOUND
// on every fork. v1.11.2 moves it under server/lib/ where it's covered
// by `server/**/*` and ships correctly. The renderer never imported
// it; the move is invisible to renderer code.

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
