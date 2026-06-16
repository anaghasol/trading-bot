/**
 * Supercycle Screener — TypeScript port of supercycle_screener.py
 *
 * Finds stocks exhibiting the SNDK-style "Narrative Supercycle" signature:
 *   • Monthly RSI ≥ 80 (Wilder's, same formula as Python EWM alpha=1/period)
 *   • Price ≥ 100% above 200-day MA
 *   • ≥ 4 consecutive green monthly candles
 *   • Monthly volume expanding vs prior 6-month average
 *   • Recency bonus for spin-offs / new listings (not a hard gate)
 *
 * Data source: Alpaca monthly + daily bars (batched, no per-ticker loops)
 * Composite score: 40% RSI / 30% deviation / 20% green streak / 10% recency
 */

const ALPACA_DATA = 'https://data.alpaca.markets'

// ── Universe: S&P 500 + Nasdaq-100 + spin-off / narrative names ─────────────
// Update quarterly — add new spin-offs and hot tickers manually
export const SUPERCYCLE_UNIVERSE: string[] = [
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
  'HOOD', 'SQ', 'SOFI', 'UPST', 'AFRM', 'LC', 'PYPL', 'FIS', 'FISV', 'ADYEN',
  // Defense / Space / Next-gen infra
  'LMT', 'NOC', 'RTX', 'GD', 'BA', 'AXON', 'RKLB', 'ASTS', 'LUNR', 'RDW',
  'ACHR', 'JOBY', 'LILM', 'EVTL', 'SPCE', 'SATL', 'MNTS', 'BBB',
  // Energy transition / Power infrastructure
  'CEG', 'VST', 'NRG', 'GEV', 'ETN', 'POWL', 'ARRY', 'ENPH', 'SEDG', 'FSLR',
  'NOVA', 'HASI', 'CWEN', 'AES', 'NEE',
  // Healthcare / Biotech — GLP-1 and rare disease supercycles
  'LLY', 'NVO', 'REGN', 'BIIB', 'MRNA', 'VRTX', 'ABBV', 'BMY', 'GILD', 'AMGN',
  'ISRG', 'DXCM', 'GEHC', 'IDXX', 'BSX', 'MDT', 'SHC', 'ALNY', 'IONS', 'RXRX',
  'RLAY', 'BEAM', 'NTLA', 'CRSP', 'EDIT',
  // Consumer / Retail
  'COST', 'SHOP', 'MELI', 'BKNG', 'ABNB', 'MAR', 'SBUX', 'MCD', 'NKE', 'LULU',
  'ONON', 'DECK', 'CELH', 'ELF', 'MNST',
  // Financial
  'V', 'MA', 'JPM', 'GS', 'MS', 'BAC', 'C', 'WFC', 'BX', 'KKR', 'APO', 'ARES',
  // Industrial / Data center picks
  'CAT', 'DE', 'GE', 'HON', 'EMR', 'ROK', 'CARR', 'VRT', 'EQIX', 'DLR',
  'AMT', 'CCI', 'PLD', 'SMCI', 'ANET', 'CSCO',
  // Consumer tech / Social
  'NFLX', 'SNAP', 'RDDT', 'PINS', 'LYFT', 'UBER', 'DASH', 'ABNB', 'RBLX',
  'U', 'MTTR', 'IONQ', 'RGTI', 'QUBT',
  // Recent spin-offs / new listings (2023-2026) — highest recency bonus
  'SOLV', 'KVYO', 'ARM', 'RDDT', 'ASTL', 'ASTS', 'ACMR', 'XPEV', 'RIVN',
  'LCID', 'FSR', 'GOEV', 'WKHS', 'BLNK', 'CHPT', 'EVGO', 'PTRA', 'IDEX',
  // SPX / QQQ for regime context
  'SPY', 'QQQ', 'IWM',
]

// ── Config ───────────────────────────────────────────────────────────────────
export interface SupercycleConfig {
  monthly_rsi_min: number
  rsi_period: number
  min_pct_above_200dma: number
  min_consecutive_green_months: number
  require_volume_expansion: boolean
  max_listing_age_years: number
}

export const DEFAULT_CONFIG: SupercycleConfig = {
  monthly_rsi_min: 80,
  rsi_period: 14,
  min_pct_above_200dma: 100,
  min_consecutive_green_months: 4,
  require_volume_expansion: true,
  max_listing_age_years: 3,
}

export interface SupercycleCandidate {
  ticker: string
  monthly_rsi: number
  pct_above_200dma: number
  consecutive_green_months: number
  listing_age_years: number | null
  volume_expanding: boolean
  score: number
}

// ── Indicators ───────────────────────────────────────────────────────────────

// Wilder's RSI — recursive smoothing equivalent to Python's EWM alpha=1/period
export function wilderRSI(closes: number[], period = 14): number {
  if (closes.length < period + 2) return NaN
  const deltas = closes.slice(1).map((c, i) => c - closes[i])
  // Seed with simple average of first `period` gains/losses
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    const d = deltas[i]
    if (d > 0) avgGain += d
    else avgLoss += -d
  }
  avgGain /= period
  avgLoss /= period
  // Wilder smoothing for the rest
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
    if (closes[i] > closes[i - 1]) count++
    else break
  }
  return count
}

function sma200(dailyCloses: number[]): number {
  if (dailyCloses.length < 200) return NaN
  const slice = dailyCloses.slice(-200)
  return slice.reduce((a, b) => a + b, 0) / 200
}

function volumeExpanding(volumes: number[]): boolean {
  if (volumes.length < 9) return true
  const recent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3
  const prior  = volumes.slice(-9, -3).reduce((a, b) => a + b, 0) / 6
  return prior > 0 ? recent > prior : true
}

// ── Alpaca data fetch (batched) ───────────────────────────────────────────────
interface Bar { c: number; v: number; t: string }

async function fetchBars(
  symbols: string[],
  timeframe: '1Month' | '1Day',
  startDate: string,
): Promise<Record<string, Bar[]>> {
  const KEY = process.env.ALPACA_KEY_ID!
  const SEC = process.env.ALPACA_SECRET_KEY!
  const headers = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }
  const result: Record<string, Bar[]> = {}
  const BATCH = 50  // symbols per request

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    let pageToken: string | null = null

    do {
      const queryParams: Record<string, string> = {
        symbols: batch.join(','),
        timeframe,
        start: startDate,
        limit: '10000',
        adjustment: 'all',
        feed: 'sip',
      }
      if (pageToken) queryParams.page_token = pageToken
      try {
        const fetchRes = await fetch(
          `${ALPACA_DATA}/v2/stocks/bars?${new URLSearchParams(queryParams)}`,
          { headers, signal: AbortSignal.timeout(15000) },
        )
        if (!fetchRes.ok) { pageToken = null; break }
        const fetchData = await fetchRes.json() as { bars?: Record<string, Bar[]>; next_page_token?: string }
        for (const [sym, bars] of Object.entries(fetchData.bars ?? {})) {
          if (!result[sym]) result[sym] = []
          result[sym].push(...bars)
        }
        pageToken = fetchData.next_page_token ?? null
      } catch {
        pageToken = null
      }
    } while (pageToken)

    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 300))
    }
  }

  return result
}

// ── Scorer ───────────────────────────────────────────────────────────────────
function score(
  rsi: number,
  pctAbove: number,
  greenMonths: number,
  ageYears: number | null,
  cfg: SupercycleConfig,
): number {
  const rsiTerm   = (rsi - cfg.monthly_rsi_min) / (100 - cfg.monthly_rsi_min)
  const devTerm   = Math.min(pctAbove / 1000, 1)
  const greenTerm = Math.min(greenMonths / 12, 1)
  const recency   = (ageYears != null && ageYears <= cfg.max_listing_age_years)
    ? 1 - ageYears / cfg.max_listing_age_years
    : 0
  return Math.round(100 * (0.40 * rsiTerm + 0.30 * devTerm + 0.20 * greenTerm + 0.10 * recency) * 100) / 100
}

// ── Public entrypoint ─────────────────────────────────────────────────────────
export async function scanSupercycles(
  cfg: SupercycleConfig = DEFAULT_CONFIG,
  universe: string[] = SUPERCYCLE_UNIVERSE,
): Promise<SupercycleCandidate[]> {
  const now = new Date()

  const monthlyStart = new Date(now)
  monthlyStart.setFullYear(monthlyStart.getFullYear() - 10)

  const dailyStart = new Date(now)
  dailyStart.setMonth(dailyStart.getMonth() - 14)  // ~14 months → well over 200 trading days

  const [monthlyBars, dailyBars] = await Promise.all([
    fetchBars(universe, '1Month', monthlyStart.toISOString().split('T')[0]),
    fetchBars(universe, '1Day',   dailyStart.toISOString().split('T')[0]),
  ])

  const candidates: SupercycleCandidate[] = []

  for (const ticker of universe) {
    const monthly = monthlyBars[ticker] ?? []
    const daily   = dailyBars[ticker]   ?? []

    if (monthly.length < cfg.rsi_period + 2 || daily.length < 200) continue

    const mCloses = monthly.map(b => b.c)
    const mVols   = monthly.map(b => b.v)
    const dCloses = daily.map(b => b.c)

    const rsi = wilderRSI(mCloses, cfg.rsi_period)
    if (!isFinite(rsi) || rsi < cfg.monthly_rsi_min) continue

    const ma200 = sma200(dCloses)
    if (!isFinite(ma200) || ma200 <= 0) continue

    const lastPrice = dCloses[dCloses.length - 1]
    const pctAbove  = (lastPrice / ma200 - 1) * 100
    if (pctAbove < cfg.min_pct_above_200dma) continue

    const greenMonths = consecutiveGreenMonths(mCloses)
    if (greenMonths < cfg.min_consecutive_green_months) continue

    const volExpanding = volumeExpanding(mVols)
    if (cfg.require_volume_expansion && !volExpanding) continue

    // Listing age from first bar timestamp
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
      score: score(rsi, pctAbove, greenMonths, ageYears, cfg),
    })
  }

  return candidates.sort((a, b) => b.score - a.score)
}
