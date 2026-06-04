/**
 * Polls SF Essential Trades channel for new messages and fires them
 * through the signal parser → Alpaca Paper execution.
 * Called by Vercel cron every minute during market hours.
 */

export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession, saveSession } from '@/lib/telegram-client'
import { parseSignal, isWorthClassifying } from '@/lib/telegram-signal'
import * as Alpaca from '@/lib/alpaca'
import { createServiceClient } from '@/lib/supabase-server'
import { calculatePositionSize, exposureCapForConfidence } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'

const API_ID     = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH   = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const GROUP_ID   = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')
// SF Essential Trades channel numeric ID (from URL: web.telegram.org/k/#-2381909837)
const CHANNEL_ID = parseInt(process.env.TELEGRAM_CHANNEL_ID ?? '-2381909837')

async function tgSend(text: string) {
  if (!GROUP_ID) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, text, parse_mode: 'Markdown' }),
  })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()

  const sessionStr = await getStoredSession()
  if (!sessionStr) {
    return NextResponse.json({ error: 'Not authenticated. Visit /api/telegram/auth first.' })
  }

  let client: TelegramClient | null = null
  try {
    client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3, useWSS: true })
    await client.connect()
  } catch (e) {
    const db2 = createServiceClient()
    await db2.from('tb_settings').upsert({ key: 'tg_status', value: `error: ${String(e).slice(0, 100)}` })
    return NextResponse.json({ ok: false, error: 'TG connect failed', detail: String(e) })
  }

  try {
    await saveSession(client.session.save() as unknown as string)
  } catch { /* non-fatal — session refresh failed but polling can continue */ }

  // Heartbeat — keeps status endpoint green
  await db.from('tb_settings').upsert({ key: 'tg_last_poll', value: new Date().toISOString() })
  await db.from('tb_settings').upsert({ key: 'tg_status', value: 'ok' })

  // Get last seen message ID from Supabase
  const { data: lastData } = await db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single()
  const lastId = parseInt(lastData?.value ?? '0')

  // Fetch recent messages from the channel
  let messages: Awaited<ReturnType<typeof client.getMessages>>
  try {
    messages = await client.getMessages(CHANNEL_ID, { limit: 10 })
  } catch (e) {
    await client.disconnect().catch(() => {})
    await db.from('tb_settings').upsert({ key: 'tg_status', value: `error: getMessages ${String(e).slice(0, 80)}` })
    return NextResponse.json({ ok: false, error: 'getMessages failed', detail: String(e) })
  }
  await client.disconnect().catch(() => {})

  // Process newest-first, cap at 5 per tick to stay well under timeout
  const newMsgs = messages
    .filter((m) => m.id > lastId && m.text?.length > 5)
    .sort((a, b) => b.id - a.id)
    .slice(0, 5)

  if (newMsgs.length === 0) {
    return NextResponse.json({ ok: true, checked: messages.length, new: 0 })
  }

  // Advance watermark immediately so a timeout on processing doesn't cause re-processing
  const maxId = Math.max(...newMsgs.map((m) => m.id))
  await db.from('tb_settings').upsert({ key: 'tg_last_msg_id', value: String(maxId) })

  // Classify all messages in parallel (Claude API calls)
  const profile = PROFILES.alpaca_paper
  const equity = (await Alpaca.getAccountBalance()) ?? 100_000

  const results = await Promise.all(newMsgs.map(async (msg) => {
    const text = msg.text ?? ''
    if (!isWorthClassifying(text)) return { id: msg.id, type: 'ignore' }
    const signal = await parseSignal(text)

    if (signal.type === 'ignore') return { id: msg.id, type: 'ignore' }

    if (signal.type === 'learn') {
      await db.from('tb_alerts').insert({
        type: 'INFO',
        symbol: signal.symbols[0] ?? null,
        message: `📚 SF Trades insight: ${signal.summary}${signal.symbols.length ? ` [${signal.symbols.join(', ')}]` : ''}`,
      })
      await tgSend(`📚 *SF Trades insight*\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}`)
      return { id: msg.id, type: 'learn', summary: signal.summary }
    }

    // trade
    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const exposureCap = exposureCapForConfidence(signal.confidence)
    const sizing = livePrice
      ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, exposureCap)
      : { qty: 10 }
    const qty = sizing.qty

    const order = await Alpaca.placeOrder(signal.symbol, qty, signal.action, 'MARKET')

    await db.from('tb_alerts').insert({
      type: signal.action,
      symbol: signal.symbol,
      message: `SF Essential Trades → ${signal.action} ${qty} ${signal.symbol}${signal.entry_price ? ` @$${signal.entry_price}` : ' mkt'}${signal.stop_loss ? ` SL$${signal.stop_loss}` : ''} [conf:${signal.confidence}%] — ${order.status}`,
    })

    if (order.status === 'PLACED' && signal.action === 'BUY') {
      await db.from('tb_trades').insert({
        symbol: signal.symbol, broker: 'alpaca_paper', action: 'BUY',
        quantity: qty, entry_price: livePrice ?? 0,
        stop_loss: signal.stop_loss ?? (livePrice ? livePrice * (1 - profile.initial_stop_pct) : 0),
        target_price: signal.target ?? null, confidence: signal.confidence,
        status: 'OPEN', order_id: order.order_id ?? null,
        reason: 'TG: SF Essential Trades',
      })
    }

    const emoji = order.status === 'PLACED' ? '✅' : '❌'
    await tgSend(`*${emoji} SF Trades → ${signal.action} ${qty} ${signal.symbol}*\n${signal.entry_price ? `Entry: $${signal.entry_price}` : 'Entry: Market'}${signal.stop_loss ? `\nSL: $${signal.stop_loss}` : ''}\nConfidence: ${signal.confidence}%\nStatus: ${order.status} · Alpaca Paper`)

    return { id: msg.id, type: 'trade', signal, order }
  }))

  return NextResponse.json({ ok: true, processed: newMsgs.length, results })
}
