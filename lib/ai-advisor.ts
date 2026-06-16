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
  scanForEMAPullback, scanMomentumSpike, getMarketRegime, getSector,
  ALL_SYMBOLS, ALL_ALPACA_SYMBOLS,
  type EMASetup, type MarketRegime,
} from './market-data'
import { getDiscoverySymbols, type DiscoverySymbol } from './trending'
import { buildLearningContext } from './learning'
import { profileFor } from './strategy-profiles'
import { getMarketSentiment } from './market-sentiment'

const claude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const OAI_KEY = process.env.OPENAI_API_KEY

const isPaperBroker = (broker: string) => broker === 'alpaca_paper'

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
  discoveries: DiscoverySymbol[]   // trending/gainer stocks found this tick
  new_discoveries: DiscoverySymbol[] // ones NOT in the static watchlist — worth alerting
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
  model: 'claude' | 'openai',
  newsContext: string
): string {
  const isPaper = broker === 'alpaca_paper'
  return `You are a ${isPaper ? 'PAPER TRADING bot collecting data aggressively' : 'conservative swing trader'}. Rate these pre-screened setups.

ACCOUNT: $${equity.toFixed(0)} | MODE: ${isPaper ? 'PAPER (fake money — be aggressive, rate high)' : 'LIVE ($2K real — be selective)'}
MARKET: ${regime.label} | VIX ${regime.vix.toFixed(0)} | SPY 200SMA: ${regime.spy_above_200sma ? 'above' : 'below'}
HELD: ${held.join(', ') || 'none'}

ADVISOR CONTEXT (recent signals from trading channels we follow):
${learning}

IMPORTANT: Stocks mentioned as bullish or in advisor's watch zone should get +5-10 confidence bonus if the setup is valid.
Stocks marked bearish/stopped-out should be skipped even if chart looks good.

${newsContext ? `REAL-TIME MARKET DATA (▲bullish news ▼bearish news — factor this into confidence):
${newsContext}
IMPORTANT: ▼bearish news = strong negative catalyst, reduce confidence -10 to -20. ▲bullish news = positive catalyst, boost confidence +5 to +10.
` : ''}
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
  equity: number, held: string[], learning: string, minConf: number, broker: string,
  newsContext: string
): Promise<Array<{ symbol: string; confidence: number; setup: string; reason: string; target_pct: number; hold_days: number; stop_pct: number }>> {
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      messages: [{ role: 'user', content: buildPrompt(setups, regime, equity, held, learning, minConf, broker, 'claude', newsContext) }],
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
  equity: number, held: string[], learning: string, minConf: number, broker: string,
  newsContext: string
): Promise<Array<{ symbol: string; confidence: number }>> {
  if (!OAI_KEY) return []
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.15,
        max_tokens: 512,
        messages: [{ role: 'user', content: buildPrompt(setups, regime, equity, held, learning, minConf, broker, 'openai', newsContext) }],
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

  const openaiMap  = new Map(openaiPicks.map((p) => [p.symbol, p.confidence]))
  const isPaper    = broker === 'alpaca_paper'
  const oaiOnline  = openaiPicks.length > 0  // did OpenAI actually respond this tick?

  return claudePicks
    .filter((p) => !held.includes(p.symbol))
    .map((p) => {
      const oConf = openaiMap.get(p.symbol) ?? 0

      // When OpenAI is offline/unset, use Claude confidence directly — no penalty.
      // Penalizing Claude-only picks 10% was blocking all paper trades because the
      // penalized score fell below the gate even when Claude was clearly bullish.
      const merged_conf = oConf > 0
        ? Math.round((p.confidence + oConf) / 2)
        : p.confidence  // Claude-only: no discount

      const ema_setup = setups.find((s) => s.symbol === p.symbol)

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
    .filter((p) => {
      // Paper mode: Claude alone is enough — we're here to collect data aggressively.
      // If OpenAI IS online, require it to agree within 10pts (not 5) so a 55% Claude
      // pick isn't killed by a 44% OpenAI rating on an admittedly noisy paper setup.
      if (isPaper) {
        if (oaiOnline && p.openai_conf > 0) {
          return p.claude_conf >= minConf && p.openai_conf >= minConf - 10
        }
        return p.claude_conf >= minConf  // Claude alone runs the paper lab
      }
      // Live (Schwab): both must agree — real money needs consensus.
      if (p.openai_conf > 0) {
        return p.claude_conf >= minConf && p.openai_conf >= minConf - 5
      }
      return p.claude_conf >= minConf
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

  // Pull recent channel advisor picks from tb_learning (last 7 days, bullish or watch_zone)
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

  const isPaper = isPaperBroker(broker)

  // 1. Market regime + market-wide discovery IN PARALLEL (both free, no API key)
  // Discovery runs for BOTH live and paper — live uses tighter liquidity filters
  // (vol≥2M enforced inside getDiscoverySymbols) so no penny stocks on real money.
  // This replaces the hardcoded 17-symbol live watchlist with a dynamic 60-100
  // symbol universe from Yahoo trending + top gainers + most active.
  const [regime, discoveries] = await Promise.all([
    getMarketRegime(),
    getDiscoverySymbols(isPaper ? 'paper' : 'live'),
  ])

  const discoverySyms = discoveries.map((d) => d.symbol)
  const staticSet     = new Set([...advisorSymbols, ...baseSymbols])
  const newDiscoveries = discoveries.filter((d) => !staticSet.has(d.symbol))

  if (regime.regime === 'RISK_OFF') {
    return { recommendations: [], regime, position_size_pct: 0, scanned: 0, candidates: 0, learning_context: 'RISK_OFF', discoveries, new_discoveries: newDiscoveries }
  }

  // Discovery symbols come first — they're the most time-sensitive
  const seen2 = new Set<string>()
  const symbols = [...discoverySyms, ...advisorSymbols, ...baseSymbols]
    .filter((s) => !seen2.has(s) && seen2.add(s))

  // 2. EMA pullback + Momentum spike scans RUN IN PARALLEL (free, no AI cost)
  // EMA: needs ≥60 days — catches established names on pullbacks
  // Momentum: needs ≥10 days — catches new IPOs, volume spikes, explosive moves (SPCX-type)
  const [emaSetups, momentumSetups] = await Promise.all([
    scanForEMAPullback(symbols, { loose: isPaper }),
    isPaper ? scanMomentumSpike(symbols, regime.spy_change, { loose: true }) : Promise.resolve([]),
  ])

  // Merge: momentum setups take priority (they're rarer and more urgent)
  // Deduplicate — if a symbol appears in both, keep the higher-scored one
  const seenSyms = new Set<string>()
  const mergedSetups: EMASetup[] = []
  for (const s of [...momentumSetups, ...emaSetups]) {
    if (!seenSyms.has(s.symbol)) { seenSyms.add(s.symbol); mergedSetups.push(s) }
  }

  const rawLimit = isPaper ? 20 : 6
  const rawSetups = mergedSetups
    .filter((s) => !heldSymbols.includes(s.symbol))
    .slice(0, rawLimit)

  if (rawSetups.length === 0) {
    return {
      recommendations: [], regime,
      position_size_pct: profile.risk_pct,
      scanned: symbols.length, candidates: 0,
      learning_context: 'No setups today',
      discoveries, new_discoveries: newDiscoveries,
    }
  }

  // 3. Learning context (Supabase read, cheap)
  let learning = 'No history yet'
  try { const ctx = await buildLearningContext(); learning = ctx.summary } catch { /* ignore */ }

  // 4. Dynamic gate: widen in good markets, tighten in caution.
  const baseConf = profile.min_confidence
  const minConf = isPaper
    ? (regime.vix < 20 && regime.spy_above_200sma
        ? Math.max(baseConf - 5, 45)
        : regime.regime === 'CAUTION'
          ? baseConf + 5
          : baseConf)
    : (regime.vix < 20 && regime.spy_above_200sma
        ? Math.max(baseConf - 3, 73)
        : baseConf)

  // 5. FREE market sentiment — Alpaca news + Polymarket (fetched before AI to save tokens)
  //    Pre-filter: symbols with 2+ bearish headlines get dropped before AI call.
  //    Remaining setups are cut to 12 max for paper (was 20) → ~40% fewer AI tokens.
  let sentiment = { newsContext: '', symbolScores: {} as Record<string, number>, news: [] as import('./market-sentiment').NewsItem[] }
  try {
    const sentResult = await getMarketSentiment(rawSetups.map((s) => s.symbol))
    sentiment = sentResult
  } catch { /* non-fatal — proceed without news */ }

  // Live (Schwab real $): drop at score ≤-2 — one confirmed bearish article is enough to skip.
  // Paper (Alpaca): drop at score ≤-3 — need multiple bearish signals before cutting a candidate.
  const bearishCutoff = isPaper ? -3 : -2
  const setups = rawSetups.filter((s) => {
    const score = sentiment.symbolScores[s.symbol] ?? 0
    if (score <= bearishCutoff) {
      const worstHeadline = sentiment.news
        .filter((n) => n.symbol === s.symbol && n.sentiment === 'bearish')
        .sort((a, b) => a.score - b.score)[0]
      const hint = worstHeadline ? ` — "${worstHeadline.headline.slice(0, 60)}"` : ''
      console.log(`[ai-advisor] DROPPED ${s.symbol} (news score ${score} ≤ ${bearishCutoff} ${isPaper ? 'paper' : 'live'} cutoff)${hint}`)
      return false
    }
    return true
  })
  const aiLimit  = isPaper ? 12 : 6
  const aiSetups = setups.slice(0, aiLimit)

  // 6. Claude + OpenAI IN PARALLEL — one call each, enriched with news context
  const [claudePicks, openaiPicks] = await Promise.all([
    askClaude(aiSetups, regime, equity, heldSymbols, learning, minConf, broker, sentiment.newsContext),
    askOpenAI(aiSetups, regime, equity, heldSymbols, learning, minConf, broker, sentiment.newsContext),
  ])

  console.log(`[ai-advisor] EMA:${emaSetups.length} Momentum:${momentumSetups.length} → Raw:${rawSetups.length} NewsFiltered:${aiSetups.length} | Claude:${claudePicks.length} OpenAI:${openaiPicks.length} | Gate:${minConf}%`)

  // 7. Merge: require both agree, average confidence
  const recommendations = mergeResults(claudePicks, openaiPicks, aiSetups, heldSymbols, minConf, broker)

  return {
    recommendations,
    regime,
    position_size_pct: profile.risk_pct,
    scanned: symbols.length,
    candidates: setups.length,
    learning_context: learning,
    discoveries,
    new_discoveries: newDiscoveries,
  }
}
