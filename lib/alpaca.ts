/**
 * Alpaca Markets API client — FREE paper trading
 * Sign up: https://app.alpaca.markets (free, instant)
 * Paper URL: https://paper-api.alpaca.markets
 * Live URL:  https://api.alpaca.markets
 *
 * Same interface as lib/schwab.ts — swap brokers via BROKER env var.
 * Paper trading = identical to live but with fake money ($100k default).
 */

import type { Position, OrderResult, SchwabOrder } from './schwab'

const IS_PAPER  = process.env.BROKER !== 'alpaca_live'
const BASE_URL  = IS_PAPER
  ? 'https://paper-api.alpaca.markets/v2'
  : 'https://api.alpaca.markets/v2'
// Market data always from data.alpaca.markets (same auth, IEX feed = free)
const DATA_URL  = 'https://data.alpaca.markets/v2'

const KEY_ID  = process.env.ALPACA_KEY_ID!
const SECRET  = process.env.ALPACA_SECRET_KEY!

function headers() {
  return {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
    'Content-Type':        'application/json',
  }
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: headers(), cache: 'no-store' })
    if (!res.ok) {
      console.error(`[alpaca] GET ${path} → ${res.status}: ${await res.text()}`)
      return null
    }
    return res.json()
  } catch (e) {
    console.error(`[alpaca] GET ${path} error:`, e)
    return null
  }
}

async function post<T>(path: string, body: object): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[alpaca] POST ${path} → ${res.status}: ${text}`)
      let message = `Alpaca ${res.status}`
      try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch { message = text }
      return { error: message }
    }
    return { data: await res.json() as T }
  } catch (e) {
    console.error(`[alpaca] POST ${path} error:`, e)
    return { error: String(e) }
  }
}

async function del(path: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: headers() })
  return res.ok
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccountBalance(): Promise<number | null> {
  const acct = await get<{ equity: string; portfolio_value: string }>('/account')
  return acct ? parseFloat(acct.portfolio_value || acct.equity) : null
}

// ── Positions ─────────────────────────────────────────────────────────────────

export async function getPositions(): Promise<Position[]> {
  const data = await get<Record<string, unknown>[]>('/positions')
  if (!data) return []

  return data.map((p) => {
    const qty      = parseFloat(String(p.qty ?? 0))
    const avg_cost = parseFloat(String(p.avg_entry_price ?? 0))
    const cur_price = parseFloat(String(p.current_price ?? avg_cost))
    const unreal   = parseFloat(String(p.unrealized_pl ?? 0))
    const pnl_pct  = avg_cost > 0 ? ((cur_price - avg_cost) / avg_cost) * 100 : 0

    return {
      symbol:        String(p.symbol),
      quantity:      qty,
      avg_cost,
      current_price: cur_price,
      market_value:  parseFloat(String(p.market_value ?? 0)),
      unrealized_pnl: unreal,
      pnl_pct:       Math.round(pnl_pct * 100) / 100,
      peak_pnl:      0,
      asset_type:    'EQUITY' as const,
    }
  })
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function placeOrder(
  symbol: string,
  quantity: number,
  action: 'BUY' | 'SELL',
  orderType: 'MARKET' | 'LIMIT' = 'MARKET',
  limitPrice?: number
): Promise<OrderResult> {
  const body: Record<string, unknown> = {
    symbol,
    qty:            quantity,
    side:           action.toLowerCase(),
    type:           orderType.toLowerCase(),
    time_in_force:  'day',
  }
  if (orderType === 'LIMIT' && limitPrice) {
    body.limit_price = limitPrice.toFixed(2)
  }

  const result = await post<{ id: string }>('/orders', body)
  if ('error' in result) {
    return { symbol, quantity, action, status: 'FAILED', error: result.error }
  }
  return { symbol, quantity, action, status: 'PLACED', order_id: result.data.id }
}

export async function placeBuyWithProtection(
  symbol: string,
  quantity: number,
  trailPct = 5.0
): Promise<{ buy: OrderResult; stop_order_id: string | null }> {
  const buy = await placeOrder(symbol, quantity, 'BUY', 'MARKET')
  if (buy.status !== 'PLACED') return { buy, stop_order_id: null }

  // Give Alpaca 500ms to process the fill
  await new Promise((r) => setTimeout(r, 500))

  const stopResult = await post<{ id: string }>('/orders', {
    symbol,
    qty:            quantity,
    side:           'sell',
    type:           'trailing_stop',
    time_in_force:  'gtc',
    trail_percent:  trailPct,
  })

  return { buy, stop_order_id: 'data' in stopResult ? stopResult.data.id : null }
}

export async function placeStopOrder(
  symbol: string,
  quantity: number,
  stopPrice: number
): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 600)) // let fill settle
  const result = await post<{ id: string }>('/orders', {
    symbol,
    qty:           quantity,
    side:          'sell',
    type:          'stop',
    time_in_force: 'gtc',
    stop_price:    stopPrice.toFixed(2),
  })
  return 'data' in result ? result.data.id : null
}

export async function cancelOrder(order_id: string): Promise<boolean> {
  return del(`/orders/${order_id}`)
}

// ── Order History ─────────────────────────────────────────────────────────────

export async function getOrders(daysBack = 10): Promise<SchwabOrder[]> {
  const after = new Date(Date.now() - daysBack * 86_400_000).toISOString()
  const data  = await get<Record<string, unknown>[]>(
    `/orders?status=all&after=${after}&limit=100&direction=desc`
  )
  if (!data) return []

  return data
    .filter((o) => o.status === 'filled')
    .map((o) => ({
      order_id:        String(o.id ?? ''),
      symbol:          String(o.symbol ?? ''),
      asset_type:      'EQUITY',
      instruction:     (o.side === 'buy' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      quantity:        parseFloat(String(o.qty ?? 0)),
      filled_quantity: parseFloat(String(o.filled_qty ?? 0)),
      price:           parseFloat(String(o.filled_avg_price ?? o.limit_price ?? 0)),
      status:          'FILLED',
      entered_time:    String(o.submitted_at ?? ''),
      close_time:      o.filled_at ? String(o.filled_at) : null,
      order_type:      String(o.type ?? 'market').toUpperCase(),
    }))
}

export async function getQuote(symbol: string): Promise<{ symbol: string; price: number; change_pct: number; volume: number } | null> {
  try {
    // PRIMARY: latest trade price — reflects actual market activity, not a stale bar close.
    // bars/latest on IEX can be hours or days behind for thin/new stocks (caused SPCX $27 vs $163 bug).
    const tradeRes = await fetch(
      `${DATA_URL}/stocks/${symbol}/trades/latest?feed=iex`,
      { headers: headers(), cache: 'no-store' }
    )
    if (tradeRes.ok) {
      const td = await tradeRes.json() as { trade?: { p: number; s: number; t: string } }
      if (td.trade?.p && td.trade.p > 0) {
        const ageMs  = Date.now() - new Date(td.trade.t).getTime()
        const utcH   = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
        const mktOpen = utcH >= 13.5 && utcH <= 20
        // Accept trade price if: market closed (use whatever we have) OR trade < 2h old
        if (!mktOpen || ageMs < 7_200_000) {
          return { symbol, price: td.trade.p, change_pct: 0, volume: td.trade.s }
        }
        // Trade is >2h stale during market hours — fall through to bar fallback but log it
        console.warn(`[alpaca] getQuote ${symbol}: latest trade is ${Math.floor(ageMs / 60000)}m old — falling back to bar`)
      }
    }

    // FALLBACK: bar close (more stale, but better than nothing)
    const barRes = await fetch(
      `${DATA_URL}/stocks/${symbol}/bars/latest?feed=iex`,
      { headers: headers(), cache: 'no-store' }
    )
    if (!barRes.ok) return null
    const data = await barRes.json() as { bar?: { c: number; o: number; v: number } }
    if (!data.bar) return null

    return {
      symbol,
      price:      data.bar.c,
      change_pct: data.bar.o > 0 ? ((data.bar.c - data.bar.o) / data.bar.o) * 100 : 0,
      volume:     data.bar.v,
    }
  } catch {
    return null
  }
}

export async function getOpenOrders(): Promise<SchwabOrder[]> {
  const data = await get<Record<string, unknown>[]>('/orders?status=open')
  if (!data) return []

  return data.map((o) => ({
    order_id:        String(o.id ?? ''),
    symbol:          String(o.symbol ?? ''),
    asset_type:      'EQUITY',
    instruction:     (o.side === 'buy' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    quantity:        parseFloat(String(o.qty ?? 0)),
    filled_quantity: 0,
    price:           parseFloat(String(o.trail_percent ?? 0)),
    status:          'WORKING',
    entered_time:    String(o.submitted_at ?? ''),
    close_time:      null,
    order_type:      String(o.type ?? '').toUpperCase(),
  }))
}

export const MODE = IS_PAPER ? 'ALPACA_PAPER' : 'ALPACA_LIVE'
