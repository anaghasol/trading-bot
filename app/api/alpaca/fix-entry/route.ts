/**
 * POST /api/alpaca/fix-entry { symbol: string }
 *
 * Corrects a wrong entry price for a manually-bought position.
 * Manual Quick Trade buys are NOT in tb_trades — they're only in tb_alerts.
 * Alpaca paper fills at whatever IEX shows (was $26 for SPCX, real was ~$166).
 *
 * Strategy:
 *   1. Find buy timestamp from tb_alerts (Manual BUY log) or Alpaca order history
 *   2. Fetch Yahoo Finance 1m bar closest to that timestamp → real market price
 *   3. Store override in tb_settings as entry_override_${symbol}
 *   4. Positions endpoint reads overrides and applies them to avg_cost display
 *   5. Also updates tb_trades if a record exists there
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2'
const ALPACA_DATA = 'https://data.alpaca.markets/v2'

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }
}

async function yahooPrice(symbol: string, targetMs: number): Promise<{ price: number; ts: string } | null> {
  // Try narrow ±15 min window first, then full day as fallback
  const windows = [
    { p1: targetMs - 15 * 60 * 1000, p2: targetMs + 15 * 60 * 1000 },
    // Full trading day in UTC (9am–5pm ET)
    { p1: new Date(new Date(targetMs).toISOString().slice(0, 10) + 'T13:00:00Z').getTime(),
      p2: new Date(new Date(targetMs).toISOString().slice(0, 10) + 'T21:00:00Z').getTime() },
  ]

  for (const { p1, p2 } of windows) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&period1=${Math.floor(p1/1000)}&period2=${Math.floor(p2/1000)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      if (!res.ok) continue
      const data = await res.json()
      const chart = data?.chart?.result?.[0]
      const timestamps: number[] = chart?.timestamp ?? []
      const closes: number[]    = chart?.indicators?.quote?.[0]?.close ?? []
      if (!timestamps.length) continue

      let bestIdx = 0, bestDiff = Infinity
      for (let i = 0; i < timestamps.length; i++) {
        const diff = Math.abs(timestamps[i] * 1000 - targetMs)
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i }
      }
      const price = closes[bestIdx]
      if (price && price > 0) {
        return { price: Math.round(price * 100) / 100, ts: new Date(timestamps[bestIdx] * 1000).toISOString() }
      }
    } catch { /* try next window */ }
  }
  return null
}

export async function POST(req: Request) {
  const { symbol } = await req.json().catch(() => ({})) as { symbol?: string }
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  const sym = symbol.toUpperCase().trim()

  const db = createServiceClient()

  // ── 1. Find buy timestamp ────────────────────────────────────────────────────

  let buyTimeMs: number | null = null
  let buySource = ''

  // A. Check tb_alerts (Quick Trade manual buys land here)
  const { data: alerts } = await db
    .from('tb_alerts')
    .select('created_at, message')
    .eq('type', 'BUY')
    .ilike('message', `%${sym}%`)
    .order('created_at', { ascending: false })
    .limit(5)

  if (alerts?.length) {
    buyTimeMs = new Date(alerts[0].created_at).getTime()
    buySource = `tb_alerts: "${alerts[0].message.slice(0, 60)}"`
  }

  // B. Check tb_trades (engine buys land here)
  if (!buyTimeMs) {
    const { data: trades } = await db
      .from('tb_trades')
      .select('created_at, entry_price')
      .eq('symbol', sym)
      .order('created_at', { ascending: false })
      .limit(1)
    if (trades?.length) {
      buyTimeMs = new Date(trades[0].created_at).getTime()
      buySource = `tb_trades (entry_price was $${trades[0].entry_price})`
    }
  }

  // C. Check Alpaca order history
  if (!buyTimeMs) {
    try {
      const after = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
      const res = await fetch(
        `${ALPACA_BASE}/orders?status=all&after=${after}&limit=50&direction=desc`,
        { headers: alpacaHeaders() }
      )
      if (res.ok) {
        const orders = await res.json() as { symbol: string; side: string; filled_at?: string; submitted_at: string; filled_avg_price?: string }[]
        const match = orders.find((o) => o.symbol === sym && o.side === 'buy')
        if (match) {
          buyTimeMs = new Date(match.filled_at ?? match.submitted_at).getTime()
          buySource = `Alpaca order history (filled_avg_price: $${match.filled_avg_price})`
        }
      }
    } catch { /* ignore */ }
  }

  if (!buyTimeMs) {
    return NextResponse.json({
      error: `Could not find any buy record for ${sym} in tb_alerts, tb_trades, or Alpaca order history. Check the symbol name.`,
    }, { status: 404 })
  }

  // ── 2. Fetch real market price from Yahoo at buy time ────────────────────────
  const yh = await yahooPrice(sym, buyTimeMs)

  if (!yh) {
    return NextResponse.json({
      error: `Found buy at ${new Date(buyTimeMs).toISOString()} but Yahoo Finance returned no price data for ${sym} at that time.`,
      buy_time: new Date(buyTimeMs).toISOString(),
      buy_source: buySource,
    }, { status: 422 })
  }

  // ── 3. Store override in tb_settings ────────────────────────────────────────
  const overrideKey = `entry_override_${sym}`
  const overrideVal = JSON.stringify({ price: yh.price, set_at: new Date().toISOString(), buy_time: new Date(buyTimeMs).toISOString() })
  await db.from('tb_settings').upsert({ key: overrideKey, value: overrideVal })

  // ── 4. Also update tb_trades if record exists ────────────────────────────────
  const { data: tradeRows } = await db.from('tb_trades').select('id, entry_price').eq('symbol', sym).eq('status', 'OPEN')
  let old_trade_price: number | null = null
  if (tradeRows?.length) {
    old_trade_price = parseFloat(String(tradeRows[0].entry_price))
    await db.from('tb_trades').update({ entry_price: yh.price }).eq('id', tradeRows[0].id)
  }

  // ── 5. Audit log ─────────────────────────────────────────────────────────────
  await db.from('tb_alerts').insert({
    type: 'INFO',
    symbol: sym,
    message: `[fix-entry] ${sym} entry override set to $${yh.price} (Yahoo at ${yh.ts.slice(11, 16)} UTC). Buy found via: ${buySource}`,
  })

  return NextResponse.json({
    ok:          true,
    symbol:      sym,
    buy_time:    new Date(buyTimeMs).toISOString(),
    buy_source:  buySource,
    price_time:  yh.ts,
    new_price:   yh.price,
    old_tb_price: old_trade_price,
    note:        'Override stored. Reload positions to see corrected entry price.',
  })
}
