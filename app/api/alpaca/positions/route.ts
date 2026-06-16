/**
 * GET /api/alpaca/positions — live positions from Alpaca paper account.
 * Applies entry_override_${symbol} corrections from tb_settings so that
 * positions with stale IEX fill prices (e.g. SPCX bought at $26 IEX vs $166 real)
 * display the correct real-market entry price and accurate P/L.
 */
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'

const BASE   = 'https://paper-api.alpaca.markets/v2'
const KEY_ID = process.env.ALPACA_KEY_ID!
const SECRET = process.env.ALPACA_SECRET_KEY!

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await fetch(`${BASE}/positions`, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET },
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ positions: [] })

    const raw = await res.json() as Record<string, string | number>[]

    // Read entry overrides (set by /api/alpaca/fix-entry) from tb_settings
    const symbols = raw.map((p) => String(p.symbol))
    const overrideKeys = symbols.map((s) => `entry_override_${s}`)
    const db = createServiceClient()
    const { data: overrideRows } = await db
      .from('tb_settings')
      .select('key, value')
      .in('key', overrideKeys)

    const overrides: Record<string, number> = {}
    for (const row of overrideRows ?? []) {
      try {
        const sym = row.key.replace('entry_override_', '')
        const val = JSON.parse(row.value) as { price: number }
        if (val.price > 0) overrides[sym] = val.price
      } catch { /* ignore */ }
    }

    const positions = raw.map((p) => {
      const symbol      = String(p.symbol)
      const isOption    = String(p.asset_class ?? '') === 'us_option' || /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(symbol)
      const qty         = parseFloat(String(p.qty ?? 0))
      const alpacaEntry = parseFloat(String(p.avg_entry_price ?? 0))
      const cur_price   = parseFloat(String(p.current_price ?? 0)) || alpacaEntry
      const market_val  = parseFloat(String(p.market_value ?? 0))
      const hasOverride = !isOption && !!overrides[symbol]

      const avg_cost = overrides[symbol] ?? alpacaEntry

      const unreal  = hasOverride
        ? (cur_price - avg_cost) * qty
        : parseFloat(String(p.unrealized_pl ?? 0))
      const pnl_pct = hasOverride
        ? (avg_cost > 0 ? ((cur_price - avg_cost) / avg_cost) * 100 : 0)
        : parseFloat(String(p.unrealized_plpc ?? 0)) * 100

      // Parse OCC symbol into a human-readable display name for options
      let displaySymbol = symbol
      let option_expiry: string | undefined
      if (isOption) {
        const m = symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
        if (m) {
          const [, und, yy, mm, dd, type, strikeRaw] = m
          const strike = parseInt(strikeRaw, 10) / 1000
          displaySymbol = `${und} $${strike % 1 === 0 ? strike.toFixed(0) : strike.toFixed(1)}${type} ${parseInt(mm)}/${parseInt(dd)}`
          option_expiry = `20${yy}-${mm}-${dd}`
        }
      }

      return {
        symbol:             displaySymbol,
        raw_symbol:         symbol,
        quantity:           qty,
        avg_cost,
        current_price:      cur_price,
        market_value:       market_val,
        unrealized_pnl:     Math.round(unreal * 100) / 100,
        unrealized_pnl_pct: Math.round(pnl_pct * 100) / 100,
        day_pnl:            parseFloat(String(p.unrealized_intraday_pl ?? 0)),
        pnl_pct:            Math.round(pnl_pct * 100) / 100,
        cost_basis:         avg_cost * qty,
        asset_type:         isOption ? 'OPTION' as const : 'EQUITY' as const,
        option_expiry,
        entry_corrected:    hasOverride,
      }
    })

    return NextResponse.json({ positions })
  } catch (e) {
    return NextResponse.json({ positions: [], error: String(e) })
  }
}
