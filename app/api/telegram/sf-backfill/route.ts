/**
 * GET /api/telegram/sf-backfill?secret=X[&days_back=1]
 * Backfill SF Essential Trades messages → relay to SF Trades Relay + Groq trade analysis.
 *
 * Uses parseSignalThread (single batched Groq call) to avoid rate-limit issues
 * when processing many historical messages.
 *
 * days_back=0 → today only
 * days_back=1 → yesterday+today (default)
 */
export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession } from '@/lib/telegram-client'
import { parseSignalThread } from '@/lib/telegram-signal'
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

BUY formats Pavan uses:
  "Trade Id : XXXXX, MM/DD: Buying TICKER at PRICE With SL of PRICE Which has max risk of X%"
  "buying TICKER at PRICE with PRICE as stop"
  "Buying TICKER counter trend with PRICE as stop cmp PRICE. Target is PRICE"
  → All of these are type:trade with action=BUY

EXIT formats:
  "TICKER TP hit" / "book profits on TICKER" / "TICKER booked" / "TICKER is early trade, alert below PRICE"
  → type:exit

INFO/LEARN:
  Macro commentary, ALAB performance updates, member Q&A, "this is a good setup" without an entry price
  → type:learn or type:ignore

Critical rule: If a message says "buying" or "Buying" with a ticker and a price, it is ALWAYS type:trade even without the word "stop" if a stop-loss price can be inferred. Never classify Pavan's buying messages as ignore.
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

  const daysBack  = parseInt(url.searchParams.get('days_back') ?? '1', 10)

  const db        = createServiceClient()
  const sessionStr = await getStoredSession()
  if (!sessionStr) return NextResponse.json({ error: 'No TG session' }, { status: 500 })

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3, useWSS: true })
  await client.connect()

  const nowET       = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const windowStart = new Date(nowET + 'T04:00:00Z').getTime() / 1000 - daysBack * 86_400
  const windowLabel = daysBack === 0 ? 'today' : daysBack === 1 ? 'yesterday+today' : `last ${daysBack + 1} days`

  const messages = await client.getMessages(SF_CHANNEL, { limit: 200 })
  const windowMsgs = messages
    .filter(m => m.date >= windowStart && (m.text?.length > 3 || m.media != null))
    .sort((a, b) => a.id - b.id)

  // Separate text messages (need Groq) from media-only
  const textMsgs  = windowMsgs.filter(m => m.text && m.text.trim().length >= 5)
  const mediaMsgs = new Set(windowMsgs.filter(m => !m.text || m.text.trim().length < 5).map(m => m.id))

  // Single batched Groq call for all text messages (avoids rate-limiting)
  const classified = await parseSignalThread(
    textMsgs.map(m => ({ id: m.id, text: m.text ?? '' })),
    'SF Essential Trades',
    SF_SIGNAL_STYLE,
  )
  const signalMap = new Map(classified.map(r => [r.id, r.signal]))

  const profile       = PROFILES.alpaca_paper
  const schwabProfile = PROFILES.schwab
  const equity        = (await getAccountBalance()) ?? 100_000
  const afterHoursEt  = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
  const afterHours    = afterHoursEt >= 16 || afterHoursEt < 9

  const results: { id: number; text: string; label: string; signal_type: string; trade?: string }[] = []

  for (const msg of windowMsgs) {
    const text = msg.text ?? ''

    if (mediaMsgs.has(msg.id)) {
      await tgRelay('[image/media]', 'INFO')
      results.push({ id: msg.id, text: '[media]', label: 'INFO', signal_type: 'media_only' })
      continue
    }

    const signal = signalMap.get(msg.id) ?? { type: 'ignore' as const }
    const relayLabel: RelayLabel =
      signal.type === 'trade' ? 'BUY/SELL' :
      signal.type === 'exit'  ? 'EXIT' : 'INFO'

    await tgRelay(text, relayLabel)

    if (signal.type === 'ignore') {
      results.push({ id: msg.id, text: text.slice(0, 80), label: 'INFO', signal_type: 'no_signal' })
      continue
    }

    if (signal.type === 'learn') {
      await tgSend(`⭐ *SF Trades insight*\n${signal.summary}${signal.symbols?.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}`)
      results.push({ id: msg.id, text: text.slice(0, 80), label: 'INFO', signal_type: 'learn' })
      continue
    }

    if (signal.type === 'exit') {
      await db.from('tb_alerts').insert({ type: 'INFO', symbol: signal.symbol, message: `⭐ SF Trades EXIT: ${signal.symbol} — ${signal.summary}` }).then(() => {}, () => {})
      const { data: openTrade } = await db.from('tb_trades').select('id, quantity, broker').eq('symbol', signal.symbol).eq('status', 'OPEN').limit(1).single()
      if (openTrade) {
        const broker = openTrade.broker as string
        const sellOrder = broker === 'schwab'
          ? await Schwab.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
          : await Alpaca.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
        if (sellOrder.status === 'PLACED') {
          await db.from('tb_trades').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', openTrade.id)
        }
        await tgSend(`🚨 *SF Trades EXIT: ${signal.symbol}*\n${signal.summary}`)
        results.push({ id: msg.id, text: text.slice(0, 80), label: 'EXIT', signal_type: 'exit', trade: `${signal.symbol} CLOSED` })
      } else {
        results.push({ id: msg.id, text: text.slice(0, 80), label: 'EXIT', signal_type: 'exit_not_held' })
      }
      continue
    }

    if (signal.type !== 'trade') {
      results.push({ id: msg.id, text: text.slice(0, 80), label: 'INFO', signal_type: 'other' })
      continue
    }

    // BUY/SELL trade signal
    await db.from('tb_alerts').insert({ type: 'INFO', symbol: signal.symbol, message: `⭐ SF Trades backfill: ${signal.action} ${signal.symbol} @ conf ${signal.confidence}%` }).then(() => {}, () => {})

    if (signal.action === 'BUY') {
      const { data: existing } = await db.from('tb_trades').select('id').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1)
      if (existing?.length) {
        await tgSend(`⚠️ *SF Trades: skip ${signal.symbol}* — already open`)
        results.push({ id: msg.id, text: text.slice(0, 80), label: 'BUY/SELL', signal_type: 'skip_already_open', trade: signal.symbol })
        continue
      }
    }

    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const qty       = livePrice ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, exposureCapForConfidence(signal.confidence)).qty : 10
    const stopPrice = signal.stop_loss ?? (livePrice ? Math.round(livePrice * (1 - profile.initial_stop_pct) * 100) / 100 : null)

    // Paper (Alpaca)
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

    // Live Schwab — priority
    let schwabNote = afterHours ? 'after_hours' : signal.confidence < 68 ? `conf_${signal.confidence}%<68%` : 'skipped'
    if (signal.action === 'BUY' && !afterHours && signal.confidence >= 68) {
      try {
        const [schwabPos, schwabBal] = await Promise.all([Schwab.getPositions(), Schwab.getAccountBalance()])
        const schwabEquity = schwabBal ?? 2000
        if (!schwabPos.some(p => p.symbol === signal.symbol) && schwabPos.length < schwabProfile.max_positions) {
          const schwabQty   = livePrice ? calculatePositionSize(schwabEquity, livePrice, schwabProfile.initial_stop_pct, schwabProfile.risk_pct, 0.25).qty : 1
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
    }

    await tgSend(`✅ *SF Trades ⭐ → ${signal.action} ${qty} ${signal.symbol}*\nConf: ${signal.confidence}% | Paper: ${paperOrder.status} | Schwab: ${schwabNote}`)
    results.push({ id: msg.id, text: text.slice(0, 80), label: 'BUY/SELL', signal_type: 'trade', trade: `${signal.action} ${signal.symbol} paper=${paperOrder.status} schwab=${schwabNote}` })
  }

  if (windowMsgs.length > 0) {
    const maxId = Math.max(...windowMsgs.map(m => m.id))
    await db.from('tb_settings').upsert({ key: 'tg_last_msg_id_sf_trades', value: String(maxId) })
  }

  await client.disconnect().catch(() => {})

  return NextResponse.json({
    ok:              true,
    window:          windowLabel,
    channel:         'SF Essential Trades',
    total_in_window: windowMsgs.length,
    results,
  })
}
