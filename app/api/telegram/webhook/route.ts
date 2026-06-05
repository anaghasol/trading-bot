import { NextResponse } from 'next/server'
import { parseSignal } from '@/lib/telegram-signal'
import * as Alpaca from '@/lib/alpaca'
import { createServiceClient } from '@/lib/supabase-server'
import { alertTradeEntered } from '@/lib/notify'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const ALLOWED_CHAT = process.env.TELEGRAM_ALLOWED_CHAT_ID
  ? parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID)
  : null

async function tgSend(chat_id: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const message = body?.message ?? body?.channel_post
    if (!message) return NextResponse.json({ ok: true })

    const chatId: number = message.chat?.id
    const text: string = message.text ?? message.caption ?? ''
    const from = message.from?.username ?? message.chat?.title ?? 'unknown'

    if (ALLOWED_CHAT && chatId !== ALLOWED_CHAT) return NextResponse.json({ ok: true })
    if (!text || text.length < 5) return NextResponse.json({ ok: true })

    console.log(`[telegram] from ${from}: ${text.slice(0, 120)}`)

    const db = createServiceClient()
    const signal = await parseSignal(text)

    // ── IGNORE ────────────────────────────────────────────────────────────────
    if (signal.type === 'ignore') {
      console.log('[telegram] ignored (promo/noise)')
      return NextResponse.json({ ok: true, type: 'ignore' })
    }

    // ── LEARN ─────────────────────────────────────────────────────────────────
    if (signal.type === 'learn') {
      await db.from('tb_alerts').insert({
        type: 'INFO',
        symbol: signal.symbols[0] ?? null,
        message: `📚 SF Trades insight: ${signal.summary}`,
      })
      await tgSend(chatId, `📚 *Insight logged*\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}`)
      return NextResponse.json({ ok: true, type: 'learn', signal })
    }

    // ── EXIT ──────────────────────────────────────────────────────────────────
    if (signal.type === 'exit') {
      return NextResponse.json({ ok: true, type: 'exit', signal })
    }

    if (signal.type !== 'trade') return NextResponse.json({ ok: true, type: 'skip' })

    // ── TRADE ─────────────────────────────────────────────────────────────────
    const qty = 1
    const order = await Alpaca.placeOrder(
      signal.symbol, qty, signal.action,
      signal.order_type, signal.entry_price ?? undefined
    )

    await db.from('tb_alerts').insert({
      type: signal.action,
      symbol: signal.symbol,
      message: `Telegram → ${signal.action} ${qty} ${signal.symbol}${signal.entry_price ? ` @$${signal.entry_price}` : ' mkt'}${signal.stop_loss ? ` SL$${signal.stop_loss}` : ''} — ${order.status}`,
    })

    const emoji = order.status === 'PLACED' ? '✅' : '❌'
    const reply = [
      `*${emoji} ${signal.action} ${qty} ${signal.symbol}*`,
      signal.order_type === 'LIMIT' && signal.entry_price ? `Entry: $${signal.entry_price}` : 'Entry: Market',
      signal.stop_loss ? `SL: $${signal.stop_loss}` : null,
      signal.target    ? `Target: $${signal.target}` : null,
      `Broker: Alpaca Paper`,
      `Status: ${order.status}`,
      `Confidence: ${signal.confidence}%`,
    ].filter(Boolean).join('\n')

    await tgSend(chatId, reply)

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
        reason: `Telegram signal from ${from}${signal.stop_loss ? ` | SL $${signal.stop_loss}` : ''}`,
      })
    }

    return NextResponse.json({ ok: true, type: 'trade', signal, order })
  } catch (e) {
    console.error('[telegram] webhook error:', e)
    return NextResponse.json({ ok: true })
  }
}
