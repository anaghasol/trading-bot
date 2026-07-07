/**
 * CRON: /api/cron/wheel — Wheel Strategy (Cash-Secured Puts → Covered Calls)
 *
 * Three-phase cycle:
 *   Phase 1 (CSP): Sell OTM cash-secured puts on quality stocks → collect premium
 *   Phase 2 (STOCK): If put is closed ITM or assigned → simulate owning shares
 *   Phase 3 (CC): Sell covered calls on owned shares → collect more premium
 *
 * Guard rails:
 *   - Max 5 concurrent wheel positions
 *   - Max 15% of account per position (cash-secured)
 *   - Hard stop: close CSP if stock drops 9%+ below strike
 *   - Close CSP at 50% profit or ≤7 DTE
 *   - Close CC at 50% profit or ≤7 DTE
 *   - No earnings within 21 days
 *   - Only SPREAD_ELIGIBLE liquid underlyings
 *
 * Schedule: "30 15,18 * * 1-5"  (10:30 AM + 1:30 PM ET)
 * PAPER ONLY — never touches Schwab.
 */

export const runtime     = 'nodejs'
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { isMarketOpen } from '@/lib/risk'
import { getAccountBalance } from '@/lib/alpaca'
import { scanForEMAPullback } from '@/lib/market-data'
import {
  SPREAD_ELIGIBLE_LIST,
  getPutChain, getCallChain,
  buildCashSecuredPut, buildCoveredCall,
  executeSingleLegSell, closeOptionPosition,
  getOptionPositions, parseDTEFromOCC,
} from '@/lib/options'

const ALPACA_KEY    = process.env.ALPACA_KEY_ID    ?? ''
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? ''
const PAPER_BASE    = 'https://paper-api.alpaca.markets/v2'

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function hdr() {
  return { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
}

async function getLivePrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
      { headers: hdr(), signal: AbortSignal.timeout(4000) },
    )
    if (!res.ok) return null
    const d = await res.json() as { quote: { ap: number; bp: number } }
    return d.quote ? (d.quote.ap + d.quote.bp) / 2 : null
  } catch { return null }
}

async function getAlpacaEquityPositions(): Promise<Array<{
  symbol: string; qty: number; avg_entry_price: number; current_price: number; unrealized_pl: number
}>> {
  try {
    const res = await fetch(`${PAPER_BASE}/positions`, { headers: hdr() })
    if (!res.ok) return []
    const all = await res.json() as Array<{
      symbol: string; asset_class: string; qty: string
      avg_entry_price: string; current_price: string; unrealized_pl: string
    }>
    return all
      .filter((p) => p.asset_class === 'us_equity')
      .map((p) => ({
        symbol:          p.symbol,
        qty:             parseFloat(p.qty),
        avg_entry_price: parseFloat(p.avg_entry_price),
        current_price:   parseFloat(p.current_price),
        unrealized_pl:   parseFloat(p.unrealized_pl),
      }))
  } catch { return [] }
}

async function tgAlert(msg: string) {
  const bot  = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!bot || !chat) return
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'Markdown' }),
  }).catch(() => {})
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db      = createServiceClient()
  const actions: string[] = []
  let   newCSPs = 0, closedCSPs = 0, newCCs = 0, closedCCs = 0

  const [equity, allOptionPositions, allEquityPositions] = await Promise.all([
    getAccountBalance(),
    getOptionPositions(),
    getAlpacaEquityPositions(),
  ])
  const accountEquity = equity ?? 100_000

  // Load all OPEN wheel positions from Supabase
  const { data: wheelRows } = await db
    .from('tb_trades')
    .select('*')
    .eq('broker', 'alpaca_paper')
    .eq('status', 'OPEN')
    .in('strategy', ['WHEEL_CSP', 'WHEEL_CC', 'WHEEL_STOCK'])

  const wheelTrades = (wheelRows ?? []) as Array<{
    id: string; symbol: string; strategy: string; entry_price: number
    quantity: number; reason: string; created_at: string; confidence: number
  }>

  // Build a map of current Alpaca option positions by OCC symbol
  const optPosMap = new Map(allOptionPositions.map((p) => [p.symbol, p]))

  // ── Phase A: Monitor open CSP positions ─────────────────────────────────────
  const openCSPs = wheelTrades.filter((t) => t.strategy === 'WHEEL_CSP')

  for (const trade of openCSPs) {
    // Extract OCC symbol from reason field: "WHEEL_CSP | OCC=NVDA260815P00130000 | ..."
    const occMatch = trade.reason.match(/OCC=([A-Z0-9]+)/)
    if (!occMatch) continue
    const occ = occMatch[1]
    const pos = optPosMap.get(occ)

    if (!pos) {
      // Position no longer in Alpaca — expired or was closed externally
      const dte = parseDTEFromOCC(occ)
      const note = dte <= 0 ? 'expired' : 'closed_externally'
      await db.from('tb_trades').update({
        status: 'CLOSED', closed_at: new Date().toISOString(), pnl: 0, pnl_pct: 0,
        reason: trade.reason + ` | ${note}`,
      }).eq('id', trade.id)
      actions.push(`CSP ${trade.symbol} ${occ}: ${note} — position gone from Alpaca`)
      closedCSPs++
      continue
    }

    const plPct = pos.unrealized_plpc * 100  // negative = we owe (short position)
    const dte   = parseDTEFromOCC(occ)
    const strike = trade.entry_price

    // Get current underlying price to check hard stop
    const livePrice = await getLivePrice(trade.symbol)
    const hardStop  = livePrice != null && livePrice < strike * 0.91  // 9% below strike

    const takeProfit = plPct <= -50  // SHORT position: profit when plPct is negative (value dropped)
    const nearExpiry = dte <= 7
    const premiumLoss = plPct >= 100  // lost 100% of premium received — bail

    if (takeProfit || nearExpiry || hardStop || premiumLoss) {
      const reason = takeProfit ? `50% profit (${(-plPct).toFixed(0)}%)` :
                     nearExpiry ? `≤7 DTE (${dte}d left)` :
                     hardStop   ? `HARD STOP: ${trade.symbol} @ $${livePrice?.toFixed(2)} vs strike $${strike}` :
                                  `100% premium loss (stop)`
      const closed = await closeOptionPosition(occ, Math.abs(pos.qty), 'buy')  // buy back short put
      if (closed) {
        const pnl = pos.unrealized_pl  // will be positive if we bought at lower price than sold
        await db.from('tb_trades').update({
          status: 'CLOSED', closed_at: new Date().toISOString(),
          pnl, pnl_pct: plPct, reason: trade.reason + ` | CLOSED: ${reason}`,
        }).eq('id', trade.id)

        // If hard stop triggered — simulate assignment (buy stock, start CC phase)
        if (hardStop && livePrice) {
          const sharesToBuy = Math.abs(pos.qty) * 100
          const buyBody = {
            symbol: trade.symbol, qty: String(sharesToBuy),
            side: 'buy', type: 'market', time_in_force: 'day',
          }
          const buyRes = await fetch(`${PAPER_BASE}/orders`, {
            method: 'POST',
            headers: { ...hdr(), 'Content-Type': 'application/json' },
            body: JSON.stringify(buyBody),
          })
          if (buyRes.ok) {
            await db.from('tb_trades').insert({
              symbol: trade.symbol, broker: 'alpaca_paper', action: 'BUY',
              strategy: 'WHEEL_STOCK', status: 'OPEN',
              entry_price: livePrice, quantity: sharesToBuy,
              confidence: 70,
              reason: `WHEEL_STOCK | assigned from CSP | strike=$${strike} | current=$${livePrice.toFixed(2)}`,
            })
            actions.push(`WHEEL ASSIGN SIMULATED: bought ${sharesToBuy} ${trade.symbol} @ $${livePrice.toFixed(2)} after hard stop`)
            await tgAlert(`🔄 *Wheel Assignment*: ${trade.symbol} hard stop triggered. Bought ${sharesToBuy} shares @ $${livePrice.toFixed(2)}. Starting CC phase.`)
          }
        }

        actions.push(`CSP CLOSED ${trade.symbol}: ${reason} | P/L $${pnl.toFixed(2)}`)
        if (takeProfit || (!hardStop && pnl > 0)) {
          await tgAlert(`✅ *Wheel CSP Win*: ${trade.symbol} ${occ} closed +${(-plPct).toFixed(0)}% | $${pnl.toFixed(2)} profit`)
        }
        closedCSPs++
      }
    } else {
      actions.push(`CSP HOLD ${trade.symbol}: ${dte}d DTE | P/L ${(-plPct).toFixed(0)}% (short)`)
    }
  }

  // ── Phase B: Monitor open CC positions ──────────────────────────────────────
  const openCCs = wheelTrades.filter((t) => t.strategy === 'WHEEL_CC')

  for (const trade of openCCs) {
    const occMatch = trade.reason.match(/OCC=([A-Z0-9]+)/)
    if (!occMatch) continue
    const occ = occMatch[1]
    const pos = optPosMap.get(occ)

    if (!pos) {
      // CC gone — expired (stock not called away) or closed
      await db.from('tb_trades').update({
        status: 'CLOSED', closed_at: new Date().toISOString(), pnl: 0, pnl_pct: 0,
        reason: trade.reason + ' | expired/closed',
      }).eq('id', trade.id)
      actions.push(`CC ${trade.symbol} ${occ}: expired/closed`)
      closedCCs++
      continue
    }

    const plPct  = pos.unrealized_plpc * 100
    const dte    = parseDTEFromOCC(occ)
    const takeProfit = plPct <= -50  // sold CC, profit when value drops
    const nearExpiry = dte <= 7

    if (takeProfit || nearExpiry) {
      const reason = takeProfit ? `50% profit CC (${(-plPct).toFixed(0)}%)` : `≤7 DTE (${dte}d)`
      const closed = await closeOptionPosition(occ, Math.abs(pos.qty), 'buy')
      if (closed) {
        await db.from('tb_trades').update({
          status: 'CLOSED', closed_at: new Date().toISOString(),
          pnl: pos.unrealized_pl, pnl_pct: plPct,
          reason: trade.reason + ` | CLOSED: ${reason}`,
        }).eq('id', trade.id)
        actions.push(`CC CLOSED ${trade.symbol}: ${reason} | $${pos.unrealized_pl.toFixed(2)}`)
        closedCCs++
      }
    } else {
      actions.push(`CC HOLD ${trade.symbol}: ${dte}d DTE | P/L ${(-plPct).toFixed(0)}%`)
    }
  }

  // ── Phase C: Open Covered Calls on WHEEL_STOCK positions ────────────────────
  const stockPositions = wheelTrades.filter((t) => t.strategy === 'WHEEL_STOCK')
  const symbolsWithCC  = new Set(openCCs.map((t) => t.symbol))

  for (const stock of stockPositions) {
    if (symbolsWithCC.has(stock.symbol)) continue  // already has a CC

    // Verify we still hold the equity in Alpaca
    const eqPos = allEquityPositions.find((p) => p.symbol === stock.symbol)
    if (!eqPos || eqPos.qty < 100) continue

    const livePrice = eqPos.current_price
    const chain     = await getCallChain(stock.symbol, livePrice)
    const cc        = buildCoveredCall(stock.symbol, livePrice, chain, eqPos.qty)
    if (!cc) {
      actions.push(`CC SKIP ${stock.symbol}: no viable call found`)
      continue
    }

    const result = await executeSingleLegSell(cc.contract.symbol, cc.contracts, cc.premium)
    if (result.ok) {
      newCCs++
      const desc = `${cc.underlying} CC $${cc.strike} exp ${cc.expiration} (${cc.dte}d) | premium $${cc.premium.toFixed(2)}/sh | ${(cc.premium_pct * 100).toFixed(1)}%`
      await db.from('tb_trades').insert({
        symbol: stock.symbol, broker: 'alpaca_paper', action: 'SELL',
        strategy: 'WHEEL_CC', status: 'OPEN',
        entry_price: cc.strike, quantity: cc.contracts * 100,
        confidence: 75,
        reason: `WHEEL_CC | OCC=${cc.contract.symbol} | ${desc}`,
      })
      actions.push(`CC OPENED ${stock.symbol}: ${desc}`)
      await tgAlert(`📞 *Wheel CC*: Sold ${cc.contracts}x ${cc.underlying} $${cc.strike} call exp ${cc.expiration} | $${(cc.premium * 100 * cc.contracts).toFixed(0)} premium`)
    } else {
      actions.push(`CC FAILED ${stock.symbol}: ${result.error}`)
    }
  }

  // ── Phase D: New CSP entries ─────────────────────────────────────────────────
  const MAX_WHEEL = 5
  const totalOpenWheel = openCSPs.length + stockPositions.length + openCCs.length
  const slotsLeft = MAX_WHEEL - totalOpenWheel

  if (slotsLeft <= 0) {
    actions.push(`WHEEL FULL: ${totalOpenWheel}/${MAX_WHEEL} positions active — no new CSPs`)
    await logAndReturn(db, actions, newCSPs, closedCSPs, newCCs, closedCCs)
    return NextResponse.json({ status: 'ok', actions, newCSPs, closedCSPs, newCCs, closedCCs })
  }

  // Scan for quality candidates
  const setups = await scanForEMAPullback(SPREAD_ELIGIBLE_LIST, { loose: true })
  const existingSymbols = new Set([
    ...openCSPs.map((t) => t.symbol),
    ...stockPositions.map((t) => t.symbol),
    ...allEquityPositions.map((p) => p.symbol),
  ])

  const candidates = setups
    .filter((s) =>
      s.pullback_score >= 5 &&
      s.rsi >= 45 &&
      s.change_5d >= -2 &&   // not in hard downtrend
      !s.earnings_soon &&
      s.price > 15 &&
      !existingSymbols.has(s.symbol),
    )
    .sort((a, b) => b.pullback_score - a.pullback_score)
    .slice(0, 8)

  actions.push(`CSP candidates: ${candidates.length} quality setups (${setups.length} scanned)`)

  // Check available cash for cash-secured puts
  // Cash available ≈ account equity minus long equity market value minus option exposure
  const longEquityValue = allEquityPositions
    .filter((p) => p.qty > 0)
    .reduce((s, p) => s + p.qty * p.current_price, 0)
  const estimatedCash = Math.max(0, accountEquity - longEquityValue)

  let cashRemaining = estimatedCash
  let slotsFilled   = 0

  for (const setup of candidates) {
    if (slotsFilled >= slotsLeft) break
    if (cashRemaining < setup.price * 100) continue  // can't afford even 1 contract

    const chain = await getPutChain(setup.symbol, setup.price)
    const csp   = buildCashSecuredPut(
      setup.symbol, setup.price, chain, cashRemaining, 0.18, setup.hv30 ?? 40,
    )

    if (!csp) {
      actions.push(`CSP SKIP ${setup.symbol}: no viable put (chain=${chain.length})`)
      continue
    }

    const result = await executeSingleLegSell(csp.contract.symbol, csp.contracts, csp.premium)
    if (result.ok) {
      newCSPs++
      slotsFilled++
      cashRemaining -= csp.cash_required

      const desc = `${csp.underlying} CSP $${csp.strike} exp ${csp.expiration} (${csp.dte}d) | premium $${csp.premium.toFixed(2)}/sh (${(csp.premium_pct * 100).toFixed(1)}%) | breakeven $${csp.breakeven.toFixed(2)} | cash $${csp.cash_required.toFixed(0)}`
      await db.from('tb_trades').insert({
        symbol:      csp.underlying,
        broker:      'alpaca_paper',
        action:      'SELL',
        strategy:    'WHEEL_CSP',
        status:      'OPEN',
        entry_price: csp.strike,
        quantity:    csp.contracts * 100,
        confidence:  78,
        reason:      `WHEEL_CSP | OCC=${csp.contract.symbol} | ${desc}`,
      })
      await db.from('tb_alerts').insert({
        type: 'SELL', symbol: csp.underlying, broker: 'alpaca_paper',
        message: `[wheel] CSP SOLD: ${desc}`,
      })
      actions.push(`CSP SOLD ${csp.underlying}: ${desc}`)
      await tgAlert(`🎯 *Wheel CSP*: Sold ${csp.contracts}x ${csp.underlying} $${csp.strike}P exp ${csp.expiration} | $${(csp.premium * 100 * csp.contracts).toFixed(0)} premium | break-even $${csp.breakeven.toFixed(2)}`)
    } else {
      actions.push(`CSP FAILED ${setup.symbol}: ${result.error}`)
    }
  }

  await logAndReturn(db, actions, newCSPs, closedCSPs, newCCs, closedCCs)
  return NextResponse.json({ status: 'ok', actions, newCSPs, closedCSPs, newCCs, closedCCs })
}

async function logAndReturn(
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>,
  actions: string[],
  newCSPs: number, closedCSPs: number, newCCs: number, closedCCs: number,
) {
  await db.from('tb_cron_log').insert({
    job: 'wheel', status: 'success',
    trades_made: newCSPs + newCCs + closedCSPs + closedCCs,
    message: `CSP +${newCSPs} -${closedCSPs} | CC +${newCCs} -${closedCCs} | ${actions.join(' | ')}`.slice(0, 500),
  })
}
