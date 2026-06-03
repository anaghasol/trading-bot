import { NextResponse } from 'next/server'

const BASE = 'https://paper-api.alpaca.markets/v2'

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }
}

type Asset = { symbol: string; name: string; tradable: boolean; status: string }

async function fetchAssets(url: string): Promise<Asset[]> {
  try {
    const res = await fetch(url, { headers: headers(), cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : [data]
  } catch { return [] }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.toUpperCase().trim()
  if (!q || q.length < 1) return NextResponse.json({ results: [] })

  // Run exact symbol lookup + name search in parallel
  const [exactData, nameData] = await Promise.all([
    fetchAssets(`${BASE}/assets/${encodeURIComponent(q)}`),
    fetchAssets(`${BASE}/assets?status=active&asset_class=us_equity&search=${encodeURIComponent(q)}`),
  ])

  const seen = new Set<string>()
  const results: { symbol: string; name: string }[] = []

  const active = (a: Asset) => a.tradable && a.status === 'active'

  // 1. Exact symbol match first
  for (const a of exactData) {
    if (active(a) && !seen.has(a.symbol)) { seen.add(a.symbol); results.push({ symbol: a.symbol, name: a.name }) }
  }

  // 2. Symbol-prefix matches from name search (e.g. OKLO, OKLO1)
  for (const a of nameData) {
    if (active(a) && a.symbol.startsWith(q) && !seen.has(a.symbol)) {
      seen.add(a.symbol); results.push({ symbol: a.symbol, name: a.name })
    }
  }

  // 3. Name-match results (if user typed a word from company name)
  for (const a of nameData) {
    if (active(a) && !seen.has(a.symbol) && results.length < 8) {
      seen.add(a.symbol); results.push({ symbol: a.symbol, name: a.name })
    }
  }

  return NextResponse.json({ results: results.slice(0, 8) })
}
