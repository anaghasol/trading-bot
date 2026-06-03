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

    // Only process messages from the configured chat (if set)
    if (ALLOWED_CHAT && chatId !== ALLOWED_CHAT) {
      return NextResponse.json({ ok: true })
    }

    if (!text || text.length < 5) return NextResponse.json({ ok: true })

    console.log(`[telegram] message from ${from}: ${text.slice(0, 120)}`)

    // Parse the signal with Claude AI
    const signal = await parseSignal(text)
    if (!signal) return NextResponse.json({ ok: true })

    console.log(`[telegram] signal parsed:`, signal)

    // Execute on Alpaca Paper (safe default)
    const qty = 1  // start with 1 share; can make this dynamic later
    const order = await Alpaca.placeOrder(
      signal.symbol,
      qty,
      signal.action,
      signal.order_type,
      signal.entry_price ?? undefined
    )

    // Log to Supabase
    const db = createServiceClient()
    await db.from('tb_alerts').insert({
      type: signal.action,
      symbol: signal.symbol,
      message: `Telegram signal → ${signal.action} ${qty} ${signal.symbol}${signal.entry_price ? ` @ $${signal.entry_price}` : ' market'}${signal.stop_loss ? ` | SL $${signal.stop_loss}` : ''} — ${order.status}`,
    })

    // Build response message
    const statusEmoji = order.status === 'PLACED' ? '✅' : '❌'
    const details = [
      `*${statusEmoji} ${signal.action} ${qty} ${signal.symbol}*`,
      signal.order_type === 'LIMIT' && signal.entry_price ? `Entry: $${signal.entry_price}` : 'Entry: Market',
      signal.stop_loss ? `SL: $${signal.stop_loss}` : null,
      signal.target ? `Target: $${signal.target}` : null,
      `Broker: Alpaca Paper`,
      `Status: ${order.status}`,
    ].filter(Boolean).join('\n')

    // Reply on Telegram
    await tgSend(chatId, details)

    // SMS alert
    if (order.status === 'PLACED') {
      await alertTradeEntered({
        symbol: signal.symbol,
        qty,
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

    return NextResponse.json({ ok: true, signal, order })
  } catch (e) {
    console.error('[telegram] webhook error:', e)
    return NextResponse.json({ ok: true })
  }
}
