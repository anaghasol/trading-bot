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
 */

const ALPACA_DATA    = 'https://data.alpaca.markets'
const ALPACA_TRADING = 'https://paper-api.alpaca.markets'

// Spin-off / new-listing discovery keywords — Alpaca news headlines are scanned for these
const SPINOFF_KEYWORDS = [
  'spin-off', 'spinoff', 'spun off', 'begins trading', 'begins trading independently',
  'new listing', 'newly listed', 'separated from', 'independent company',
  'rebranded', 'renamed to', 'restructuring complete', 'ipo',
]

// ── Universe: S&P 500 + Nasdaq-100 + spin-off / narrative names ─────────────
// Expanded quarterly — getExpandedUniverse() adds dynamic spin-off discoveries on top
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
  min_avg_dollar_vol: number       // $5M daily avg → filters micro-cap noise
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

export interface SupercycleCandidate {
  ticker: string
  monthly_rsi: number
  pct_above_200dma: number
  consecutive_green_months: number
  listing_age_years: number | null
  volume_expanding: boolean
  rs_vs_spy_6m: number   // stock 6m return / SPY 6m return — >1 = outperforming
  avg_dollar_vol_m: number  // 20-day avg daily dollar volume in $M
  score: number
  discovered?: boolean   // true if added via news discovery (not in static list)
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

// RS vs SPY over ~6 months (130 trading days)
// Returns ratio: 2.0 means stock returned 2× what SPY did
function rsVsSpy6m(closes: number[], spyCloses: number[]): number {
  const BARS = 130
  if (closes.length < BARS || spyCloses.length < BARS) return 1
  const stockRet = closes[closes.length - 1] / closes[closes.length - BARS] - 1
  const spyRet   = spyCloses[spyCloses.length - 1] / spyCloses[spyCloses.length - BARS] - 1
  if (spyRet <= 0) return stockRet > 0 ? 2 : 1  // edge case: SPY flat/down
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
// Scans last 90 days of Alpaca news for spin-off / new-listing headlines.
// Returns symbols mentioned in matching articles — these are added to the
// screener universe so brand-new tickers (SNDK-style) get evaluated.
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
        if (SPINOFF_KEYWORDS.some(kw => text.includes(kw))) {
          for (const sym of article.symbols ?? []) {
            if (/^[A-Z]{1,5}$/.test(sym)) found.add(sym)  // only clean tickers
          }
        }
      }
      pageToken = d.next_page_token ?? null
    } catch { break }
    pages++
  } while (pageToken && pages < 20)  // max 1000 articles

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

// ── Scorer (updated weights: +RS vs SPY factor) ───────────────────────────────
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
  // RS term: 0 if stock tracked SPY, 1.0 if stock returned 5x SPY over 6 months
  const rsTerm    = Math.min(1, Math.max(0, (rs6m - 1) / 4))
  const recency   = ageYears != null && ageYears <= cfg.max_listing_age_years
    ? 1 - ageYears / cfg.max_listing_age_years : 0
  return Math.round(
    100 * (0.35 * rsiTerm + 0.25 * devTerm + 0.20 * greenTerm + 0.10 * rsTerm + 0.10 * recency) * 100
  ) / 100
}

// ── Public entrypoint ─────────────────────────────────────────────────────────
export async function scanSupercycles(
  cfg: SupercycleConfig = DEFAULT_CONFIG,
  universe: string[] = SUPERCYCLE_UNIVERSE,
  discoveredSet: Set<string> = new Set(),
): Promise<SupercycleCandidate[]> {
  const now = new Date()

  // Always ensure SPY is in universe (needed for RS benchmark)
  if (!universe.includes('SPY')) universe = ['SPY', ...universe]

  const monthlyStart = new Date(now)
  monthlyStart.setFullYear(monthlyStart.getFullYear() - 10)

  const dailyStart = new Date(now)
  dailyStart.setMonth(dailyStart.getMonth() - 14)  // ~14 months → well over 200 trading days + RS lookback

  const [monthlyBars, dailyBars] = await Promise.all([
    fetchBars(universe, '1Month', monthlyStart.toISOString().split('T')[0]),
    fetchBars(universe, '1Day',   dailyStart.toISOString().split('T')[0]),
  ])

  // SPY daily bars used for RS calculation across all candidates
  const spyDaily = (dailyBars['SPY'] ?? []).map(b => b.c)

  const candidates: SupercycleCandidate[] = []

  for (const ticker of universe) {
    if (ticker === 'SPY' || ticker === 'QQQ' || ticker === 'IWM') continue  // skip benchmarks

    const monthly = monthlyBars[ticker] ?? []
    const daily   = dailyBars[ticker]   ?? []

    if (monthly.length < cfg.rsi_period + 2 || daily.length < 200) continue

    const mCloses = monthly.map(b => b.c)
    const mVols   = monthly.map(b => b.v)
    const dCloses = daily.map(b => b.c)

    // ── Liquidity gate: 20-day avg dollar volume (uses bars we already have) ──
    const last20 = daily.slice(-20)
    const avgDolVol = last20.reduce((s, b) => s + b.c * b.v, 0) / last20.length
    if (avgDolVol < cfg.min_avg_dollar_vol) {
      console.log(`[supercycle] skip ${ticker} — low liquidity $${(avgDolVol / 1e6).toFixed(1)}M avg`)
      continue
    }

    // ── RSI ──────────────────────────────────────────────────────────────────
    const rsi = wilderRSI(mCloses, cfg.rsi_period)
    if (!isFinite(rsi) || rsi < cfg.monthly_rsi_min) continue

    // ── 200-day MA deviation ─────────────────────────────────────────────────
    const ma200 = sma200(dCloses)
    if (!isFinite(ma200) || ma200 <= 0) continue
    const pctAbove = (dCloses[dCloses.length - 1] / ma200 - 1) * 100
    if (pctAbove < cfg.min_pct_above_200dma) continue

    // ── Green streak ─────────────────────────────────────────────────────────
    const greenMonths = consecutiveGreenMonths(mCloses)
    if (greenMonths < cfg.min_consecutive_green_months) continue

    // ── Volume expansion ─────────────────────────────────────────────────────
    const volExpanding = volumeExpanding(mVols)
    if (cfg.require_volume_expansion && !volExpanding) continue

    // ── RS vs SPY 6-month ────────────────────────────────────────────────────
    const rs6m = rsVsSpy6m(dCloses, spyDaily)

    // ── Listing age ──────────────────────────────────────────────────────────
    const firstBar  = monthly[0]
    const ageYears  = firstBar
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
