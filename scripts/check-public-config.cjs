const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function violations(value) {
  if (!value || typeof value !== 'object') return []
  const errors = []
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalized === 'installoverrides' && child && Object.keys(child).length) errors.push('private overrides')
    if (['lat', 'lon', 'lng', 'latitude', 'longitude', 'coordinates', 'coords'].includes(normalized) && child !== null) errors.push('coordinates')
    if (['label', 'friendlyname', 'osuser'].includes(normalized) && child) errors.push('identifying label')
    if (normalized === 'googlemapsapikey' && child) errors.push('credential')
    errors.push(...violations(child))
  }
  return errors
}

function check() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  let failed = false
  for (const filename of files) {
    if (!/\.(json|jsonc|ya?ml|toml|ini|env|webmanifest)$/i.test(filename) && path.basename(filename) !== '.env') continue
    const text = fs.readFileSync(filename, 'utf8')
    let errors = []
    if (/\.(json|webmanifest)$/i.test(filename)) {
      try { errors = violations(JSON.parse(text)) } catch { errors = ['invalid JSON config'] }
    } else {
      if (/\b(?:lat|lon|lng|latitude|longitude|coordinates|coords|label|friendly[_-]?name|os[_-]?user)\s*[:=]\s*\S/i.test(text)) errors.push('private metadata')
      if (/\binstall_overrides\s*[:=]\s*(?!\{\s*\}|null\b)\S/i.test(text)) errors.push('private overrides')
    }
    // Also catch coordinate pairs embedded in strings and comments.
    if (/-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}/.test(text)) errors.push('precise coordinate pair')
    if (errors.length) {
      failed = true
      console.error('Public config privacy check failed: ' + filename + ' (' + [...new Set(errors)].join(', ') + ')')
    }
  }
  if (failed) process.exitCode = 1
  else console.log('Public config privacy check passed')
}
module.exports = { violations }
if (require.main === module) check()
