// Quick test: can Node reach the torrent APIs?
// Run: node test-torrent-api.js

const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }

async function test() {
  console.log('Testing YTS (movies)...')
  try {
    const r = await fetch('https://movies-api.accel.li/api/v2/list_movies.json?query_term=Inception&limit=1', opts)
    const d = await r.json()
    const count = d?.data?.movies?.[0]?.torrents?.length ?? 0
    console.log('  YTS OK:', count, 'torrents for Inception')
  } catch (e) {
    console.log('  YTS FAIL:', e.message)
  }

  console.log('Testing EZTV (TV)...')
  try {
    const r = await fetch('https://eztvx.to/api/get-torrents?imdb_id=0944947&limit=1', opts)
    const d = await r.json()
    const count = d?.torrents?.length ?? 0
    console.log('  EZTV OK:', count, 'torrents for Game of Thrones')
  } catch (e) {
    console.log('  EZTV FAIL:', e.message)
  }
}

test()
