// Generates PWA PNG icons and a Windows .ico from public/icon.svg.
// Run: node scripts/gen-icons.mjs
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..')
const SVG = path.join(ROOT, 'public', 'icon.svg')
const svgBuf = fs.readFileSync(SVG)

async function png(size, outPath) {
  await sharp(svgBuf).resize(size, size).png().toFile(outPath)
  console.log(`wrote ${outPath}`)
}

async function run() {
  // PWA icons
  await png(192, path.join(ROOT, 'public', 'icon-192.png'))
  await png(512, path.join(ROOT, 'public', 'icon-512.png'))
  // Maskable — same art (the SVG already has generous padding inside the rounded rect)
  await png(512, path.join(ROOT, 'public', 'icon-maskable-512.png'))
  // Windows .ico — multi-size PNG embedded
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = await Promise.all(sizes.map((s) => sharp(svgBuf).resize(s, s).png().toBuffer()))
  const ico = await pngToIco(pngs)
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico)
  console.log(`wrote ${path.join(ROOT, 'build', 'icon.ico')}`)
  // Also emit a 512 PNG for macOS/Linux builds
  await png(512, path.join(ROOT, 'build', 'icon.png'))
}

run().catch((e) => { console.error(e); process.exit(1) })
