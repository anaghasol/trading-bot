/**
 * Defined-risk options module — Bull Put Spreads on Alpaca paper only.
 *
 * Strategy: Bull Put Spread (credit spread)
 *   Sell put ~6% OTM (collect premium)
 *   Buy put $2-5 below (cap the risk)
 *   Net credit = income; max loss = spread width − credit
 *
 * Why Bull Put Spread first:
 *   - Time decay (theta) works FOR us (selling premium)
 *   - Defined max loss known upfront → no blowup risk
 *   - Works on existing bullish setups (same signals as equity scan)
 *   - Target: 20-30% return on max risk in 21-45 days
 *
 * PAPER ONLY. Never touches Schwab or live money.
 */

const PAPER_BASE = 'https://paper-api.alpaca.markets/v2'
const KEY_ID     = process.env.ALPACA_KEY_ID!
const SECRET     = process.env.ALPACA_SECRET_KEY!

function hdr() {
  return { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' }
}

// Only trade spreads on liquid underlyings — tight bid/ask, high open interest
export const SPREAD_ELIGIBLE_LIST = ['SPY', 'QQQ', 'NVDA', 'AMD', 'AAPL', 'TSLA', 'META', 'AMZN', 'MSFT', 'ARM', 'GOOGL', 'SMCI']
export const SPREAD_ELIGIBLE = new Set(SPREAD_ELIGIBLE_LIST)

export interface OptionsContract {
  id: string
  symbol: string             // OCC e.g. NVDA240119P00500000
  underlying_symbol: string
  type: 'put' | 'call'
  strike_price: number
  expiration_date: string    // YYYY-MM-DD
  open_interest: number
  close_price: number        // prior close (fallback when bid/ask absent)
  bid_price?: number
  ask_price?: number
  delta?: number
  implied_volatility?: number
}

export interface BullPutSpread {
  underlying: string
  current_price: number
  short_put: OptionsContract   // sell (higher strike, ~6% OTM)
  long_put: OptionsContract    // buy  (lower strike, protection)
  spread_width: number         // short_strike − long_strike in $
  net_credit: number           // per share collected ($ per contract ÷ 100)
  max_profit_per_contract: number  // net_credit × 100
  max_loss_per_contract: number    // (spread_width − net_credit) × 100
  credit_pct: number           // net_credit / spread_width — want ≥ 25%
  breakeven: number            // short_strike − net_credit
  expiration: string
  dte: number                  // days to expiry
  contracts: number            // how many contracts fit in risk budget
  max_risk_dollars: number     // actual $ at risk
  roi_pct: number              // max_profit / max_loss × 100
}

// ── Chain fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch put options expiring 21-45 days out for a symbol.
 * Filters to strikes 80-100% of current price (0-20% OTM).
 */
export async function getPutChain(symbol: string, currentPrice: number): Promise<OptionsContract[]> {
  try {
    const today  = new Date()
    const minExp = new Date(today.getTime() + 21 * 86_400_000).toISOString().split('T')[0]
    const maxExp = new Date(today.getTime() + 45 * 86_400_000).toISOString().split('T')[0]
    const minStrike = (currentPrice * 0.80).toFixed(2)
    const maxStrike = (currentPrice * 1.01).toFixed(2)

    const url  = `${PAPER_BASE}/options/contracts?underlying_symbols=${symbol}&type=put`
             + `&expiration_date_gte=${minExp}&expiration_date_lte=${maxExp}`
             + `&strike_price_gte=${minStrike}&strike_price_lte=${maxStrike}&limit=200`
    const res = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.error(`[options] chain ${symbol}: ${res.status} ${await res.text()}`)
      return []
    }
    const data = await res.json() as { option_contracts: OptionsContract[] }
    return (data.option_contracts ?? []).sort((a, b) =>
      new Date(a.expiration_date).getTime() - new Date(b.expiration_date).getTime()
    )
  } catch (e) {
    console.error(`[options] chain fetch failed for ${symbol}:`, e)
    return []
  }
}

// ── Spread builder ────────────────────────────────────────────────────────────

/**
 * Select the best Bull Put Spread for a bullish setup.
 *
 * Logic:
 *  1. Pick first expiry with 21-45 DTE
 *  2. Short put: ~6% OTM (strike near 94% of current price), OI > 100
 *  3. Long put: $2-5 below short put, OI > 50
 *  4. Validate: credit ≥ 20% of spread width, total risk ≤ 2% of equity
 */
export function buildBullPutSpread(
  symbol: string,
  currentPrice: number,
  chain: OptionsContract[],
  accountEquity: number,
  maxRiskPct = 0.02,
): BullPutSpread | null {
  if (chain.length === 0) return null

  const today   = new Date()
  const seen = new Set<string>()
  const expiries = chain.map((c) => c.expiration_date).filter((d) => { if (seen.has(d)) return false; seen.add(d); return true }).sort()

  for (const expiry of expiries) {
    const dte = Math.round((new Date(expiry + 'T16:00:00-05:00').getTime() - today.getTime()) / 86_400_000)
    if (dte < 21 || dte > 45) continue

    const slice = chain.filter((c) => c.expiration_date === expiry)

    // Short put: target 93-96% of current price (~4-7% OTM)
    const targetStrike = currentPrice * 0.935
    const shortCandidates = slice
      .filter((c) => c.strike_price >= currentPrice * 0.91 && c.strike_price <= currentPrice * 0.97)
      .filter((c) => (c.open_interest ?? 0) > 50)
      .sort((a, b) => Math.abs(a.strike_price - targetStrike) - Math.abs(b.strike_price - targetStrike))

    if (!shortCandidates.length) continue
    const shortPut = shortCandidates[0]

    // IV proxy filter: require annualized IV > 25% on short put (screens out low-vol setups
    // where selling premium doesn't generate enough credit). True IVR needs historical data;
    // this per-contract IV is a practical substitute available directly from the chain.
    const shortIV = shortPut.implied_volatility ?? 0
    if (shortIV > 0 && shortIV < 0.25) continue  // skip if IV data present but < 25%

    // Long put: $2-5 below short put, hard cap at $5 width to keep risk small
    const longCandidates = slice
      .filter((c) => c.strike_price >= shortPut.strike_price - 5 && c.strike_price < shortPut.strike_price - 1.5)
      .filter((c) => (c.open_interest ?? 0) > 20)
      .sort((a, b) => b.strike_price - a.strike_price)   // closest to short put first

    if (!longCandidates.length) continue
    const longPut = longCandidates[0]

    // Hard cap: spread width must be ≤ $5
    if (shortPut.strike_price - longPut.strike_price > 5) continue

    // Use mid-price; fall back to close_price (prior session)
    const shortMid = shortPut.bid_price != null ? (shortPut.bid_price + (shortPut.ask_price ?? shortPut.bid_price)) / 2 : (shortPut.close_price ?? 0)
    const longMid  = longPut.bid_price  != null ? (longPut.bid_price  + (longPut.ask_price  ?? longPut.bid_price))  / 2 : (longPut.close_price  ?? 0)

    const netCredit  = shortMid - longMid
    const spreadWidth = shortPut.strike_price - longPut.strike_price
    if (netCredit <= 0 || spreadWidth <= 0) continue

    const creditPct = netCredit / spreadWidth
    if (creditPct < 0.25) continue   // raised from 20% → 25% — better edge on each spread

    const maxLossPerContract   = (spreadWidth - netCredit) * 100
    const maxProfitPerContract = netCredit * 100
    if (maxLossPerContract <= 0) continue

    // Fit contracts within risk budget
    const maxRiskDollars = accountEquity * maxRiskPct
    const numContracts   = Math.max(1, Math.floor(maxRiskDollars / maxLossPerContract))
    const actualRisk     = numContracts * maxLossPerContract

    // Never risk more than 4% of account on one spread (hard cap above the 2% default)
    if (actualRisk > accountEquity * 0.04) continue

    return {
      underlying:              symbol,
      current_price:           currentPrice,
      short_put:               shortPut,
      long_put:                longPut,
      spread_width:            spreadWidth,
      net_credit:              netCredit,
      max_profit_per_contract: maxProfitPerContract,
      max_loss_per_contract:   maxLossPerContract,
      credit_pct:              creditPct,
      breakeven:               shortPut.strike_price - netCredit,
      expiration:              expiry,
      dte,
      contracts:               numContracts,
      max_risk_dollars:        actualRisk,
      roi_pct:                 (maxProfitPerContract / maxLossPerContract) * 100,
    }
  }

  return null
}

// ── Order execution ───────────────────────────────────────────────────────────

/**
 * Place a Bull Put Spread on Alpaca paper as a multi-leg order.
 * Uses a limit price equal to the net credit we calculated.
 */
export async function executeBullPutSpread(spread: BullPutSpread): Promise<{ ok: boolean; order_id?: string; error?: string }> {
  try {
    const body = {
      type:           'limit',
      time_in_force:  'day',
      order_class:    'mleg',
      limit_price:    spread.net_credit.toFixed(2),
      qty:            String(spread.contracts),
      legs: [
        { symbol: spread.short_put.symbol, side: 'sell', ratio_qty: 1, position_effect: 'open' },
        { symbol: spread.long_put.symbol,  side: 'buy',  ratio_qty: 1, position_effect: 'open' },
      ],
    }

    const res = await fetch(`${PAPER_BASE}/orders`, {
      method: 'POST', headers: hdr(), body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[options] executeBullPutSpread ${spread.underlying}: ${res.status} ${err}`)
      return { ok: false, error: `${res.status}: ${err.slice(0, 120)}` }
    }

    const data = await res.json() as { id: string }
    return { ok: true, order_id: data.id }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ── Spread monitor ────────────────────────────────────────────────────────────

/**
 * Get open options positions from Alpaca paper.
 * Used by the monitor to close spreads at 50% profit or ≤7 DTE.
 */
export async function getOptionPositions(): Promise<Array<{
  symbol: string; qty: number; avg_entry_price: number; current_price: number; unrealized_pl: number; unrealized_plpc: number
}>> {
  try {
    const res  = await fetch(`${PAPER_BASE}/positions`, { headers: hdr() })
    if (!res.ok) return []
    const all = await res.json() as Array<{ symbol: string; asset_class: string; qty: string; avg_entry_price: string; current_price: string; unrealized_pl: string; unrealized_plpc: string }>
    return all
      .filter((p) => p.asset_class === 'us_option')
      .map((p) => ({
        symbol:            p.symbol,
        qty:               parseFloat(p.qty),
        avg_entry_price:   parseFloat(p.avg_entry_price),
        current_price:     parseFloat(p.current_price),
        unrealized_pl:     parseFloat(p.unrealized_pl),
        unrealized_plpc:   parseFloat(p.unrealized_plpc),
      }))
  } catch {
    return []
  }
}

/** Close an options position (used to take 50% profit or exit at ≤7 DTE). */
export async function closeOptionPosition(symbol: string, qty: number, side: 'buy' | 'sell'): Promise<boolean> {
  try {
    const res = await fetch(`${PAPER_BASE}/orders`, {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ symbol, qty: String(Math.abs(qty)), side, type: 'market', time_in_force: 'day' }),
    })
    return res.ok
  } catch {
    return false
  }
}
