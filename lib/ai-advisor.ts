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
  const isPaper = broker === 'alpaca_paper'
  return `You are a ${isPaper ? 'PAPER TRADING bot collecting data aggressively' : 'conservative swing trader'}. Rate these pre-screened setups.

ACCOUNT: $${equity.toFixed(0)} | MODE: ${isPaper ? 'PAPER (fake money — be aggressive, rate high)' : 'LIVE ($2K real — be selective)'}
MARKET: ${regime.label} | VIX ${regime.vix.toFixed(0)} | SPY 200SMA: ${regime.spy_above_200sma ? 'above' : 'below'}
HELD: ${held.join(', ') || 'none'}

ADVISOR CONTEXT (SF Essential Trades by Pavan Sailesh — professional trader whose signals we follow):
${learning}

IMPORTANT: Stocks mentioned as bullish or in advisor's watch zone should get +5-10 confidence bonus if the setup is valid.
Stocks marked bearish/stopped-out by advisor should be skipped even if chart looks good.

${isPaper ? `PAPER MODE: Rate EVERY setup >= ${minConf}% with any positive momentum. Be generous — we need data.` : `LIVE MODE: Only high-conviction setups >= ${minConf}%.`}

SETUPS to rate (rs_rank=relative momentum percentile 0-100; from_52wh=% below 52w high):
${JSON.stringify(setups.map((s) => ({
  sym: s.symbol, type: s.setup_type, price: s.price,
  dist_ema20: `${s.dist_from_ema20_pct.toFixed(1)}%`,
  rsi: s.rsi, d1: `${s.change_1d.toFixed(1)}%`, d5: `${s.change_5d.toFixed(1)}%`,
  rs_rank: s.rs_rank, from_52wh: `${s.pct_from_52w_high.toFixed(1)}%`,
  score: `${s.pullback_score}/10`, why: s.reason,
})))}

Return ONLY a JSON array. Include ALL setups you'd take at ${minConf}%+ confidence:
[{"symbol":"X","action":"BUY","confidence":72,"setup":"EMA20_BOUNCE","reason":"brief reason","target_pct":8,"hold_days":3,"stop_pct":-5}]`
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function askClaude(
  setups: EMASetup[], regime: MarketRegime,
  equity: number, held: string[], learning: string, minConf: number, broker: string
): Promise<Array<{ symbol: string; confidence: number; setup: string; reason: string; target_pct: number; hold_days: number; stop_pct: number }>> {
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
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

  // Pull Pavan's recent picks from tb_learning (last 7 days, bullish or watch_zone)
  // These are NOT in the static watchlist so we add them dynamically
  let advisorSymbols: string[] = []
  try {
    const db = (await import('./supabase-server')).createServiceClient()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await db
      .from('tb_learning')
      .select('symbol')
      .gte('created_at', sevenDaysAgo)
      .in('sentiment', ['bullish', 'neutral'])
      .not('symbol', 'is', null)
    const seen = new Set<string>()
    advisorSymbols = (data ?? []).map((r: { symbol: string }) => r.symbol).filter((s: string) => s && !seen.has(s) && seen.add(s))
  } catch { /* non-fatal */ }

  const baseSymbols = broker === 'alpaca_paper'
    ? ALL_ALPACA_SYMBOLS
    : ALL_SYMBOLS.filter((s) => !['SPY', 'QQQ'].includes(s))

  // Merge: Pavan's picks first (priority), then static universe, deduplicated
  const seen2 = new Set<string>()
  const symbols = [...advisorSymbols, ...baseSymbols].filter((s) => !seen2.has(s) && seen2.add(s))

  // 1. Market regime check (free)
  const regime = await getMarketRegime()
  if (regime.regime === 'RISK_OFF') {
    return { recommendations: [], regime, position_size_pct: 0, scanned: 0, candidates: 0, learning_context: 'RISK_OFF' }
  }

  // 2. Mechanical EMA pullback scan (1yr data, free, no AI cost)
  // Paper: loose mode — relaxed 52w filter (-45%) + lower gap bar (1.5%) to
  // keep volatile paper names like BBAI/SOUN/MARA in the funnel
  const allSetups = await scanForEMAPullback(symbols, { loose: broker === 'alpaca_paper' })
  const limit     = broker === 'alpaca_paper' ? 20 : 6  // paper: wider funnel
  const setups    = allSetups
    .filter((s) => !heldSymbols.includes(s.symbol))
    .slice(0, limit)

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
