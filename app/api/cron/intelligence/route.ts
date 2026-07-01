/**
 * CRON: /api/cron/intelligence — Groq adaptive trading stance
 *
 * Runs every 20 min during market hours. Reads recent performance, current
 * portfolio state, win rate, sector patterns, and today's P&L velocity, then
 * calls Groq to produce a structured trading_stance JSON that the scan cron
 * reads each tick to dynamically adjust confidence gates, sizing, and
 * symbol-level focus/avoid decisions.
 *
 * Output key in tb_settings: "ai_trading_stance"
 * Shape: {
 *   stance: 'aggressive' | 'neutral' | 'cautious' | 'pause',
 *   confidence_delta: number,   // e.g. -8 → raise gate by 8pp
 *   risk_delta: number,          // e.g. -0.5 → reduce risk_pct by 0.5pp
 *   max_positions_cap: number | null,
 *   focus_symbols: string[],    // give +10 boost to these
 *   avoid_symbols: string[],    // block these today
 *   reasoning: string,
 *   set_at: string,             // ISO timestamp
 *   model: string,
 * }
 */

export const runtime    = 'nodejs'
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { groqTextComplete } from '@/lib/groq-text'
import { isMarketOpen } from '@/lib/risk'

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const today = new Date().toISOString().split('T')[0] + 'T00:00:00Z'
  const since7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()

  // ── Gather metrics ────────────────────────────────────────────────────────────

  const [closedTodayRes, closed7dRes, openRes, equityRes] = await Promise.all([
    db.from('tb_trades').select('symbol,pnl,pnl_pct,reason,closed_at')
      .eq('broker', 'alpaca_paper').eq('status', 'CLOSED').gte('closed_at', today)
      .order('closed_at', { ascending: false }),
    db.from('tb_trades').select('symbol,pnl,pnl_pct,reason,created_at')
      .eq('broker', 'alpaca_paper').eq('status', 'CLOSED').gte('closed_at', since7d)
      .order('closed_at', { ascending: false }).limit(50),
    db.from('tb_trades').select('symbol,quantity,entry_price,reason,created_at')
      .eq('broker', 'alpaca_paper').eq('status', 'OPEN'),
    db.from('tb_settings').select('value').eq('key', 'alpaca_equity').single(),
  ])

  const closedToday = closedTodayRes.data ?? []
  const closed7d    = closed7dRes.data    ?? []
  const openTrades  = openRes.data        ?? []
  const equity      = parseFloat(equityRes.data?.value ?? '68000')

  // Win rate over last 7 days
  const wins   = closed7d.filter(t => ((t.pnl as number) ?? 0) > 0)
  const losses = closed7d.filter(t => ((t.pnl as number) ?? 0) < 0)
  const winRate = closed7d.length > 0 ? (wins.length / closed7d.length * 100).toFixed(0) : 'N/A'
  const avgWin  = wins.length  ? (wins.reduce((s,t)  => s + (t.pnl as number), 0) / wins.length).toFixed(2)  : '0'
  const avgLoss = losses.length ? (losses.reduce((s,t) => s + (t.pnl as number), 0) / losses.length).toFixed(2) : '0'
  const profitFactor = losses.length && Math.abs(parseFloat(avgLoss)) > 0
    ? Math.abs(wins.reduce((s,t) => s + (t.pnl as number), 0) / losses.reduce((s,t) => s + (t.pnl as number), 0)).toFixed(2)
    : 'N/A'

  // Today's realized P&L
  const dailyPnl = closedToday.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const dailyPct = equity > 0 ? (dailyPnl / equity * 100).toFixed(2) : '0'

  // Count today's buy trades per symbol (churn detection)
  const { data: todayBuyRows } = await db.from('tb_trades')
    .select('symbol').eq('action', 'BUY').eq('broker', 'alpaca_paper').gte('created_at', today)
  const buysPerSym = new Map<string, number>()
  for (const r of todayBuyRows ?? []) {
    const s = r.symbol as string
    buysPerSym.set(s, (buysPerSym.get(s) ?? 0) + 1)
  }
  const churnSymbols = Array.from(buysPerSym.entries())
    .filter(([, n]) => n >= 2).map(([s, n]) => `${s}×${n}`)

  // Top losers today
  const todayLosers = closedToday
    .filter(t => ((t.pnl as number) ?? 0) < 0)
    .sort((a, b) => (a.pnl as number) - (b.pnl as number))
    .slice(0, 5)
    .map(t => `${t.symbol} ${(t.pnl as number).toFixed(0)}`)

  // Top winners today
  const todayWinners = closedToday
    .filter(t => ((t.pnl as number) ?? 0) > 0)
    .sort((a, b) => (b.pnl as number) - (a.pnl as number))
    .slice(0, 5)
    .map(t => `${t.symbol} +${(t.pnl as number).toFixed(0)}`)

  // Open position summary
  const openSummary = openTrades
    .map(t => t.symbol as string)
    .join(', ') || 'none'

  // Recent 7d loss streak
  const recent10 = closed7d.slice(0, 10)
  const recentWinPct = recent10.length
    ? (recent10.filter(t => ((t.pnl as number) ?? 0) > 0).length / recent10.length * 100).toFixed(0)
    : 'N/A'

  // ── Groq prompt ───────────────────────────────────────────────────────────────

  const prompt = `You are the risk intelligence layer for a live US equity trading bot (Alpaca paper account, starting $100K, currently $${equity.toFixed(0)}).

CURRENT STATE:
- Account equity: $${equity.toFixed(0)} (${((1 - equity / 100000) * 100).toFixed(1)}% drawdown from $100K start)
- Today realized P&L: $${dailyPnl.toFixed(0)} (${dailyPct}%)
- Open positions: ${openTrades.length} — ${openSummary}

PERFORMANCE (last 7 days, ${closed7d.length} closed trades):
- Win rate: ${winRate}%  |  Recent 10: ${recentWinPct}%
- Avg win: $${avgWin}  |  Avg loss: $${avgLoss}
- Profit factor: ${profitFactor}
- Today losers: ${todayLosers.join(', ') || 'none'}
- Today winners: ${todayWinners.join(', ') || 'none'}
- Churn (same symbol bought multiple times today): ${churnSymbols.join(', ') || 'none'}

SYSTEM CONTEXT:
- Scan fires every 10 min, monitor every 2 min
- Deep recovery mode: equity < $75K (current: ${equity < 75000 ? 'YES' : 'NO'})
- Recovery mode: equity < $85K (current: ${equity < 85000 ? 'YES' : 'NO'})
- Daily breaker: -8% deep recovery / -10% recovery / -12% normal

Based on this, output a trading stance as STRICT JSON (no markdown, no explanation outside JSON):
{
  "stance": "aggressive" | "neutral" | "cautious" | "pause",
  "confidence_delta": <integer -10 to +5, negative = raise the AI confidence gate>,
  "risk_delta": <float -1.0 to +0.5, negative = reduce risk% per trade>,
  "max_positions_cap": <integer 3-20 or null for no override>,
  "focus_symbols": [<up to 3 symbols showing strength today, or []>],
  "avoid_symbols": [<symbols that churned or lost today, up to 5, or []>],
  "reasoning": "<one sentence why>"
}

Rules:
- "pause" only if account is in serious danger or daily loss > -10%
- "aggressive" only if win rate > 60% AND today is profitable
- negative confidence_delta means RAISE the gate (more selective)
- avoid_symbols should include any churned symbols and big losers
- focus_symbols should be today's winners still showing momentum
- Keep reasoning under 120 chars`

  const result = await groqTextComplete(prompt, 400)
  if (!result) {
    return NextResponse.json({ ok: false, reason: 'groq_unavailable' })
  }

  // Parse JSON from response (strip any accidental markdown)
  let stance: Record<string, unknown>
  try {
    const clean = result.text.replace(/```json\n?/gi, '').replace(/```/g, '').trim()
    stance = JSON.parse(clean)
  } catch {
    // Groq returned non-JSON — log and exit gracefully
    await db.from('tb_alerts').insert({
      type: 'INFO',
      symbol: null,
      message: `[intelligence] Groq parse failed: ${result.text.slice(0, 150)}`,
    })
    return NextResponse.json({ ok: false, reason: 'parse_failed', raw: result.text.slice(0, 200) })
  }

  const payload = {
    ...stance,
    set_at: new Date().toISOString(),
    model: result.model,
    metrics: {
      equity: equity.toFixed(0),
      dailyPnl: dailyPnl.toFixed(0),
      winRate,
      profitFactor,
      openCount: openTrades.length,
    },
  }

  await db.from('tb_settings').upsert({ key: 'ai_trading_stance', value: JSON.stringify(payload) })

  // Alert if stance changed to cautious or pause
  const prevRes = await db.from('tb_settings').select('value').eq('key', 'ai_trading_stance_prev').single()
  const prevStance = prevRes.data?.value ?? 'neutral'
  const newStance = String(stance.stance ?? 'neutral')
  if (newStance !== prevStance && (newStance === 'pause' || newStance === 'cautious')) {
    const bot  = process.env.TELEGRAM_BOT_TOKEN
    const chat = process.env.TELEGRAM_ALLOWED_CHAT_ID
    if (bot && chat) {
      const icon = newStance === 'pause' ? '🛑' : '⚠️'
      await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: `${icon} *AI Stance → ${newStance.toUpperCase()}*\n${stance.reasoning ?? ''}\nWin rate: ${winRate}% | Day P&L: $${dailyPnl.toFixed(0)} (${dailyPct}%)`,
          parse_mode: 'Markdown',
        }),
      }).catch(() => {})
    }
  }
  await db.from('tb_settings').upsert({ key: 'ai_trading_stance_prev', value: newStance })

  return NextResponse.json({ ok: true, stance: payload })
}
