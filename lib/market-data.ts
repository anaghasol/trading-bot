/**
 * Yahoo Finance REST API client for market data.
 * No API key required - uses public endpoints.
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
  high_52w: number
  low_52w: number
}

export interface MarketRegime {
  regime: 'RISK_OFF' | 'CAUTION' | 'NORMAL'
  spy_change: number
  vix: number
  label: string
}

const YF_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'
const YF_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote'

// Watchlist - high-liquidity stocks with good momentum
export const WATCHLIST = {
  TECH:     ['NVDA', 'AMD', 'MSFT', 'AAPL', 'PLTR'],
  CONSUMER: ['TSLA', 'AMZN', 'SHOP', 'NFLX'],
  FINANCE:  ['COIN', 'SOFI'],
  COMM:     ['META', 'GOOGL'],
  ETF:      ['SPY', 'QQQ'],
}

export const ALL_SYMBOLS = Object.values(WATCHLIST).flat()

// ── Technical Analysis ────────────────────────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50

  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains += change
    else losses += Math.abs(change)
  }

  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100

  const rs = avgGain / avgLoss
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

async function fetchChart(symbol: string, period = '15d'): Promise<number[] | null> {
  try {
    const res = await fetch(
      `${YF_CHART}/${symbol}?interval=1d&range=${period}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 300 },
      }
    )
    if (!res.ok) return null

    const data = await res.json()
    const closes: number[] = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close
    return closes?.filter((c: number) => c != null) ?? null
  } catch {
    return null
  }
}

async function fetchQuoteBatch(symbols: string[]): Promise<Record<string, { price: number; volume: number; avgVolume: number }>> {
  try {
    const syms = symbols.join(',')
    const res = await fetch(
      `${YF_QUOTE}?symbols=${syms}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume3Month`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 60 },
      }
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function getMarketRegime(): Promise<MarketRegime> {
  try {
    const [spyCloses, vixCloses] = await Promise.all([
      fetchChart('SPY', '5d'),
      fetchChart('%5EVIX', '2d'),
    ])

    const spy_change =
      spyCloses && spyCloses.length >= 2
        ? ((spyCloses.at(-1)! - spyCloses.at(-2)!) / spyCloses.at(-2)!) * 100
        : 0

    const vix = vixCloses?.at(-1) ?? 20

    let regime: MarketRegime['regime']
    let label: string

    if (spy_change <= -1.5 || vix >= 30) {
      regime = 'RISK_OFF'
      label = `Market crash warning: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)}`
    } else if (spy_change <= -0.5 || vix >= 22) {
      regime = 'CAUTION'
      label = `Elevated volatility: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)}`
    } else {
      regime = 'NORMAL'
      label = `Healthy market: SPY ${spy_change.toFixed(1)}% | VIX ${vix.toFixed(0)}`
    }

    return { regime, spy_change, vix, label }
  } catch {
    return { regime: 'CAUTION', spy_change: 0, vix: 20, label: 'Market data unavailable' }
  }
}

export async function getMarketData(symbols: string[]): Promise<MarketData[]> {
  const results: MarketData[] = []

  const quotes = await fetchQuoteBatch(symbols)

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      const closes = await fetchChart(symbol, '15d')
      if (!closes || closes.length < 6) return

      const price = closes.at(-1)!
      const prev = closes.at(-2)!
      const week_ago = closes.at(-6)!

      const change_1d = ((price - prev) / prev) * 100
      const change_5d = ((price - week_ago) / week_ago) * 100
      const rsi = calculateRSI(closes)

      const q = quotes[symbol] || { volume: 0, avgVolume: 1 }
      const volume_ratio = q.avgVolume > 0 ? q.volume / q.avgVolume : 1

      results.push({
        symbol,
        price: Math.round(price * 100) / 100,
        prev_close: Math.round(prev * 100) / 100,
        change_1d: Math.round(change_1d * 100) / 100,
        change_5d: Math.round(change_5d * 100) / 100,
        volume: q.volume,
        avg_volume: q.avgVolume,
        volume_ratio: Math.round(volume_ratio * 100) / 100,
        rsi,
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
