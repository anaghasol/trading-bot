/**
 * CRON: /api/cron/discovery-trade — Autonomous LT sleeve entry.
 * Runs 9:45 AM ET weekdays (45 13 * * 1-5) after open volatility settles.
 *
 * Takes top Stage 1 SNDK-screener candidates and auto-buys for the long-term
 * growth sleeve. Uses trend hold mode: 8% trail (tightens to 4% at +30%),
 * partial exits at +20%/+40%, no calendar cap — hold weeks not days.
 *
 * Alpaca paper: top 3 slots, score ≥ 40, 2% risk/trade, 10% initial stop
 * Schwab live:  top 2 slots, score ≥ 55, 1.5% risk/trade, 8% initial stop
 */
import { NextResponse } from 'next/server'
import * as AlpacaBroker from '@/lib/alpaca'
import * as SchwabBroker from '@/lib/schwab'
import { createServiceClient } from '@/lib/supabase-server'
import { isMarketOpen } from '@/lib/risk'

export const runtime     = 'nodejs'
export const maxDuration = 120

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

interface DiscoveryRow {
  symbol:        string
  sndk_score:    number
  stage:         number
  sector:        string
  current_price: number
  highlights:    string
}

async function runLTSleeve(
  broker: 'alpaca_paper' | 'schwab',
  db: ReturnType<typeof createServiceClient>,
): Promise<{ bought: string[]; skipped: string[]; message: string }> {
  const isPaper = broker === 'alpaca_paper'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api     = isPaper ? (AlpacaBroker as any) : (SchwabBroker as any)

  const minScore = isPaper ? 40 : 55
  const maxSlots = isPaper ? 3  : 2
  const riskPct  = isPaper ? 0.02  : 0.015
  const stopPct  = isPaper ? 0.10  : 0.08

  // Top Stage 1 candidates from most recent screener run
  const { data: candidates } = await db
    .from('tb_discoveries')
    .select('symbol, sndk_score, stage, sector, current_price, highlights')
    .eq('stage', 1)
    .gte('sndk_score', minScore)
    .order('sndk_score', { ascending: false })
    .limit(10) as { data: DiscoveryRow[] | null }

  if (!candidates || candidates.length === 0) {
    return { bought: [], skipped: [], message: `[${broker}] No Stage 1 candidates (score ≥ ${minScore})` }
  }

  const [positions, equity] = await Promise.all([
    api.getPositions() as Promise<{ symbol: string }[]>,
    api.getAccountBalance() as Promise<number | null>,
  ])
  const heldSymbols  = new Set(positions.map((p: { symbol: string }) => p.symbol))
  const accountEquity = equity ?? (isPaper ? 100000 : 2000)

  // Count existing open LT positions to enforce sleeve cap
  const { data: ltOpen } = await db
    .from('tb_trades')
    .select('symbol')
    .eq('status', 'OPEN')
    .eq('strategy', 'DISCOVERY_LT')
    .or(`broker.eq.${broker},broker.is.null`)
  const ltHeld = new Set((ltOpen ?? []).map((t: { symbol: string }) => t.symbol))
  const openSlots = maxSlots - ltHeld.size

  if (openSlots <= 0) {
    return { bought: [], skipped: [], message: `[${broker}] LT sleeve full (${ltHeld.size}/${maxSlots})` }
  }

  const bought:  string[] = []
  const skipped: string[] = []

  for (const c of candidates) {
    if (bought.length >= openSlots) break
    if (heldSymbols.has(c.symbol) || ltHeld.has(c.symbol)) {
      skipped.push(`${c.symbol}(held)`)
      continue
    }

    // Live price
    const quote = await (api.getQuote(c.symbol) as Promise<{ price: number } | null>).catch(() => null)
    const price = quote?.price ?? c.current_price
    if (!price || price <= 0) { skipped.push(`${c.symbol}(no price)`); continue }

    // Size: risk$ / stop$ per share
    const riskDollars  = accountEquity * riskPct
    const stopPerShare = price * stopPct
    const qty = Math.floor(riskDollars / stopPerShare)
    if (qty < 1) { skipped.push(`${c.symbol}(qty<1 price=$${price.toFixed(0)})`); continue }

    const order = await (api.placeOrder(c.symbol, qty, 'BUY', 'MARKET') as Promise<{ status: string; order_id?: string }>)
      .catch(() => null)
    if (!order || order.status === 'FAILED') {
      skipped.push(`${c.symbol}(order failed)`)
      continue
    }

    const stopPrice = price * (1 - stopPct)
    const highlights = (() => { try { return JSON.parse(c.highlights) as string[] } catch { return [] } })()
    const topHighlight = highlights[0] ?? ''

    await db.from('tb_trades').insert({
      symbol:      c.symbol,
      action:      'BUY',
      quantity:    qty,
      entry_price: price,
      status:      'OPEN',
      broker,
      strategy:    'DISCOVERY_LT',
      reason:      `hold_mode=trend stop=$${stopPrice.toFixed(2)} | Stage1 score=${c.sndk_score} | ${c.sector} | ${topHighlight}`,
      order_id:    order.order_id ?? null,
    })

    await db.from('tb_alerts').insert({
      type:    'BUY',
      symbol:  c.symbol,
      message: `🔭 DISCOVERY BUY ${qty} ${c.symbol} @ $${price.toFixed(2)} | Stage1 score=${c.sndk_score} | stop $${stopPrice.toFixed(2)} | ${c.sector}`,
      pnl:     0,
    })

    const BOT = process.env.TELEGRAM_BOT_TOKEN
    const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
    if (BOT && GID) {
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    GID,
          text: [
            `🔭 *DISCOVERY BUY — LT Sleeve [${broker}]*`,
            `*${c.symbol}* ${qty} shares @ $${price.toFixed(2)}`,
            `Score: ${c.sndk_score}/100 | Stage 1 | ${c.sector.replace(/_/g, ' ')}`,
            `Stop: $${stopPrice.toFixed(2)} (${(stopPct * 100).toFixed(0)}%) | trend hold`,
            topHighlight ? `_${topHighlight}_` : '',
          ].filter(Boolean).join('\n'),
          parse_mode: 'Markdown',
        }),
      }).catch(() => {})
    }

    bought.push(`${c.symbol}(${qty}sh@$${price.toFixed(0)})`)
    ltHeld.add(c.symbol)
  }

  return {
    bought,
    skipped,
    message: `[${broker}] LT: bought=${bought.join(',')||'none'} skipped=${skipped.join(',')||'none'}`,
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ ok: true, message: 'Market closed — skipping' })

  const db    = createServiceClient()
  const start = Date.now()

  const [paper, live] = await Promise.all([
    runLTSleeve('alpaca_paper', db),
    runLTSleeve('schwab', db),
  ])

  const totalBought = paper.bought.length + live.bought.length

  try {
    await db.from('tb_cron_log').insert({
      job:         'discovery_trade',
      status:      'success',
      trades_made: totalBought,
      message:     `${paper.message} | ${live.message}`,
      duration_ms: Date.now() - start,
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true, paper, live, total_bought: totalBought, duration_ms: Date.now() - start })
}
