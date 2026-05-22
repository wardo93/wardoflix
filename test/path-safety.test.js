// v1.11.1 — regression tests for the path-traversal fix.
//
// A real attack pattern (`%2e.` mixed encoding) bypassed v1.11.0's
// guard and went unnoticed because there was no test. This file is
// the safety net: every attack form goes here so we can never
// silently regress, and every legitimate-looking-but-actually-
// dangerous filename is exercised too.

import { describe, it, expect } from 'vitest'
import { deepDecodePath, hasPathTraversal } from '../server/lib/path-safety.js'

describe('deepDecodePath', () => {
  it('passes through ASCII unchanged', () => {
    expect(deepDecodePath('foo/bar/baz')).toBe('foo/bar/baz')
    expect(deepDecodePath('Season 1/episode.mkv')).toBe('Season 1/episode.mkv')
  })
  it('decodes single-encoded sequences', () => {
    expect(deepDecodePath('foo%2Fbar')).toBe('foo/bar')
    expect(deepDecodePath('%2e%2e')).toBe('..')
    expect(deepDecodePath('%20')).toBe(' ')
  })
  it('decodes mixed encoding', () => {
    expect(deepDecodePath('%2e.')).toBe('..')
    expect(deepDecodePath('.%2e')).toBe('..')
  })
  it('decodes double-encoded sequences', () => {
    expect(deepDecodePath('%252e%252e')).toBe('..')
    expect(deepDecodePath('%2525%2532%2565%2525%2532%2565')).toBe('..')
  })
  it('throws on malformed escapes', () => {
    expect(() => deepDecodePath('%ZZ')).toThrow()
    expect(() => deepDecodePath('foo%')).toThrow()
    expect(() => deepDecodePath('%2')).toThrow()
  })
})

describe('hasPathTraversal — attack patterns must be blocked', () => {
  it('catches literal ..', () => {
    expect(hasPathTraversal('foo/../bar')).toBe(true)
    expect(hasPathTraversal('../etc/passwd')).toBe(true)
    expect(hasPathTraversal('a/b/c/..')).toBe(true)
    expect(hasPathTraversal('..')).toBe(true)
    expect(hasPathTraversal('..\\windows\\system32')).toBe(true)
  })
  it('catches single-encoded %2e%2e', () => {
    expect(hasPathTraversal('foo/%2e%2e/bar')).toBe(true)
    expect(hasPathTraversal('%2e%2e/foo')).toBe(true)
    expect(hasPathTraversal('foo/%2e%2e')).toBe(true)
  })
  it('catches mixed-encoding bypass (the v1.11.0 bug)', () => {
    expect(hasPathTraversal('foo/%2e./bar')).toBe(true)
    expect(hasPathTraversal('foo/.%2e/bar')).toBe(true)
    expect(hasPathTraversal('foo/%2E./bar')).toBe(true)
    expect(hasPathTraversal('%2E%2E/foo')).toBe(true)
  })
  it('catches double-encoded sequences', () => {
    expect(hasPathTraversal('foo/%252e%252e/bar')).toBe(true)
    expect(hasPathTraversal('foo/%2525%2532%2565%2525%2532%2565/bar')).toBe(true)
  })
  it('catches encoded slashes around dot-dot (real traversal)', () => {
    // %2f = / — so %2f%2e%2e%2f decodes to /../ — that IS traversal.
    // Note: `foo%2e%2e%2fbar` is NOT traversal — it decodes to
    // `foo../bar`, where `foo..` is a (weird but legal) filename
    // and the `..` is part of it, not its own segment.
    expect(hasPathTraversal('foo%2f%2e%2e%2fbar')).toBe(true)
    expect(hasPathTraversal('%2f%2e%2e%2fbar')).toBe(true)
    // Counter-example: encoded segment that ISN'T traversal
    expect(hasPathTraversal('foo%2e%2e%2fbar')).toBe(false) // foo../bar — `foo..` is a legal filename
  })
  it('treats malformed encoding as a fail (safer than letting it through)', () => {
    expect(hasPathTraversal('foo/%ZZ/bar')).toBe(true)
    expect(hasPathTraversal('foo%')).toBe(true)
  })
})

describe('hasPathTraversal — legitimate paths must pass', () => {
  it('plain filenames', () => {
    expect(hasPathTraversal('foo/bar/baz')).toBe(false)
    expect(hasPathTraversal('episode.mkv')).toBe(false)
    expect(hasPathTraversal('Season 1/episode.mkv')).toBe(false)
  })
  it('filenames that contain dots but are not traversal', () => {
    expect(hasPathTraversal('..foo')).toBe(false) // starts with dots, but no segment is `..`
    expect(hasPathTraversal('foo..bar')).toBe(false)
    expect(hasPathTraversal('a.b.c.d.mkv')).toBe(false)
    expect(hasPathTraversal('Season/..weirdname.mkv')).toBe(false)
    expect(hasPathTraversal('.hidden')).toBe(false)
  })
  it('paths with URL-encoded characters that are not traversal', () => {
    expect(hasPathTraversal('Season%201/episode.mkv')).toBe(false) // %20 = space
    expect(hasPathTraversal('foo%2520bar')).toBe(false) // double-encoded space
  })
  it('non-string input returns false (caller will reject for other reasons)', () => {
    expect(hasPathTraversal(null)).toBe(false)
    expect(hasPathTraversal(undefined)).toBe(false)
    expect(hasPathTraversal(42)).toBe(false)
  })
  it('empty string', () => {
    expect(hasPathTraversal('')).toBe(false)
  })
})
