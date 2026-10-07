// Owner dashboard only. Never import this module into the distributed client.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

export function loadOwnerOverrides(filename = process.env.WARDOFLIX_OWNER_OVERRIDES_FILE) {
  if (!filename) return Object.create(null)
  if (!path.isAbsolute(filename)) throw new Error('Owner override file must use an absolute external path')
  const resolved = fs.realpathSync(filename)
  const relative = path.relative(repository, resolved)
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Owner override file must be outside the repository')
  }
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid owner overrides')
  const result = Object.create(null)
  for (const [id, entry] of Object.entries(data)) {
    if (!/^[a-f0-9-]{36}$/i.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid owner override entry')
    }
    const clean = {}
    if (entry.label !== undefined) {
      if (typeof entry.label !== 'string' || entry.label.length > 64) throw new Error('Invalid owner label')
      clean.label = entry.label
    }
    for (const [key, limit] of [['lat', 90], ['lon', 180]]) {
      if (entry[key] !== undefined) {
        if (!Number.isFinite(entry[key]) || Math.abs(entry[key]) > limit) throw new Error('Invalid owner coordinates')
        clean[key] = entry[key]
      }
    }
    result[id] = clean
  }
  return result
}
