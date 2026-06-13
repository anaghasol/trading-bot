/**
 * Research & Conviction Engine — scores each candidate 0–10 before AI validation.
 *
 * Combines four independent signals:
 *   RS vs SPY  (0–3 pts) — outperforming the index means something is actually happening
 *   Volume pace (0–3 pts) — time-normalized relative to 3-month average
 *   52-week high proximity (0–2 pts) — breakout zone = institutional accumulation
 *   Range position (0–2 pts) — upper quartile of annual range = strong trend
 *
 * Applied in scan cron BEFORE the confidence gate so a high-research stock can
 * receive a confidence boost that pushes it over the gate threshold.
 *
 *   score ≥ 9.0  → paper: auto-qualify at 68% floor (very strong setup)
 *   score ≥ 7.5  → paper +10pts confidence, live +5pts
 *   score ≥ 5.0  → paper +5pts confidence, live +2pts
 */

export interface ResearchScore {
  symbol:            string
  rs_vs_spy:         number   // symbol day% − SPY day%
  vol_pace:          number   // vol / (avgVol × sessionFrac)
  pct_from_52w_high: number   // % below 52-week high (lower = closer to breakout)
  range_pct:         number   // 0–100, position within 52-week range
  score:             number   // 0–10 composite
  label:             'STRONG' | 'GOOD' | 'NEUTRAL'
}

function sessionFrac(): number {
  const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  if (h < 13.5) return 0.15
  if (h > 20.0) return 1
  return Math.max(0.15, (h - 13.5) / 6.5)
}

export async function batchResearch(symbols: string[]): Promise<Map<string, ResearchScore>> {
  const sf      = sessionFrac()
  const allSyms = ['SPY', ...symbols.filter((s) => s !== 'SPY')]
  const BATCH   = 50
  const rows: Record<string, unknown>[] = []

  for (let i = 0; i < allSyms.length; i += BATCH) {
    try {
      const slice = allSyms.slice(i, i + BATCH)
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${slice.join(',')}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekHigh,fiftyTwoWeekLow`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      if (!res.ok) continue
      const data = await res.json()
      rows.push(...(data.quoteResponse?.result ?? []))
    } catch { /* skip batch on network error */ }
  }

  const spyChg = Number(rows.find((r) => r.symbol === 'SPY')?.regularMarketChangePercent ?? 0)
  const out    = new Map<string, ResearchScore>()

  for (const q of rows) {
    if (q.symbol === 'SPY') continue

    const chg    = (q.regularMarketChangePercent    ?? 0) as number
    const vol    = (q.regularMarketVolume           ?? 0) as number
    const avgVol = (q.averageDailyVolume3Month      ?? 1) as number
    const high52 = (q.fiftyTwoWeekHigh              ?? 0) as number
    const low52  = (q.fiftyTwoWeekLow               ?? 0) as number
    const price  = (q.regularMarketPrice            ?? 0) as number
    const sym    = String(q.symbol)

    // ── RS vs SPY (0–3 pts) ───────────────────────────────────────────────────
    const rs = chg - spyChg
    const rsScore = rs >= 5 ? 3 : rs >= 2 ? 2 : rs >= 0.5 ? 1 : 0

    // ── Volume pace (0–3 pts) ─────────────────────────────────────────────────
    const vp = avgVol > 0 ? vol / (avgVol * sf) : 0
    const vpScore = vp >= 3 ? 3 : vp >= 2 ? 2 : vp >= 1.5 ? 1 : 0

    // ── 52-week high proximity (0–2 pts) ──────────────────────────────────────
    const pctFromHigh = high52 > 0 ? ((high52 - price) / high52) * 100 : 100
    const highScore   = pctFromHigh <= 1 ? 2 : pctFromHigh <= 5 ? 1.5 : pctFromHigh <= 10 ? 1 : 0

    // ── Annual range position (0–2 pts) ───────────────────────────────────────
    const rangeSize  = high52 - low52
    const rangePct   = rangeSize > 0 ? (price - low52) / rangeSize : 0
    const rangeScore = rangePct >= 0.90 ? 2 : rangePct >= 0.75 ? 1 : 0

    const score = Math.min(10, Math.round((rsScore + vpScore + highScore + rangeScore) * 10) / 10)

    out.set(sym, {
      symbol:            sym,
      rs_vs_spy:         Math.round(rs * 10) / 10,
      vol_pace:          Math.round(vp * 10) / 10,
      pct_from_52w_high: Math.round(pctFromHigh * 10) / 10,
      range_pct:         Math.round(rangePct * 100),
      score,
      label: score >= 8 ? 'STRONG' : score >= 6 ? 'GOOD' : 'NEUTRAL',
    })
  }

  return out
}

/** Apply research boosts to a confidence value before the AI gate. */
export function applyResearchBoost(
  confidence: number,
  rs: ResearchScore | undefined,
  isPaper: boolean
): number {
  if (!rs) return confidence
  if (isPaper) {
    if (rs.score >= 9.0) return Math.max(confidence, 68)   // auto-qualify very strong setups
    if (rs.score >= 7.5) return Math.min(100, confidence + 10)
    if (rs.score >= 5.0) return Math.min(100, confidence + 5)
  } else {
    // Live — protect real money, smaller boosts
    if (rs.score >= 8.5) return Math.min(100, confidence + 5)
    if (rs.score >= 7.0) return Math.min(100, confidence + 3)
  }
  return confidence
}
