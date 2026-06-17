/**
 * Stage 2 Breakout Screener — finds SNDK-pattern stocks across the FULL US market.
 *
 * Stage 2 (Weinstein / O'Neil definition):
 *   Stock has been in a sustained uptrend for months:
 *     • Price > $8, avg volume > 200K (liquid, real)
 *     • Within 15% of 52-week high (still in the run, not broken)
 *     • Above 200 SMA (institutional uptrend confirmed)
 *     • RSI > 50 (momentum, not extended or broken)
 *     • Sorted by 6-month performance (best sustained runners first)
 *
 * This is how SNDK looked from early 2025 — cheap base, then never looked back.
 * Current discovery only sees TODAY's movers. This finds stocks that have been
 * quietly compounding for months and are still going.
 *
 * Sources (in priority order, all free):
 *   1. Finviz screener HTML — full 7000+ US stock universe, richest criteria
 *   2. Yahoo Finance predefined screeners — growth + momentum categories
 *   3. Yahoo Finance 52w-high screener — stocks currently at yearly highs
 *
 * Runs via supercycle cron (weekly Sunday) → saves to tb_settings['stage2_watchlist']
 * Injected into ai-advisor symbol universe every scan tick.
 */

const EXCLUDE = new Set([
  'SPY','QQQ','IWM','DIA','TQQQ','SQQQ','UVXY','VXX','SPXS','SPXL',
  'GLD','SLV','TLT','HYG','AGG','BND','GDX','GDXJ',
])

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── Source 1: Finviz full-market screener ─────────────────────────────────────
// Filters ~7000 US stocks down to Stage 2 candidates, sorted by 6-month RS.
// Returns up to 100 tickers.

export async function getStage2FromFinviz(): Promise<string[]> {
  // Each page of Finviz shows 20 results. Fetch first 5 pages (100 stocks).
  const BASE = 'https://finviz.com/screener.ashx'
  const FILTERS = [
    'sh_price_o8',        // price > $8
    'sh_avgvol_o200',     // 3-month avg volume > 200K
    'ta_rsi_ob50',        // RSI(14) > 50 — bullish momentum
    'ta_sma200_pa',       // price above 200-day SMA — institutional uptrend
    'ta_highlow52w_b0to15h',  // within 15% of 52-week high — still in the run
  ].join(',')

  const allTickers: string[] = []

  for (const startRow of [1, 21, 41, 61, 81]) {
    try {
      const url = `${BASE}?v=111&f=${FILTERS}&ft=4&o=-perf6m&r=${startRow}`
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) break
      const html = await res.text()
      // Finviz ticker links look like: href="quote.ashx?t=NVDA"
      const matches = Array.from(html.matchAll(/href="quote\.ashx\?t=([A-Z]{1,6})"/g))
      const page = Array.from(new Set(matches.map((m) => m[1]))).filter((s) => !EXCLUDE.has(s) && /^[A-Z]{1,5}$/.test(s))
      if (page.length === 0) break  // no more results
      allTickers.push(...page)
    } catch {
      break  // rate-limited or network issue — use what we have
    }
    // Polite delay between pages so Finviz doesn't block us
    await new Promise((r) => setTimeout(r, 800))
  }

  const unique = Array.from(new Set(allTickers))
  console.log(`[stage2] Finviz: ${unique.length} Stage 2 candidates`)
  return unique
}

// ── Source 2: Yahoo Finance growth / momentum predefined screeners ─────────────
// These are Yahoo's curated lists — not full-market but good Stage 2 overlap.

export async function getStage2FromYahoo(): Promise<string[]> {
  const SCREENER_IDS = [
    'undervalued_growth_stocks',   // strong fundamentals + price momentum
    'growth_technology_stocks',    // tech in sustained uptrends
    'small_cap_gainers',           // small cap momentum leaders
  ]
  const results: string[] = []
  for (const id of SCREENER_IDS) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=50`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }
      )
      if (!res.ok) continue
      const data = await res.json() as { finance: { result: [{ quotes: { symbol: string }[] }] } }
      const quotes = data.finance?.result?.[0]?.quotes ?? []
      const syms = quotes
        .map((q) => q.symbol)
        .filter((s) => s && /^[A-Z]{1,5}$/.test(s) && !EXCLUDE.has(s))
      results.push(...syms)
      console.log(`[stage2] Yahoo ${id}: ${syms.length} symbols`)
    } catch { /* non-fatal, try next */ }
  }
  return Array.from(new Set(results))
}

// ── Source 3: Yahoo Finance 52-week high screener ──────────────────────────────
// Stocks currently AT or near their 52-week highs = classic Stage 2 signal.

export async function get52WeekHighLeaders(minVol = 300_000, minPrice = 8): Promise<string[]> {
  // Yahoo doesn't have a "52_wk_high" predefined ID, so we pull most_actives
  // and day_gainers with a wider count, then filter by 52w high proximity ourselves.
  const results: string[] = []
  for (const scrId of ['most_actives', 'day_gainers']) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=100`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }
      )
      if (!res.ok) continue
      const data = await res.json() as { finance: { result: [{ quotes: Record<string, unknown>[] }] } }
      const quotes = data.finance?.result?.[0]?.quotes ?? []
      for (const q of quotes) {
        const sym   = String(q.symbol ?? '')
        const price = Number(q.regularMarketPrice ?? 0)
        const vol   = Number(q.regularMarketVolume ?? q.averageDailyVolume10Day ?? 0)
        const high52 = Number(q.fiftyTwoWeekHigh ?? 0)
        if (!sym || EXCLUDE.has(sym) || !/^[A-Z]{1,5}$/.test(sym)) continue
        if (price < minPrice || vol < minVol) continue
        // Within 20% of 52-week high = Stage 2 active
        if (high52 > 0 && price / high52 < 0.80) continue
        results.push(sym)
      }
    } catch { /* non-fatal */ }
  }
  const deduped = Array.from(new Set(results))
  console.log(`[stage2] 52w-high leaders: ${deduped.length} symbols`)
  return deduped
}

// ── Combined Stage 2 build ─────────────────────────────────────────────────────

export interface Stage2Result {
  symbols: string[]
  from_finviz: number
  from_yahoo: number
  from_52wh: number
  total: number
  scanned_at: string
}

export async function buildStage2Watchlist(): Promise<Stage2Result> {
  console.log('[stage2] Starting full-market Stage 2 screen…')

  const [finviz, yahoo, highLeaders] = await Promise.allSettled([
    getStage2FromFinviz(),
    getStage2FromYahoo(),
    get52WeekHighLeaders(),
  ])

  const fv  = finviz.status  === 'fulfilled' ? finviz.value  : []
  const yh  = yahoo.status   === 'fulfilled' ? yahoo.value   : []
  const hl  = highLeaders.status === 'fulfilled' ? highLeaders.value : []

  // Deduplicate — Finviz results take priority (most filtered)
  const seen = new Set<string>()
  const combined: string[] = []
  for (const sym of [...fv, ...yh, ...hl]) {
    if (!seen.has(sym)) { seen.add(sym); combined.push(sym) }
  }

  console.log(`[stage2] Total Stage 2 candidates: ${combined.length} (finviz=${fv.length} yahoo=${yh.length} 52wh=${hl.length})`)

  return {
    symbols:      combined,
    from_finviz:  fv.length,
    from_yahoo:   yh.length,
    from_52wh:    hl.length,
    total:        combined.length,
    scanned_at:   new Date().toISOString(),
  }
}
