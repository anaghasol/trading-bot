/**
 * Supercycle Screener — TypeScript port of supercycle_screener.py
 *
 * Finds stocks exhibiting the SNDK-style "Narrative Supercycle" signature:
 *   • Monthly RSI ≥ 80 (Wilder's, same formula as Python EWM alpha=1/period)
 *   • Price ≥ 100% above 200-day MA
 *   • ≥ 4 consecutive green monthly candles
 *   • Monthly volume expanding vs prior 6-month average
 *   • Liquidity gate: 20-day avg dollar volume > $5M (computed from daily bars, no extra API call)
 *   • RS vs SPY 6-month included in scoring (stock outperforms → higher score)
 *   • Recency bonus for spin-offs / new listings (not a hard gate)
 *
 * Universe: static 250-symbol base + dynamic discovery via Alpaca news scan
 * (headlines mentioning "spin-off", "spun off", "begins trading" etc. in last 90 days)
 * This is what would have caught SNDK on day 1 of its listing.
 *
 * Composite score: 35% RSI / 25% deviation / 20% green streak / 10% RS vs SPY / 10% recency
 *
 * Early-Watch layer: stocks passing relaxed gates (RSI ≥ 60, +20% 200MA, 2+ green months)
 * but NOT yet full criteria are stored as WATCHLIST — auto-promoted when they graduate.
 */

const ALPACA_DATA    = 'https://data.alpaca.markets'
const ALPACA_TRADING = 'https://paper-api.alpaca.markets'

// Negative filter — skip articles that match these even if a positive keyword also matches.
const NEGATIVE_KEYWORDS = [
  'bankruptcy', 'bankrupt', 'chapter 11', 'chapter 7', 'delisting', 'delisted',
  'sec investigation', 'sec charges', 'fraud charges', 'class action',
  'lawsuit filed', 'securities fraud', 'accounting irregularities',
  'going concern', 'default notice', 'debt restructuring',
]

// Discovery keywords — Alpaca news headlines/summaries scanned for these.
const SPINOFF_KEYWORDS = [
  // Corporate structure changes
  'spin-off', 'spinoff', 'spun off', 'begins trading', 'begins trading independently',
  'new listing', 'newly listed', 'separated from', 'independent company',
  'rebranded', 'renamed to', 'restructuring complete',
  'direct listing', 'reverse merger', 'de-spac',
  // IPO / capital events
  'ipo', 'initial public offering', 'priced its ipo', 'began trading on',
  'uplisted to', 'uplisting to nasdaq', 'uplisting to nyse',
  // Catalysts that create narrative identity changes
  'fda approval', 'fda approved', 'breakthrough designation',
  'major contract', 'awarded contract', 'billion-dollar contract',
  'strategic partnership', 'exclusive partnership', 'named preferred supplier',
  'pivots to', 'pivot to ai', 'enters ai', 'ai infrastructure',
  'acquisition complete', 'merger complete', 'completed the acquisition',
]

// ── Universe: S&P 500 + Nasdaq-100 + spin-off / narrative names ─────────────
export const SUPERCYCLE_UNIVERSE: string[] = [
  // Always include SPY for RS benchmark calculation
  'SPY', 'QQQ', 'IWM',
  // Mega-cap
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'TSLA', 'BRK-B', 'ORCL',
  // Semis — most supercycle-prone sector
  'AVGO', 'QCOM', 'AMD', 'INTC', 'MU', 'AMAT', 'LRCX', 'KLAC', 'TXN', 'ADI',
  'MCHP', 'ON', 'NXPI', 'ASML', 'ARM', 'SNDK', 'WDC', 'SMCI', 'GFS', 'CRUS',
  'ACLS', 'AMBA', 'MRVL', 'SWKS', 'QRVO', 'MPWR', 'WOLF', 'MKSI',
  // AI / Cloud / Software
  'PLTR', 'SNOW', 'DDOG', 'CRWD', 'ZS', 'PANW', 'NET', 'OKTA', 'MDB', 'TEAM',
  'WDAY', 'CRM', 'NOW', 'VEEV', 'HUBS', 'GTLB', 'SMAR', 'BILL', 'TTD', 'APP',
  'APPN', 'AI', 'BBAI', 'SOUN', 'GFAI', 'KOPN',
  // Crypto-adjacent
  'COIN', 'MSTR', 'RIOT', 'MARA', 'CLSK', 'IREN', 'HUT', 'CIFR', 'WULF', 'CORZ',
  'BTBT', 'BITF',
  // Fintech
  'HOOD', 'SQ', 'SOFI', 'UPST', 'AFRM', 'LC', 'PYPL', 'FIS', 'FISV',
  // Defense / Space / Next-gen infra
  'LMT', 'NOC', 'RTX', 'GD', 'BA', 'AXON', 'RKLB', 'ASTS', 'LUNR', 'RDW',
  'ACHR', 'JOBY', 'LILM', 'EVTL', 'SPCE', 'SATL', 'MNTS',
  // Energy transition / Power infrastructure
  'CEG', 'VST', 'NRG', 'GEV', 'ETN', 'POWL', 'ARRY', 'ENPH', 'SEDG', 'FSLR',
  'NOVA', 'HASI', 'AES', 'NEE',
  // Healthcare / Biotech — GLP-1 and rare disease supercycles
  'LLY', 'NVO', 'REGN', 'BIIB', 'MRNA', 'VRTX', 'ABBV', 'BMY', 'GILD', 'AMGN',
  'ISRG', 'DXCM', 'GEHC', 'IDXX', 'BSX', 'MDT', 'ALNY', 'IONS', 'RXRX',
  'BEAM', 'NTLA', 'CRSP', 'EDIT',
  // Consumer / Retail
  'COST', 'SHOP', 'MELI', 'BKNG', 'ABNB', 'MAR', 'SBUX', 'MCD', 'NKE', 'LULU',
  'ONON', 'DECK', 'CELH', 'ELF', 'MNST', 'DKNG', 'DUOL', 'TOST',
  // Financial
  'V', 'MA', 'JPM', 'GS', 'MS', 'BAC', 'C', 'WFC', 'BX', 'KKR', 'APO', 'ARES',
  // Industrial / Data center picks
  'CAT', 'DE', 'GE', 'HON', 'EMR', 'ROK', 'CARR', 'VRT', 'EQIX', 'DLR',
  'AMT', 'CCI', 'PLD', 'ANET', 'CSCO',
  // Consumer tech / Social / Quantum
  'NFLX', 'SNAP', 'RDDT', 'PINS', 'LYFT', 'UBER', 'DASH', 'RBLX',
  'U', 'IONQ', 'RGTI', 'QUBT', 'QMCO',
  // Recent spin-offs / new listings (2023-2026) — highest recency bonus
  'SOLV', 'KVYO', 'RDDT', 'ASTL', 'ACMR', 'XPEV', 'RIVN', 'LCID',
  'BLNK', 'CHPT', 'EVGO', 'ZM', 'PTON',
]

// ── Config ───────────────────────────────────────────────────────────────────
export interface SupercycleConfig {
  monthly_rsi_min: number
  rsi_period: number
  min_pct_above_200dma: number
  min_consecutive_green_months: number
  require_volume_expansion: boolean
  max_listing_age_years: number
  min_avg_dollar_vol: number
}

export const DEFAULT_CONFIG: SupercycleConfig = {
  monthly_rsi_min:               80,
  rsi_period:                    14,
  min_pct_above_200dma:          100,
  min_consecutive_green_months:  4,
  require_volume_expansion:      true,
  max_listing_age_years:         3,
  min_avg_dollar_vol:            5_000_000,
}

// Relaxed gates for Early Watch — catches SNDK-style runners 2-4 months before they light up
export const WATCHLIST_CONFIG: SupercycleConfig = {
  monthly_rsi_min:               60,
  rsi_period:                    14,
  min_pct_above_200dma:          20,
  min_consecutive_green_months:  2,
  require_volume_expansion:      false,
  max_listing_age_years:         5,
  min_avg_dollar_vol:            5_000_000,
}

export interface SupercycleCandidate {
  ticker: string
  monthly_rsi: number
  pct_above_200dma: number
  consecutive_green_months: number
  listing_age_years: number | null
  volume_expanding: boolean
  rs_vs_spy_6m: number
  avg_dollar_vol_m: number
  score: number
  discovered?: boolean
}

// WatchlistItem = SupercycleCandidate + criteria_met (how many of the 4 full gates pass)
export interface WatchlistItem extends SupercycleCandidate {
  criteria_met: number   // 0–4: gates met against DEFAULT_CONFIG thresholds
}

// ── Indicators ───────────────────────────────────────────────────────────────

export function wilderRSI(closes: number[], period = 14): number {
  if (closes.length < period + 2) return NaN
  const deltas = closes.slice(1).map((c, i) => c - closes[i])
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    const d = deltas[i]
    if (d > 0) avgGain += d; else avgLoss += -d
  }
  avgGain /= period; avgLoss /= period
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function consecutiveGreenMonths(closes: number[]): number {
  let count = 0
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) count++; else break
  }
  return count
}

function sma200(closes: number[]): number {
  if (closes.length < 200) return NaN
  return closes.slice(-200).reduce((a, b) => a + b, 0) / 200
}

function volumeExpanding(volumes: number[]): boolean {
  if (volumes.length < 9) return true
  const recent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3
  const prior  = volumes.slice(-9, -3).reduce((a, b) => a + b, 0) / 6
  return prior > 0 ? recent > prior : true
}

function rsVsSpy6m(closes: number[], spyCloses: number[]): number {
  const BARS = 130
  if (closes.length < BARS || spyCloses.length < BARS) return 1
  const stockRet = closes[closes.length - 1] / closes[closes.length - BARS] - 1
  const spyRet   = spyCloses[spyCloses.length - 1] / spyCloses[spyCloses.length - BARS] - 1
  if (spyRet <= 0) return stockRet > 0 ? 2 : 1
  return Math.round((stockRet / spyRet) * 100) / 100
}

// ── Alpaca data fetch (batched, paginated) ────────────────────────────────────
interface Bar { c: number; v: number; t: string }

async function fetchBars(
  symbols: string[],
  timeframe: '1Month' | '1Day',
  startDate: string,
): Promise<Record<string, Bar[]>> {
  const headers = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }
  const result: Record<string, Bar[]> = {}
  const BATCH = 50

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    let pageToken: string | null = null

    do {
      const qp: Record<string, string> = {
        symbols: batch.join(','), timeframe, start: startDate,
        limit: '10000', adjustment: 'all', feed: 'sip',
      }
      if (pageToken) qp.page_token = pageToken
      try {
        const res = await fetch(`${ALPACA_DATA}/v2/stocks/bars?${new URLSearchParams(qp)}`, {
          headers, signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) { pageToken = null; break }
        const d = await res.json() as { bars?: Record<string, Bar[]>; next_page_token?: string }
        for (const [sym, bars] of Object.entries(d.bars ?? {})) {
          if (!result[sym]) result[sym] = []
          result[sym].push(...bars)
        }
        pageToken = d.next_page_token ?? null
      } catch { pageToken = null }
    } while (pageToken)

    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300))
  }
  return result
}

// ── Dynamic discovery: Alpaca news spin-off scanner ──────────────────────────
async function discoverNewListings(): Promise<string[]> {
  const headers = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  const found  = new Set<string>()
  let pageToken: string | null = null
  let pages = 0

  do {
    const qp: Record<string, string> = { start: cutoff, limit: '50', sort: 'desc' }
    if (pageToken) qp.page_token = pageToken
    try {
      const res = await fetch(
        `${ALPACA_DATA}/v1beta1/news?${new URLSearchParams(qp)}`,
        { headers, signal: AbortSignal.timeout(10000) },
      )
      if (!res.ok) break
      const d = await res.json() as {
        news?: { headline: string; summary?: string; symbols?: string[] }[]
        next_page_token?: string
      }
      for (const article of d.news ?? []) {
        const text = `${article.headline ?? ''} ${article.summary ?? ''}`.toLowerCase()
        const isNegative = NEGATIVE_KEYWORDS.some(kw => text.includes(kw))
        if (!isNegative && SPINOFF_KEYWORDS.some(kw => text.includes(kw))) {
          for (const sym of article.symbols ?? []) {
            if (/^[A-Z]{1,5}$/.test(sym)) found.add(sym)
          }
        }
      }
      pageToken = d.next_page_token ?? null
    } catch { break }
    pages++
  } while (pageToken && pages < 20)

  return Array.from(found)
}

// ── Public: expanded universe (static base + spin-off discoveries) ────────────
export async function getExpandedUniverse(): Promise<{ symbols: string[]; discovered: string[] }> {
  const base = new Set<string>(SUPERCYCLE_UNIVERSE)
  let discovered: string[] = []
  try {
    discovered = await discoverNewListings()
    let added = 0
    for (const sym of discovered) { if (!base.has(sym)) { base.add(sym); added++ } }
    console.log(`[supercycle] Universe: ${SUPERCYCLE_UNIVERSE.length} base + ${added} discovered (${discovered.length} raw hits) = ${base.size} total`)
  } catch (e) {
    console.warn('[supercycle] News discovery failed — using static universe:', e)
  }
  return { symbols: Array.from(base), discovered }
}

// ── Scorer ────────────────────────────────────────────────────────────────────
function score(
  rsi: number,
  pctAbove: number,
  greenMonths: number,
  rs6m: number,
  ageYears: number | null,
  cfg: SupercycleConfig,
): number {
  const rsiTerm   = (rsi - cfg.monthly_rsi_min) / (100 - cfg.monthly_rsi_min)
  const devTerm   = Math.min(pctAbove / 1000, 1)
  const greenTerm = Math.min(greenMonths / 12, 1)
  const rsTerm    = Math.min(1, Math.max(0, (rs6m - 1) / 4))
  const recency   = ageYears != null && ageYears <= cfg.max_listing_age_years
    ? 1 - ageYears / cfg.max_listing_age_years : 0
  return Math.round(
    100 * (0.35 * rsiTerm + 0.25 * devTerm + 0.20 * greenTerm + 0.10 * rsTerm + 0.10 * recency) * 100
  ) / 100
}

// ── Internal: evaluate a universe against a config given pre-fetched bars ─────
// Separated from bar-fetching so scanAll() can call it twice without double-fetching.
function evaluateTickers(
  cfg: SupercycleConfig,
  universe: string[],
  monthlyBars: Record<string, Bar[]>,
  dailyBars: Record<string, Bar[]>,
  spyDaily: number[],
  discoveredSet: Set<string>,
  now: Date,
): SupercycleCandidate[] {
  const candidates: SupercycleCandidate[] = []

  for (const ticker of universe) {
    if (ticker === 'SPY' || ticker === 'QQQ' || ticker === 'IWM') continue

    const monthly = monthlyBars[ticker] ?? []
    const daily   = dailyBars[ticker]   ?? []

    if (monthly.length < cfg.rsi_period + 2 || daily.length < 200) continue

    const mCloses = monthly.map(b => b.c)
    const mVols   = monthly.map(b => b.v)
    const dCloses = daily.map(b => b.c)

    const lastPrice = dCloses[dCloses.length - 1]
    if (lastPrice < 5) continue

    const last20 = daily.slice(-20)
    const avgDolVol = last20.reduce((s, b) => s + b.c * b.v, 0) / last20.length
    if (avgDolVol < cfg.min_avg_dollar_vol) continue

    const rsi = wilderRSI(mCloses, cfg.rsi_period)
    if (!isFinite(rsi) || rsi < cfg.monthly_rsi_min) continue

    const ma200 = sma200(dCloses)
    if (!isFinite(ma200) || ma200 <= 0) continue
    const pctAbove = (dCloses[dCloses.length - 1] / ma200 - 1) * 100
    if (pctAbove < cfg.min_pct_above_200dma) continue

    const greenMonths = consecutiveGreenMonths(mCloses)
    if (greenMonths < cfg.min_consecutive_green_months) continue

    const volExpanding = volumeExpanding(mVols)
    if (cfg.require_volume_expansion && !volExpanding) continue

    const rs6m = rsVsSpy6m(dCloses, spyDaily)

    const firstBar = monthly[0]
    const ageYears = firstBar
      ? Math.round(((now.getTime() - new Date(firstBar.t).getTime()) / (365.25 * 86400000)) * 100) / 100
      : null

    candidates.push({
      ticker,
      monthly_rsi:              Math.round(rsi * 100) / 100,
      pct_above_200dma:         Math.round(pctAbove * 10) / 10,
      consecutive_green_months: greenMonths,
      listing_age_years:        ageYears,
      volume_expanding:         volExpanding,
      rs_vs_spy_6m:             rs6m,
      avg_dollar_vol_m:         Math.round(avgDolVol / 1e5) / 10,
      score:                    score(rsi, pctAbove, greenMonths, rs6m, ageYears, cfg),
      discovered:               discoveredSet.has(ticker),
    })
  }

  return candidates.sort((a, b) => b.score - a.score)
}

// ── Public: scan all — returns full candidates + early-watch list ─────────────
// Fetches bars ONCE and evaluates against both DEFAULT_CONFIG and WATCHLIST_CONFIG.
// Use this in the cron — it's more efficient than calling scanSupercycles + a second pass.
export async function scanAll(
  universe: string[] = SUPERCYCLE_UNIVERSE,
  discoveredSet: Set<string> = new Set(),
): Promise<{ candidates: SupercycleCandidate[]; watchlist: WatchlistItem[] }> {
  const now = new Date()
  if (!universe.includes('SPY')) universe = ['SPY', ...universe]

  const monthlyStart = new Date(now)
  monthlyStart.setFullYear(monthlyStart.getFullYear() - 10)
  const dailyStart = new Date(now)
  dailyStart.setMonth(dailyStart.getMonth() - 14)

  console.log('[supercycle] Fetching bars for', universe.length, 'symbols…')
  const [monthlyBars, dailyBars] = await Promise.all([
    fetchBars(universe, '1Month', monthlyStart.toISOString().split('T')[0]),
    fetchBars(universe, '1Day',   dailyStart.toISOString().split('T')[0]),
  ])

  const spyDaily = (dailyBars['SPY'] ?? []).map(b => b.c)

  // Full supercycle candidates
  const candidates = evaluateTickers(DEFAULT_CONFIG, universe, monthlyBars, dailyBars, spyDaily, discoveredSet, now)
  const candidateSymbols = new Set(candidates.map(c => c.ticker))

  // Relaxed pass — filter out already-promoted tickers
  const relaxed = evaluateTickers(WATCHLIST_CONFIG, universe, monthlyBars, dailyBars, spyDaily, discoveredSet, now)
    .filter(c => !candidateSymbols.has(c.ticker))

  // Count which of the 4 FULL gates each watchlist item currently meets
  const watchlist: WatchlistItem[] = relaxed.map(c => ({
    ...c,
    criteria_met: [
      c.monthly_rsi               >= DEFAULT_CONFIG.monthly_rsi_min,
      c.pct_above_200dma          >= DEFAULT_CONFIG.min_pct_above_200dma,
      c.consecutive_green_months  >= DEFAULT_CONFIG.min_consecutive_green_months,
      c.volume_expanding,
    ].filter(Boolean).length,
  })).sort((a, b) => b.criteria_met - a.criteria_met || b.monthly_rsi - a.monthly_rsi)

  return { candidates, watchlist }
}

// Backward-compat wrapper — cron code that called scanSupercycles still works.
export async function scanSupercycles(
  cfg: SupercycleConfig = DEFAULT_CONFIG,
  universe: string[] = SUPERCYCLE_UNIVERSE,
  discoveredSet: Set<string> = new Set(),
): Promise<SupercycleCandidate[]> {
  const { candidates } = await scanAll(universe, discoveredSet)
  return candidates
}
