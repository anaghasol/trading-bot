/**
 * Market data + mechanical pattern scanner.
 *
 * Flow: mechanical EMA scanner runs FIRST (cheap, no AI cost), then only the
 * pre-filtered setups go to Claude for final validation. This generates daily
 * signals instead of waiting for Claude to reach arbitrary confidence on random
 * symbols.
 *
 * Pattern: 20/50 EMA Pullback + Momentum Confirmation
 *   • Uptrend: price > 20 EMA > 50 EMA > 200 SMA
 *   • Market filter: SPY above 200 SMA + VIX < 25
 *   • Pullback: price within 4% of 20 EMA (touched/near it)
 *   • Momentum: RSI > 50 + volume spike ≥ 1.5× avg
 *   • Bull flag: price bouncing, not falling through EMA
 */

export interface MarketData {
  symbol: string
  price: number
  prev_close: number
  change_1d: number
  change_5d: number
  volume: number
  avg_volume: number
  volume_ratio: number
  rsi: number
  ema20: number
  ema50: number
  sma200: number
  above_200sma: boolean
  pullback_score: number  // 0-10 mechanical strength
  high_52w: number
  low_52w: number
}

export interface EMASetup {
  symbol: string
  price: number
  ema20: number
  ema50: number
  sma200: number
  rsi: number
  volume_ratio: number
  change_1d: number
  change_5d: number
  dist_from_ema20_pct: number
  pullback_score: number
  setup_type: 'EMA20_BOUNCE' | 'EMA50_PULLBACK' | 'BREAKOUT' | 'MOMENTUM'
  reason: string
  // Candlestick + RS additions
  candle_pattern: string        // e.g. 'HAMMER', 'ENGULFING', 'NONE'
  rs_vs_spy: number             // stock 1d change minus SPY 1d change
  earnings_soon: boolean        // within 7 days of earnings (avoid)
  earnings_date: string | null  // ISO date of next earnings, e.g. "2026-07-22"
  hv30: number | null           // 30-day annualized historical volatility % (IV proxy)
  rs_rank: number               // 0-100 percentile rank by 1d RS within scanned batch
  pct_from_52w_high: number     // % below 52w high (negative, e.g. -12.5 = 12.5% below)
}

export interface MarketRegime {
  regime: 'RISK_OFF' | 'CAUTION' | 'NORMAL'
  spy_change: number
  vix: number
  spy_above_200sma: boolean
  days_below_200sma: number  // 0 if above, else consecutive trading days below
  label: string
}

const YF_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'
const YF_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote'

// Schwab live — liquid names with strong EMA behaviour (expanded)
export const WATCHLIST = {
  TECH:     ['NVDA', 'AMD', 'MSFT', 'AAPL', 'PLTR', 'AVGO', 'ARM'],
  CONSUMER: ['TSLA', 'AMZN', 'SHOP', 'NFLX', 'UBER'],
  FINANCE:  ['COIN', 'SOFI', 'HOOD'],
  COMM:     ['META', 'GOOGL'],
  ETF:      ['SPY', 'QQQ'],
}

// Alpaca paper — wide aggressive universe (high-beta, EMA-responsive)
export const ALPACA_WATCHLIST = {
  MEGA:         ['NVDA', 'AMD', 'MSFT', 'AAPL', 'TSLA', 'META', 'GOOGL', 'AMZN', 'AVGO'],
  GROWTH:       ['PLTR', 'COIN', 'SOFI', 'RKLB', 'IONQ', 'ACHR', 'HOOD', 'SHOP', 'CRWD', 'INTC', 'AFRM', 'DKNG', 'TTD', 'CELH', 'DUOL'],
  MOMENTUM:     ['MSTR', 'SMCI', 'ARM', 'UBER', 'ABNB', 'NFLX', 'SPOT', 'TSLL', 'NVDL', 'APP', 'UPST', 'SOXL', 'RIVN', 'SNAP', 'ZM'],
  VOLATILE:     ['BBAI', 'SOUN', 'MARA', 'RIOT', 'HIMS', 'RXRX', 'JOBY', 'LUNR', 'OKLO', 'ASTS', 'RDDT', 'SPIR', 'TEM', 'POET', 'GME', 'MRNA', 'PTON'],
  SPACE_DEFENSE:['SPCX', 'RKLB', 'ASTS', 'LUNR', 'JOBY', 'ACHR', 'IONQ', 'OKLO'],
  ETF:          ['SPY', 'QQQ', 'ARKK', 'SOXL', 'TQQQ', 'IWM', 'SPXL', 'LABU', 'FAS'],
  CRYPTO_PROXY: ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'IBIT'],
}

export const ALL_SYMBOLS        = Object.values(WATCHLIST).flat()
export const ALL_ALPACA_SYMBOLS = Object.values(ALPACA_WATCHLIST).flat().filter((s, i, a) => a.indexOf(s) === i)

// ── Technical Indicators ──────────────────────────────────────────────────────

/** Exponential Moving Average — properly converged */
function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return prices.map(() => prices.at(-1) ?? 0)
  const k = 2 / (period + 1)
  const result: number[] = []
  // Seed with SMA of first `period` values
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = 0; i < prices.length; i++) {
    const val = i < period ? prices[i] : prices[i] * k + prev * (1 - k)
    result.push(Math.round(val * 100) / 100)
    if (i >= period - 1) prev = result[i]
  }
  return result
}

function sma(prices: number[], period: number): number {
  const slice = prices.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const ag = gains / period, al = losses / period
  if (al === 0) return 100
  return Math.round((100 - 100 / (1 + ag / al)) * 10) / 10
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

interface OHLCV {
  opens: number[]; highs: number[]; lows: number[]
  closes: number[]; volumes: number[]
}

async function fetchOHLCV(symbol: string, range = '1y'): Promise<OHLCV | null> {
  try {
    const res = await fetch(
      `${YF_CHART}/${symbol}?interval=1d&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 300 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    const q = data.chart?.result?.[0]?.indicators?.quote?.[0]
    const closes: number[]  = (q?.close  as number[])?.filter((c) => c != null) ?? []
    const opens: number[]   = (q?.open   as number[])?.filter((c) => c != null) ?? []
    const highs: number[]   = (q?.high   as number[])?.filter((c) => c != null) ?? []
    const lows: number[]    = (q?.low    as number[])?.filter((c) => c != null) ?? []
    const volumes: number[] = (q?.volume as number[])?.filter((v) => v != null) ?? []
    return closes.length >= 20 ? { opens, highs, lows, closes, volumes } : null
  } catch {
    return null
  }
}

// ── Candlestick Pattern Detection ─────────────────────────────────────────────

function detectCandle(opens: number[], highs: number[], lows: number[], closes: number[]): string {
  const o  = opens.at(-1)!,  h  = highs.at(-1)!,  l  = lows.at(-1)!,  c  = closes.at(-1)!
  const o2 = opens.at(-2)!,  h2 = highs.at(-2)!,  l2 = lows.at(-2)!,  c2 = closes.at(-2)!
  const body    = Math.abs(c - o)
  const range   = h - l
  const upWick  = h - Math.max(o, c)
  const dnWick  = Math.min(o, c) - l
  const bullish = c > o

  if (range === 0) return 'NONE'

  // Bullish Engulfing: current green candle fully wraps previous red candle
  if (bullish && c2 < o2 && o < c2 && c > o2) return 'ENGULFING'

  // Hammer: small body near top, long lower wick (>= 2× body), tiny upper wick
  if (bullish && dnWick >= body * 2 && upWick <= body * 0.5 && body / range < 0.4) return 'HAMMER'

  // Dragonfly Doji: tiny body, very long lower wick
  if (body / range < 0.1 && dnWick >= range * 0.7) return 'DOJI_BULL'

  // Morning Star (3-candle): big red → small body → big green
  const o3 = opens.at(-3)!, c3 = closes.at(-3)!
  const midBodySmall = Math.abs(c2 - o2) < Math.abs(c3 - o3) * 0.4
  if (c3 < o3 && midBodySmall && bullish && c > (o3 + c3) / 2) return 'MORNING_STAR'

  // Bullish Marubozu: nearly all body, minimal wicks (strong momentum)
  if (bullish && body / range > 0.85) return 'MARUBOZU'

  // Inside bar after down move (compression before breakout)
  if (h < h2 && l > l2 && c2 < o2) return 'INSIDE_BAR'

  // Tweezer bottom: two candles with near-identical lows (double support)
  if (Math.abs(l - l2) / l < 0.003) return 'TWEEZER_BOTTOM'

  return 'NONE'
}

// Candle score bonus: 0 = no pattern, up to 3 = strong confirmation
function candleScore(pattern: string): number {
  return { ENGULFING: 3, MORNING_STAR: 3, HAMMER: 2, DOJI_BULL: 2,
           MARUBOZU: 2, TWEEZER_BOTTOM: 2, INSIDE_BAR: 1, NONE: 0 }[pattern] ?? 0
}

// ── Earnings Proximity Check ──────────────────────────────────────────────────

export async function getEarningsInfo(symbol: string): Promise<{ soon: boolean; daysUntil: number | null; date: string | null }> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 3600 } }
    )
    if (!res.ok) return { soon: false, daysUntil: null, date: null }
    const data = await res.json()
    const dates = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate
    if (!Array.isArray(dates) || dates.length === 0) return { soon: false, daysUntil: null, date: null }
    const nextEarnings = new Date((dates[0].raw as number) * 1000)
    const daysUntil = (nextEarnings.getTime() - Date.now()) / 86_400_000
    return {
      soon: daysUntil >= 0 && daysUntil <= 7,
      daysUntil: Math.round(daysUntil * 10) / 10,
      date: nextEarnings.toISOString().split('T')[0],
    }
  } catch { return { soon: false, daysUntil: null, date: null } }
}

async function hasEarningsSoon(symbol: string): Promise<boolean> {
  return (await getEarningsInfo(symbol)).soon
}

// ── Historical Volatility (HV30) — free IV proxy ──────────────────────────────
// Annualized 30-day HV from log returns of daily closes.
// Correlates ~80% with implied volatility — no options chain needed.
//
// Interpretation:
//   HV30 < 25%  → low vol / quiet stock
//   HV30 25-40% → moderate — options priced fairly
//   HV30 > 40%  → elevated — options expensive, good for post-earnings put selling
//   HV30 > 60%  → very high — biotech/meme territory, avoid unless directional
export async function getHistoricalVolatility(symbol: string): Promise<{ hv30: number | null; elevated: boolean }> {
  try {
    const ohlcv = await fetchOHLCV(symbol, '45d')
    const closes = ohlcv?.closes
    if (!closes || closes.length < 22) return { hv30: null, elevated: false }
    const last30 = closes.slice(-31)
    const logReturns = last30.slice(1).map((c, i) => Math.log(c / last30[i]))
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
    const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length
    const hv30 = Math.sqrt(variance * 252) * 100
    return { hv30: Math.round(hv30 * 10) / 10, elevated: hv30 > 38 }
  } catch { return { hv30: null, elevated: false } }
}

// Keep legacy fetchChart for getMarketRegime
async function fetchChart(symbol: string, period = '15d'): Promise<number[] | null> {
  const d = await fetchOHLCV(symbol, period)
  return d?.closes ?? null
}

async function fetchQuoteBatch(symbols: string[]): Promise<Record<string, { price: number; volume: number; avgVolume: number; changePct: number }>> {
  try {
    const res = await fetch(
      `${YF_QUOTE}?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume3Month,regularMarketChangePercent`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 60 } }
    )
    if (!res.ok) return {}
    const data = await res.json()
    const result: Record<string, { price: number; volume: number; avgVolume: number; changePct: number }> = {}
    for (const q of data.quoteResponse?.result ?? []) {
      result[q.symbol] = {
        price:     q.regularMarketPrice        || 0,
        volume:    q.regularMarketVolume        || 0,
        avgVolume: q.averageDailyVolume3Month   || 1,
        changePct: q.regularMarketChangePercent || 0,
      }
    }
    return result
  } catch {
    return {}
  }
}

// ── Market Regime (extended: SPY 200 SMA check) ───────────────────────────────

export async function getMarketRegime(): Promise<MarketRegime> {
  try {
    const [spy1y, vixData] = await Promise.all([
      fetchOHLCV('SPY', '1y'),
      fetchChart('%5EVIX', '2d'),
    ])

    const spyCloses     = spy1y?.closes ?? []
    const sma200val = spyCloses.length >= 200 ? sma(spyCloses, 200) : null
    const spy_above_200sma = sma200val !== null ? spyCloses.at(-1)! > sma200val : true

    // Count consecutive trading days SPY has closed below the 200SMA (from most recent backward)
    let days_below_200sma = 0
    if (sma200val !== null && !spy_above_200sma) {
      for (let i = spyCloses.length - 1; i >= Math.max(0, spyCloses.length - 30); i--) {
        const dayAvg = sma(spyCloses.slice(0, i + 1), Math.min(200, i + 1))
        if (spyCloses[i] < dayAvg) days_below_200sma++
        else break
      }
    }

    const spy_change = spyCloses.length >= 2
      ? ((spyCloses.at(-1)! - spyCloses.at(-2)!) / spyCloses.at(-2)!) * 100
      : 0

    const vix = vixData?.at(-1) ?? 20

    let regime: MarketRegime['regime']
    let label: string

    // Sustained downtrend: >3 days below 200SMA = treat same as RISK_OFF even on calm days
    const sustainedDowntrend = days_below_200sma >= 3
    if (spy_change <= -1.5 || vix >= 30 || !spy_above_200sma || sustainedDowntrend) {
      regime = 'RISK_OFF'
      label  = `Bear signal: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)} | SPY ${spy_above_200sma ? 'above' : `BELOW 200SMA ${days_below_200sma}d`}`
    } else if (spy_change <= -0.5 || vix >= 22) {
      regime = 'CAUTION'
      label  = `Elevated vol: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)}`
    } else {
      regime = 'NORMAL'
      label  = `Bull: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)} | above 200SMA ✓`
    }

    return { regime, spy_change, vix, spy_above_200sma, days_below_200sma, label }
  } catch {
    return { regime: 'CAUTION', spy_change: 0, vix: 20, spy_above_200sma: true, days_below_200sma: 0, label: 'Market data unavailable' }
  }
}

// ── 20/50 EMA Pullback Scanner — the mechanical pre-filter ───────────────────

/**
 * Scans symbols for the 20 EMA pullback pattern:
 *   1. Uptrend confirmed: price > 20 EMA > 50 EMA > 200 SMA
 *   2. Pullback: price touched or is near 20 EMA (within 4%)
 *   3. Bounce: today's price > yesterday's (bouncing off EMA, not falling through)
 *   4. RSI > 50 (momentum intact)
 *   5. Volume ≥ 1.5× 20-day avg (institutional interest)
 *
 * Returns setups sorted by pullback_score descending. Fetch 1y data for
 * accurate 200-period calculations.
 */
export async function scanForEMAPullback(
  symbols: string[],
  opts: { loose?: boolean } = {},  // loose=true for paper: relaxed 52w filter + lower gap bar
): Promise<EMASetup[]> {
  const loose = opts.loose ?? false
  const setups: EMASetup[] = []

  // Fetch SPY once for relative strength baseline
  const spyOhlcv = await fetchOHLCV('SPY', '5d')
  const spyChange1d = spyOhlcv && spyOhlcv.closes.length >= 2
    ? ((spyOhlcv.closes.at(-1)! - spyOhlcv.closes.at(-2)!) / spyOhlcv.closes.at(-2)!) * 100
    : 0

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      try {
        const ohlcv = await fetchOHLCV(symbol, '1y')
        if (!ohlcv || ohlcv.closes.length < 60) return

        const { opens, highs, lows, closes, volumes } = ohlcv
        const price   = closes.at(-1)!
        const prev    = closes.at(-2)!

        const ema20arr = ema(closes, 20)
        const ema50arr = ema(closes, 50)
        const e20      = ema20arr.at(-1)!
        const e50      = ema50arr.at(-1)!
        const s200     = closes.length >= 200 ? sma(closes, 200) : sma(closes, closes.length)
        const rsiVal   = rsi(closes, 14)

        const change_1d = ((price - prev) / prev) * 100
        const change_5d = closes.length >= 6
          ? ((price - closes.at(-6)!) / closes.at(-6)!) * 100 : 0

        // 52-week high proximity — Minervini for live: skip if > 25% below.
        // Paper (loose): allow up to -45% — volatile names like BBAI/SOUN/MARA
        // are legitimately far from highs but are the best paper momentum targets.
        const high_52w = Math.max(...closes.slice(-252))
        const pct_from_52w_high = Math.round(((price - high_52w) / high_52w) * 10000) / 100
        if (pct_from_52w_high < (loose ? -45 : -25)) return

        // Volume vs 20-day average
        const avgVol20   = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20
        const todayVol   = volumes.at(-1) ?? 0
        const vol_ratio  = avgVol20 > 0 ? todayVol / avgVol20 : 1

        // Distance from 20 EMA
        const dist_from_ema20_pct = e20 > 0 ? ((price - e20) / e20) * 100 : 0

        // ── Pattern checks ────────────────────────────────────────────────────
        const in_uptrend    = e20 > e50 && e50 > s200  // EMA stack aligned
        const above_all_ema = price > e20               // price above 20 EMA
        const near_ema20    = dist_from_ema20_pct >= -4 && dist_from_ema20_pct <= 6  // within band
        const bouncing      = price >= prev              // today up vs yesterday
        const rsi_ok        = rsiVal >= 48 && rsiVal <= 80  // momentum intact, not overbought
        const volume_ok     = vol_ratio >= 1.3           // some interest
        const volume_spike  = vol_ratio >= 1.8           // strong interest

        let score = 0
        const reasons: string[] = []
        let setup_type: EMASetup['setup_type'] = 'EMA20_BOUNCE'

        // ── Tier 1: Classic patterns (require uptrend) ────────────────────────
        if (in_uptrend) {
          if (above_all_ema && near_ema20 && bouncing && rsi_ok) {
            score += 4; setup_type = 'EMA20_BOUNCE'
            reasons.push(`20 EMA bounce (dist ${dist_from_ema20_pct.toFixed(1)}%, RSI ${rsiVal})`)
          } else if (price > e50 && price <= e20 * 1.02 && rsiVal >= 45 && bouncing) {
            score += 3; setup_type = 'EMA50_PULLBACK'
            reasons.push(`50 EMA pullback (RSI ${rsiVal})`)
          } else if (dist_from_ema20_pct > 0 && dist_from_ema20_pct < 2 && change_1d > 1.5 && volume_spike) {
            score += 4; setup_type = 'BREAKOUT'
            reasons.push(`EMA20 breakout +${change_1d.toFixed(1)}% on ${vol_ratio.toFixed(1)}x vol`)
          } else if (price > e20 && rsiVal >= 60 && rsiVal <= 78 && change_5d > 5 && volume_ok) {
            score += 2; setup_type = 'MOMENTUM'
            reasons.push(`Momentum: +${change_5d.toFixed(1)}% 5d, RSI ${rsiVal}`)
          }
        }

        // ── Tier 2: Loose patterns — NO volume requirement because intraday
        //    volume is partial (e.g. 11am vol ≈ 40% of daily avg, always fails)
        if (score === 0) {
          if (Math.abs(dist_from_ema20_pct) <= 8 && e20 > e50 && rsiVal >= 42) {
            score += 3; setup_type = 'EMA20_BOUNCE'
            reasons.push(`Loose EMA20 (dist ${dist_from_ema20_pct.toFixed(1)}%, RSI ${rsiVal})`)
          } else if (change_1d >= 1.5 && rsiVal >= 50 && price > e20) {
            score += 3; setup_type = 'BREAKOUT'
            reasons.push(`Momentum +${change_1d.toFixed(1)}% RSI ${rsiVal}`)
          } else if (change_1d >= (loose ? 1.5 : 2.5) && rsiVal >= 45 && rsiVal <= 85) {
            score += 4; setup_type = 'BREAKOUT'
            reasons.push(`Gap-up +${change_1d.toFixed(1)}%, RSI ${rsiVal}`)
          } else if (price > e50 && rsiVal >= 38 && dist_from_ema20_pct >= -10) {
            score += 2; setup_type = 'EMA20_BOUNCE'
            reasons.push(`Near EMA (dist ${dist_from_ema20_pct.toFixed(1)}%, RSI ${rsiVal})`)
          } else if (change_1d >= (loose ? 0.3 : 0.5) && price > e50 && rsiVal >= 40) {
            score += 2; setup_type = 'MOMENTUM'
            reasons.push(`Up-day +${change_1d.toFixed(1)}%, RSI ${rsiVal}`)
          }
        }

        if (score === 0) return  // no pattern matched

        // Bonus scoring
        if (volume_spike)              { score += 2; reasons.push(`${vol_ratio.toFixed(1)}× vol spike`) }
        else if (volume_ok)            { score += 1; reasons.push(`${vol_ratio.toFixed(1)}× vol`) }
        if (rsiVal >= 55 && rsiVal <= 70) { score += 1; reasons.push(`RSI ${rsiVal} ideal`) }
        if (change_5d > 8)             { score += 1; reasons.push(`+${change_5d.toFixed(1)}% 5d trend`) }
        if (change_1d > 1)             { score += 1; reasons.push(`+${change_1d.toFixed(1)}% today`) }

        // ── 52-week high proximity bonus ──────────────────────────────────────
        if (pct_from_52w_high >= -10)      { score += 2; reasons.push(`within 10% of 52w high`) }
        else if (pct_from_52w_high >= -20) { score += 1; reasons.push(`within 20% of 52w high`) }

        // ── Candlestick pattern ───────────────────────────────────────────────
        const candle_pattern = detectCandle(opens, highs, lows, closes)
        const cScore = candleScore(candle_pattern)
        if (cScore > 0) { score += cScore; reasons.push(`${candle_pattern} candle`) }

        // ── Relative strength vs SPY ──────────────────────────────────────────
        const rs_vs_spy = Math.round((change_1d - spyChange1d) * 100) / 100
        if (rs_vs_spy > 2) { score += 2; reasons.push(`RS+${rs_vs_spy.toFixed(1)}% vs SPY`) }
        else if (rs_vs_spy > 1) { score += 1; reasons.push(`RS+${rs_vs_spy.toFixed(1)}% vs SPY`) }

        // ── Earnings proximity + HV30 (run in parallel — both use cached OHLCV) ─
        const [earningsInfo, hvData] = await Promise.all([
          getEarningsInfo(symbol),
          getHistoricalVolatility(symbol),
        ])
        const earnings_soon = earningsInfo.soon
        if (earnings_soon) {
          const dStr = earningsInfo.daysUntil !== null ? ` in ${earningsInfo.daysUntil.toFixed(0)}d` : ''
          reasons.push(`⚠️ earnings${dStr} — skip`)
        }
        if (hvData.elevated) {
          reasons.push(`HV30=${hvData.hv30}% elevated`)
        }

        setups.push({
          symbol, price, ema20: e20, ema50: e50, sma200: s200,
          rsi: rsiVal, volume_ratio: vol_ratio,
          change_1d: Math.round(change_1d * 100) / 100,
          change_5d: Math.round(change_5d * 100) / 100,
          dist_from_ema20_pct: Math.round(dist_from_ema20_pct * 100) / 100,
          pullback_score: earnings_soon ? 0 : Math.min(10, score),
          setup_type,
          reason: reasons.join(', '),
          candle_pattern,
          rs_vs_spy,
          earnings_soon,
          earnings_date: earningsInfo.date,
          hv30: hvData.hv30,
          pct_from_52w_high,
          rs_rank: 0,  // computed after all symbols processed
        })
      } catch {
        // skip
      }
    })
  )

  // Compute intra-batch RS rank: percentile of 1d change within this scan
  if (setups.length > 1) {
    const ranked = [...setups].sort((a, b) => a.change_1d - b.change_1d)
    for (const s of setups) {
      const idx = ranked.findIndex(x => x.symbol === s.symbol)
      s.rs_rank = Math.round((idx / (ranked.length - 1)) * 100)
      if (!s.earnings_soon) {
        if (s.rs_rank >= 90)      { s.pullback_score = Math.min(10, s.pullback_score + 3); s.reason += `, RS#${s.rs_rank}` }
        else if (s.rs_rank >= 75) { s.pullback_score = Math.min(10, s.pullback_score + 2); s.reason += `, RS#${s.rs_rank}` }
        else if (s.rs_rank >= 60) { s.pullback_score = Math.min(10, s.pullback_score + 1); s.reason += `, RS#${s.rs_rank}` }
      }
    }
  }

  return setups.sort((a, b) => b.pullback_score - a.pullback_score)
}

// ── Legacy getMarketData (used by category-rotation + learning) ───────────────

export async function getMarketData(symbols: string[]): Promise<MarketData[]> {
  const results: MarketData[] = []
  const quotes = await fetchQuoteBatch(symbols)

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      const ohlcv = await fetchOHLCV(symbol, '1y')
      if (!ohlcv || ohlcv.closes.length < 20) return

      const { closes, volumes } = ohlcv
      const price     = closes.at(-1)!
      const prev      = closes.at(-2)!
      const week_ago  = closes.length >= 6 ? closes.at(-6)! : prev

      const e20arr = ema(closes, 20)
      const e50arr = ema(closes, 50)
      const s200   = closes.length >= 200 ? sma(closes, 200) : sma(closes, closes.length)
      const rsiVal = rsi(closes, 14)

      const change_1d = ((price - prev) / prev) * 100
      const change_5d = ((price - week_ago) / week_ago) * 100

      const q = quotes[symbol] || { volume: 0, avgVolume: 1 }
      const vol_ratio = q.avgVolume > 0 ? q.volume / q.avgVolume : 1

      const pullback_score_raw = (
        (e20arr.at(-1)! > e50arr.at(-1)! && e50arr.at(-1)! > s200 ? 2 : 0) +
        (rsiVal > 50 && rsiVal < 75 ? 2 : 0) +
        (vol_ratio >= 1.5 ? 2 : vol_ratio >= 1.0 ? 1 : 0) +
        (change_5d > 0 ? 1 : 0) +
        (change_1d > 0 ? 1 : 0)
      )

      results.push({
        symbol,
        price: Math.round(price * 100) / 100,
        prev_close: Math.round(prev * 100) / 100,
        change_1d: Math.round(change_1d * 100) / 100,
        change_5d: Math.round(change_5d * 100) / 100,
        volume: q.volume,
        avg_volume: q.avgVolume,
        volume_ratio: Math.round(vol_ratio * 100) / 100,
        rsi: rsiVal,
        ema20: e20arr.at(-1)!,
        ema50: e50arr.at(-1)!,
        sma200: Math.round(s200 * 100) / 100,
        above_200sma: price > s200,
        pullback_score: Math.min(10, pullback_score_raw),
        high_52w: 0,
        low_52w: 0,
      })
    })
  )

  return results
}

export function getSector(symbol: string): string {
  for (const [sector, syms] of Object.entries(WATCHLIST)) {
    if (syms.includes(symbol)) return sector
  }
  for (const [sector, syms] of Object.entries(ALPACA_WATCHLIST)) {
    if ((syms as string[]).includes(symbol)) return sector
  }
  return 'OTHER'
}

// ── Opening Range Breakout helper ────────────────────────────────────────────
// Returns the opening range high (max of first 30 min 5-min bar highs) or null
// if too early (range not formed yet) or outside meaningful ORB window.
// Only called for paper mode candidates — adds 2pts to score on breakout.
async function getOpeningRangeHigh(symbol: string): Promise<number | null> {
  // Don't evaluate until 30 min after market open (14:00 UTC in EDT, June)
  // and stop caring after 3 PM ET (19:00 UTC) — intraday ORB loses edge late day
  const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  if (utcH < 14.0 || utcH > 19.0) return null

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (!res.ok) return null
    const data = await res.json()
    const bars = data.chart?.result?.[0]
    if (!bars) return null

    // First 6 bars = first 30 minutes of the trading session (5-min intervals)
    const highs: number[] = bars.indicators?.quote?.[0]?.high ?? []
    const orbHighs = highs.slice(0, 6).filter((h: number) => h > 0)
    if (orbHighs.length === 0) return null

    return Math.max(...orbHighs)
  } catch {
    return null
  }
}

// ── Momentum Spike Scanner ────────────────────────────────────────────────────
// Catches explosive movers and new IPOs that the EMA scanner misses:
//   - Works with as little as 20 days of data (EMA scanner needs ≥60)
//   - Requires: strong today's move + volume spike + near recent high
//   - Perfect for: new IPOs, short squeezes, news-driven breakouts (SPCX-type)

export async function scanMomentumSpike(
  symbols: string[],
  spyChange1d = 0,
  opts: { loose?: boolean } = {}
): Promise<EMASetup[]> {
  const setups: EMASetup[] = []

  // How far through the 6.5-hour NYSE session are we? (9:30-16:00 ET = 13:30-20:00 UTC)
  // Used to compute volume pace: "trading at Nx the normal rate for this exact time of day"
  const hoursUTC = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  const sessionFraction = hoursUTC < 13.5 ? 0 : hoursUTC > 20.0 ? 1 : (hoursUTC - 13.5) / 6.5
  const sf = Math.max(0.15, sessionFraction)  // floor at 15% to avoid false spikes at open

  // Step 1: batch-fetch live quotes for ALL symbols — one call per 50 symbols.
  // regularMarketChangePercent is real-time (no partial-day ambiguity).
  // volPace = vol / (avg3m * sf): >2.0 means trading at 2x the expected rate right now.
  const BATCH = 50
  const quoteMap: Record<string, { price: number; volume: number; avgVolume: number; changePct: number }> = {}
  for (let i = 0; i < symbols.length; i += BATCH) {
    try {
      const slice = symbols.slice(i, i + BATCH)
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${slice.join(',')}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume3Month,regularMarketChangePercent`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 30 } }
      )
      if (res.ok) {
        const data = await res.json()
        for (const q of (data.quoteResponse?.result ?? [])) {
          quoteMap[q.symbol] = {
            price:     q.regularMarketPrice        || 0,
            volume:    q.regularMarketVolume        || 0,
            avgVolume: q.averageDailyVolume3Month   || 1,
            changePct: q.regularMarketChangePercent || 0,
          }
        }
      }
    } catch { /* skip batch */ }
  }

  // Quick pre-filter: only fetch OHLCV for symbols actually moving with elevated volume pace.
  // Paper (loose) mode casts a wider net: +0.8% and 1.4× pace to generate more candidates;
  // live stays strict at +1.5% and 2.0× so we only surface truly explosive moves.
  const MIN_CHANGE   = opts.loose ? 0.8 : 1.5
  const MIN_VOL_PACE = opts.loose ? 1.4 : 2.0

  const candidates = symbols.filter(sym => {
    const q = quoteMap[sym]
    if (!q || q.price <= 0) return false
    if (q.changePct < MIN_CHANGE) return false
    const volPace = q.avgVolume > 0 ? q.volume / (q.avgVolume * sf) : 0
    return volPace >= MIN_VOL_PACE
  })

  console.log(`[momentum] ${symbols.length} scanned → ${candidates.length} candidates (sf=${sf.toFixed(2)}): ${candidates.slice(0, 8).join(', ')}`)
  if (candidates.length === 0) return []

  // Step 2: OHLCV only for candidates — for EMA, RSI, breakout, 52w analysis
  await Promise.allSettled(
    candidates.map(async (symbol) => {
      try {
        const ohlcv = await fetchOHLCV(symbol, '3mo')
        if (!ohlcv || ohlcv.closes.length < 10) return

        const { opens, highs, lows, closes, volumes } = ohlcv

        // Use real-time quote values — more accurate than daily close during trading hours
        const qt        = quoteMap[symbol]
        const price     = qt?.price    || closes.at(-1)!
        const change_1d = qt?.changePct || ((closes.at(-1)! - closes.at(-2)!) / closes.at(-2)!) * 100

        // Time-normalized volume pace (same formula as the pre-filter above)
        const todayVol  = qt?.volume || volumes.at(-1) || 0
        const avgVol    = qt?.avgVolume || (volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1))
        const vol_ratio = avgVol > 0 ? todayVol / (avgVol * sf) : 1

        // Historical closes only (exclude today's partial candle) for breakout analysis
        const histCloses   = closes.length > 1 ? closes.slice(0, -1) : closes
        const high20d      = Math.max(...histCloses.slice(-20))
        const breakout     = price >= high20d * 0.99

        const high_all     = Math.max(...histCloses, price)
        const pct_from_52w_high = Math.round(((price - high_all) / high_all) * 10000) / 100

        const change_5d = closes.length >= 6
          ? ((price - closes.at(-6)!) / closes.at(-6)!) * 100 : change_1d

        const priceSeries = [...histCloses, price]
        const rsiVal = rsi(priceSeries, Math.min(14, priceSeries.length - 1))

        if (rsiVal > 85 && !breakout) return

        let score = 4
        const reasons: string[] = [`Spike +${change_1d.toFixed(1)}% on ${vol_ratio.toFixed(1)}x vol pace`]

        // vol_ratio is time-normalized pace (2.0 = twice expected rate for this time of day)
        if (vol_ratio >= 5)        { score += 3; reasons.push(`${vol_ratio.toFixed(0)}x pace surge`) }
        else if (vol_ratio >= 3)   { score += 2; reasons.push(`${vol_ratio.toFixed(1)}x pace`) }
        else if (vol_ratio >= 2)   { score += 1 }

        if (change_1d >= 8)        { score += 3; reasons.push(`+${change_1d.toFixed(1)}% explosive`) }
        else if (change_1d >= 4)   { score += 2; reasons.push(`+${change_1d.toFixed(1)}% strong`) }
        else if (change_1d >= 2)   { score += 1 }

        if (breakout)              { score += 2; reasons.push('20d high breakout') }
        if (pct_from_52w_high >= -5) { score += 2; reasons.push('near 52w high') }

        const rs_vs_spy = Math.round((change_1d - spyChange1d) * 100) / 100
        if (rs_vs_spy > 3)         { score += 2; reasons.push(`RS+${rs_vs_spy.toFixed(1)}% vs SPY`) }
        else if (rs_vs_spy > 1)    { score += 1 }

        const candle_pattern = detectCandle(opens, highs, lows, closes)
        score += candleScore(candle_pattern)

        const ema20arr = ema(priceSeries, Math.min(20, priceSeries.length))
        const ema50arr = ema(priceSeries, Math.min(50, priceSeries.length))
        const e20  = ema20arr.at(-1)!
        const e50  = ema50arr.at(-1)!
        const s200 = sma(priceSeries, Math.min(200, priceSeries.length))

        // ORB: in paper (loose) mode, check if price just broke above the opening range high.
        // Only runs after 10:00 ET — adds 2 pts and flags setup as 'ORB' for the AI prompt.
        let setup_type: EMASetup['setup_type'] = 'MOMENTUM'
        if (opts.loose) {
          const orbHigh = await getOpeningRangeHigh(symbol)
          if (orbHigh && price > orbHigh) {
            score += 3
            reasons.push(`ORB breakout above $${orbHigh.toFixed(2)}`)
            setup_type = 'BREAKOUT'  // BREAKOUT type gets the AI excited
          }
        }

        setups.push({
          symbol, price, ema20: e20, ema50: e50, sma200: s200,
          rsi: rsiVal, volume_ratio: vol_ratio,
          change_1d: Math.round(change_1d * 100) / 100,
          change_5d: Math.round(change_5d * 100) / 100,
          dist_from_ema20_pct: e20 > 0 ? Math.round(((price - e20) / e20) * 10000) / 100 : 0,
          pullback_score: Math.min(10, score),
          setup_type,
          reason: reasons.join(', '),
          candle_pattern,
          rs_vs_spy,
          earnings_soon: false,
          earnings_date: null,
          hv30: null,
          pct_from_52w_high,
          rs_rank: 0,
        })
      } catch { /* skip */ }
    })
  )

  const sorted = setups.sort((a, b) => b.pullback_score - a.pullback_score)
  if (sorted.length > 0) {
    const top = sorted.slice(0, 5).map(s => `${s.symbol} +${s.change_1d}% score=${s.pullback_score} (${s.reason})`).join('\n  ')
    console.log(`[momentum] ${sorted.length} setups found:\n  ${top}`)
  }
  return sorted
}
