/**
 * Polls multiple Telegram channels for new messages and fires them
 * through the signal parser → Alpaca Paper + Schwab Live execution.
 * Called by Vercel cron every minute, 24/7 — signals logged for learning any time.
 *
 * Channels:
 *  - SF Essential Trades (-1002381909837): LEARN ONLY — muted, no trade execution
 *  - US Equities (@OptionT1):              ACTIVE — full trade execution
 */

export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession, saveSession } from '@/lib/telegram-client'
import { parseSignal, isWorthClassifying, isOptionsSignal, isOCCSymbol } from '@/lib/telegram-signal'
import { addIntention, parseZonePrices } from '@/lib/tg-intentions'
import * as Alpaca from '@/lib/alpaca'
import { placeStopOrder, getAccountBalance } from '@/lib/alpaca'
import * as Schwab from '@/lib/schwab'
import { createServiceClient } from '@/lib/supabase-server'
import { calculatePositionSize, exposureCapForConfidence } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'

const API_ID    = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH  = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const GROUP_ID  = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')

interface ChannelCfg {
  id: number | string   // numeric ID or '@username'
  name: string
  watermarkKey: string  // key in tb_settings for last-seen message ID
  source: string        // written to tb_learning.source
  tradeEnabled: boolean // false = learn/log only, no order execution
}

// Index symbols → tradeable ETF equivalents (indices can't be ordered on Alpaca)
const INDEX_MAP: Record<string, string> = {
  RUT: 'IWM', RTY: 'IWM',   // Russell 2000
  SPX: 'SPY', ES: 'SPY',    // S&P 500
  NDX: 'QQQ', NQ: 'QQQ',   // Nasdaq 100
  DJI: 'DIA', YM: 'DIA',   // Dow Jones
  VIX: 'UVXY',              // Volatility (closest tradeable proxy)
}

function resolveSymbol(sym: string): string {
  return INDEX_MAP[sym.toUpperCase()] ?? sym.toUpperCase()
}

const CHANNELS: ChannelCfg[] = [
  {
    id:           parseInt(process.env.TELEGRAM_CHANNEL_ID ?? '-1002381909837'),
    name:         'SF Essential Trades',
    watermarkKey: 'tg_last_msg_id',
    source:       'sf_essential_trades',
    tradeEnabled: false,  // muted — removed subscription, keep for macro/learn context only
  },
  {
    id:           '@OptionT1',
    name:         'US Equities',
    watermarkKey: 'tg_last_msg_id_us_equities',
    source:       'us_equities',
    tradeEnabled: true,
  },
]

async function tgSend(text: string) {
  if (!GROUP_ID) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, text, parse_mode: 'Markdown' }),
  })
}

export async function GET(req: Request) {
  const db = createServiceClient()

  // Heartbeat first — confirms Vercel is calling this endpoint regardless of auth outcome.
  // This lets the dashboard distinguish "cron down" from "cron running but TG session issue".
  await db.from('tb_settings').upsert({ key: 'tg_cron_ping', value: new Date().toISOString() }).then(() => {}, () => {})

  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionStr = await getStoredSession()
  if (!sessionStr) {
    await db.from('tb_settings').upsert({ key: 'tg_status', value: 'no_session' })
    return NextResponse.json({ error: 'Not authenticated. Visit /api/telegram/auth first.' })
  }

  let client: TelegramClient | null = null
  try {
    client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3, useWSS: true })
    await client.connect()
  } catch (e) {
    await db.from('tb_settings').upsert({ key: 'tg_status', value: `error: ${String(e).slice(0, 100)}` })
    return NextResponse.json({ ok: false, error: 'TG connect failed', detail: String(e) })
  }

  try {
    await saveSession(client.session.save() as unknown as string)
  } catch { /* non-fatal */ }

  await db.from('tb_settings').upsert({ key: 'tg_last_poll', value: new Date().toISOString() })
  await db.from('tb_settings').upsert({ key: 'tg_status', value: 'ok' })

  // Duplicate-run lock — one lock covers the whole tick across all channels
  const lockKey = `tg_poll_lock_${Date.now()}`
  await db.from('tb_settings').upsert({ key: 'tg_poll_lock', value: lockKey })
  const { data: lockCheck } = await db.from('tb_settings').select('value').eq('key', 'tg_poll_lock').single()
  if (lockCheck?.value !== lockKey) {
    await client.disconnect().catch(() => {})
    return NextResponse.json({ ok: true, skipped: 'concurrent poll detected' })
  }

  const profile      = PROFILES.alpaca_paper
  const schwabProfile = PROFILES.schwab
  const equity       = (await getAccountBalance()) ?? 100_000

  const allResults: Record<string, unknown>[] = []

  for (const ch of CHANNELS) {
    // Load watermark for this channel
    const { data: lastData } = await db.from('tb_settings').select('value').eq('key', ch.watermarkKey).single()
    const lastId = parseInt(lastData?.value ?? '0')

    let messages: Awaited<ReturnType<typeof client.getMessages>>
    try {
      messages = await client.getMessages(ch.id, { limit: 10 })
    } catch (e) {
      allResults.push({ channel: ch.name, error: `getMessages failed: ${String(e).slice(0, 80)}` })
      continue
    }

    const newMsgs = messages
      .filter((m) => m.id > lastId && m.text?.length > 5)
      .sort((a, b) => b.id - a.id)
      .slice(0, 5)

    if (newMsgs.length === 0) {
      allResults.push({ channel: ch.name, checked: messages.length, new: 0 })
      continue
    }

    const maxId = Math.max(...newMsgs.map((m) => m.id))
    await db.from('tb_settings').upsert({ key: ch.watermarkKey, value: String(maxId) })

    const chResults = await Promise.all(newMsgs.map(async (msg) => {
      const text = msg.text ?? ''
      if (!isWorthClassifying(text)) return { id: msg.id, type: 'ignore' }

      // Options signals are never stock trades — fast-path to learn without AI call
      if (isOptionsSignal(text)) {
        await db.from('tb_alerts').insert({ type: 'INFO', symbol: null, message: `📊 ${ch.name} [options]: ${text.slice(0, 120)}` })
        return { id: msg.id, type: 'options_learn' }
      }

      const signal = await parseSignal(text, ch.name)
      if (signal.type === 'ignore') return { id: msg.id, type: 'ignore' }

      // Resolve index symbols → ETF only for TRADE and EXIT signals (not learn — index context is fine)
      if ((signal.type === 'trade' || signal.type === 'exit') && 'symbol' in signal && signal.symbol) {
        const resolved = resolveSymbol(signal.symbol)
        if (resolved !== signal.symbol) {
          console.log(`[tg-poll] ${ch.name}: mapped ${signal.symbol} → ${resolved}`)
          ;(signal as unknown as Record<string, unknown>).symbol = resolved
        }
      }

      // ── EXIT ──────────────────────────────────────────────────────────────────
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
          await tgSend(`🚨 *${ch.name} Exit: ${signal.symbol}*\n${signal.summary}\nStatus: ${sellOrder.status} · ${broker}`)
          return { id: msg.id, type: 'exit', symbol: signal.symbol }
        }

        await tgSend(`📌 *${signal.symbol} exit signal* (not held) — ${ch.name}`)
        return { id: msg.id, type: 'exit_not_held', symbol: signal.symbol }
      }

      // ── LEARN ─────────────────────────────────────────────────────────────────
      if (signal.type === 'learn') {
        const learnMsg = `📚 ${ch.name} [${signal.sentiment}${signal.sector ? ' · ' + signal.sector : ''}]: ${signal.summary}${signal.symbols.length ? ` [${signal.symbols.join(', ')}]` : ''}`
        await db.from('tb_alerts').insert({ type: 'INFO', symbol: signal.symbols[0] ?? null, message: learnMsg })

        const isMacroSignal = signal.symbols.length === 0
        // Only update macro stance when the signal actually discusses market/index direction.
        // Personal account updates, options P/L summaries, and "X trades closed" messages
        // have no directional info and should never flip the scanner's macro gate.
        const hasMacroKeyword = /\b(SPX|SPY|QQQ|IWM|RUT|NDX|DJI|market|indices|index|gap.?down|gap.?up|broad.?market|macro|regime|risk.?off|risk.?on|sell.?off|rally|correction)\b/i.test(signal.summary)
        if (isMacroSignal) {
          await db.from('tb_learning').insert({
            symbol: null, source: ch.source, sentiment: signal.sentiment,
            sector: signal.sector ?? null, insight: signal.summary, created_at: new Date().toISOString(),
          })
          if (hasMacroKeyword) {
            if (signal.sentiment === 'bearish') {
              await db.from('tb_settings').upsert({ key: 'tg_macro_stance', value: JSON.stringify({ stance: 'bearish', set_at: new Date().toISOString(), insight: signal.summary }) })
              await tgSend(`🛑 *Macro bearish stance saved* (${ch.name}) — AI scanner will pause new entries for 18h\n${signal.summary}`)
            } else if (signal.sentiment === 'bullish') {
              await db.from('tb_settings').upsert({ key: 'tg_macro_stance', value: JSON.stringify({ stance: 'bullish', set_at: new Date().toISOString(), insight: signal.summary }) })
            }
          }
        } else {
          for (const sym of signal.symbols) {
            await db.from('tb_learning').insert({
              symbol: sym, source: ch.source, sentiment: signal.sentiment,
              sector: signal.sector, insight: signal.summary + (signal.watch_zone ? ` Watch zone: ${signal.watch_zone}` : ''),
              created_at: new Date().toISOString(),
            })

            if (signal.sentiment === 'bullish' || signal.sentiment === 'neutral') {
              const priceZone = signal.watch_zone ? parseZonePrices(signal.watch_zone) : null
              const isHoldSignal = /hold|don'?t.exit|remain.bullish|stay.in|keep/i.test(signal.summary)
              if (isHoldSignal) {
                await addIntention({ symbol: sym, type: 'hold_position', urgency: 'high', price_zone: null, context: signal.summary.slice(0, 120), expires_hours: 24 })
              } else if (priceZone) {
                await addIntention({ symbol: sym, type: 'buy_zone', urgency: 'medium', price_zone: priceZone, context: signal.summary.slice(0, 120), expires_hours: 72 })
              } else if (signal.actionable) {
                await addIntention({ symbol: sym, type: 'watch_only', urgency: 'low', price_zone: null, context: signal.summary.slice(0, 120), expires_hours: 48 })
              }
            } else if (signal.sentiment === 'bearish') {
              await addIntention({ symbol: sym, type: 'avoid', urgency: 'high', price_zone: null, context: signal.summary.slice(0, 120), expires_hours: 48 })
            }
          }
        }

        const sentimentTag = signal.sentiment === 'bearish' ? '🔴' : signal.sentiment === 'bullish' ? '🟢' : '⚪'
        const watchTag = signal.watch_zone ? `\n👁 Watch zone: ${signal.watch_zone}` : ''
        const mutedTag = !ch.tradeEnabled ? ' _(muted)_' : ''
        await tgSend(`📚 *${ch.name} insight*${mutedTag} ${sentimentTag}\n${signal.summary}${signal.symbols.length ? `\nTickers: ${signal.symbols.join(', ')}` : ''}${watchTag}`)

        // Only trigger AI scanner for active (non-muted) channels
        if (ch.tradeEnabled) {
          const DEFENSIVE_PATTERN = /book.*(gain|profit|partial)|hold.*(cash|off)|precaution|step\s*back|minor\s*pull|small\s*account|reduce|trim|caution|wait\s*for|not.*buy/i
          const isDefensive = DEFENSIVE_PATTERN.test(signal.summary)
          let macroIsBearish = false
          try {
            const { data: macroRow } = await db.from('tb_settings').select('value').eq('key', 'tg_macro_stance').single()
            if (macroRow?.value) {
              const macro = JSON.parse(macroRow.value) as { stance: string; set_at: string }
              macroIsBearish = macro.stance === 'bearish' && (Date.now() - new Date(macro.set_at).getTime()) < 18 * 3600000
            }
          } catch { /* non-fatal */ }

          const isDipSignal = signal.actionable && signal.sentiment === 'bullish' && isMacroSignal && !isDefensive && !macroIsBearish
          if (isDipSignal) {
            const appUrl = process.env.VERCEL_APP_URL ?? 'https://trading-bot-hazel-one.vercel.app'
            fetch(`${appUrl}/api/engine?secret=${process.env.CRON_SECRET}&source=tg_dip_signal`, { method: 'POST' }).catch(() => {})
            await tgSend(`🔍 *Dip signal (${ch.name}) — triggering AI scanner now*\nLooking for buy setups across watchlist...`)
          } else if (signal.actionable && signal.sentiment === 'bullish' && isMacroSignal && (isDefensive || macroIsBearish)) {
            await tgSend(`📌 *Bullish but cautious* (${ch.name}) — scanner NOT triggered${macroIsBearish ? ' (macro bearish stance active)' : ' (defensive signal)'}`)
          }
        }

        return { id: msg.id, type: 'learn', summary: signal.summary }
      }

      // ── TRADE EXECUTION (active channels only) ────────────────────────────────
      if (!ch.tradeEnabled) {
        // Muted channel — log the signal but don't trade
        await db.from('tb_alerts').insert({ type: 'INFO', symbol: signal.symbol ?? null, message: `[MUTED] ${ch.name}: ${signal.action ?? ''} ${signal.symbol ?? ''} — not executed` })
        return { id: msg.id, type: 'muted', channel: ch.name }
      }

      // Guard 1: BUY — skip if we already hold this symbol
      if (signal.action === 'BUY') {
        const { data: existing } = await db.from('tb_trades')
          .select('id').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1)
        if (existing && existing.length > 0) {
          await tgSend(`⚠️ *Skipped ${signal.symbol}* — already have open position`)
          return { id: msg.id, type: 'skip', reason: 'already_open' }
        }
      }

      // Guard 2: SELL — only execute if we actually hold the position (never naked short)
      if (signal.action === 'SELL') {
        const { data: openTrade } = await db.from('tb_trades')
          .select('id, quantity').eq('symbol', signal.symbol).eq('status', 'OPEN').eq('broker', 'alpaca_paper').limit(1).single()
        if (!openTrade) {
          await tgSend(`📌 *Skipped SELL ${signal.symbol}* (${ch.name}) — not held, no short selling`)
          return { id: msg.id, type: 'skip', reason: 'not_held' }
        }
      }

      // Guard 3: block after market hours
      const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
      const afterHours = parseInt(etHour) >= 16 || parseInt(etHour) < 9
      const afterHoursTag = afterHours ? ' [FILLS AT OPEN]' : ''

      // ── Options single-leg: route through dedicated options handler ─────────────
      if (isOCCSymbol(signal.symbol)) {
        // OCC symbol → options trade. Place order, journal with raw_symbol for monitor.
        const m = signal.symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
        const displayLabel = m
          ? (() => { const [,und,yy,mm,dd,type,sr] = m; const strike = parseInt(sr)/1000; return `${und} $${strike%1===0?strike.toFixed(0):strike.toFixed(1)}${type} ${parseInt(mm)}/${parseInt(dd)}` })()
          : signal.symbol
        const expiry = m ? `20${m[2]}-${m[3]}-${m[4]}` : null
        const dteDays = expiry ? (new Date(expiry).getTime() - Date.now()) / 86400000 : 999

        if (dteDays < 3) {
          await tgSend(`⚠️ *Skipped options signal* — ${displayLabel} expires in <3 days, too risky`)
          return { id: msg.id, type: 'skip', reason: 'options_expiry_too_close' }
        }

        // Size by premium risk: risk 3% of equity on premium paid
        const premiumPerShare = signal.entry_price ?? 5  // fallback estimate
        const maxRiskDollars  = equity * 0.03
        const contracts       = Math.max(1, Math.floor(maxRiskDollars / (premiumPerShare * 100)))

        const order = await Alpaca.placeOrder(signal.symbol, contracts, signal.action, 'MARKET')

        await db.from('tb_alerts').insert({
          type: signal.action, symbol: signal.symbol,
          message: `${ch.name} → OPTIONS ${signal.action} ${contracts}x ${displayLabel} [conf:${signal.confidence}%]${afterHoursTag} — ${order.status}`,
        })

        if (order.status === 'PLACED' && signal.action === 'BUY') {
          await db.from('tb_trades').insert({
            symbol: displayLabel, broker: 'alpaca_paper', action: 'BUY',
            quantity: contracts, entry_price: premiumPerShare,
            status: 'OPEN', order_id: order.order_id ?? null,
            confidence: signal.confidence, strategy: 'OPTION',
            reason: `raw_symbol=${signal.symbol} | option_expiry=${expiry} | stop=50%prem | TG: ${ch.name}`,
          })
          await tgSend(`📈 *Options BUY* (${ch.name})\n${displayLabel} · ${contracts} contract${contracts > 1 ? 's' : ''} @ est $${premiumPerShare}/sh\nExpiry: ${expiry} · DTE: ${Math.floor(dteDays)}d\nStop: -50% premium | Target: +80%/+150%`)
        }
        return { id: msg.id, type: 'options_trade', symbol: displayLabel }
      }

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
        message: `${ch.name} → ${signal.action} ${qty} ${signal.symbol} mkt${stopPrice ? ` SL$${stopPrice}` : ''} [conf:${signal.confidence}%]${afterHoursTag} — ${order.status}`,
      })

      if (order.status === 'PLACED' && signal.action === 'BUY') {
        await db.from('tb_learning').insert({
          symbol: signal.symbol, source: ch.source, sentiment: 'bullish', sector: null,
          insight: `Advisor recommended BUY at market, SL $${stopPrice ?? 'N/A'}, confidence ${signal.confidence}%`,
          created_at: new Date().toISOString(),
        })

        if (stopPrice && !afterHours) {
          await placeStopOrder(signal.symbol, qty, stopPrice).catch(() => {})
        }

        await db.from('tb_trades').insert({
          symbol: signal.symbol, broker: 'alpaca_paper', action: 'BUY',
          quantity: qty, entry_price: livePrice ?? 0,
          stop_loss: stopPrice ?? 0,
          target_price: signal.target ?? null, confidence: signal.confidence,
          status: 'OPEN', order_id: order.order_id ?? null,
          reason: `TG: ${ch.name}`,
        })
      }

      // ── SCHWAB LIVE (parallel, active channels only) ──────────────────────────
      let schwabNote = ''
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
                reason: `TG: ${ch.name} (live)`,
              })
              schwabNote = `\n💰 *Schwab LIVE: BUY ${schwabQty} ${signal.symbol}* · $${((livePrice ?? 0) * schwabQty).toFixed(0)}`
            }
          } else {
            schwabNote = alreadyOpen ? `\n📌 Schwab: already holding ${signal.symbol}` : `\n📌 Schwab: at max ${schwabProfile.max_positions} positions`
          }
        } catch { /* Schwab failures never block paper trade */ }
      }

      const emoji = order.status === 'PLACED' ? '✅' : '❌'
      await tgSend(`*${emoji} ${ch.name} → ${signal.action} ${qty} ${signal.symbol}*\nEntry: Market${stopPrice ? `\nSL: $${stopPrice}` : ''}\nConf: ${signal.confidence}%\nPaper: ${order.status}${afterHoursTag}${schwabNote}`)

      return { id: msg.id, type: 'trade', signal, order }
    }))

    allResults.push({ channel: ch.name, processed: newMsgs.length, results: chResults })
  }

  await client.disconnect().catch(() => {})
  return NextResponse.json({ ok: true, channels: allResults })
}
