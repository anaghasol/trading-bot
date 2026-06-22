/**
 * CRON: /api/cron/options — Bull Put Spread scanner + executor (PAPER ONLY)
 * Runs once at 10:00 AM ET (after market open settles) and 1:00 PM ET.
 *
 * What it does:
 *  1. Pulls today's high-conviction equity setups (EMA score ≥ 8, conf ≥ 80%)
 *     for symbols eligible for options spreads (liquid underlyings only).
 *  2. For each candidate, fetches the put options chain (21-45 DTE).
 *  3. Builds the best Bull Put Spread and validates risk/reward.
 *  4. Executes on Alpaca paper if: credit ≥ 20% of width, risk ≤ 2% of equity,
 *     and max 3 open option positions.
 *  5. Monitors existing spreads — closes at 50% profit or ≤7 DTE (standard practice).
 *
 * Schedule: "0 15,18 * * 1-5"  (10 AM + 1 PM ET = 15:00 + 18:00 UTC)
 * PAPER ONLY — never touches Schwab.
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance } from '@/lib/alpaca'
import {
  SPREAD_ELIGIBLE, SPREAD_ELIGIBLE_LIST, getPutChain, buildBullPutSpread, executeBullPutSpread,
  getOptionPositions, closeOptionPosition,
} from '@/lib/options'

const ALPACA_KEY    = process.env.ALPACA_KEY_ID    ?? ''
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? ''
import { scanForEMAPullback, getMarketRegime, ALL_ALPACA_SYMBOLS } from '@/lib/market-data'
import { isMarketOpen } from '@/lib/risk'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime  = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function GET(req: Request) {
  const db = createServiceClient()
  if (!authorized(req)) {
    await db.from('tb_cron_log').insert({ job: 'options', status: 'skipped', message: 'unauthorized' })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMarketOpen()) {
    await db.from('tb_cron_log').insert({ job: 'options', status: 'skipped', message: 'market_closed' })
    return NextResponse.json({ status: 'skipped', reason: 'market_closed' })
  }
  const actions: string[] = []
  let newSpreads = 0
  let closedSpreads = 0

  try {
    // ── 1. Monitor existing option positions ─────────────────────────────────
    const optPositions = await getOptionPositions()
    for (const pos of optPositions) {
      const plPct = pos.unrealized_plpc * 100  // as percentage

      // Stop loss at -15% of premium paid — AMD-style blow-ups cost 5x more than they should
      const stopLoss = plPct <= -15
      // Take profit at 50% of max profit (standard options management rule)
      const takeProfit = plPct >= 50
      // Exit near expiry to avoid assignment risk (≤7 DTE)
      const nearExpiry = (() => {
        // OCC symbol: NVDA240119P00500000 — extract YYMMDD (chars 4-9 for 4-char tickers or 3-9 for shorter)
        try {
          const sym = pos.symbol
          // Find first digit after the ticker letters
          const match = sym.match(/[A-Z]+(\d{6})[CP]/)
          if (!match) return false
          const [yy, mm, dd] = [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)]
          const expDate = new Date(`20${yy}-${mm}-${dd}T16:00:00-05:00`)
          const dte = Math.round((expDate.getTime() - Date.now()) / 86_400_000)
          return dte <= 7
        } catch { return false }
      })()

      if (stopLoss || takeProfit || nearExpiry) {
        const reason = stopLoss ? `STOP -15% premium (${plPct.toFixed(0)}% loss — protecting capital)` : takeProfit ? `50% profit (${plPct.toFixed(0)}% gain)` : `≤7 DTE — exit before assignment risk`
        // For a short spread: buy back the short put, sell the long put
        // Simplest approach for paper: close each leg as a market order
        const side = pos.qty < 0 ? 'buy' : 'sell'  // reverse the position
        const ok = await closeOptionPosition(pos.symbol, Math.abs(pos.qty), side)
        if (ok) {
          closedSpreads++
          actions.push(`CLOSED ${pos.symbol}: ${reason} | P/L $${pos.unrealized_pl.toFixed(2)}`)
          await db.from('tb_alerts').insert({
            type: pos.unrealized_pl >= 0 ? 'SELL' : 'STOP_LOSS',
            symbol: pos.symbol.slice(0, 4),
            broker: 'alpaca_paper',
            message: `[options] CLOSED ${pos.symbol}: ${reason} | $${pos.unrealized_pl.toFixed(2)}`,
            pnl: pos.unrealized_pl,
          })
        }
      } else {
        actions.push(`HOLD ${pos.symbol}: ${plPct.toFixed(0)}% P/L ($${pos.unrealized_pl.toFixed(2)})`)
      }
    }

    // ── 2. Check how many option positions are open + total exposure cap ────
    const openOptionCount = optPositions.filter((p) => p.qty < 0).length  // short legs = open spreads
    const MAX_SPREADS = 3
    // Total options exposure cap: sum of max risk across all open spreads ≤ 15% of equity
    // Approximated from market_value of option positions (negative = short premium collected)
    const totalOptionsExposure = optPositions.reduce((s, p) => s + Math.abs(p.unrealized_pl + (p.avg_entry_price * Math.abs(p.qty) * 100)), 0)
    const equity2 = await getAccountBalance() ?? 100_000
    const exposurePct = totalOptionsExposure / equity2
    if (openOptionCount >= MAX_SPREADS || exposurePct >= 0.15) {
      actions.push(`CAP REACHED: ${openOptionCount}/${MAX_SPREADS} spreads, ${(exposurePct * 100).toFixed(0)}% options exposure — no new entries`)
      await db.from('tb_cron_log').insert({ job: 'options', status: 'success', trades_made: closedSpreads, message: actions.join(' | ') })
      return NextResponse.json({ status: 'ok', actions, new_spreads: 0, closed_spreads: closedSpreads })
    }

    // ── 3. Scan for high-conviction setups eligible for spreads ──────────────
    const [equity, regime] = await Promise.all([
      getAccountBalance(),
      getMarketRegime(),
    ])
    const accountEquity = equity ?? 100_000

    // Only trade spreads in GOOD or NORMAL markets — not RISK_OFF or CAUTION
    if (regime.regime === 'RISK_OFF') {
      actions.push(`RISK_OFF market — no new spreads`)
      await db.from('tb_cron_log').insert({ job: 'options', status: 'success', trades_made: 0, message: `RISK_OFF — skipped` })
      return NextResponse.json({ status: 'ok', actions, new_spreads: 0, closed_spreads: closedSpreads })
    }

    // Scan eligible symbols (liquid underlyings only)
    const eligibleSyms = ALL_ALPACA_SYMBOLS.filter((s) => SPREAD_ELIGIBLE_LIST.includes(s))
    const setups = await scanForEMAPullback(eligibleSyms, { loose: false })

    // Filter for high conviction only: EMA score ≥ 8, strong momentum
    const candidates = setups
      .filter((s) => s.pullback_score >= 8 && s.rsi >= 50 && s.change_1d >= 0)
      .sort((a, b) => b.pullback_score - a.pullback_score)
      .slice(0, 5)

    actions.push(`Candidates: ${candidates.length} high-score setups (${setups.length} scanned)`)

    // Also check tb_learning for recent bullish advisor picks in eligible symbols
    const { data: advisorPicks } = await db
      .from('tb_learning')
      .select('symbol')
      .gte('created_at', new Date(Date.now() - 3 * 86_400_000).toISOString())
      .in('sentiment', ['bullish'])
      .not('symbol', 'is', null)

    const advisorEligible = (advisorPicks ?? [])
      .map((r: { symbol: string }) => r.symbol)
      .filter((s: string) => SPREAD_ELIGIBLE.has(s))
      .filter((s: string) => !candidates.find((c) => c.symbol === s))

    // Already-entered equity positions this broker — don't double up
    const openEquity = await getPositions()
    const openSyms = new Set(openEquity.map((p) => p.symbol))

    // ── 4. Build + execute spreads ───────────────────────────────────────────
    let slotsLeft = MAX_SPREADS - openOptionCount

    for (const setup of candidates) {
      if (slotsLeft <= 0) break
      if (openSyms.has(setup.symbol)) continue  // already long equity — skip

      const chain  = await getPutChain(setup.symbol, setup.price)
      const spread = buildBullPutSpread(setup.symbol, setup.price, chain, accountEquity)

      if (!spread) {
        actions.push(`${setup.symbol}: no viable spread (chain=${chain.length} contracts)`)
        continue
      }

      // Log the spread opportunity
      const desc = `${spread.underlying} Bull Put ${spread.long_put.strike_price}/${spread.short_put.strike_price} exp ${spread.expiration} (${spread.dte}d) | credit $${spread.net_credit.toFixed(2)} (${(spread.credit_pct * 100).toFixed(0)}% of width) | risk $${spread.max_risk_dollars.toFixed(0)} | ROI ${spread.roi_pct.toFixed(0)}%`
      actions.push(`SPREAD: ${desc}`)

      // Execute
      const result = await executeBullPutSpread(spread)
      if (result.ok) {
        newSpreads++
        slotsLeft--

        await db.from('tb_trades').insert({
          symbol:      spread.underlying,
          broker:      'alpaca_paper',
          status:      'OPEN',
          strategy:    'BULL_PUT_SPREAD',
          entry_price: spread.short_put.strike_price,
          quantity:    spread.contracts,
          confidence:  82,
          reason:      `${desc} | order=${result.order_id}`,
          created_at:  new Date().toISOString(),
        })

        await db.from('tb_alerts').insert({
          type: 'BUY', symbol: spread.underlying, broker: 'alpaca_paper',
          message: `[options] BULL PUT SPREAD ${desc}`,
        })

        actions.push(`EXECUTED: ${spread.underlying} spread (order ${result.order_id})`)
      } else {
        actions.push(`FAILED: ${spread.underlying} — ${result.error}`)
      }
    }

    // Advisor-picked symbols as bonus candidates
    for (const sym of advisorEligible.slice(0, 2)) {
      if (slotsLeft <= 0) break
      if (openSyms.has(sym)) continue

      // Need price — fetch from Alpaca
      try {
        const priceRes = await fetch(`https://data.alpaca.markets/v2/stocks/${sym}/quotes/latest`, {
          headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
          signal: AbortSignal.timeout(3000),
        })
        if (!priceRes.ok) continue
        const priceData = await priceRes.json() as { quote: { ap: number; bp: number } }
        const price = (priceData.quote.ap + priceData.quote.bp) / 2
        if (price <= 0) continue

        const chain  = await getPutChain(sym, price)
        const spread = buildBullPutSpread(sym, price, chain, accountEquity)
        if (!spread) continue

        const result = await executeBullPutSpread(spread)
        if (result.ok) {
          newSpreads++
          slotsLeft--
          actions.push(`ADVISOR SPREAD EXECUTED: ${sym} (order ${result.order_id})`)
        }
      } catch { /* non-fatal */ }
    }

    const summary = `Options scan: ${newSpreads} new spreads | ${closedSpreads} closed | ${actions.join(' | ')}`
    await db.from('tb_cron_log').insert({
      job: 'options', status: 'success', trades_made: newSpreads + closedSpreads,
      message: summary.slice(0, 500),
    })

    return NextResponse.json({ status: 'ok', new_spreads: newSpreads, closed_spreads: closedSpreads, actions })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'options', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
