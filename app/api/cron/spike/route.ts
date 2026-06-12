/**
 * CRON: /api/cron/spike — lightweight 5-minute momentum spike detector.
 *
 * Runs every 5 min during market hours. No AI, no OHLCV — just a single
 * Yahoo Finance batch quote call. Fires a Telegram alert the instant a
 * stock is moving at 2×+ its expected volume pace AND price is up ≥4%.
 *
 * Why this exists: the full scan cron runs every 10 min (was 20) and calls
 * Claude + OpenAI which takes ~10–15s. By the time it fires, a momentum
 * move like ROKU +20% is already well underway. This cron costs ~$0/run
 * and catches the move within 5 minutes of open.
 *
 * Deduplication: alerts once per symbol per calendar day via tb_settings.
 * The full scan cron handles the actual trade — this just gives early warning.
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { ALL_ALPACA_SYMBOLS, ALL_SYMBOLS } from '@/lib/market-data'

export const runtime  = 'nodejs'
export const maxDuration = 30

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function isMarketOpen() {
  const now = new Date()
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = now.getUTCHours() + now.getUTCMinutes() / 60
  return h >= 13.5 && h < 20.0  // 9:30–4:00 ET (EDT)
}

// Time-normalized volume pace — same formula as the momentum scanner
function sessionFraction() {
  const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  if (h < 13.5) return 0
  if (h > 20.0) return 1
  return Math.max(0.15, (h - 13.5) / 6.5)
}

interface Quote { symbol: string; changePct: number; volume: number; avgVolume: number; price: number }

async function batchQuotes(symbols: string[]): Promise<Quote[]> {
  const BATCH = 50
  const results: Quote[] = []
  for (let i = 0; i < symbols.length; i += BATCH) {
    try {
      const slice = symbols.slice(i, i + BATCH)
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${slice.join(',')}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume3Month,regularMarketChangePercent`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      if (!res.ok) continue
      const data = await res.json()
      for (const q of data.quoteResponse?.result ?? []) {
        results.push({
          symbol:    q.symbol,
          changePct: q.regularMarketChangePercent || 0,
          volume:    q.regularMarketVolume        || 0,
          avgVolume: q.averageDailyVolume3Month   || 1,
          price:     q.regularMarketPrice         || 0,
        })
      }
    } catch { /* skip batch */ }
  }
  return results
}

async function sendTelegram(text: string) {
  const bot = process.env.TELEGRAM_BOT_TOKEN
  const cid = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!bot || !cid) return
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cid, text, parse_mode: 'Markdown' }),
  }).catch(() => {})
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen())  return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const sf      = sessionFraction()
  const today   = new Date().toISOString().slice(0, 10)
  const db      = createServiceClient()

  // Deduplicate all watchlist symbols across both brokers
  const allSyms = Array.from(new Set([...ALL_SYMBOLS, ...ALL_ALPACA_SYMBOLS]))

  const quotes  = await batchQuotes(allSyms)

  // Thresholds: significant move + high volume pace
  const SPIKE_CHANGE = 4.0   // ≥4% move
  const SPIKE_PACE   = 2.0   // ≥2× expected volume pace for this time of day
  const BIG_CHANGE   = 8.0   // ≥8% = "explosive" — gets priority alert

  const spikes = quotes
    .filter((q) => {
      if (q.changePct < SPIKE_CHANGE) return false
      if (q.price <= 0) return false
      const pace = q.avgVolume > 0 ? q.volume / (q.avgVolume * sf) : 0
      return pace >= SPIKE_PACE
    })
    .sort((a, b) => b.changePct - a.changePct)

  if (spikes.length === 0) {
    return NextResponse.json({ status: 'ok', spikes: 0, scanned: allSyms.length })
  }

  // Alert each spike once per day
  const alerted: string[] = []
  for (const s of spikes.slice(0, 5)) {
    const key = `spike_alert_${s.symbol}_${today}`
    const { data: existing } = await db.from('tb_settings').select('value').eq('key', key).single()
    if (existing) continue  // already alerted today

    const pace  = s.avgVolume > 0 ? s.volume / (s.avgVolume * sf) : 0
    const emoji = s.changePct >= BIG_CHANGE ? '🚨' : '⚡'
    const msg   = `${emoji} *Spike: ${s.symbol}*\n+${s.changePct.toFixed(1)}% @ $${s.price.toFixed(2)}\nVolume pace: ${pace.toFixed(1)}× expected\n_Next AI scan will evaluate for trade_`

    await Promise.all([
      sendTelegram(msg),
      db.from('tb_alerts').insert({ type: 'INFO', symbol: s.symbol, message: `${emoji} Spike: ${s.symbol} +${s.changePct.toFixed(1)}% on ${pace.toFixed(1)}x vol pace` }),
      db.from('tb_settings').upsert({ key, value: new Date().toISOString() }),
    ])

    alerted.push(s.symbol)
  }

  return NextResponse.json({ status: 'ok', scanned: allSyms.length, spikes: spikes.length, alerted })
}
