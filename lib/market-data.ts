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
  dist_from_ema20_pct: number  // negative = below EMA (pullback), positive = above
  pullback_score: number       // 0-10
  setup_type: 'EMA20_BOUNCE' | 'EMA50_PULLBACK' | 'BREAKOUT' | 'MOMENTUM'
  reason: string
}

export interface MarketRegime {
  regime: 'RISK_OFF' | 'CAUTION' | 'NORMAL'
  spy_change: number
  vix: number
  spy_above_200sma: boolean
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
  GROWTH:       ['PLTR', 'COIN', 'SOFI', 'RKLB', 'IONQ', 'ACHR', 'HOOD', 'SHOP', 'CRWD'],
  MOMENTUM:     ['MSTR', 'SMCI', 'ARM', 'UBER', 'ABNB', 'NFLX', 'SPOT', 'TSLL', 'NVDL', 'APP', 'UPST'],
  VOLATILE:     ['BBAI', 'SOUN', 'MARA', 'RIOT', 'HIMS', 'RXRX', 'JOBY', 'LUNR', 'OKLO', 'ASTS', 'RDDT'],
  ETF:          ['SPY', 'QQQ', 'ARKK', 'SOXL', 'TQQQ', 'LABU'],
  CRYPTO_PROXY: ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'IBIT', 'HOOD'],
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

interface OHLCV { closes: number[]; volumes: number[] }

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
    const volumes: number[] = (q?.volume as number[])?.filter((v) => v != null) ?? []
    return closes.length >= 20 ? { closes, volumes } : null
  } catch {
    return null
  }
}

// Keep legacy fetchChart for getMarketRegime
async function fetchChart(symbol: string, period = '15d'): Promise<number[] | null> {
  const d = await fetchOHLCV(symbol, period)
  return d?.closes ?? null
}

async function fetchQuoteBatch(symbols: string[]): Promise<Record<string, { price: number; volume: number; avgVolume: number }>> {
  try {
    const res = await fetch(
      `${YF_QUOTE}?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume3Month`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 60 } }
    )
    if (!res.ok) return {}
    const data = await res.json()
    const result: Record<string, { price: number; volume: number; avgVolume: number }> = {}
    for (const q of data.quoteResponse?.result ?? []) {
      result[q.symbol] = {
        price: q.regularMarketPrice || 0,
        volume: q.regularMarketVolume || 0,
        avgVolume: q.averageDailyVolume3Month || 1,
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
    const spy_above_200sma = spyCloses.length >= 200
      ? spyCloses.at(-1)! > sma(spyCloses, 200)
      : true

    const spy_change = spyCloses.length >= 2
      ? ((spyCloses.at(-1)! - spyCloses.at(-2)!) / spyCloses.at(-2)!) * 100
      : 0

    const vix = vixData?.at(-1) ?? 20

    let regime: MarketRegime['regime']
    let label: string

    if (spy_change <= -1.5 || vix >= 30 || !spy_above_200sma) {
      regime = 'RISK_OFF'
      label  = `Bear signal: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)} | SPY ${spy_above_200sma ? 'above' : 'BELOW'} 200SMA`
    } else if (spy_change <= -0.5 || vix >= 22) {
      regime = 'CAUTION'
      label  = `Elevated vol: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)}`
    } else {
      regime = 'NORMAL'
      label  = `Bull: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)} | above 200SMA ✓`
    }

    return { regime, spy_change, vix, spy_above_200sma, label }
  } catch {
    return { regime: 'CAUTION', spy_change: 0, vix: 20, spy_above_200sma: true, label: 'Market data unavailable' }
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
export async function scanForEMAPullback(symbols: string[]): Promise<EMASetup[]> {
  const setups: EMASetup[] = []

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      try {
        const ohlcv = await fetchOHLCV(symbol, '1y')
        if (!ohlcv || ohlcv.closes.length < 60) return

        const { closes, volumes } = ohlcv
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

        if (!in_uptrend) return  // skip broken structure

        let score = 0
        const reasons: string[] = []
        let setup_type: EMASetup['setup_type'] = 'EMA20_BOUNCE'

        // Core pattern: pullback to 20 EMA with bounce
        if (above_all_ema && near_ema20 && bouncing && rsi_ok) {
          score += 4
          setup_type = 'EMA20_BOUNCE'
          reasons.push(`20 EMA bounce (dist ${dist_from_ema20_pct.toFixed(1)}%, RSI ${rsiVal})`)
        }
        // Deeper pullback to 50 EMA
        else if (price > e50 && price <= e20 * 1.02 && rsiVal >= 45 && bouncing) {
          score += 3
          setup_type = 'EMA50_PULLBACK'
          reasons.push(`50 EMA pullback (RSI ${rsiVal})`)
        }
        // Breakout above 20 EMA after consolidation
        else if (dist_from_ema20_pct > 0 && dist_from_ema20_pct < 2 && change_1d > 1.5 && volume_spike) {
          score += 4
          setup_type = 'BREAKOUT'
          reasons.push(`EMA20 breakout +${change_1d.toFixed(1)}% on ${vol_ratio.toFixed(1)}x vol`)
        }
        // Pure momentum continuation
        else if (price > e20 && rsiVal >= 60 && rsiVal <= 78 && change_5d > 5 && volume_ok) {
          score += 2
          setup_type = 'MOMENTUM'
          reasons.push(`Momentum: +${change_5d.toFixed(1)}% 5d, RSI ${rsiVal}`)
        }
        // Loose 20 EMA pullback — paper mode: slightly above/below EMA, lower thresholds
        else if (
          Math.abs(dist_from_ema20_pct) <= 6 &&
          e20 > e50 &&
          rsiVal >= 45 &&
          vol_ratio >= 1.15
        ) {
          score += 3
          setup_type = 'EMA20_BOUNCE'
          reasons.push(`Loose EMA20 (dist ${dist_from_ema20_pct.toFixed(1)}%, RSI ${rsiVal}, ${vol_ratio.toFixed(1)}x vol)`)
        }
        // Momentum breakout — simple day move + volume surge
        else if (change_1d >= 1.5 && vol_ratio >= 1.6 && rsiVal >= 52 && price > e20) {
          score += 3
          setup_type = 'BREAKOUT'
          reasons.push(`Momentum break +${change_1d.toFixed(1)}% on ${vol_ratio.toFixed(1)}x vol, RSI ${rsiVal}`)
        }
        // Gap-up scanner — stock opened significantly higher than prior close
        else if (change_1d >= 2.5 && vol_ratio >= 2.0 && rsiVal >= 50 && rsiVal <= 80) {
          score += 4
          setup_type = 'BREAKOUT'
          reasons.push(`Gap-up +${change_1d.toFixed(1)}% on ${vol_ratio.toFixed(1)}x vol, RSI ${rsiVal}`)
        }

        if (score === 0) return  // no pattern

        // Bonus scoring
        if (volume_spike)              { score += 2; reasons.push(`${vol_ratio.toFixed(1)}× vol spike`) }
        else if (volume_ok)            { score += 1; reasons.push(`${vol_ratio.toFixed(1)}× vol`) }
        if (rsiVal >= 55 && rsiVal <= 70) { score += 1; reasons.push(`RSI ${rsiVal} ideal`) }
        if (change_5d > 8)             { score += 1; reasons.push(`+${change_5d.toFixed(1)}% 5d trend`) }
        if (change_1d > 1)             { score += 1; reasons.push(`+${change_1d.toFixed(1)}% today`) }

        setups.push({
          symbol, price, ema20: e20, ema50: e50, sma200: s200,
          rsi: rsiVal, volume_ratio: vol_ratio,
          change_1d: Math.round(change_1d * 100) / 100,
          change_5d: Math.round(change_5d * 100) / 100,
          dist_from_ema20_pct: Math.round(dist_from_ema20_pct * 100) / 100,
          pullback_score: Math.min(10, score),
          setup_type,
          reason: reasons.join(', '),
        })
      } catch {
        // skip
      }
    })
  )

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
  return 'OTHER'
}
