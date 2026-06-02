/**
 * CATEGORY ROTATION — rank market themes by momentum every scan, then bias the
 * engine toward the hottest categories and away from (or out of) cold ones.
 *
 * This is the "flexible, situational" layer that sits on top of the per-symbol
 * AI picks: even a decent setup in a dead theme gets down-weighted, while setups
 * in a category that's ripping get full (or boosted) size. Rotation runs daily,
 * so the bot follows where money is actually flowing.
 *
 * Cheap by design: one liquid LEADER per category is charted (≈8 fetches), so it
 * adds little latency to the 60s cron budget. Re-uses getMarketData from
 * market-data.ts; no new data source.
 */

import { getMarketData, type MarketData } from './market-data'

export type CategoryKey =
  | 'AI_SEMIS' | 'CRYPTO' | 'BIG_TECH' | 'ENERGY' | 'FINANCIALS' | 'BIOTECH' | 'CONSUMER'

interface CategoryDef { key: CategoryKey; label: string; leader: string; members: string[] }

/** Theme → symbols. `leader` is charted for the momentum read; members map picks back. */
export const CATEGORIES: CategoryDef[] = [
  { key: 'AI_SEMIS',   label: 'AI / Semis',   leader: 'NVDA', members: ['NVDA', 'AMD', 'SMCI', 'ARM', 'AVGO', 'TSM', 'MU', 'SOXL'] },
  { key: 'CRYPTO',     label: 'Crypto',       leader: 'COIN', members: ['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'HOOD'] },
  { key: 'BIG_TECH',   label: 'Big Tech',     leader: 'MSFT', members: ['MSFT', 'AAPL', 'GOOGL', 'META', 'AMZN', 'NFLX', 'SPOT'] },
  { key: 'ENERGY',     label: 'Energy',       leader: 'XLE',  members: ['XLE', 'XOM', 'CVX', 'OXY', 'SLB'] },
  { key: 'FINANCIALS', label: 'Financials',   leader: 'XLF',  members: ['XLF', 'JPM', 'GS', 'BAC', 'SOFI'] },
  { key: 'BIOTECH',    label: 'Biotech',      leader: 'XBI',  members: ['XBI', 'HIMS', 'RXRX', 'MRNA', 'VKTX'] },
  { key: 'CONSUMER',   label: 'Consumer',     leader: 'XLY',  members: ['XLY', 'TSLA', 'SHOP', 'ABNB', 'UBER', 'NKE'] },
]

/** symbol → category, for mapping an AI pick back to its theme. */
export const CATEGORY_OF: Record<string, CategoryKey> = (() => {
  const m: Record<string, CategoryKey> = {}
  for (const c of CATEGORIES) for (const s of c.members) if (!m[s]) m[s] = c.key
  return m
})()

export interface CategoryScore {
  key: CategoryKey
  label: string
  leader: string
  change_1d: number
  change_5d: number
  breadth: number        // 0..1 share of leaders+members that are green 5d (proxy from leader)
  rsi: number
  vol_ratio: number
  score: number          // composite momentum score
  rank: number           // 1 = hottest
  temp: 'HOT' | 'WARM' | 'COOL' | 'COLD'
  bias: number           // sizing multiplier the engine applies (0 = skip)
}

export interface RotationResult {
  categories: CategoryScore[]
  hottest: CategoryKey | null
  generated_at: string
}

function tempFor(rank: number, total: number, score: number): CategoryScore['temp'] {
  if (score <= -2) return 'COLD'
  if (rank <= Math.ceil(total * 0.3)) return 'HOT'
  if (rank <= Math.ceil(total * 0.6)) return 'WARM'
  return 'COOL'
}

/** Hot themes get >1 size, cool get <1, cold get skipped (0). */
function biasFor(temp: CategoryScore['temp']): number {
  switch (temp) {
    case 'HOT':  return 1.35
    case 'WARM': return 1.0
    case 'COOL': return 0.7
    case 'COLD': return 0
  }
}

/**
 * Score every category by its leader's momentum (5d move weighted heaviest,
 * plus 1d follow-through, volume confirmation, and an RSI sanity bound).
 */
export async function getCategoryMomentum(): Promise<RotationResult> {
  const leaders = CATEGORIES.map((c) => c.leader)
  let data: MarketData[] = []
  try { data = await getMarketData(leaders) } catch { data = [] }
  const bySym = new Map(data.map((d) => [d.symbol, d]))

  const scored: CategoryScore[] = CATEGORIES.map((c) => {
    const d = bySym.get(c.leader)
    const change_1d = d?.change_1d ?? 0
    const change_5d = d?.change_5d ?? 0
    const rsi       = d?.rsi ?? 50
    const vol_ratio = d?.volume_ratio ?? 1

    // composite: 5d trend (×1) + 1d follow-through (×0.5) + volume kicker, RSI-bounded
    let score = change_5d + change_1d * 0.5
    if (vol_ratio >= 1.5) score += 1
    if (rsi >= 80) score -= 1.5            // extended — fade the chase a touch
    if (rsi <= 35 && change_5d < 0) score -= 1

    return {
      key: c.key, label: c.label, leader: c.leader,
      change_1d, change_5d, rsi, vol_ratio,
      breadth: change_5d > 0 ? 1 : 0,
      score: Math.round(score * 100) / 100,
      rank: 0, temp: 'COOL', bias: 1,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  const total = scored.length
  scored.forEach((s, i) => {
    s.rank = i + 1
    s.temp = tempFor(s.rank, total, s.score)
    s.bias = biasFor(s.temp)
  })

  return {
    categories: scored,
    hottest: scored[0]?.key ?? null,
    generated_at: new Date().toISOString(),
  }
}

/** Look up the sizing bias for a given symbol from a rotation result (1 if unknown). */
export function biasForSymbol(symbol: string, rotation: RotationResult): number {
  const cat = CATEGORY_OF[symbol]
  if (!cat) return 1
  const c = rotation.categories.find((x) => x.key === cat)
  return c ? c.bias : 1
}

export function categoryLabel(symbol: string): string {
  const cat = CATEGORY_OF[symbol]
  return CATEGORIES.find((c) => c.key === cat)?.label ?? 'Other'
}
