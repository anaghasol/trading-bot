/**
 * POLLER 2 — SF Trades (Pavan exclusive paid channel)
 *
 * Responsibilities:
 *  1. Relay every raw message → SF Trades Relay group (as-is, no modification)
 *  2. Execute trades with PRIORITY on both Alpaca paper and Schwab live
 *     (lower confidence gate vs the 3-channel poller — Pavan's signals are curated)
 *
 * Health keys: tg_sf_cron_ping, tg_sf_last_poll, tg_sf_status, tg_sf_relay_last_msg
 * Watermark:   tg_last_msg_id_sf_trades
 *
 * Runs: every minute via Vercel cron (same schedule as main poller)
 */

export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession, saveSession } from '@/lib/telegram-client'
import { parseSignal, isWorthClassifying } from '@/lib/telegram-signal'
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
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''  // SF Trades Relay group

// Pavan's exclusive SF Trades channel — set TELEGRAM_SF_TRADES_CHANNEL_ID in Vercel
const SF_CHANNEL_ID: string | number = (() => {
  const raw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  const n = parseInt(raw)
  return isNaN(n) ? raw : n   // numeric ID or '@username'
})()

// Priority live settings — Pavan's channel is curated, lower bar for Schwab
const SF_SCHWAB_MIN_CONF = 68  // vs 78% for the 3-channel poller
const SF_SIGNAL_STYLE = `
Pavan's SF Trades channel — curated US equity trading signals from a paid membership channel.
Formats:
  - "Buy TICKER at PRICE SL PRICE target PRICE" or "TICKER Long entry X SL Y TP Z"
  - Watchlist alerts: "Watch TICKER near PRICE support"
  - Updates: "TICKER TP hit" / "TICKER SL hit — exit" / "Partial exit TICKER"
These are high-conviction, actionable signals — treat as PRIORITY for trade execution.
Always extract ticker, direction, and price levels. Never classify as ignore unless pure non-trade content.
`

async function tgSend(text: string) {
  if (!GROUP_ID || !BOT_TOKEN) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, text, parse_mode: 'Markdown' }),
  }).catch(() => {})
}

async function tgRelay(text: string): Promise<boolean> {
  if (!RELAY_CHAT || !BOT_TOKEN || !text.trim()) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: RELAY_CHAT,
        text: `⭐ [SF Trades]\n\n${text}`,  // ⭐ marks it as priority / Pavan's channel
      }),
    })
    const data = await res.json() as { ok: boolean }
    return data.ok === true
  } catch { return false }
}

export async function GET(req: Request) {
  const db = createServiceClient()

  // Heartbeat — always written, even before auth check
  await db.from('tb_settings').upsert({ key: 'tg_sf_cron_ping', value: new Date().toISOString() }).then(() => {}, () => {})

  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // If channel not configured yet, skip gracefully
  if (!SF_CHANNEL_ID) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'not_configured' })
    return NextResponse.json({ ok: false, reason: 'TELEGRAM_SF_TRADES_CHANNEL_ID not set' })
  }

  const sessionStr = await getStoredSession()
  if (!sessionStr) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'no_session' })
    return NextResponse.json({ error: 'Not authenticated. Visit /tg-connect first.' })
  }

  // Connect with retry
  let client: TelegramClient | null = null
  let connectErr: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
      await client.connect()
      connectErr = null
      break
    } catch (e) {
      connectErr = String(e).slice(0, 120)
      client = null
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }

  if (!client || connectErr) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: `error: ${connectErr}` })
    // Phone alert on disconnect — 30-min dedupe, separate key from main poller
    const { data: lastAlertRow } = await db.from('tb_settings').select('value').eq('key', 'tg_sf_disconnect_alerted_at').single()
    const lastAlert = lastAlertRow?.value ? new Date(lastAlertRow.value).getTime() : 0
    if (BOT_TOKEN && GROUP_ID && Date.now() - lastAlert > 30 * 60_000) {
      await db.from('tb_settings').upsert({ key: 'tg_sf_disconnect_alerted_at', value: new Date().toISOString() })
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: GROUP_ID,
          text: `🔴 *SF Trades Poller disconnected*\nError: ${connectErr}\nOpen /tg-connect to restore.`,
          parse_mode: 'Markdown',
        }),
      }).catch(() => {})
    }
    return NextResponse.json({ ok: false, error: 'TG connect failed after 3 retries', detail: connectErr })
  }

  try { await saveSession(client.session.save() as unknown as string) } catch { /* non-fatal */ }

  await db.from('tb_settings').upsert({ key: 'tg_sf_last_poll', value: new Date().toISOString() })
  await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'ok' })

  // Watermark
  const WATERMARK_KEY = 'tg_last_msg_id_sf_trades'
  const { data: lastData } = await db.from('tb_settings').select('value').eq('key', WATERMARK_KEY).single()
  const lastId = parseInt(lastData?.value ?? '0')

  let messages: Awaited<ReturnType<typeof client.getMessages>>
  try {
    messages = await client.getMessages(SF_CHANNEL_ID, { limit: 10 })
  } catch (e) {
    await client.disconnect().catch(() => {})
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: `error: getMessages failed: ${String(e).slice(0, 80)}` })
    return NextResponse.json({ ok: false, error: 'getMessages failed', detail: String(e) })
  }

  const newMsgs = messages
    .filter(m => m.id > lastId && (m.text?.length > 3 || m.media != null))
    .sort((a, b) => b.id - a.id)
    .slice(0, 5)

  if (newMsgs.length === 0) {
    await client.disconnect().catch(() => {})
    return NextResponse.json({ ok: true, channel: 'SF Trades', new: 0, checked: messages.length })
  }

  const maxId = Math.max(...newMsgs.map(m => m.id))
  await db.from('tb_settings').upsert({ key: WATERMARK_KEY, value: String(maxId) })

  const profile      = PROFILES.alpaca_paper
  const schwabProfile = PROFILES.schwab
  const equity       = (await getAccountBalance()) ?? 100_000

  const results = await Promise.all(newMsgs.map(async (msg) => {
    const text = msg.text ?? ''

    // 1. Relay as-is to SF Trades Relay group (ALWAYS — before any parsing)
    if (text.trim()) {
      const relayed = await tgRelay(text)
      if (relayed) {
        await db.from('tb_settings').upsert({ key: 'tg_sf_relay_last_msg', value: new Date().toISOString() }).then(() => {}, () => {})
      }
    }

    // 2. Parse signal
    if (!isWorthClassifying(text)) return { id: msg.id, type: 'relay_only' }

    const signal = await parseSignal(text, 'SF Trades', SF_SIGNAL_STYLE)
    if (signal.type === 'ignore') return { id: msg.id, type: 'relayed_ignored' }

    // Log to alerts
    const alertSym = signal.type === 'trade' ? signal.symbol : signal.type === 'learn' ? (signal.symbols?.[0] ?? null) : null
    const alertMsg = signal.type === 'trade' ? `⭐ SF Trades: ${signal.action} ${signal.symbol}` : signal.type === 'learn' ? `⭐ SF Trades insight: ${signal.summary}` : `⭐ SF Trades exit`
    await db.from('tb_alerts').insert({ type: 'INFO', symbol: alertSym, message: alertMsg }).then(() => {}, () => {})

    // Exit signal
    if (signal.type === 'exit') {
      const { data: openTrade } = await db.from('tb_trades')
        .select('id, quantity, broker').eq('symbol', signal.symbol).eq('status', 'OPEN').limit(1).single()
      if (openTrade) {
        const broker = openTrade.broker as string
        const sellOrder = broker === 'schwab'
          ? await Schwab.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
          : await Alpaca.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
        if (sellOrder.status === 'PLACED') {
          await db.from('tb_trades').update({ status: 'CLOSED', closed_at: new Date().toISOString(), reason: `⭐ SF Trades exit: ${signal.reason}` }).eq('id', openTrade.id)
        }
        await tgSend(`🚨 *SF Trades EXIT: ${signal.symbol}*\n${signal.summary}\nStatus: ${sellOrder.status} · ${broker}`)
        return { id: msg.id, type: 'exit', symbol: signal.symbol }
      }
      return { id: msg.id, type: 'exit_not_held', symbol: signal.symbol }
    }

    // Learn signal
    if (signal.type === 'learn') {
      await tgSend(`⭐ *SF Trades insight*\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}`)
      return { id: msg.id, type: 'learn' }
    }

    // Trade signal — execute on both brokers with priority settings
    if (signal.type !== 'trade') return { id: msg.id, type: 'other' }

    const afterHoursEt = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
    const afterHours   = afterHoursEt >= 16 || afterHoursEt < 9
    const afterHoursTag = afterHours ? ' [FILLS AT OPEN]' : ''

    // Guard: already holding
    if (signal.action === 'BUY') {
      const { data: existing } = await db.from('tb_trades').select('id').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1)
      if (existing?.length) {
        await tgSend(`⚠️ *SF Trades: skip ${signal.symbol}* — already open`)
        return { id: msg.id, type: 'skip', reason: 'already_open' }
      }
    }

    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const exposureCap = exposureCapForConfidence(signal.confidence)
    const qty = livePrice
      ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, exposureCap).qty
      : 10
    const stopPrice = signal.stop_loss ?? (livePrice ? Math.round(livePrice * (1 - profile.initial_stop_pct) * 100) / 100 : null)

    // Paper trade (Alpaca)
    const paperOrder = await Alpaca.placeOrder(signal.symbol, qty, signal.action, 'MARKET')

    if (paperOrder.status === 'PLACED' && signal.action === 'BUY') {
      if (stopPrice && !afterHours) await placeStopOrder(signal.symbol, qty, stopPrice).catch(() => {})
      await db.from('tb_trades').insert({
        symbol: signal.symbol, broker: 'alpaca_paper', action: 'BUY',
        quantity: qty, entry_price: livePrice ?? 0,
        stop_loss: stopPrice ?? 0, target_price: signal.target ?? null,
        confidence: signal.confidence, status: 'OPEN',
        order_id: paperOrder.order_id ?? null,
        reason: '⭐ SF Trades (Pavan)',
      })
    }

    // Live trade (Schwab) — PRIORITY: lower confidence bar, always attempt
    let schwabNote = ''
    if (signal.action === 'BUY' && !afterHours && signal.confidence >= SF_SCHWAB_MIN_CONF) {
      try {
        const [schwabPositions, schwabBalance] = await Promise.all([Schwab.getPositions(), Schwab.getAccountBalance()])
        const schwabEquity = schwabBalance ?? 2000
        const alreadyOpen  = schwabPositions.some(p => p.symbol === signal.symbol)
        const atMax        = schwabPositions.length >= schwabProfile.max_positions

        if (!alreadyOpen && !atMax) {
          const schwabQty = livePrice
            ? calculatePositionSize(schwabEquity, livePrice, schwabProfile.initial_stop_pct, schwabProfile.risk_pct, 0.25).qty
            : 1
          const schwabOrder = await Schwab.placeOrder(signal.symbol, schwabQty, 'BUY', 'MARKET')

          if (schwabOrder.status === 'PLACED') {
            const schwabStop = stopPrice ?? (livePrice ? Math.round(livePrice * (1 - schwabProfile.initial_stop_pct) * 100) / 100 : null)
            await db.from('tb_trades').insert({
              symbol: signal.symbol, broker: 'schwab', action: 'BUY',
              quantity: schwabQty, entry_price: livePrice ?? 0,
              stop_loss: schwabStop ?? 0, target_price: signal.target ?? null,
              confidence: signal.confidence, status: 'OPEN',
              order_id: schwabOrder.order_id ?? null,
              reason: '⭐ SF Trades (Pavan) PRIORITY',
            })
            schwabNote = `\n💰 *Schwab LIVE: BUY ${schwabQty} ${signal.symbol}* · $${((livePrice ?? 0) * schwabQty).toFixed(0)}`
          }
        } else {
          schwabNote = alreadyOpen ? `\n📌 Schwab: already holding ${signal.symbol}` : `\n📌 Schwab: at max positions`
        }
      } catch { /* Schwab failure never blocks paper */ }
    } else if (signal.action === 'BUY' && signal.confidence < SF_SCHWAB_MIN_CONF) {
      schwabNote = `\n📌 Schwab skipped: conf ${signal.confidence}% < ${SF_SCHWAB_MIN_CONF}% floor`
    }

    const emoji = paperOrder.status === 'PLACED' ? '✅' : '❌'
    await tgSend(`*${emoji} SF Trades ⭐ → ${signal.action} ${qty} ${signal.symbol}*\nEntry: Market${stopPrice ? `\nSL: $${stopPrice}` : ''}\nConf: ${signal.confidence}%\nPaper: ${paperOrder.status}${afterHoursTag}${schwabNote}`)

    return { id: msg.id, type: 'trade', symbol: signal.symbol, action: signal.action }
  }))

  await client.disconnect().catch(() => {})
  return NextResponse.json({ ok: true, channel: 'SF Trades', processed: newMsgs.length, results })
}
