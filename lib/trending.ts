/**
 * Market Discovery — finds hot stocks the bot doesn't already know about.
 *
 * Sources (all free, no API key):
 *   1. Yahoo Finance Trending US   — stocks people are searching right now
 *   2. Yahoo Finance Top Gainers   — stocks up ≥3% with real volume today
 *
 * A human trader checks these every morning and catches things like SPCX on
 * IPO day. This module automates that loop — runs every scan tick.
 */

const YF_BASE = 'https://query1.finance.yahoo.com'
const HEADERS = { 'User-Agent': 'Mozilla/5.0' }

// Symbols to always exclude — indices, ETFs, foreign ADRs, leveraged noise
const EXCLUDE = new Set([
  'SPY','QQQ','IWM','DIA','TQQQ','SQQQ','UVXY','VXX','SPXS','SPXL',
  'GLD','SLV','TLT','HYG','AGG','BND','GDX','GDXJ',
  '^GSPC','^DJI','^IXIC','^VIX','NQ=F','ES=F','YM=F','RTY=F',
])

export interface DiscoverySymbol {
  symbol:     string
  source:     'trending' | 'gainer'
  rank?:      number     // position in trending list (1 = most searched)
  change_pct?: number
  volume?:    number
  signal:     string     // human-readable why this is interesting
}

// ── Source 1: Yahoo Finance Trending ─────────────────────────────────────────

export async function getTrendingSymbols(): Promise<DiscoverySymbol[]> {
  try {
    const res = await fetch(
      `${YF_BASE}/v1/finance/trending/US?count=20`,
      { headers: HEADERS, next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data = await res.json() as {
      finance: { result: [{ quotes: { symbol: string }[] }] }
    }
    const quotes = data.finance?.result?.[0]?.quotes ?? []
    return quotes
      .map((q, i) => ({ symbol: q.symbol, rank: i + 1 }))
      .filter((q) => q.symbol && !EXCLUDE.has(q.symbol) && /^[A-Z]{1,5}$/.test(q.symbol))
      .map((q) => ({
        symbol:  q.symbol,
        source:  'trending' as const,
        rank:    q.rank,
        signal:  `Trending #${q.rank} on Yahoo Finance`,
      }))
  } catch {
    return []
  }
}

// ── Source 2: Yahoo Finance Top Gainers ──────────────────────────────────────

export async function getTopGainers(
  minVol    = 500_000,   // minimum volume — filters out micro-cap noise
  minChange = 3.0        // minimum % gain
): Promise<DiscoverySymbol[]> {
  try {
    const res = await fetch(
      `${YF_BASE}/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=25&start=0`,
      { headers: HEADERS, next: { revalidate: 180 } }
    )
    if (!res.ok) return []
    const data = await res.json() as {
      finance: { result: [{ quotes: Record<string, unknown>[] }] }
    }
    const quotes = data.finance?.result?.[0]?.quotes ?? []
    return quotes
      .filter((q) => {
        const sym = String(q.symbol ?? '')
        const vol = Number(q.regularMarketVolume ?? 0)
        const chg = Number(q.regularMarketChangePercent ?? 0)
        return sym && !EXCLUDE.has(sym) && /^[A-Z]{1,5}$/.test(sym) && vol >= minVol && chg >= minChange
      })
      .map((q) => {
        const chg = Math.round(Number(q.regularMarketChangePercent) * 10) / 10
        const vol = Number(q.regularMarketVolume)
        return {
          symbol:     String(q.symbol),
          source:     'gainer' as const,
          change_pct: chg,
          volume:     vol,
          signal:     `+${chg}% today, ${(vol / 1_000_000).toFixed(1)}M vol`,
        }
      })
  } catch {
    return []
  }
}

// ── Combined discovery ────────────────────────────────────────────────────────

export async function getDiscoverySymbols(): Promise<DiscoverySymbol[]> {
  const [trending, gainers] = await Promise.all([
    getTrendingSymbols(),
    getTopGainers(),
  ])

  // Merge: if a symbol appears in both, it's a strong signal — keep highest-signal entry
  const seen = new Map<string, DiscoverySymbol>()

  for (const d of trending) {
    seen.set(d.symbol, d)
  }
  for (const d of gainers) {
    const existing = seen.get(d.symbol)
    if (existing) {
      // Appears in both trending AND gainers — double signal, upgrade the entry
      seen.set(d.symbol, {
        ...existing,
        signal: `${existing.signal} · ${d.signal} 🔥`,
      })
    } else {
      seen.set(d.symbol, d)
    }
  }

  // Sort: double-signal first, then trending rank, then gainers by change_pct
  return Array.from(seen.values()).sort((a, b) => {
    const aDouble = a.signal.includes('🔥') ? 1 : 0
    const bDouble = b.signal.includes('🔥') ? 1 : 0
    if (aDouble !== bDouble) return bDouble - aDouble
    if (a.rank && b.rank) return a.rank - b.rank
    return (b.change_pct ?? 0) - (a.change_pct ?? 0)
  })
}
