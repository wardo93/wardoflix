const assert = require('node:assert/strict')
const { violations } = require('./check-public-config.cjs')
assert.equal(violations({ mode: 'open', allow: [], blocked: [], install_overrides: {} }).length, 0)
for (const input of [
  { install_overrides: { 'synthetic-install': { label: 'test-only' } } },
  { nested: { latitude: 12.34567, longitude: 23.45678 } },
  { nested: { friendlyName: 'test-only' } },
  { nested: { label: 'test-only' } },
  { google_maps_api_key: 'test-only' },
]) assert.ok(violations(input).length > 0)
console.log('Public config regression tests passed')
