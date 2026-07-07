/**
 * /api/admin/paper-nuke — Close ALL Alpaca paper positions + cancel all orders
 * Also clears tb_trades OPEN records for alpaca_paper so the dashboard matches.
 * Use when the paper account is in an unrecoverable state.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

const BASE = 'https://paper-api.alpaca.markets/v2'

function hdrs() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Content-Type': 'application/json',
  }
}

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const results: Record<string, unknown> = {}

  // 1. Cancel all open orders
  try {
    const r = await fetch(`${BASE}/orders?status=all`, {
      method: 'DELETE', headers: hdrs(),
    })
    results.cancel_orders = r.ok ? 'ok' : `${r.status}: ${await r.text()}`
  } catch (e) {
    results.cancel_orders = `error: ${e}`
  }

  // 2. Close all positions (cancel_orders=true handles any lingering fills)
  try {
    const r = await fetch(`${BASE}/positions?cancel_orders=true`, {
      method: 'DELETE', headers: hdrs(),
    })
    const body = r.ok ? await r.json() : await r.text()
    results.close_positions = r.ok ? body : `${r.status}: ${body}`
  } catch (e) {
    results.close_positions = `error: ${e}`
  }

  // 3. Mark all OPEN alpaca_paper trades as CLOSED in tb_trades with a nuke reason
  const db = createServiceClient()
  const now = new Date().toISOString()
  const { count, error: dbErr } = await db
    .from('tb_trades')
    .update({ status: 'CLOSED', closed_at: now, pnl: 0, pnl_pct: 0, reason: 'NUKED: manual paper reset' })
    .eq('broker', 'alpaca_paper')
    .eq('status', 'OPEN')
    .select('*', { count: 'exact', head: true })
  results.db_closed = dbErr ? `error: ${dbErr.message}` : `${count} rows closed`

  // 4. Reset runtime config so tuner starts fresh
  await db.from('tb_settings').upsert({ key: 'paper_runtime_config', value: JSON.stringify({
    min_confidence: 42, max_hold_days: 3, stop_loss_pct: 3,
    trail_pct: 6, last_tuned: now, reset_reason: 'paper-nuke',
  })})

  // 5. Clear stale AI stance
  await db.from('tb_settings').upsert({ key: 'ai_trading_stance', value: JSON.stringify({
    stance: 'neutral', confidence_delta: 0, risk_delta: 0,
    max_positions_cap: null, focus_symbols: [], avoid_symbols: [],
    reasoning: 'Fresh start after paper account nuke', set_at: now,
  })})

  results.success = true
  results.message = 'Paper account liquidated. Dashboard will show CLOSED for all prior positions. New trades will open fresh.'

  return NextResponse.json(results)
}
