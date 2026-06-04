/**
 * Receives messages from the local tg-poll.cjs script.
 * Silently classifies with Claude and executes on Alpaca Paper.
 * No Telegram replies. No noise. Just trade + SMS + Supabase log.
 */

import { NextResponse } from 'next/server'
import { parseSignal } from '@/lib/telegram-signal'
import * as Alpaca from '@/lib/alpaca'
import { createServiceClient } from '@/lib/supabase-server'
import { alertTradeEntered } from '@/lib/notify'
import { calculatePositionSize } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const PRIVATE_GROUP = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')

async function notify(text: string) {
  if (!PRIVATE_GROUP) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: PRIVATE_GROUP, text, parse_mode: 'Markdown' }),
  })
}

export async function POST(req: Request) {
  try {
    const { text, source, msg_id } = await req.json()
    if (!text || text.length < 5) return NextResponse.json({ ok: true, type: 'skip' })

    const signal = await parseSignal(text)
    const db = createServiceClient()

    if (signal.type === 'ignore') {
      return NextResponse.json({ ok: true, type: 'ignore' })
    }

    if (signal.type === 'learn') {
      await db.from('tb_alerts').insert({
        type: 'INFO',
        symbol: signal.symbols[0] ?? null,
        message: `📚 ${source}: ${signal.summary}`,
      })
      await notify(`📚 *Insight from SF Trades*\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}`)
      return NextResponse.json({ ok: true, type: 'learn', signal })
    }

    // trade — always size on live price; execute at market
    const profile = PROFILES.alpaca_paper
    const equity = (await Alpaca.getAccountBalance()) ?? 100_000
    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const sizing = livePrice
      ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, 0.15)
      : { qty: 10 }
    const qty = sizing.qty
    const entryPrice = livePrice

    const order = await Alpaca.placeOrder(signal.symbol, qty, signal.action, 'MARKET')

    await db.from('tb_alerts').insert({
      type: signal.action,
      symbol: signal.symbol,
      message: `${source} msg#${msg_id} → ${signal.action} ${qty} ${signal.symbol}${signal.entry_price ? ` @$${signal.entry_price}` : ' mkt'}${signal.stop_loss ? ` SL$${signal.stop_loss}` : ''} [conf:${signal.confidence}%] — ${order.status}`,
    })

    if (order.status === 'PLACED' && signal.action === 'BUY') {
      await db.from('tb_trades').insert({
        symbol: signal.symbol,
        broker: 'alpaca_paper',
        action: 'BUY',
        quantity: qty,
        entry_price: entryPrice ?? 0,
        stop_loss: signal.stop_loss ?? (entryPrice ? entryPrice * (1 - profile.initial_stop_pct) : 0),
        target_price: signal.target ?? null,
        confidence: signal.confidence,
        status: 'OPEN',
        order_id: order.order_id ?? null,
        reason: `TG: ${source}`,
      })
    }

    const emoji = order.status === 'PLACED' ? '✅' : '❌'
    await notify([
      `*${emoji} SF Trades → ${signal.action} ${qty} ${signal.symbol}*`,
      signal.entry_price ? `Entry: $${signal.entry_price}` : 'Entry: Market',
      signal.stop_loss   ? `SL: $${signal.stop_loss}` : null,
      signal.target      ? `Target: $${signal.target}` : null,
      `Confidence: ${signal.confidence}%`,
      `Status: ${order.status} · Alpaca Paper`,
    ].filter(Boolean).join('\n'))

    if (order.status === 'PLACED') {
      await alertTradeEntered({
        symbol: signal.symbol, qty,
        price: signal.entry_price ?? 0,
        broker: 'alpaca_paper',
        claude_conf: signal.confidence,
        openai_conf: signal.confidence,
        ema_score: 0,
        stop: signal.stop_loss ?? 0,
        target: signal.target ?? 0,
        reason: `${source} signal${signal.stop_loss ? ` | SL $${signal.stop_loss}` : ''}`,
      })
    }

    return NextResponse.json({ ok: true, type: 'trade', signal, order })
  } catch (e) {
    console.error('[ingest] error:', e)
    return NextResponse.json({ ok: true, type: 'error' })
  }
}
