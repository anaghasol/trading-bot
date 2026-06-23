/**
 * POST /api/research/generate
 * Runs one of the 10 quant research lab prompts through Claude,
 * auto-injecting current market context (VIX, regime, positions, recent PF).
 * Saves output to tb_research_reports for review in the Research Lab UI.
 */
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getPrompt, QUANT_PROMPTS } from '@/lib/quant-prompts'
import { getMarketRegime } from '@/lib/market-data'
import { getPositions, getAccountBalance } from '@/lib/alpaca'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime   = 'nodejs'
export const maxDuration = 120  // research calls are long — allow up to 2 min

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export async function GET() {
  return NextResponse.json({ prompts: QUANT_PROMPTS.map(({ key, name, firm, focus, emoji }) => ({ key, name, firm, focus, emoji })) })
}

export async function POST(req: Request) {
  try {
    const { promptKey, userNotes = '' } = await req.json() as { promptKey: string; userNotes?: string }

    const promptDef = getPrompt(promptKey)
    if (!promptDef) {
      return NextResponse.json({ error: `Unknown prompt key: ${promptKey}` }, { status: 400 })
    }

    // Gather live context in parallel
    const db = createServiceClient()
    const [regime, equity, positions, recentEOD] = await Promise.all([
      getMarketRegime().catch(() => null),
      getAccountBalance().catch(() => null),
      getPositions().catch(() => [] as Awaited<ReturnType<typeof getPositions>>),
      db.from('tb_eod_reports')
        .select('date, win_rate, profit_factor, total_pnl, wins, losses')
        .eq('broker', 'alpaca_paper')
        .order('date', { ascending: false })
        .limit(5)
        .then((r) => r.data ?? []),
    ])

    const topPositions = [...positions]
      .sort((a, b) => Math.abs(b.market_value ?? 0) - Math.abs(a.market_value ?? 0))
      .slice(0, 8)
      .map((p) => `${p.symbol} ${p.pnl_pct >= 0 ? '+' : ''}${p.pnl_pct.toFixed(1)}%`)
      .join(', ')

    const recentPF = recentEOD.length > 0
      ? recentEOD.map((r) => `${r.date}: PF=${r.profit_factor?.toFixed(2) ?? 'N/A'} WR=${(r.win_rate * 100)?.toFixed(0) ?? '?'}% P&L=${r.total_pnl >= 0 ? '+' : ''}$${r.total_pnl?.toFixed(0)} (${r.wins}W/${r.losses}L)`).join('\n')
      : 'No recent EOD data available'

    const context = `
---
[ACCOUNT CONTEXT — injected automatically]
Account: Alpaca Paper ($${equity?.toFixed(0) ?? '85,000'} equity) + Schwab Live (~$2,000 real money)
Goal: Compound paper account toward $25,000. Learn strategies before deploying to real $$.
Market Regime: ${regime?.regime ?? 'UNKNOWN'} | VIX: ${regime?.vix?.toFixed(1) ?? '?'} | SPY: ${regime?.spy_above_200sma ? 'above' : 'below'} 200SMA${regime?.days_below_200sma ? ` (${regime.days_below_200sma}d below)` : ''}

Current Positions (${positions.length} open): ${topPositions || 'None'}

Recent Strategy Performance (last 5 trading days):
${recentPF}

Current Strategy:
- Gate: 36%+ AI confidence + RS vs SPY ≥ 1.3pp + research score ≥ 6.5
- Max positions: 20 (GOOD market: 25, TOUGH: 18, BAD: 12)
- Stop: 2.5% initial, 5% trail
- Paper: day trades OK | Live: PDT-safe swings only
${userNotes ? `\nAdditional context from user:\n${userNotes}` : ''}
---`

    const fullPrompt = `${promptDef.prompt}\n\n${context}`

    const message = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: fullPrompt }],
    })

    const output = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')

    // Persist to Supabase for history
    try {
      await db.from('tb_research_reports').insert({
        prompt_key:  promptKey,
        prompt_name: promptDef.name,
        firm:        promptDef.firm,
        output,
        market_context: JSON.stringify({ regime: regime?.regime, vix: regime?.vix, equity, positions: positions.length }),
        created_at:  new Date().toISOString(),
      })
    } catch { /* tb_research_reports may not exist yet — non-fatal */ }

    return NextResponse.json({ success: true, output, prompt: { key: promptDef.key, name: promptDef.name, firm: promptDef.firm } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
