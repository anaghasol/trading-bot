/**
 * Schwab API client for Vercel serverless environment.
 * Tokens stored in Supabase public.tb_schwab_tokens; auto-refreshed before each call.
 */
import { createServiceClient } from './supabase-server'

const TOKEN_URL   = 'https://api.schwabapi.com/v1/oauth/token'
const API_BASE    = 'https://api.schwabapi.com/trader/v1'
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1'

const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID!
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET!
const REDIRECT_URI  = process.env.SCHWAB_REDIRECT_URI!

export interface Position {
  symbol: string
  quantity: number
  avg_cost: number
  current_price: number
  market_value: number
  unrealized_pnl: number
  pnl_pct: number
  peak_pnl: number
  asset_type: 'EQUITY' | 'OPTION'
}

export interface Quote {
  symbol: string
  price: number
  change_pct: number
  volume: number
}

export interface OrderResult {
  symbol: string
  quantity: number
  action: string
  status: 'PLACED' | 'FAILED'
  order_id?: string
}

export interface SchwabOrder {
  order_id: string
  symbol: string
  asset_type: string
  instruction: 'BUY' | 'SELL'
  quantity: number
  filled_quantity: number
  price: number
  status: string
  entered_time: string
  close_time: string | null
  order_type: string
}

export interface SchwabTransaction {
  transaction_id: string
  type: string
  symbol: string
  description: string
  amount: number
  quantity: number
  price: number
  date: string
}

// ── Token Management ──────────────────────────────────────────────────────────

async function getStoredTokens() {
  const db = createServiceClient()
  const { data } = await db
    .from('tb_schwab_tokens')
    .select('*')
    .eq('id', 1)
    .single()
  return data
}

async function saveTokens(tokens: {
  access_token: string
  refresh_token: string
  account_hash: string
  expiry: string
}) {
  const db = createServiceClient()
  await db.from('tb_schwab_tokens').upsert({
    id: 1,
    ...tokens,
    updated_at: new Date().toISOString(),
  })
}

async function refreshAccessToken(refreshToken: string, currentHash: string): Promise<string | null> {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  })

  if (!res.ok) {
    console.error(`[schwab] Token refresh failed: ${res.status}`)
    return null
  }

  const data = await res.json()
  const expiry = new Date(Date.now() + (data.expires_in - 60) * 1000).toISOString()

  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    account_hash: currentHash,
    expiry,
  })

  return data.access_token
}

async function getAccessToken(): Promise<string | null> {
  const stored = await getStoredTokens()
  if (!stored) return null

  const expiry = new Date(stored.expiry)
  const expiresIn5Min = new Date(Date.now() + 5 * 60 * 1000)

  if (expiry <= expiresIn5Min) {
    return refreshAccessToken(stored.refresh_token, stored.account_hash)
  }

  return stored.access_token
}

// ── HTTP Helpers ──────────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T | null> {
  const token = await getAccessToken()
  if (!token) return null

  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  })

  if (res.status === 401) {
    const stored = await getStoredTokens()
    if (!stored) return null
    const newToken = await refreshAccessToken(stored.refresh_token, stored.account_hash)
    if (!newToken) return null
    const retry = await fetch(path, {
      headers: { Authorization: `Bearer ${newToken}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    return retry.ok ? retry.json() : null
  }

  if (!res.ok) return null
  return res.json()
}

async function apiPost<T>(path: string, body: object): Promise<T | null> {
  const token = await getAccessToken()
  if (!token) return null

  const res = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.ok) {
    try { return await res.json() } catch { return { status: 'ok' } as T }
  }
  return null
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccountHash(): Promise<string | null> {
  const stored = await getStoredTokens()
  return stored?.account_hash || null
}

export async function getAccountBalance(): Promise<number | null> {
  const hash = await getAccountHash()
  if (!hash) return null

  const data = await apiGet<Record<string, unknown>>(
    `${API_BASE}/accounts/${hash}?fields=positions`
  )
  if (!data) return null

  const balances = (data.securitiesAccount as Record<string, unknown>)?.currentBalances as Record<string, number>
  return balances?.liquidationValue ?? null
}

export async function getPositions(): Promise<Position[]> {
  const hash = await getAccountHash()
  if (!hash) return []

  const data = await apiGet<Record<string, unknown>>(
    `${API_BASE}/accounts/${hash}?fields=positions`
  )
  if (!data) return []

  const rawPositions =
    ((data.securitiesAccount as Record<string, unknown>)?.positions as Record<string, unknown>[]) ?? []

  return rawPositions.map((pos) => {
    const instrument = pos.instrument as Record<string, unknown>
    const symbol = instrument.symbol as string
    const assetType: 'EQUITY' | 'OPTION' = (instrument.assetType as string) === 'OPTION' ? 'OPTION' : 'EQUITY'
    const longQty = (pos.longQuantity as number) || 0
    const shortQty = (pos.shortQuantity as number) || 0
    const quantity = longQty - shortQty
    const avg_cost = (pos.averagePrice as number) || 0
    const market_value = (pos.marketValue as number) || 0
    const current_price = quantity !== 0 ? market_value / Math.abs(quantity) : avg_cost
    const pnl_pct =
      avg_cost > 0
        ? ((current_price - avg_cost) / avg_cost) * 100 * (quantity < 0 ? -1 : 1)
        : 0

    return {
      symbol,
      quantity,
      avg_cost,
      current_price,
      market_value,
      unrealized_pnl: (pos.unrealizedProfitLoss as number) || 0,
      pnl_pct: Math.round(pnl_pct * 100) / 100,
      peak_pnl: 0,
      asset_type: assetType,
    }
  }).filter((p) => p.quantity !== 0)
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function placeOrder(
  symbol: string,
  quantity: number,
  action: 'BUY' | 'SELL',
  orderType: 'MARKET' | 'LIMIT' = 'MARKET',
  limitPrice?: number
): Promise<OrderResult> {
  const hash = await getAccountHash()
  if (!hash) return { symbol, quantity, action, status: 'FAILED' }

  const payload: Record<string, unknown> = {
    orderType,
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [
      {
        instruction: action,
        quantity,
        instrument: { symbol, assetType: 'EQUITY' },
      },
    ],
  }

  if (orderType === 'LIMIT' && limitPrice) {
    payload.price = limitPrice.toFixed(2)
  }

  const result = await apiPost<{ orderId?: string }>(
    `${API_BASE}/accounts/${hash}/orders`,
    payload
  )

  return {
    symbol,
    quantity,
    action,
    status: result !== null ? 'PLACED' : 'FAILED',
    order_id: result?.orderId,
  }
}

/**
 * Place BUY + immediately attach a GTC trailing-stop at Schwab level.
 * This fires INSTANTLY at the exchange — no 15-min cron gap for stops.
 *
 * Schwab TRAILING_STOP: trails 5% below highest price since order placed.
 * GTC = stays active until cancelled or filled.
 */
export async function placeBuyWithProtection(
  symbol: string,
  quantity: number,
  trailPct = 5.0
): Promise<{ buy: OrderResult; stop_order_id: string | null }> {
  const buy = await placeOrder(symbol, quantity, 'BUY', 'MARKET')

  if (buy.status !== 'PLACED') {
    return { buy, stop_order_id: null }
  }

  // Give Schwab 1s to process the fill
  await new Promise((r) => setTimeout(r, 1000))

  const hash = await getAccountHash()
  if (!hash) return { buy, stop_order_id: null }

  const stopPayload = {
    orderType:           'TRAILING_STOP',
    session:             'NORMAL',
    duration:            'GOOD_TILL_CANCEL',
    stopPriceLinkBasis:  'LAST',
    stopPriceLinkType:   'PERCENT',
    stopPriceOffset:     trailPct,
    orderStrategyType:   'SINGLE',
    orderLegCollection:  [{
      instruction: 'SELL',
      quantity,
      instrument:  { symbol, assetType: 'EQUITY' },
    }],
  }

  const stopResult = await apiPost<{ orderId?: string }>(
    `${API_BASE}/accounts/${hash}/orders`,
    stopPayload
  )

  const stop_order_id = stopResult?.orderId ? String(stopResult.orderId) : null
  console.log(`[schwab] Trailing stop placed for ${symbol}: order ${stop_order_id}`)

  return { buy, stop_order_id }
}

/**
 * Cancel an open order by order ID.
 * Used when we want to replace a trailing stop after a partial exit.
 */
export async function cancelOrder(order_id: string): Promise<boolean> {
  const hash = await getAccountHash()
  if (!hash) return false

  const token = await getAccessToken()
  if (!token) return false

  const res = await fetch(`${API_BASE}/accounts/${hash}/orders/${order_id}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  return res.ok
}

/**
 * Get all open/working orders for the account.
 * Used to check if a trailing stop is still active.
 */
export async function getOpenOrders(): Promise<SchwabOrder[]> {
  const hash = await getAccountHash()
  if (!hash) return []

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const to   = new Date().toISOString()

  const data = await apiGet<unknown[]>(
    `${API_BASE}/accounts/${hash}/orders?fromEnteredTime=${from}&toEnteredTime=${to}&status=WORKING`
  )
  if (!data || !Array.isArray(data)) return []

  return (data as Record<string, unknown>[]).flatMap((o) => {
    const legs = (o.orderLegCollection as Record<string, unknown>[]) ?? []
    return legs.map((leg) => {
      const inst = leg.instrument as Record<string, unknown>
      return {
        order_id:        String(o.orderId ?? ''),
        symbol:          String(inst?.symbol ?? ''),
        asset_type:      String(inst?.assetType ?? 'EQUITY'),
        instruction:     (leg.instruction as 'BUY' | 'SELL') ?? 'SELL',
        quantity:        Number(o.quantity ?? 0),
        filled_quantity: Number(o.filledQuantity ?? 0),
        price:           Number(o.price ?? 0),
        status:          String(o.status ?? ''),
        entered_time:    String(o.enteredTime ?? ''),
        close_time:      null,
        order_type:      String(o.orderType ?? ''),
      }
    })
  }).filter((o) => o.symbol)
}

// ── Market Data ───────────────────────────────────────────────────────────────

export async function getQuote(symbol: string): Promise<Quote | null> {
  const data = await apiGet<Record<string, unknown>>(
    `${MARKET_BASE}/quotes?symbols=${symbol}&fields=quote`
  )
  if (!data || !data[symbol]) return null

  const q = (data[symbol] as Record<string, unknown>).quote as Record<string, number>
  return {
    symbol,
    price: q.lastPrice || 0,
    change_pct: q.netPercentChangeInDouble || 0,
    volume: q.totalVolume || 0,
  }
}

// ── OAuth Flow ────────────────────────────────────────────────────────────────

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  })
  return `https://api.schwabapi.com/v1/oauth/authorize?${params}`
}

export async function exchangeAuthCode(code: string): Promise<boolean> {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  })

  if (!res.ok) return false

  const data = await res.json()
  const expiry = new Date(Date.now() + (data.expires_in - 60) * 1000).toISOString()

  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    account_hash: '',
    expiry,
  })

  await fetchAndSaveAccountHash(data.access_token)
  return true
}

async function fetchAndSaveAccountHash(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return

  const accounts: Array<{ accountNumber: string; hashValue: string }> = await res.json()
  const accountId = process.env.SCHWAB_ACCOUNT_ID!
  const match = accounts.find((a) => a.accountNumber === accountId)
  if (!match) return

  const stored = await getStoredTokens()
  if (stored) {
    await saveTokens({ ...stored, account_hash: match.hashValue })
  }
}

// ── Order & Transaction History (source of truth for dashboard) ───────────────

export async function getOrders(daysBack = 10): Promise<SchwabOrder[]> {
  const hash = await getAccountHash()
  if (!hash) return []

  // Schwab requires ISO 8601 with milliseconds
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const to   = new Date().toISOString()

  // Get all orders (no status filter — filter client side so we get everything)
  const data = await apiGet<unknown[]>(
    `${API_BASE}/accounts/${hash}/orders?fromEnteredTime=${from}&toEnteredTime=${to}&maxResults=100`
  )
  if (!data || !Array.isArray(data)) return []

  return (data as Record<string, unknown>[]).flatMap((o) => {
    if (o.status !== 'FILLED') return []     // only filled orders

    const legs = (o.orderLegCollection as Record<string, unknown>[]) ?? []

    // Get actual fill price from executionLegs (not the limit price)
    const actColl = o.orderActivityCollection as Record<string, unknown>[] | undefined
    const execLegs = actColl?.[0]?.executionLegs as Record<string, unknown>[] | undefined
    const fillPrice = Number(execLegs?.[0]?.price ?? o.price ?? 0)

    return legs.map((leg) => {
      const inst = leg.instrument as Record<string, unknown>
      return {
        order_id:        String(o.orderId ?? ''),
        symbol:          String(inst?.symbol ?? ''),
        asset_type:      String(inst?.assetType ?? 'EQUITY'),
        instruction:     (leg.instruction as 'BUY' | 'SELL') ?? 'BUY',
        quantity:        Number(o.quantity ?? 0),
        filled_quantity: Number(o.filledQuantity ?? 0),
        price:           fillPrice,
        status:          String(o.status ?? ''),
        entered_time:    String(o.enteredTime ?? o.closeTime ?? ''),
        close_time:      o.closeTime ? String(o.closeTime) : null,
        order_type:      String(o.orderType ?? 'MARKET'),
      }
    })
  }).filter((o) => o.symbol && o.filled_quantity > 0)
}

export async function getTransactions(daysBack = 30): Promise<SchwabTransaction[]> {
  const hash = await getAccountHash()
  if (!hash) return []

  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const to   = new Date().toISOString().split('T')[0]

  const data = await apiGet<unknown[]>(
    `${API_BASE}/accounts/${hash}/transactions?startDate=${from}&endDate=${to}&types=TRADE`
  )
  if (!data || !Array.isArray(data)) return []

  return (data as Record<string, unknown>[]).map((t) => {
    const inst = t.transferItems as Record<string, unknown>[] | undefined
    const item = inst?.[0]
    const instr = item?.instrument as Record<string, unknown> | undefined
    return {
      transaction_id: String(t.activityId ?? t.transactionId ?? ''),
      type:           String(t.type ?? ''),
      symbol:         String(instr?.symbol ?? ''),
      description:    String(t.description ?? ''),
      amount:         Number(t.netAmount ?? 0),
      quantity:       Number(item?.amount ?? 0),
      price:          Number(item?.price ?? 0),
      date:           String(t.tradeDate ?? t.settleDate ?? ''),
    }
  }).filter((t) => t.symbol)
}

// ── Account Summary + Funding Events (from schwab-additions.ts) ───────────────

export interface AccountSummary {
  account_value: number
  cash: number
  stock_buying_power: number
  option_buying_power: number
  day_trade_buying_power: number
  long_market_value: number
  equity: number
}

export async function getAccountSummary(): Promise<AccountSummary | null> {
  const hash = await getAccountHash()
  if (!hash) return null

  const data = await apiGet<Record<string, unknown>>(
    `${API_BASE}/accounts/${hash}?fields=positions`
  )
  if (!data) return null

  const sa   = (data.securitiesAccount as Record<string, unknown>) ?? {}
  const cur  = (sa.currentBalances   as Record<string, number>) ?? {}
  const proj = (sa.projectedBalances as Record<string, number>) ?? {}

  return {
    account_value:          cur.liquidationValue ?? cur.equity ?? 0,
    cash:                   cur.cashBalance ?? cur.cashAvailableForTrading ?? cur.totalCash ?? 0,
    stock_buying_power:     proj.buyingPower ?? cur.buyingPower ?? cur.cashAvailableForTrading ?? 0,
    option_buying_power:    cur.buyingPowerNonMarginableTrade ?? cur.buyingPower ?? 0,
    day_trade_buying_power: cur.dayTradingBuyingPower ?? 0,
    long_market_value:      cur.longMarketValue ?? 0,
    equity:                 cur.equity ?? cur.liquidationValue ?? 0,
  }
}

const FUNDING_TYPES = ['ACH_RECEIPT', 'CASH_RECEIPT', 'ELECTRONIC_FUND', 'WIRE_IN', 'JOURNAL', 'RECEIVE_AND_DELIVER']

export interface FundingEvent { date: string; type: string; amount: number; description: string }

export async function getFundingEvents(daysBack = 120): Promise<FundingEvent[]> {
  const hash = await getAccountHash()
  if (!hash) return []

  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const to   = new Date().toISOString().split('T')[0]

  const data = await apiGet<unknown[]>(
    `${API_BASE}/accounts/${hash}/transactions?startDate=${from}&endDate=${to}`
  )
  if (!data || !Array.isArray(data)) return []

  return (data as Record<string, unknown>[])
    .map((t) => ({
      date:        String(t.tradeDate ?? t.time ?? t.settleDate ?? ''),
      type:        String(t.type ?? ''),
      amount:      Number(t.netAmount ?? 0),
      description: String(t.description ?? ''),
    }))
    .filter((t) => FUNDING_TYPES.includes(t.type) && Math.abs(t.amount) > 0)
}
