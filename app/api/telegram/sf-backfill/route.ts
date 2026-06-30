/**
 * GET /api/telegram/sf-backfill?secret=X
 * One-time backfill: fetch all of today's messages from SF Essential Trades,
 * relay them as-is to SF Trades Relay, and process through Groq for trade signals.
 */
export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession } from '@/lib/telegram-client'
import { parseSignal } from '@/lib/telegram-signal'
import * as Alpaca from '@/lib/alpaca'
import { placeStopOrder, getAccountBalance } from '@/lib/alpaca'
import * as Schwab from '@/lib/schwab'
import { createServiceClient } from '@/lib/supabase-server'
import { calculatePositionSize, exposureCapForConfidence } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'

const API_ID     = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH   = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const GROUP_ID   = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''
const SF_CHANNEL = -1002381909837   // SF Essential Trades (Pavan)

const SF_SIGNAL_STYLE = `
Pavan Sailesh's SF Essential Trades — paid membership US equity trade alerts.
Primary format: "Trade Id : XXXXX, MM/DD: Buying TICKER at PRICE With SL of PRICE"
Follow-ups: "TICKER TP hit" / "book profits on TICKER" / "TICKER is early trade, alert below PRICE"
Context: ALAB, CRDO, IBM, MDB type large-cap swing trades.
Always extract ticker + direction. Trade Id = BUY signal. TP/book = exit signal.
`

async function tgSend(text: string) {
  if (!BOT_TOKEN || !GROUP_ID) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, text, parse_mode: 'Markdown' }),
  }).catch(() => {})
}

type RelayLabel = 'BUY/SELL' | 'EXIT' | 'INFO'

async function tgRelay(text: string, label: RelayLabel = 'INFO') {
  if (!BOT_TOKEN || !RELAY_CHAT || !text.trim()) return
  const badge = label === 'BUY/SELL' ? '🟢 BUY/SELL — IMPORTANT'
              : label === 'EXIT'     ? '🔴 EXIT SIGNAL'
              :                        'ℹ️ INFO'
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: RELAY_CHAT,
      text: `⭐ [SF Essential Trades] — ${badge}\n\n${text}`,
    }),
  }).catch(() => {})
}

export async function GET(req: Request) {
  const url    = new URL(req.url)
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // days_back=0 → today only, days_back=1 → yesterday+today (default 1)
  const daysBack  = parseInt(url.searchParams.get('days_back') ?? '1', 10)

  const db = createServiceClient()
  const sessionStr = await getStoredSession()
  if (!sessionStr) return NextResponse.json({ error: 'No TG session' }, { status: 500 })

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3, useWSS: true })
  await client.connect()

  // Calculate start of window in ET (midnight ET, daysBack days ago)
  const nowET       = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const windowStart = new Date(nowET + 'T04:00:00Z').getTime() / 1000 - daysBack * 86_400
  const windowLabel = daysBack === 0 ? 'today' : daysBack === 1 ? 'yesterday+today' : `last ${daysBack + 1} days`

  // Fetch up to 200 recent messages, filter to window
  const messages = await client.getMessages(SF_CHANNEL, { limit: 200 })
  const todayMsgs = messages
    .filter(m => m.date >= windowStart && (m.text?.length > 3 || m.media != null))
    .sort((a, b) => a.id - b.id)   // oldest first so relay order matches original

  const profile       = PROFILES.alpaca_paper
  const schwabProfile = PROFILES.schwab
  const equity        = (await getAccountBalance()) ?? 100_000

  const results: { id: number; text: string; relay: boolean; signal_type: string; trade?: string }[] = []

  for (const msg of todayMsgs) {
    const text = msg.text ?? ''

    if (!text || text.trim().length < 5) {
      // Media/image only — relay as INFO, no parsing
      await tgRelay('[image/media]', 'INFO')
      results.push({ id: msg.id, text: '[media]', relay: true, signal_type: 'media_only' })
      continue
    }

    // 1. Classify with Groq first so we know the label before relaying
    const signal = await parseSignal(text, 'SF Trades', SF_SIGNAL_STYLE)

    // 2. Relay to SF Trades Relay with correct label
    const relayLabel: RelayLabel =
      signal.type === 'trade' ? 'BUY/SELL' :
      signal.type === 'exit'  ? 'EXIT' : 'INFO'
    await tgRelay(text, relayLabel)

    if (signal.type === 'ignore') {
      results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'no_signal' })
      continue
    }

    // Log to alerts
    await db.from('tb_alerts').insert({
      type: 'INFO',
      symbol: signal.type === 'trade' ? signal.symbol : null,
      message: `⭐ SF Trades backfill: ${signal.type === 'trade' ? `${signal.action} ${signal.symbol}` : signal.summary?.slice(0, 80)}`,
    }).then(() => {}, () => {})

    if (signal.type === 'learn') {
      await tgSend(`⭐ *SF Trades insight*\n${signal.summary}`)
      results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'learn' })
      continue
    }

    if (signal.type === 'exit') {
      const { data: openTrade } = await db.from('tb_trades')
        .select('id, quantity, broker').eq('symbol', signal.symbol).eq('status', 'OPEN').limit(1).single()
      if (openTrade) {
        const broker = openTrade.broker as string
        const sellOrder = broker === 'schwab'
          ? await Schwab.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
          : await Alpaca.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
        if (sellOrder.status === 'PLACED') {
          await db.from('tb_trades').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', openTrade.id)
        }
        await tgSend(`🚨 *SF Trades EXIT: ${signal.symbol}*\n${signal.summary}`)
        results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'exit', trade: `${signal.symbol} CLOSED` })
      } else {
        results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'exit_not_held' })
      }
      continue
    }

    if (signal.type !== 'trade') {
      results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'other' })
      continue
    }

    // Trade execution
    const afterHoursEt = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
    const afterHours   = afterHoursEt >= 16 || afterHoursEt < 9

    // Skip if already holding this symbol
    if (signal.action === 'BUY') {
      const { data: existing } = await db.from('tb_trades').select('id').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1)
      if (existing?.length) {
        results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'skip_already_open', trade: signal.symbol })
        continue
      }
    }

    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const qty = livePrice
      ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, exposureCapForConfidence(signal.confidence)).qty
      : 10
    const stopPrice = signal.stop_loss ?? (livePrice ? Math.round(livePrice * (1 - profile.initial_stop_pct) * 100) / 100 : null)

    // Paper trade
    const paperOrder = await Alpaca.placeOrder(signal.symbol, qty, signal.action, 'MARKET')
    if (paperOrder.status === 'PLACED' && signal.action === 'BUY') {
      if (stopPrice && !afterHours) await placeStopOrder(signal.symbol, qty, stopPrice).catch(() => {})
      await db.from('tb_trades').insert({
        symbol: signal.symbol, broker: 'alpaca_paper', action: 'BUY',
        quantity: qty, entry_price: livePrice ?? 0,
        stop_loss: stopPrice ?? 0, target_price: signal.target ?? null,
        confidence: signal.confidence, status: 'OPEN',
        reason: `⭐ SF Trades backfill (Pavan)`,
      })
    }

    // Live Schwab — priority execution
    let schwabNote = 'skipped'
    if (signal.action === 'BUY' && !afterHours && signal.confidence >= 68) {
      try {
        const [schwabPos, schwabBal] = await Promise.all([Schwab.getPositions(), Schwab.getAccountBalance()])
        const schwabEquity = schwabBal ?? 2000
        if (!schwabPos.some(p => p.symbol === signal.symbol) && schwabPos.length < schwabProfile.max_positions) {
          const schwabQty = livePrice ? calculatePositionSize(schwabEquity, livePrice, schwabProfile.initial_stop_pct, schwabProfile.risk_pct, 0.25).qty : 1
          const schwabOrder = await Schwab.placeOrder(signal.symbol, schwabQty, 'BUY', 'MARKET')
          if (schwabOrder.status === 'PLACED') {
            await db.from('tb_trades').insert({
              symbol: signal.symbol, broker: 'schwab', action: 'BUY',
              quantity: schwabQty, entry_price: livePrice ?? 0,
              stop_loss: stopPrice ?? 0, confidence: signal.confidence, status: 'OPEN',
              reason: `⭐ SF Trades backfill PRIORITY`,
            })
            schwabNote = `BUY ${schwabQty} @ $${livePrice}`
          }
        } else {
          schwabNote = schwabPos.some(p => p.symbol === signal.symbol) ? 'already_holding' : 'max_positions'
        }
      } catch { schwabNote = 'error' }
    } else if (afterHours) {
      schwabNote = 'after_hours'
    } else if (signal.confidence < 68) {
      schwabNote = `conf_${signal.confidence}%_<_68%`
    }

    await tgSend(`✅ *SF Trades ⭐ → ${signal.action} ${qty} ${signal.symbol}*\nConf: ${signal.confidence}% | Paper: ${paperOrder.status}\nSchwab: ${schwabNote}`)
    results.push({ id: msg.id, text: text.slice(0, 80), relay: true, signal_type: 'trade', trade: `${signal.action} ${signal.symbol} paper=${paperOrder.status} schwab=${schwabNote}` })
  }

  // Update watermark to latest processed message
  if (todayMsgs.length > 0) {
    const maxId = Math.max(...todayMsgs.map(m => m.id))
    await db.from('tb_settings').upsert({ key: 'tg_last_msg_id_sf_trades', value: String(maxId) })
  }

  await client.disconnect().catch(() => {})

  return NextResponse.json({
    ok:      true,
    window:  windowLabel,
    channel: 'SF Essential Trades',
    total_in_window: todayMsgs.length,
    results,
  })
}
