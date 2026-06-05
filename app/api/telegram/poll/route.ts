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
import { placeStopOrder, getAccountBalance } from '@/lib/alpaca'
import * as Schwab from '@/lib/schwab'
import { createServiceClient } from '@/lib/supabase-server'
import { calculatePositionSize, exposureCapForConfidence } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'

const API_ID     = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH   = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const GROUP_ID   = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')
// SF Essential Trades: Telegram API uses -100 prefix for channels (-1002381909837)
// web.telegram.org URL shows -2381909837 (without -100) — DO NOT use that directly
const CHANNEL_ID = parseInt(process.env.TELEGRAM_CHANNEL_ID ?? '-1002381909837')

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

  // Get last seen message ID — use upsert lock to prevent duplicate processing across concurrent cron ticks
  const { data: lastData } = await db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single()
  const lastId = parseInt(lastData?.value ?? '0')
  const lockKey = `tg_poll_lock_${Date.now()}`
  await db.from('tb_settings').upsert({ key: 'tg_poll_lock', value: lockKey })
  const { data: lockCheck } = await db.from('tb_settings').select('value').eq('key', 'tg_poll_lock').single()
  if (lockCheck?.value !== lockKey) return NextResponse.json({ ok: true, skipped: 'concurrent poll detected' })

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
  const equity = (await getAccountBalance()) ?? 100_000

  const results = await Promise.all(newMsgs.map(async (msg) => {
    const text = msg.text ?? ''
    if (!isWorthClassifying(text)) return { id: msg.id, type: 'ignore' }
    const signal = await parseSignal(text)

    if (signal.type === 'ignore') return { id: msg.id, type: 'ignore' }

    // EXIT signal — channel says a stock hit SL or target → close our position
    if (signal.type === 'exit') {
      const { data: openTrade } = await db.from('tb_trades')
        .select('id, quantity, broker').eq('symbol', signal.symbol).eq('status', 'OPEN').limit(1).single()

      if (openTrade) {
        const broker = openTrade.broker as string
        const sellOrder = broker === 'schwab'
          ? await Schwab.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')
          : await Alpaca.placeOrder(signal.symbol, openTrade.quantity, 'SELL', 'MARKET')

        if (sellOrder.status === 'PLACED') {
          await db.from('tb_trades').update({ status: 'CLOSED', closed_at: new Date().toISOString(), reason: `TG exit: ${signal.reason}` }).eq('id', openTrade.id)
        }

        await db.from('tb_alerts').insert({ type: 'SELL', symbol: signal.symbol, message: `🚨 TG EXIT ${signal.symbol} — ${signal.summary} [${sellOrder.status}]` })
        await tgSend(`🚨 *Advisor Exit: ${signal.symbol}*\n${signal.summary}\nStatus: ${sellOrder.status} · ${broker}`)
        return { id: msg.id, type: 'exit', symbol: signal.symbol, reason: signal.reason }
      }

      // Not held — just log the insight
      await tgSend(`📌 *${signal.symbol} exit signal* (not held)\n${signal.summary}`)
      return { id: msg.id, type: 'exit_not_held', symbol: signal.symbol }
    }

    // LEARN signal — digest as context, never blindly act
    // Our own GTC stop orders and monitor cron handle exits; advisor commentary informs future decisions
    if (signal.type === 'learn') {
      const learnMsg = `📚 SF Trades [${signal.sentiment}${signal.sector ? ' · ' + signal.sector : ''}]: ${signal.summary}${signal.symbols.length ? ` [${signal.symbols.join(', ')}]` : ''}`
      await db.from('tb_alerts').insert({ type: 'INFO', symbol: signal.symbols[0] ?? null, message: learnMsg })

      // Save to learning table — AI scanner uses this context for future picks
      // Bearish signals on held stocks are noted but our own stop orders decide exit
      if (signal.symbols.length > 0) {
        for (const sym of signal.symbols) {
          await db.from('tb_learning').insert({
            symbol: sym,
            source: 'sf_essential_trades',
            sentiment: signal.sentiment,
            sector: signal.sector,
            insight: signal.summary + (signal.watch_zone ? ` Watch zone: ${signal.watch_zone}` : ''),
            created_at: new Date().toISOString(),
          })
        }
      }

      const sentimentTag = signal.sentiment === 'bearish' ? '🔴' : signal.sentiment === 'bullish' ? '🟢' : '⚪'
      const watchTag = signal.watch_zone ? `\n👁 Watch zone: ${signal.watch_zone}` : ''
      await tgSend(`📚 *SF Trades insight* ${sentimentTag}\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}${watchTag}`)

      // If advisor signals a broad buy-on-dips / accumulation opportunity with no specific ticker,
      // trigger the AI scanner immediately instead of waiting for the 30-min cron
      const isDipSignal = signal.actionable && signal.sentiment === 'bullish' && signal.symbols.length === 0
      if (isDipSignal) {
        const appUrl = process.env.VERCEL_APP_URL ?? 'https://trading-bot-hazel-one.vercel.app'
        fetch(`${appUrl}/api/engine?secret=${process.env.CRON_SECRET}&source=tg_dip_signal`, {
          method: 'POST',
        }).catch(() => {})
        await tgSend(`🔍 *Dip signal detected — triggering AI scanner now*\nLooking for buy setups across watchlist...`)
      }

      return { id: msg.id, type: 'learn', summary: signal.summary }
    }

    // ── TRADE EXECUTION ───────────────────────────────────────────────────────
    // TG signals from Pavan ALWAYS take priority — they bypass VIX/market-tier
    // gates entirely. Those filters only apply to the AI scanner's own picks.
    // Only hard guards here: duplicate symbol + after-hours tag.

    // Guard 1: skip if we already hold this symbol (prevents duplicates from repeat signals)
    if (signal.action === 'BUY') {
      const { data: existing } = await db.from('tb_trades')
        .select('id').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1)
      if (existing && existing.length > 0) {
        await tgSend(`⚠️ *Skipped ${signal.symbol}* — already have open position`)
        return { id: msg.id, type: 'skip', reason: 'already_open' }
      }
    }

    // Guard 2: block after market hours (4 PM ET = 20:00 UTC)
    const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
    const afterHours = parseInt(etHour) >= 16 || parseInt(etHour) < 9
    const afterHoursTag = afterHours ? ' [FILLS AT OPEN]' : ''

    const liveQuote = await Alpaca.getQuote(signal.symbol)
    const livePrice = liveQuote?.price ?? signal.entry_price
    const exposureCap = exposureCapForConfidence(signal.confidence)
    const sizing = livePrice
      ? calculatePositionSize(equity, livePrice, profile.initial_stop_pct, profile.risk_pct, exposureCap)
      : { qty: 10 }
    const qty = sizing.qty

    const order = await Alpaca.placeOrder(signal.symbol, qty, signal.action, 'MARKET')

    const stopPrice = signal.stop_loss ?? (livePrice ? Math.round(livePrice * (1 - profile.initial_stop_pct) * 100) / 100 : null)

    await db.from('tb_alerts').insert({
      type: signal.action,
      symbol: signal.symbol,
      message: `SF Essential Trades → ${signal.action} ${qty} ${signal.symbol} mkt${stopPrice ? ` SL$${stopPrice}` : ''} [conf:${signal.confidence}%]${afterHoursTag} — ${order.status}`,
    })

    if (order.status === 'PLACED' && signal.action === 'BUY') {
      // Save trade recommendation to learning context so AI scanner knows advisor likes this stock
      await db.from('tb_learning').insert({
        symbol: signal.symbol,
        source: 'sf_essential_trades',
        sentiment: 'bullish',
        sector: null,
        insight: `Advisor recommended BUY at market, SL $${stopPrice ?? 'N/A'}, confidence ${signal.confidence}%`,
        created_at: new Date().toISOString(),
      })

      // Place broker-level GTC stop order immediately — protects position even if monitor cron is down
      if (stopPrice && !afterHours) {
        await placeStopOrder(signal.symbol, qty, stopPrice).catch(() => {})
      }

      await db.from('tb_trades').insert({
        symbol: signal.symbol, broker: 'alpaca_paper', action: 'BUY',
        quantity: qty, entry_price: livePrice ?? 0,
        stop_loss: stopPrice ?? 0,
        target_price: signal.target ?? null, confidence: signal.confidence,
        status: 'OPEN', order_id: order.order_id ?? null,
        reason: 'TG: SF Essential Trades',
      })
    }

    // ── SCHWAB LIVE (parallel) ────────────────────────────────────────────────
    // TG signals bypass VIX/market-tier scanner gates — Pavan's conviction IS the filter.
    // Schwab uses its own hard limits: conf≥78%, ≤3 positions, market hours only.
    let schwabNote = ''
    const schwabProfile = PROFILES.schwab
    if (signal.action === 'BUY' && !afterHours && signal.confidence >= schwabProfile.min_confidence) {
      try {
        const [schwabPositions, schwabBalance] = await Promise.all([Schwab.getPositions(), Schwab.getAccountBalance()])
        const schwabEquity = schwabBalance ?? 2000
        const alreadyOpen = schwabPositions.some(p => p.symbol === signal.symbol)
        const atMaxPositions = schwabPositions.length >= schwabProfile.max_positions

        if (!alreadyOpen && !atMaxPositions) {
          const schwabQty = livePrice
            ? calculatePositionSize(schwabEquity, livePrice, schwabProfile.initial_stop_pct, schwabProfile.risk_pct, 0.25).qty
            : 1
          const schwabOrder = await Schwab.placeOrder(signal.symbol, schwabQty, 'BUY', 'MARKET')

          if (schwabOrder.status === 'PLACED') {
            const schwabStop = stopPrice ?? (livePrice ? Math.round(livePrice * (1 - schwabProfile.initial_stop_pct) * 100) / 100 : null)
            await db.from('tb_trades').insert({
              symbol: signal.symbol, broker: 'schwab', action: 'BUY',
              quantity: schwabQty, entry_price: livePrice ?? 0,
              stop_loss: schwabStop ?? 0,
              target_price: signal.target ?? null, confidence: signal.confidence,
              status: 'OPEN', order_id: schwabOrder.order_id ?? null,
              reason: 'TG: SF Essential Trades (live)',
            })
            schwabNote = `\n💰 *Schwab LIVE: BUY ${schwabQty} ${signal.symbol}* · $${((livePrice ?? 0) * schwabQty).toFixed(0)}`
          }
        } else {
          schwabNote = alreadyOpen ? `\n📌 Schwab: already holding ${signal.symbol}` : `\n📌 Schwab: at max ${schwabProfile.max_positions} positions`
        }
      } catch { /* Schwab failures never block paper trade */ }
    }

    const emoji = order.status === 'PLACED' ? '✅' : '❌'
    await tgSend(`*${emoji} SF Trades → ${signal.action} ${qty} ${signal.symbol}*\nEntry: Market${stopPrice ? `\nSL: $${stopPrice}` : ''}\nConf: ${signal.confidence}%\nPaper: ${order.status}${afterHoursTag}${schwabNote}`)

    return { id: msg.id, type: 'trade', signal, order }
  }))

  return NextResponse.json({ ok: true, processed: newMsgs.length, results })
}
