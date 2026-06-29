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

// Liquid underlyings with active options markets (tight bid/ask, high OI)
export const SPREAD_ELIGIBLE_LIST = [
  'SPY', 'QQQ', 'NVDA', 'AMD', 'AAPL', 'TSLA', 'META', 'AMZN', 'MSFT', 'ARM', 'GOOGL', 'SMCI',
  'COIN', 'MSTR', 'PLTR', 'CRWD', 'PANW', 'SOFI', 'RIVN', 'MRVL', 'MU', 'INTC',
]
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

// ── OCC symbol resolver ───────────────────────────────────────────────────────
// Groq returns "NVDA 140 CALL 2026-08-15" — this converts to the real OCC symbol
// by querying Alpaca's contracts endpoint for the exact strike+expiry.

export interface ResolvedContract {
  occ: string              // e.g. "NVDA260815C00140000"
  premium: number          // estimated premium (close_price or BS estimate)
  dte: number
  displayLabel: string     // "NVDA $140C 8/15"
}

export async function resolveOptionToOCC(
  description: string,  // e.g. "NVDA 140 CALL 2026-08-15" from Groq
  currentPrice: number,
): Promise<ResolvedContract | null> {
  try {
    // Parse: "TICKER STRIKE TYPE DATE"
    const m = description.match(/^([A-Z]{1,6})\s+([\d.]+)\s+(CALL|PUT|C|P)\s+(\d{4}-\d{2}-\d{2})$/i)
    if (!m) return null
    const [, ticker, strikeStr, typeStr, expiry] = m
    const strike = parseFloat(strikeStr)
    const optType = typeStr.toUpperCase().startsWith('C') ? 'call' : 'put'

    const dte = Math.round((new Date(expiry + 'T16:00:00-05:00').getTime() - Date.now()) / 86_400_000)
    if (dte < 3) return null   // too close to expiry

    // Find the contract on Alpaca
    const url = `${PAPER_BASE}/options/contracts?underlying_symbols=${ticker}&type=${optType}`
             + `&expiration_date_gte=${expiry}&expiration_date_lte=${expiry}`
             + `&strike_price_gte=${(strike * 0.99).toFixed(2)}&strike_price_lte=${(strike * 1.01).toFixed(2)}&limit=5`
    const res = await fetch(url, { headers: hdr(), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = await res.json() as { option_contracts: OptionsContract[] }
    const contracts = data.option_contracts ?? []
    if (contracts.length === 0) return null

    const c = contracts[0]
    const premium = c.close_price ?? bsEstimatePut(currentPrice, strike, dte, 0.40)
    const typeChar = optType === 'call' ? 'C' : 'P'
    const displayLabel = `${ticker} $${strike}${typeChar} ${parseInt(expiry.slice(5, 7))}/${parseInt(expiry.slice(8, 10))}`

    return { occ: c.symbol, premium, dte, displayLabel }
  } catch {
    return null
  }
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

// ── Black-Scholes put price estimator ─────────────────────────────────────────
// Used when Alpaca doesn't provide live bid/ask (common on paper accounts).
// σ = HV30 as decimal (e.g. 0.45 for 45%), r = 4% risk-free, T = DTE/365
function bsEstimatePut(S: number, K: number, dte: number, sigma: number): number {
  if (sigma <= 0 || dte <= 0) return 0
  const T = dte / 365
  const r = 0.04
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)
  const nd1 = normalCDF(-d1)
  const nd2 = normalCDF(-d2)
  return Math.max(0, K * Math.exp(-r * T) * nd2 - S * nd1)
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + p * Math.abs(x))
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2)
  return 0.5 * (1 + sign * y)
}

// ── Spread builder ────────────────────────────────────────────────────────────

/**
 * Select the best Bull Put Spread for a bullish setup.
 *
 * Logic:
 *  1. Pick first expiry with 21-45 DTE
 *  2. Short put: ~5.5% OTM (92-97% of current price), OI > 10
 *  3. Long put: $2-10 below short put
 *  4. Validate: credit ≥ 10% of spread width (uses BS estimate when no bid/ask)
 *
 * hv30: 30-day historical volatility as percent (e.g. 45 for 45%) — used for BS fallback.
 */
export function buildBullPutSpread(
  symbol: string,
  currentPrice: number,
  chain: OptionsContract[],
  accountEquity: number,
  maxRiskPct = 0.02,
  hv30 = 40,   // default 40% HV — reasonable for liquid equities
): BullPutSpread | null {
  if (chain.length === 0) return null

  const today   = new Date()
  const seen = new Set<string>()
  const expiries = chain.map((c) => c.expiration_date).filter((d) => { if (seen.has(d)) return false; seen.add(d); return true }).sort()

  for (const expiry of expiries) {
    const dte = Math.round((new Date(expiry + 'T16:00:00-05:00').getTime() - today.getTime()) / 86_400_000)
    if (dte < 21 || dte > 45) continue

    const slice = chain.filter((c) => c.expiration_date === expiry)

    // Short put: target 92-97% of current price (~3-8% OTM) — widened to find more candidates
    const targetStrike = currentPrice * 0.945
    const shortCandidates = slice
      .filter((c) => c.strike_price >= currentPrice * 0.90 && c.strike_price <= currentPrice * 0.97)
      .filter((c) => (c.open_interest ?? 0) > 10)   // lowered from 50 — paper OI data is sparse
      .sort((a, b) => Math.abs(a.strike_price - targetStrike) - Math.abs(b.strike_price - targetStrike))

    if (!shortCandidates.length) continue
    const shortPut = shortCandidates[0]

    // Long put: $2-10 below short put (widened from $5 max to allow larger spreads on high-priced stocks)
    const longCandidates = slice
      .filter((c) => c.strike_price >= shortPut.strike_price - 10 && c.strike_price < shortPut.strike_price - 1)
      .filter((c) => (c.open_interest ?? 0) > 5)
      .sort((a, b) => b.strike_price - a.strike_price)   // closest to short put first

    if (!longCandidates.length) continue
    const longPut = longCandidates[0]

    const spreadWidth = shortPut.strike_price - longPut.strike_price
    if (spreadWidth <= 0 || spreadWidth > 20) continue

    // Use mid-price; fall back to close_price (prior session); fall back to HV30 Black-Scholes estimate
    // Alpaca paper rarely has live bid/ask for options — close_price is stale but usable as floor
    const shortMid = shortPut.bid_price != null
      ? (shortPut.bid_price + (shortPut.ask_price ?? shortPut.bid_price)) / 2
      : (shortPut.close_price ?? bsEstimatePut(currentPrice, shortPut.strike_price, dte, hv30))
    const longMid  = longPut.bid_price  != null
      ? (longPut.bid_price  + (longPut.ask_price  ?? longPut.bid_price))  / 2
      : (longPut.close_price  ?? bsEstimatePut(currentPrice, longPut.strike_price, dte, hv30))

    const netCredit  = shortMid - longMid
    if (netCredit <= 0) continue

    const creditPct = netCredit / spreadWidth
    // Require ≥ 10% credit (lowered from 25% — Alpaca stale close_price makes 25% unreachable)
    if (creditPct < 0.10) continue

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
