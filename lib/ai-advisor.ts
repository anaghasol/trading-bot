/**
 * Claude-powered AI advisor — SWING TRADING MODE.
 *
 * Under $25K PDT rule: we hold overnight (1-5 days), NOT day-trade.
 * Goal: $100-200/day profit compounding toward $25K.
 * Strategy: momentum breakouts + oversold reversals with 1-5 day holds.
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  getMarketData, getMarketRegime, getSector, ALL_SYMBOLS,
  type MarketData, type MarketRegime,
} from './market-data'
import { buildLearningContext } from './learning'
import { SWING_CONFIG } from './pdt'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export interface Recommendation {
  symbol: string
  action: 'BUY'
  confidence: number
  setup: string
  reason: string
  target_pct: number
  hold_days: number      // expected hold in trading days
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

// ── Candidate Scoring ─────────────────────────────────────────────────────────

interface Candidate {
  symbol: string
  score: number
  setup: string
  data: MarketData
  reasons: string[]
}

function scoreCandidates(marketData: MarketData[]): Candidate[] {
  const candidates: Candidate[] = []

  for (const d of marketData) {
    const { rsi, volume_ratio, change_1d, change_5d } = d
    let score = 0
    let setup = 'TREND'
    const reasons: string[] = []

    if (rsi > 85 && volume_ratio < 1.5) continue
    if (rsi < 18) continue

    // MOMENTUM BREAKOUT: RSI powering up + volume + day move
    if (rsi >= 60 && volume_ratio >= 1.5 && change_1d > 1.0) {
      score += 5
      setup = 'MOMENTUM_BREAKOUT'
      reasons.push(`RSI ${rsi.toFixed(0)} breakout, ${volume_ratio.toFixed(1)}x vol, +${change_1d.toFixed(1)}% day`)
    }
    // OVERSOLD REVERSAL: beaten down with volume returning (swing bounce)
    else if (rsi <= 35 && volume_ratio >= 1.5 && change_1d < -1.5) {
      score += 4
      setup = 'REVERSAL'
      reasons.push(`Oversold RSI ${rsi.toFixed(0)}, ${volume_ratio.toFixed(1)}x vol, reversal candidate`)
    }
    // STEADY UPTREND: not overbought, consistent grind
    else if (rsi >= 45 && rsi <= 65 && change_5d >= 3.0) {
      score += 3
      setup = 'TREND'
      reasons.push(`Steady trend RSI ${rsi.toFixed(0)}, +${change_5d.toFixed(1)}% 5d`)
      if (volume_ratio >= 1.3) { score += 1; reasons.push(`${volume_ratio.toFixed(1)}x vol`) }
    }

    // Day momentum bonus
    if (change_1d >= 2.0) { score += 1; reasons.push(`+${change_1d.toFixed(1)}% today`) }
    if (change_5d >= 8.0) { score += 2; reasons.push(`+${change_5d.toFixed(1)}% 5d rally`) }

    // BUY-side only
    if (change_1d < -3.0 && setup !== 'REVERSAL') continue

    if (score >= 3) {
      candidates.push({ symbol: d.symbol, score, setup, data: d, reasons })
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 6)
}

function filterBySector(candidates: Candidate[], heldSymbols: string[]): Candidate[] {
  const heldSectors = new Set(heldSymbols.map(getSector))
  const usedSectors = new Set(heldSectors)
  return candidates.filter((c) => {
    const sector = getSector(c.symbol)
    if (usedSectors.has(sector)) return false
    usedSectors.add(sector)
    return true
  })
}

// ── Claude Prompt ─────────────────────────────────────────────────────────────

async function getClaudePicks(
  candidates: Candidate[],
  regime: MarketRegime,
  balance: number,
  heldSymbols: string[],
  learningContext: string,
  pdtSlotsLeft: number
): Promise<Recommendation[]> {

  const prompt = `You are a swing trader managing a $${balance.toFixed(0)} account under the PDT rule (under $25K).

CRITICAL CONSTRAINTS:
- SWING TRADE ONLY: Hold 1-5 days. Do NOT day-trade (we hold overnight).
- PDT day-trade slots remaining today: ${pdtSlotsLeft}/3 (reserve for emergencies)
- Goal: $100-200 profit daily compounding toward $25K
- Currently holding: ${heldSymbols.join(', ') || 'nothing'}
- Max 3 positions total

MARKET REGIME: ${regime.regime} — ${regime.label}

RECENT PERFORMANCE CONTEXT:
${learningContext}

TECHNICAL SETUPS (candidates for 1-5 day holds):
${JSON.stringify(candidates.map((c) => ({
  symbol: c.symbol,
  setup: c.setup,
  price: c.data.price,
  rsi: c.data.rsi,
  volume_ratio: c.data.volume_ratio,
  change_1d: c.data.change_1d,
  change_5d: c.data.change_5d,
  reason: c.reasons.join('; '),
})), null, 2)}

RULES FOR SWING TRADE PICKS:
1. Only pick if 75%+ confident in a 1-5 day hold thesis
2. Momentum breakouts: best for 2-3 day holds after volume surge
3. Reversals: best for 1-2 day bounces off support
4. Target +8-15% over the hold period
5. Stop at -5% (held overnight, not same-day)
6. Prefer stocks with clear catalysts or sector momentum
7. In RISK_OFF: return empty array
8. In CAUTION: only 1 pick max, highest confidence only

Return ONLY valid JSON array (no markdown, no explanation):
[{"symbol":"NVDA","action":"BUY","confidence":83,"setup":"MOMENTUM_BREAKOUT","reason":"breaking above 200MA on 2x volume, sector rotation into semis","target_pct":12,"hold_days":3,"stop_pct":-5}]`

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })

    let text = (msg.content[0] as { type: string; text: string }).text.trim()
    if (text.includes('```')) {
      text = text.split('```')[1].replace(/^json/, '').trim()
    }
    if (!text.startsWith('[')) {
      const match = text.match(/\[[\s\S]*\]/)
      if (match) text = match[0]
      else return []
    }

    const picks: Recommendation[] = JSON.parse(text)
    return picks
      .filter((p) => p.confidence >= 75 && !heldSymbols.includes(p.symbol))
      .map((p) => ({
        ...p,
        sector: getSector(p.symbol),
        hold_days: p.hold_days ?? 2,
        stop_pct: p.stop_pct ?? SWING_CONFIG.stop_loss_pct,
      }))
  } catch (err) {
    console.error('[ai-advisor] Claude failed:', err)
    return []
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function getRecommendations(
  balance: number,
  heldSymbols: string[] = [],
  pdtSlotsLeft = 3
): Promise<AdvisorResult> {

  const [regime, learningCtx] = await Promise.all([
    getMarketRegime(),
    buildLearningContext(),
  ])

  if (regime.regime === 'RISK_OFF') {
    return {
      recommendations: [],
      regime,
      position_size_pct: 0,
      scanned: 0,
      candidates: 0,
      learning_context: learningCtx.summary,
    }
  }

  // In CAUTION, reduce position size
  const position_size_pct = regime.regime === 'CAUTION'
    ? SWING_CONFIG.position_size_pct * 0.6
    : SWING_CONFIG.position_size_pct

  const marketData = await getMarketData(
    ALL_SYMBOLS.filter((s) => !['SPY', 'QQQ'].includes(s))
  )

  const rawCandidates = scoreCandidates(marketData)
  const candidates    = filterBySector(rawCandidates, heldSymbols)

  if (candidates.length === 0) {
    return {
      recommendations: [],
      regime,
      position_size_pct,
      scanned: marketData.length,
      candidates: 0,
      learning_context: learningCtx.summary,
    }
  }

  const recommendations = await getClaudePicks(
    candidates,
    regime,
    balance,
    heldSymbols,
    learningCtx.summary,
    pdtSlotsLeft
  )

  return {
    recommendations,
    regime,
    position_size_pct,
    scanned: marketData.length,
    candidates: candidates.length,
    learning_context: learningCtx.summary,
  }
}
