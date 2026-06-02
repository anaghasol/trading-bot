/**
 * Broker abstraction layer.
 * Set BROKER env var to switch between brokers with zero code change:
 *
 *   BROKER=schwab         → Schwab live trading ($2k real account)
 *   BROKER=alpaca_paper   → Alpaca paper trading (free, $100k fake money)
 *   BROKER=alpaca_live    → Alpaca live trading
 *
 * All cron routes import from here, not from schwab.ts or alpaca.ts directly.
 */

import * as Schwab from './schwab'
import * as Alpaca from './alpaca'
import type { Position, OrderResult, SchwabOrder } from './schwab'

export type { Position, OrderResult, SchwabOrder }

type Broker = 'schwab' | 'alpaca_paper' | 'alpaca_live'

function getBroker(): Broker {
  const b = (process.env.BROKER ?? 'schwab').toLowerCase() as Broker
  return b
}

export const BROKER_MODE = getBroker()
export const IS_PAPER = BROKER_MODE === 'alpaca_paper'
export const BROKER_LABEL = {
  schwab:       'Schwab Live',
  alpaca_paper: 'Alpaca Paper',
  alpaca_live:  'Alpaca Live',
}[BROKER_MODE]

// ── Unified API ───────────────────────────────────────────────────────────────

export async function getAccountBalance(): Promise<number | null> {
  return BROKER_MODE === 'schwab' ? Schwab.getAccountBalance() : Alpaca.getAccountBalance()
}

export async function getPositions(): Promise<Position[]> {
  return BROKER_MODE === 'schwab' ? Schwab.getPositions() : Alpaca.getPositions()
}

export async function placeOrder(
  symbol: string,
  quantity: number,
  action: 'BUY' | 'SELL',
  orderType: 'MARKET' | 'LIMIT' = 'MARKET',
  limitPrice?: number
): Promise<OrderResult> {
  return BROKER_MODE === 'schwab'
    ? Schwab.placeOrder(symbol, quantity, action, orderType, limitPrice)
    : Alpaca.placeOrder(symbol, quantity, action, orderType, limitPrice)
}

export async function placeBuyWithProtection(
  symbol: string,
  quantity: number,
  trailPct = 5.0
): Promise<{ buy: OrderResult; stop_order_id: string | null }> {
  return BROKER_MODE === 'schwab'
    ? Schwab.placeBuyWithProtection(symbol, quantity, trailPct)
    : Alpaca.placeBuyWithProtection(symbol, quantity, trailPct)
}

export async function cancelOrder(order_id: string): Promise<boolean> {
  return BROKER_MODE === 'schwab'
    ? Schwab.cancelOrder(order_id)
    : Alpaca.cancelOrder(order_id)
}

export async function getOrders(daysBack = 10): Promise<SchwabOrder[]> {
  return BROKER_MODE === 'schwab'
    ? Schwab.getOrders(daysBack)
    : Alpaca.getOrders(daysBack)
}

export async function getQuote(symbol: string) {
  return BROKER_MODE === 'schwab'
    ? Schwab.getQuote(symbol)
    : Alpaca.getQuote(symbol)
}

export async function getOpenOrders(): Promise<SchwabOrder[]> {
  return BROKER_MODE === 'schwab'
    ? Schwab.getOpenOrders()
    : Alpaca.getOpenOrders()
}
