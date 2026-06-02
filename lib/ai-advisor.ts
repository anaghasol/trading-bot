/**
 * AI advisor — mechanical EMA scanner → Claude validation.
 *
 * Old flow: Claude scans all symbols → often returns nothing (conservative)
 * New flow: mechanical 20/50 EMA pullback scanner filters first → Claude only
 *           validates the 3-6 best setups → generates signals every day.
 *
 * VIX < 25 + SPY above 200 SMA = market filter (skip cold markets entirely).
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  scanForEMAPullback, getMarketRegime, getSector,
  ALL_SYMBOLS, ALL_ALPACA_SYMBOLS,
  type EMASetup, type MarketRegime,
} from './market-data'
import { buildLearningContext } from './learning'
import { profileFor } from './strategy-profiles'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export interface Recommendation {
  symbol: string
  action: 'BUY'
  confidence: number
  setup: string
  reason: string
  target_pct: number
  hold_days: number
  stop_pct: number
  sector: string
}

export interface AdvisorResult {
  recommendations: Recommendation[]
  regime: MarketRegime
  position_size_pct: number
  scanned: number
  candidates: number
  learning_context: string
}

// ── Claude validation — only called on pre-filtered mechanical setups ──────────

async function claudeValidate(
  setups: EMASetup[],
  regime: MarketRegime,
  equity: number,
  held: string[],
  learning: string,
  minConf: number,
  broker: string
): Promise<Recommendation[]> {

  const profile = profileFor(broker)

  const prompt = `You are a professional swing trader. Pre-screened mechanical setups are below.
Your job: validate each with market context and assign confidence.

ACCOUNT: $${equity.toFixed(0)} | BROKER: ${broker} | MIN CONFIDENCE TO TRADE: ${minConf}%
MARKET: ${regime.label} (SPY ${regime.spy_above_200sma ? 'above' : 'BELOW'} 200 SMA, VIX ${regime.vix.toFixed(0)})
HELD SYMBOLS: ${held.join(', ') || 'none — all slots open'}

RECENT PERFORMANCE:
${learning}

MECHANICAL SETUPS (pre-filtered, all pass 20/50 EMA uptrend + pullback rules):
${JSON.stringify(setups.map((s) => ({
  symbol:          s.symbol,
  setup_type:      s.setup_type,
  price:           s.price,
  ema20:           s.ema20,
  ema50:           s.ema50,
  dist_from_ema20: `${s.dist_from_ema20_pct.toFixed(1)}%`,
  rsi:             s.rsi,
  volume_ratio:    `${s.volume_ratio.toFixed(1)}x`,
  change_1d:       `${s.change_1d.toFixed(1)}%`,
  change_5d:       `${s.change_5d.toFixed(1)}%`,
  pullback_score:  `${s.pullback_score}/10`,
  reason:          s.reason,
})), null, 2)}

RULES:
- Only return setups you'd actually trade. These already pass mechanical filters.
- ${profile.vibe === 'aggressive' ? 'Aggressive lab: take more setups, lower bar, no PDT limit' : 'Protected real account: only high-conviction, PDT-safe swing holds (1-5 days)'}
- Target: +${profile.vibe === 'aggressive' ? '8-20' : '5-15'}% over ${profile.max_hold_days} days
- Stop: ${(profile.initial_stop_pct * 100).toFixed(0)}% below entry
- Do NOT return symbols in held list
- In RISK_OFF: return []

Return ONLY valid JSON array (no markdown):
[{"symbol":"NVDA","action":"BUY","confidence":84,"setup":"EMA20_BOUNCE","reason":"perfect pullback to 20 EMA, volume surge, RSI 61 ideal","target_pct":10,"hold_days":3,"stop_pct":-2.5}]`

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })

    let text = (msg.content[0] as { type: string; text: string }).text.trim()
    if (text.includes('```')) text = text.split('```')[1].replace(/^json/, '').trim()
    if (!text.startsWith('[')) { const m = text.match(/\[[\s\S]*\]/); text = m ? m[0] : '[]' }

    const picks: Recommendation[] = JSON.parse(text)
    return picks
      .filter((p) => p.confidence >= minConf && !held.includes(p.symbol))
      .map((p) => ({ ...p, sector: getSector(p.symbol) }))
  } catch (err) {
    console.error('[ai-advisor] Claude error:', err)
    return []
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function getRecommendations(
  equity: number,
  heldSymbols: string[] = [],
  pdtSlotsLeft = 3,
  broker = 'schwab'
): Promise<AdvisorResult> {

  const profile = profileFor(broker)
  const symbols = broker === 'alpaca_paper' ? ALL_ALPACA_SYMBOLS : ALL_SYMBOLS.filter((s) => !['SPY', 'QQQ'].includes(s))

  // Step 1: Market regime check (free)
  const regime = await getMarketRegime()

  if (regime.regime === 'RISK_OFF') {
    return { recommendations: [], regime, position_size_pct: 0, scanned: 0, candidates: 0, learning_context: 'RISK_OFF — no trades' }
  }

  // Step 2: Mechanical EMA pullback scan (free, no AI cost)
  // Fetches 1-year data per symbol for accurate 200 SMA + 50/20 EMA
  const allSetups = await scanForEMAPullback(symbols)
  const setups    = allSetups
    .filter((s) => !heldSymbols.includes(s.symbol))  // skip already held
    .slice(0, 6)  // top 6 mechanical setups → feed to Claude

  if (setups.length === 0) {
    return {
      recommendations: [],
      regime,
      position_size_pct: profile.risk_pct,
      scanned: symbols.length,
      candidates: 0,
      learning_context: 'No EMA pullback setups found today',
    }
  }

  // Step 3: Learning context (free, Supabase read)
  let learning = 'No history yet — using defaults'
  try {
    const ctx = await buildLearningContext()
    learning = ctx.summary
  } catch { /* ignore */ }

  // Step 4: Claude validates only the pre-filtered setups (1 API call, cheap)
  const recommendations = await claudeValidate(
    setups,
    regime,
    equity,
    heldSymbols,
    learning,
    profile.min_confidence,
    broker
  )

  return {
    recommendations,
    regime,
    position_size_pct: profile.risk_pct,
    scanned: symbols.length,
    candidates: setups.length,
    learning_context: learning,
  }
}
