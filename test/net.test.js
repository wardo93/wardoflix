// v1.12.0 — regression tests for the rate-limiter's loopback exemption.
//
// v1.11.6: the app rate-limited its own ~50-call stream-start burst
// because the 200 req/60s limit applied to 127.0.0.1. The fix exempts
// loopback. These tests pin that exemption so a future "tighten the
// rate limit" edit can't silently re-brick stream-start.

import { describe, it, expect } from 'vitest'
import { isLoopback } from '../server/lib/net.js'

describe('isLoopback — must exempt every loopback form Node produces', () => {
  it('IPv4 loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.1.2.3')).toBe(true) // whole 127/8 is loopback
  })
  it('IPv6 loopback', () => {
    expect(isLoopback('::1')).toBe(true)
  })
  it('IPv4-mapped IPv6 loopback (the form Windows uses by default)', () => {
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.1.2.3')).toBe(true)
  })
})

describe('isLoopback — must NOT exempt remote addresses', () => {
  it('LAN IPs are rate-limited', () => {
    expect(isLoopback('192.168.1.5')).toBe(false)
    expect(isLoopback('10.0.0.7')).toBe(false)
    expect(isLoopback('172.16.0.1')).toBe(false)
    expect(isLoopback('::ffff:192.168.1.5')).toBe(false)
  })
  it('public IPs are rate-limited', () => {
    expect(isLoopback('8.8.8.8')).toBe(false)
    expect(isLoopback('1.2.3.4')).toBe(false)
  })
  it('garbage / empty / non-string returns false (gets rate-limited, fail-safe)', () => {
    expect(isLoopback('')).toBe(false)
    expect(isLoopback(null)).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
    expect(isLoopback(42)).toBe(false)
    expect(isLoopback('unknown')).toBe(false)
  })
  it('does NOT match an address that merely contains 127', () => {
    // 12.7.x or 8.127.x must not be treated as loopback
    expect(isLoopback('12.7.0.1')).toBe(false)
    expect(isLoopback('8.127.0.1')).toBe(false)
  })
})
