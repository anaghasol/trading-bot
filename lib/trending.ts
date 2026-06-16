/**
 * Market Discovery — finds hot stocks the bot doesn't already know about.
 *
 * Sources (all free, no API key):
 *   1. Yahoo Finance Trending US   — stocks people are searching right now
 *   2. Yahoo Finance Top Gainers   — stocks up ≥3% with real volume today
 *   3. Yahoo Finance Most Active   — highest dollar-volume leaders today
 *
 * A human trader checks these every morning and catches things like SPCX on
 * IPO day. This module automates that loop — runs every scan tick.
 * Used for BOTH paper AND live (live mode applies tighter liquidity filters).
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
  minChange = 3.0,       // minimum % gain
  minPrice  = 3.0        // minimum price per share
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
    const accepted: DiscoverySymbol[] = []
    for (const q of quotes) {
      const sym = String(q.symbol ?? '')
      if (!sym || EXCLUDE.has(sym) || !/^[A-Z]{1,5}$/.test(sym)) continue
      const vol   = Number(q.regularMarketVolume ?? 0)
      const chg   = Number(q.regularMarketChangePercent ?? 0)
      const price = Number(q.regularMarketPrice ?? 0)
      if (price < minPrice) { console.log(`[DISCOVERY] Skipped ${sym} (gainers) — price $${price.toFixed(2)} < $${minPrice}`); continue }
      if (vol < minVol)     { console.log(`[DISCOVERY] Skipped ${sym} (gainers) — vol ${(vol/1e6).toFixed(1)}M < ${(minVol/1e6).toFixed(0)}M`); continue }
      if (chg < minChange)  { console.log(`[DISCOVERY] Skipped ${sym} (gainers) — change ${chg.toFixed(1)}% < ${minChange}%`); continue }
      const roundedChg = Math.round(chg * 10) / 10
      console.log(`[DISCOVERY] Accepted ${sym} (gainers) — $${price.toFixed(2)}, +${roundedChg}%, ${(vol/1e6).toFixed(1)}M vol`)
      accepted.push({
        symbol:     sym,
        source:     'gainer' as const,
        change_pct: roundedChg,
        volume:     vol,
        signal:     `+${roundedChg}% today, ${(vol / 1_000_000).toFixed(1)}M vol`,
      })
    }
    return accepted
  } catch {
    return []
  }
}

// ── Source 3: Yahoo Finance Most Active (by dollar volume) ───────────────────

export async function getMostActive(minVol = 1_000_000, minPrice = 3.0): Promise<DiscoverySymbol[]> {
  try {
    const res = await fetch(
      `${YF_BASE}/v1/finance/screener/predefined/saved?scrIds=most_actives&count=30&start=0`,
      { headers: HEADERS, next: { revalidate: 180 } }
    )
    if (!res.ok) return []
    const data = await res.json() as {
      finance: { result: [{ quotes: Record<string, unknown>[] }] }
    }
    const quotes = data.finance?.result?.[0]?.quotes ?? []
    const accepted: DiscoverySymbol[] = []
    for (const q of quotes) {
      const sym = String(q.symbol ?? '')
      if (!sym || EXCLUDE.has(sym) || !/^[A-Z]{1,5}$/.test(sym)) continue
      const vol   = Number(q.regularMarketVolume ?? 0)
      const price = Number(q.regularMarketPrice ?? 0)
      if (price < minPrice) { console.log(`[DISCOVERY] Skipped ${sym} (actives) — price $${price.toFixed(2)} < $${minPrice}`); continue }
      if (vol < minVol)     { console.log(`[DISCOVERY] Skipped ${sym} (actives) — vol ${(vol/1e6).toFixed(1)}M < ${(minVol/1e6).toFixed(0)}M`); continue }
      const chg = Math.round(Number(q.regularMarketChangePercent) * 10) / 10
      console.log(`[DISCOVERY] Accepted ${sym} (actives) — $${price.toFixed(2)}, ${chg > 0 ? '+' : ''}${chg}%, ${(vol/1e6).toFixed(1)}M vol`)
      accepted.push({
        symbol:     sym,
        source:     'gainer' as const,
        change_pct: chg,
        volume:     vol,
        signal:     `Most Active: ${(vol / 1_000_000).toFixed(1)}M vol, ${chg > 0 ? '+' : ''}${chg}%`,
      })
    }
    return accepted
  } catch {
    return []
  }
}

// ── Combined discovery ────────────────────────────────────────────────────────
// mode='live': tighter filters (price≥$10, vol≥2M) — real money needs liquidity
// mode='paper': wider net (price≥$3, vol≥500K) — fake money collects data fast

export async function getDiscoverySymbols(mode: 'live' | 'paper' = 'paper'): Promise<DiscoverySymbol[]> {
  const [trending, gainers, actives] = await Promise.all([
    getTrendingSymbols(),
    getTopGainers(
      mode === 'live' ? 2_000_000 : 500_000,   // vol floor
      mode === 'live' ? 2.0 : 3.0,              // min % gain
      mode === 'live' ? 8.0 : 3.0,              // min price ($8 live, $3 paper)
    ),
    getMostActive(
      mode === 'live' ? 2_000_000 : 1_000_000,  // vol floor
      mode === 'live' ? 8.0 : 3.0,              // min price ($8 live, $3 paper)
    ),
  ])

  // Merge all three sources — symbols appearing in multiple lists are strongest signals
  const seen = new Map<string, DiscoverySymbol>()

  for (const d of [...trending, ...actives]) {
    seen.set(d.symbol, d)
  }
  for (const d of gainers) {
    const existing = seen.get(d.symbol)
    if (existing) {
      seen.set(d.symbol, {
        ...existing,
        signal: `${existing.signal} · ${d.signal} 🔥`,
      })
    } else {
      seen.set(d.symbol, d)
    }
  }

  let results = Array.from(seen.values())

  // Live mode: apply minimum liquidity filter on final merged list
  if (mode === 'live') {
    results = results.filter((d) => {
      const vol = d.volume ?? 0
      if (vol < 2_000_000) {
        console.log(`[DISCOVERY] Skipped ${d.symbol} (final-live) — vol ${(vol/1e6).toFixed(1)}M < 2M (trending-only, no vol data)`)
        return false
      }
      return true
    })
  }
  console.log(`[DISCOVERY] ${mode.toUpperCase()} final pool: ${results.length} symbols — ${results.map(d => d.symbol).join(', ')}`)

  // Sort: multi-source (🔥) first, then by trending rank, then by volume/change
  return results.sort((a, b) => {
    const aDouble = a.signal.includes('🔥') ? 1 : 0
    const bDouble = b.signal.includes('🔥') ? 1 : 0
    if (aDouble !== bDouble) return bDouble - aDouble
    if (a.rank && b.rank) return a.rank - b.rank
    return (b.change_pct ?? 0) - (a.change_pct ?? 0)
  })
}
