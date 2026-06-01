/**
 * Claude-powered AI stock advisor.
 * Scores candidates with technicals, then calls Claude for final conviction.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getMarketData, getMarketRegime, getSector, ALL_SYMBOLS, type MarketData, type MarketRegime } from './market-data'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export interface Recommendation {
  symbol: string
  action: 'BUY'
  confidence: number
  setup: string
  reason: string
  target_pct: number
  stop_pct: number
  sector: string
}

export interface AdvisorResult {
  recommendations: Recommendation[]
  regime: MarketRegime
  position_size_pct: number
  scanned: number
  candidates: number
}

// ── Candidate Scoring (free - no AI calls) ────────────────────────────────────

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

    // Skip extreme RSI without volume confirmation
    if (rsi > 85 && volume_ratio < 1.5) continue
    if (rsi < 20) continue

    // MOMENTUM BREAKOUT: RSI high + volume surge + strong day
    if (rsi >= 65 && volume_ratio >= 1.5 && change_1d > 1.5) {
      score += 5
      setup = 'MOMENTUM_BREAKOUT'
      reasons.push(`RSI ${rsi.toFixed(0)} breakout + ${volume_ratio.toFixed(1)}x volume + ${change_1d.toFixed(1)}% day`)
    }
    // REVERSAL: Oversold + volume spike (mean reversion)
    else if (rsi <= 35 && volume_ratio >= 2.0 && change_1d < -2.0) {
      score += 4
      setup = 'REVERSAL'
      reasons.push(`Oversold RSI ${rsi.toFixed(0)} + ${volume_ratio.toFixed(1)}x vol reversal`)
    }
    // STEADY TREND: RSI in range + momentum
    else if (rsi >= 40 && rsi <= 68) {
      if (Math.abs(change_1d) >= 2.0) { score += 3; reasons.push(`${change_1d > 0 ? '+' : ''}${change_1d.toFixed(1)}% strong move`) }
      else if (Math.abs(change_1d) >= 1.0) { score += 2; reasons.push(`${change_1d.toFixed(1)}% move`) }
      if (volume_ratio >= 1.5) { score += 2; reasons.push(`${volume_ratio.toFixed(1)}x volume`) }
      else if (volume_ratio >= 0.8) score += 1
    }

    // 5-day trend bonus
    if (change_5d >= 5.0) { score += 2; reasons.push(`${change_5d.toFixed(1)}% 5d trend`) }
    else if (change_5d >= 2.0) { score += 1 }

    // Only BUY setups (no shorting without margin approval)
    if (change_1d < 0 && setup !== 'REVERSAL') continue

    if (score >= 3) {
      candidates.push({ symbol: d.symbol, score, setup, data: d, reasons })
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 6)
}

function filterBySector(candidates: Candidate[], heldSymbols: string[]): Candidate[] {
  const heldSectors = new Set(heldSymbols.map(getSector))
  const usedSectors = new Set(heldSectors)
  const filtered: Candidate[] = []

  for (const c of candidates) {
    const sector = getSector(c.symbol)
    if (!usedSectors.has(sector)) {
      filtered.push(c)
      usedSectors.add(sector)
    }
  }
  return filtered
}

// ── Claude AI Call ────────────────────────────────────────────────────────────

async function getClaudePicks(
  candidates: Candidate[],
  regime: MarketRegime,
  balance: number,
  heldSymbols: string[]
): Promise<Recommendation[]> {
  const prompt = `You are an expert momentum trader. Evaluate these technical setups and pick the highest-probability BUY trades.

MARKET REGIME: ${regime.regime} — ${regime.label}
ACCOUNT BALANCE: $${balance.toFixed(2)}
CURRENTLY HELD: ${heldSymbols.join(', ') || 'nothing'}

TECHNICAL SETUPS:
${JSON.stringify(candidates.map(c => ({
  symbol: c.symbol,
  setup: c.setup,
  price: c.data.price,
  rsi: c.data.rsi,
  volume_ratio: c.data.volume_ratio,
  change_1d: c.data.change_1d,
  change_5d: c.data.change_5d,
  technical_reason: c.reasons.join('; '),
})), null, 2)}

RULES:
- Only BUY (no shorting)
- Only approve if confidence >= 75%
- Max 3 picks total
- Prefer stocks with clear momentum and volume confirmation
- RISK_OFF regime: return empty array
- Target: +5–15% within 1 day, stop loss at -5%

Return ONLY a valid JSON array (no markdown):
[{"symbol":"NVDA","action":"BUY","confidence":82,"setup":"MOMENTUM_BREAKOUT","reason":"breaking out on volume above 200MA","target_pct":8,"stop_pct":-5}]`

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })

    let text = (msg.content[0] as { type: string; text: string }).text.trim()
    if (text.includes('```')) {
      text = text.split('```')[1].replace(/^json/, '').trim()
    }

    const picks: Recommendation[] = JSON.parse(text)
    return picks
      .filter((p) => p.confidence >= 75 && !heldSymbols.includes(p.symbol))
      .map((p) => ({ ...p, sector: getSector(p.symbol) }))
  } catch (err) {
    console.error('[ai-advisor] Claude failed:', err)
    return []
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function getRecommendations(
  balance: number,
  heldSymbols: string[] = []
): Promise<AdvisorResult> {
  const regime = await getMarketRegime()

  if (regime.regime === 'RISK_OFF') {
    return { recommendations: [], regime, position_size_pct: 0, scanned: 0, candidates: 0 }
  }

  const position_size_pct = regime.regime === 'CAUTION' ? 0.10 : 0.15

  const marketData = await getMarketData(
    ALL_SYMBOLS.filter((s) => !['SPY', 'QQQ'].includes(s))
  )

  const rawCandidates = scoreCandidates(marketData)
  const candidates = filterBySector(rawCandidates, heldSymbols)

  if (candidates.length === 0) {
    return {
      recommendations: [],
      regime,
      position_size_pct,
      scanned: marketData.length,
      candidates: 0,
    }
  }

  const recommendations = await getClaudePicks(candidates, regime, balance, heldSymbols)

  return {
    recommendations,
    regime,
    position_size_pct,
    scanned: marketData.length,
    candidates: candidates.length,
  }
}
