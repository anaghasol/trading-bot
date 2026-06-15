/**
 * Market sentiment from free APIs — zero AI cost, zero auth for reads.
 *
 * Sources:
 *  1. Alpaca News API — recent headlines per symbol batch (free with Alpaca key)
 *  2. Polymarket Gamma API — active macro prediction markets (unauthenticated)
 *
 * Role in the pipeline:
 *  - Pre-filter EMA/momentum scan candidates BEFORE sending to Claude/OpenAI:
 *      symbols with strong bearish news (≥2 bearish articles) are dropped,
 *      which cuts AI token usage by 20-40% on noisy days.
 *  - Inject formatted news + Polymarket context into the Claude/OpenAI prompt
 *      so both AIs can factor in breaking headlines when rating confidence.
 *  - Per-symbol net score drives confidence bonus (+3 bullish, -8 bearish)
 *      applied after AI scoring in the merge step.
 */

const ALPACA_NEWS = 'https://data.alpaca.markets/v1beta1/news'
const POLY_BASE   = 'https://gamma-api.polymarket.com'

const ALPACA_KEY    = process.env.ALPACA_KEY_ID ?? ''
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? ''

const BULL_KW = /\b(surge|beat|record|jump|soar|rally|upgrade|outperform|rise|gain|strong|bullish|breakout|tops|best|acqui|partner|contract|launch|approved|clears|wins|deal)\b/i
const BEAR_KW = /\b(plunge|plunges|drop|drops|miss|misses|fall|falls|decline|declines|downgrade|warning|warns|concern|lawsuit|investigation|recall|fraud|loss|selloff|crash|cut|cuts|layoff|bankrupt|halt|halted|delist|probe|fine|penalty)\b/i

// High-severity bearish: earnings miss, legal/regulatory action, fraud, SEC — these are -4 each
const HIGH_SEVERITY_BEAR = /\b(SEC|fraud|bankruptcy|bankrupt|delist|criminal|securities violation|class action|restatement|going concern|misses estimates|earnings warning|guidance cut|suspended|HALT)\b/i

export interface NewsItem {
  symbol: string
  headline: string
  published_at: string
  sentiment: 'bullish' | 'bearish' | 'neutral'
  score: number  // raw weight applied to symbolScore (+1 bullish, -2 bearish, -4 high-severity)
  recent: boolean  // published within last 4 hours
}

export interface PolymarketSignal {
  question: string
  yes_pct: number  // 0-100 probability
  volume: number
}

export interface MarketSentimentResult {
  news: NewsItem[]
  polymarket: PolymarketSignal[]
  newsContext: string     // formatted string injected into Claude/OpenAI prompt
  symbolScores: Record<string, number>  // +1 bullish, -2 bearish per article
}

function classifyHeadline(headline: string): { sentiment: 'bullish' | 'bearish' | 'neutral'; score: number } {
  const isBull        = BULL_KW.test(headline)
  const isBear        = BEAR_KW.test(headline)
  const isHighSeverity = HIGH_SEVERITY_BEAR.test(headline)
  if (isHighSeverity)         return { sentiment: 'bearish', score: -4 }
  if (isBear && !isBull)      return { sentiment: 'bearish', score: -2 }
  if (isBull && !isBear)      return { sentiment: 'bullish', score: 1 }
  return { sentiment: 'neutral', score: 0 }
}

export async function getAlpacaNews(symbols: string[]): Promise<NewsItem[]> {
  if (!ALPACA_KEY || symbols.length === 0) return []
  try {
    const batch = symbols.slice(0, 50).join(',')
    const url   = `${ALPACA_NEWS}?symbols=${encodeURIComponent(batch)}&limit=50&include_content=false&sort=desc`
    const res   = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data = await res.json() as { news: Array<{ headline: string; created_at: string; symbols: string[] }> }
    const symSet = new Set(symbols)
    const cutoff4h = new Date(Date.now() - 4 * 60 * 60_000)
    const items: NewsItem[] = []
    for (const article of data.news ?? []) {
      const { sentiment, score } = classifyHeadline(article.headline)
      const recent = new Date(article.created_at) > cutoff4h
      // Recent articles get 1.5× weight on negative scores (positive cap stays at +1)
      const weightedScore = score < 0 && recent ? Math.round(score * 1.5) : score
      for (const sym of article.symbols ?? []) {
        if (symSet.has(sym)) {
          items.push({
            symbol:       sym,
            headline:     article.headline,
            published_at: article.created_at,
            sentiment,
            score:        weightedScore,
            recent,
          })
        }
      }
    }
    return items
  } catch {
    return []
  }
}

export async function getPolymarketMacro(): Promise<PolymarketSignal[]> {
  try {
    const url = `${POLY_BASE}/markets?closed=false&limit=100&active=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json() as Array<{
      question: string
      outcomes: string
      outcomePrices: string
      volume: number
    }>
    if (!Array.isArray(data)) return []
    const macroKw = /\b(recession|fed|rate hike|rate cut|inflation|S&P|SPX|nasdaq|dow|market crash|economy|GDP|unemployment|default)\b/i
    const signals: PolymarketSignal[] = []
    for (const market of data) {
      if (!macroKw.test(market.question)) continue
      try {
        const prices  = JSON.parse(market.outcomePrices) as number[]
        const outcomes = JSON.parse(market.outcomes) as string[]
        const yesIdx  = outcomes.findIndex((o) => /yes/i.test(o))
        const yes_pct = Math.round((prices[yesIdx >= 0 ? yesIdx : 0] ?? 0) * 100)
        if (yes_pct > 0 && market.volume > 1000) {
          signals.push({ question: market.question.slice(0, 80), yes_pct, volume: market.volume })
        }
      } catch { /* malformed JSON in outcomePrices — skip */ }
    }
    return signals.sort((a, b) => b.volume - a.volume).slice(0, 5)
  } catch {
    return []
  }
}

/**
 * Fetch all sentiment data in parallel.
 * Returns per-symbol net score and a formatted context string for AI prompts.
 */
export async function getMarketSentiment(symbols: string[]): Promise<MarketSentimentResult> {
  const [news, polymarket] = await Promise.all([
    getAlpacaNews(symbols),
    getPolymarketMacro(),
  ])

  // Per-symbol net score using pre-computed weighted scores per article
  const symbolScores: Record<string, number> = {}
  const bullCounts:  Record<string, number>  = {}
  const bearCounts:  Record<string, number>  = {}
  for (const item of news) {
    symbolScores[item.symbol] = (symbolScores[item.symbol] ?? 0) + item.score
    if (item.sentiment === 'bullish') bullCounts[item.symbol]  = (bullCounts[item.symbol]  ?? 0) + 1
    if (item.sentiment === 'bearish') bearCounts[item.symbol]  = (bearCounts[item.symbol]  ?? 0) + 1
  }

  // Emit per-symbol log line; include headline snippet for high-severity bearish articles
  for (const [sym, score] of Object.entries(symbolScores)) {
    const b = bullCounts[sym] ?? 0
    const d = bearCounts[sym] ?? 0
    const label = score >= 2 ? '→ BOOSTED' : score <= -3 ? '→ FILTERED' : ''
    console.log(`[SENTIMENT] ${sym}: score=${score} (${b}▲ ${d}▼) ${label}`.trim())
    // Surface the exact headline that triggered a high-severity score (-4)
    const highSev = news.filter((n) => n.symbol === sym && n.score <= -4)
    for (const h of highSev) {
      console.log(`[SENTIMENT] ${sym} HIGH-SEVERITY: "${h.headline.slice(0, 80)}"`)
    }
  }
  if (polymarket.length) {
    console.log(`[SENTIMENT] Polymarket: ${polymarket.map((p) => `${p.question.slice(0, 40)}… ${p.yes_pct}%`).join(' | ')}`)
  }

  // Group headlines by symbol for prompt injection (show most recent first)
  const bySymbol: Record<string, string[]> = {}
  for (const item of news) {
    const tag = item.sentiment === 'bullish' ? '▲' : item.sentiment === 'bearish' ? '▼' : '·'
    const recency = item.recent ? '[recent]' : ''
    ;(bySymbol[item.symbol] ??= []).push(`${tag}${recency} ${item.headline.slice(0, 85)}`)
  }

  const newsLines  = Object.entries(bySymbol).map(([sym, lines]) => `${sym}: ${lines.slice(0, 2).join(' | ')}`)
  const polyLines  = polymarket.map((p) => `${p.question}: ${p.yes_pct}% YES ($${(p.volume / 1e6).toFixed(1)}M vol)`)

  const parts: string[] = []
  if (newsLines.length)  parts.push(`LATEST NEWS (▲bullish ▼bearish [recent]=last 4h):\n${newsLines.join('\n')}`)
  if (polyLines.length)  parts.push(`POLYMARKET MACRO:\n${polyLines.join('\n')}`)

  return {
    news,
    polymarket,
    newsContext:  parts.join('\n\n') || '',
    symbolScores,
  }
}
