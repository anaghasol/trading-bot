/**
 * GET /api/alpaca/orders?days=7 — order history from Alpaca paper account
 * Used by the dashboard Activity section when in paper mode.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const BASE   = 'https://paper-api.alpaca.markets/v2'
const KEY_ID = process.env.ALPACA_KEY_ID!
const SECRET = process.env.ALPACA_SECRET_KEY!

/** Parse OCC option symbol → human label */
function occLabel(occ: string): string {
  try {
    const m = occ.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
    if (!m) return occ
    const [, und, , mm, dd, type, strikeRaw] = m
    const strike = parseInt(strikeRaw, 10) / 1000
    return `${und} $${strike % 1 === 0 ? strike.toFixed(0) : strike.toFixed(1)}${type} ${parseInt(mm)}/${parseInt(dd)}`
  } catch { return occ }
}

/** Format a multi-leg spread order → readable label.
 *  Alpaca mleg orders have legs[] instead of a top-level symbol/qty. */
function formatMleg(o: Record<string, unknown>): { symbol: string; qty: number; instruction: string } {
  const legs = (o.legs as Record<string, unknown>[] | undefined) ?? []
  const shortLeg = legs.find((l) => String(l.side) === 'sell')
  const longLeg  = legs.find((l) => String(l.side) === 'buy')
  if (shortLeg && longLeg) {
    const shortLabel = occLabel(String(shortLeg.symbol ?? ''))
    const longLabel  = occLabel(String(longLeg.symbol ?? ''))
    const symbol = `${shortLabel} / ${longLabel.replace(/^[A-Z]+ /, '')}`
    return { symbol, qty: parseFloat(String(shortLeg.qty ?? 1)), instruction: 'SPREAD' }
  }
  const symbol = legs.map((l) => occLabel(String(l.symbol ?? ''))).join(' / ') || 'MLEG'
  return { symbol, qty: 1, instruction: 'SPREAD' }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const days  = parseInt(searchParams.get('days') ?? '7', 10)
  const after = new Date(Date.now() - days * 86_400_000).toISOString()

  try {
    const res = await fetch(
      `${BASE}/orders?status=all&after=${after}&limit=200&direction=desc`,
      { headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET }, cache: 'no-store' }
    )
    if (!res.ok) {
      console.error('[alpaca/orders]', res.status, await res.text())
      return NextResponse.json({ orders: [] })
    }

    const raw = await res.json() as Record<string, unknown>[]
    const orders = raw.map((o) => {
      const isMleg = String(o.order_class ?? '') === 'mleg'
      const mleg   = isMleg ? formatMleg(o) : null

      return {
        order_id:        String(o.id ?? ''),
        symbol:          mleg ? mleg.symbol : String(o.symbol ?? ''),
        instruction:     mleg ? mleg.instruction : String(o.side ?? 'buy').toUpperCase(),
        quantity:        mleg ? mleg.qty : parseFloat(String(o.qty ?? 0)),
        filled_quantity: mleg ? mleg.qty : parseFloat(String(o.filled_qty ?? 0)),
        price:           parseFloat(String(o.filled_avg_price ?? o.limit_price ?? 0)),
        status:          String(o.status ?? '').toUpperCase(),
        entered_time:    String(o.submitted_at ?? ''),
        close_time:      o.filled_at ? String(o.filled_at) : null,
        order_type:      isMleg ? 'SPREAD' : String(o.type ?? 'market').toUpperCase(),
        asset_type:      isMleg ? 'OPTION' : 'EQUITY',
      }
    })

    return NextResponse.json({ orders })
  } catch (e) {
    return NextResponse.json({ orders: [], error: String(e) })
  }
}
