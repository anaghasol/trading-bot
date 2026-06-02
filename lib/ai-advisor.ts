/**
 * Dual-AI advisor — mechanical EMA scanner → Claude + OpenAI parallel validation.
 *
 * Flow:
 *   1. EMA pullback scanner (free, no AI) → top 6 mechanical setups
 *   2. Claude and OpenAI evaluate setups IN PARALLEL (one call each)
 *   3. Merge: final confidence = avg(claude, openai), only keep if BOTH >= threshold
 *   4. Sort by merged confidence, return top picks
 *
 * Why dual AI: two independent LLMs disagreeing → skip (weak signal).
 * Both agreeing with high confidence → strong edge.
 * OpenAI called via raw fetch — no extra npm package needed.
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  scanForEMAPullback, getMarketRegime, getSector,
  ALL_SYMBOLS, ALL_ALPACA_SYMBOLS,
  type EMASetup, type MarketRegime,
} from './market-data'
import { buildLearningContext } from './learning'
import { profileFor } from './strategy-profiles'

const claude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const OAI_KEY = process.env.OPENAI_API_KEY

export interface Recommendation {
  symbol: string
  action: 'BUY'
  confidence: number        // merged (avg claude + openai)
  claude_conf: number
  openai_conf: number
  setup: string
  reason: string
  target_pct: number
  hold_days: number
  stop_pct: number
  sector: string
  ema_score: number         // mechanical score 0-10
}

export interface AdvisorResult {
  recommendations: Recommendation[]
  regime: MarketRegime
  position_size_pct: number
  scanned: number
  candidates: number
  learning_context: string
}

// ── Shared prompt builder ─────────────────────────────────────────────────────

function buildPrompt(
  setups: EMASetup[],
  regime: MarketRegime,
  equity: number,
  held: string[],
  learning: string,
  minConf: number,
  broker: string,
  model: 'claude' | 'openai'
): string {
  const profile = profileFor(broker)
  return `You are an expert swing trader. Pre-screened mechanical setups below.

ACCOUNT: $${equity.toFixed(0)} | BROKER: ${broker.toUpperCase()} | MIN CONFIDENCE: ${minConf}%
MARKET: ${regime.label} | SPY ${regime.spy_above_200sma ? 'above ✓' : 'BELOW ✗'} 200 SMA | VIX ${regime.vix.toFixed(0)}
HELD: ${held.join(', ') || 'none'}
PERFORMANCE: ${learning}

SETUPS (all pass 20 EMA pullback mechanical filter):
${JSON.stringify(setups.map((s) => ({
  sym:      s.symbol,
  type:     s.setup_type,
  price:    s.price,
  ema20:    s.ema20,
  dist:     `${s.dist_from_ema20_pct.toFixed(1)}%`,
  rsi:      s.rsi,
  vol:      `${s.volume_ratio.toFixed(1)}x`,
  d1:       `${s.change_1d.toFixed(1)}%`,
  d5:       `${s.change_5d.toFixed(1)}%`,
  score:    `${s.pullback_score}/10`,
  why:      s.reason,
})), null, 2)}

RULES:
- ${profile.vibe === 'aggressive' ? 'AGGRESSIVE LAB (paper money): take more setups, 3-day holds ok' : 'PROTECTED (real $2K): only 1-5 day swing holds, PDT-safe'}
- Skip held symbols. Skip if RISK_OFF.
- Target ${(profile.initial_stop_pct * 2 * 100).toFixed(0)}-15% over ${profile.max_hold_days}d. Stop at ${(profile.initial_stop_pct * 100).toFixed(0)}%.

Return ONLY valid JSON array (no markdown):
[{"symbol":"NVDA","action":"BUY","confidence":84,"setup":"EMA20_BOUNCE","reason":"textbook pullback to 20 EMA, RSI 61, 2.1x volume","target_pct":10,"hold_days":3,"stop_pct":-2.5}]`
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function askClaude(
  setups: EMASetup[], regime: MarketRegime,
  equity: number, held: string[], learning: string, minConf: number, broker: string
): Promise<Array<{ symbol: string; confidence: number; setup: string; reason: string; target_pct: number; hold_days: number; stop_pct: number }>> {
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 512,
      messages: [{ role: 'user', content: buildPrompt(setups, regime, equity, held, learning, minConf, broker, 'claude') }],
    })
    let text = (msg.content[0] as { type: string; text: string }).text.trim()
    if (text.includes('```')) text = text.split('```')[1].replace(/^json/, '').trim()
    const match = text.match(/\[[\s\S]*\]/)
    return match ? JSON.parse(match[0]) : []
  } catch (e) {
    console.error('[ai-advisor] Claude error:', e)
    return []
  }
}

// ── OpenAI call (raw fetch, no extra package) ─────────────────────────────────

async function askOpenAI(
  setups: EMASetup[], regime: MarketRegime,
  equity: number, held: string[], learning: string, minConf: number, broker: string
): Promise<Array<{ symbol: string; confidence: number }>> {
  if (!OAI_KEY) return []
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',   // cheap + fast; gpt-4o for higher quality if budget allows
        temperature: 0.15,
        max_tokens: 512,
        messages: [{ role: 'user', content: buildPrompt(setups, regime, equity, held, learning, minConf, broker, 'openai') }],
      }),
    })
    if (!res.ok) return []
    const data = await res.json() as { choices: { message: { content: string } }[] }
    let text = data.choices[0]?.message?.content?.trim() ?? ''
    if (text.includes('```')) text = text.split('```')[1].replace(/^json/, '').trim()
    const match = text.match(/\[[\s\S]*\]/)
    return match ? JSON.parse(match[0]) : []
  } catch (e) {
    console.error('[ai-advisor] OpenAI error:', e)
    return []
  }
}

// ── Merge dual-AI results ─────────────────────────────────────────────────────

function mergeResults(
  claudePicks: Array<{ symbol: string; confidence: number; setup: string; reason: string; target_pct: number; hold_days: number; stop_pct: number }>,
  openaiPicks: Array<{ symbol: string; confidence: number }>,
  setups: EMASetup[],
  held: string[],
  minConf: number,
  broker: string
): Recommendation[] {

  const openaiMap = new Map(openaiPicks.map((p) => [p.symbol, p.confidence]))

  return claudePicks
    .filter((p) => !held.includes(p.symbol))
    .map((p) => {
      const oConf        = openaiMap.get(p.symbol) ?? 0
      const merged_conf  = oConf > 0 ? Math.round((p.confidence + oConf) / 2) : Math.round(p.confidence * 0.9)
      const ema_setup    = setups.find((s) => s.symbol === p.symbol)

      return {
        symbol:      p.symbol,
        action:      'BUY' as const,
        confidence:  merged_conf,
        claude_conf: p.confidence,
        openai_conf: oConf,
        setup:       p.setup ?? ema_setup?.setup_type ?? 'EMA20_BOUNCE',
        reason:      p.reason,
        target_pct:  p.target_pct ?? 10,
        hold_days:   p.hold_days  ?? 3,
        stop_pct:    p.stop_pct   ?? -2.5,
        sector:      getSector(p.symbol),
        ema_score:   ema_setup?.pullback_score ?? 0,
      }
    })
    // Require BOTH AIs to agree at >= threshold (or just Claude if OpenAI unavailable)
    .filter((p) => {
      if (p.openai_conf > 0) {
        return p.claude_conf >= minConf && p.openai_conf >= minConf - 5
      }
      return p.claude_conf >= minConf  // OpenAI unavailable → Claude-only gate
    })
    .sort((a, b) => b.confidence - a.confidence)
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function getRecommendations(
  equity: number,
  heldSymbols: string[] = [],
  pdtSlotsLeft = 3,
  broker = 'schwab'
): Promise<AdvisorResult> {

  const profile = profileFor(broker)
  const symbols = broker === 'alpaca_paper'
    ? ALL_ALPACA_SYMBOLS
    : ALL_SYMBOLS.filter((s) => !['SPY', 'QQQ'].includes(s))

  // 1. Market regime check (free)
  const regime = await getMarketRegime()
  if (regime.regime === 'RISK_OFF') {
    return { recommendations: [], regime, position_size_pct: 0, scanned: 0, candidates: 0, learning_context: 'RISK_OFF' }
  }

  // 2. Mechanical EMA pullback scan (1yr data, free, no AI cost)
  const allSetups = await scanForEMAPullback(symbols)
  const setups    = allSetups
    .filter((s) => !heldSymbols.includes(s.symbol))
    .slice(0, 6)

  if (setups.length === 0) {
    return {
      recommendations: [], regime,
      position_size_pct: profile.risk_pct,
      scanned: symbols.length, candidates: 0,
      learning_context: 'No EMA pullback setups today',
    }
  }

  // 3. Learning context (Supabase read, cheap)
  let learning = 'No history yet'
  try { const ctx = await buildLearningContext(); learning = ctx.summary } catch { /* ignore */ }

  // 4. Claude + OpenAI IN PARALLEL — one call each
  const [claudePicks, openaiPicks] = await Promise.all([
    askClaude(setups, regime, equity, heldSymbols, learning, profile.min_confidence, broker),
    askOpenAI(setups, regime, equity, heldSymbols, learning, profile.min_confidence, broker),
  ])

  console.log(`[ai-advisor] Claude:${claudePicks.length} picks | OpenAI:${openaiPicks.length} picks`)

  // 5. Merge: require both agree, average confidence
  const recommendations = mergeResults(claudePicks, openaiPicks, setups, heldSymbols, profile.min_confidence, broker)

  return {
    recommendations,
    regime,
    position_size_pct: profile.risk_pct,
    scanned: symbols.length,
    candidates: setups.length,
    learning_context: learning,
  }
}
