/**
 * POST /api/alpaca/fix-entry { symbol: string }
 *
 * Corrects a wrong entry_price in tb_trades using the REAL market price
 * at the time of purchase (from Yahoo Finance historical 1m bars).
 *
 * Why: Alpaca paper fills at whatever the IEX feed shows. For stale/new
 * tickers like SPCX, IEX had $26 while real market was ~$166. Both our DB
 * and Alpaca's avg_entry_price are wrong. The fix: look up the buy timestamp
 * from tb_trades, then fetch Yahoo Finance 1m chart for that exact time.
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { symbol } = await req.json().catch(() => ({})) as { symbol?: string }
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })

  const db = createServiceClient()

  // 1. Find the open trade record for this symbol
  const { data: trades } = await db
    .from('tb_trades')
    .select('id, symbol, entry_price, quantity, created_at')
    .eq('symbol', symbol.toUpperCase())
    .eq('status', 'OPEN')
    .order('created_at', { ascending: false })
    .limit(1)

  const trade = trades?.[0]
  if (!trade) return NextResponse.json({ error: `No open trade found for ${symbol}` }, { status: 404 })

  const buyTime = new Date(trade.created_at)
  const old_price = parseFloat(String(trade.entry_price))

  // 2. Fetch Yahoo Finance 1m bars around the buy timestamp (±10 min window)
  const period1 = Math.floor((buyTime.getTime() - 10 * 60 * 1000) / 1000)
  const period2 = Math.floor((buyTime.getTime() + 10 * 60 * 1000) / 1000)

  let realPrice: number | null = null
  let priceTs: string | null = null

  try {
    const yhRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1m&period1=${period1}&period2=${period2}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (yhRes.ok) {
      const yhData = await yhRes.json()
      const chart = yhData?.chart?.result?.[0]
      const timestamps: number[] = chart?.timestamp ?? []
      const closes: number[]    = chart?.indicators?.quote?.[0]?.close ?? []

      if (timestamps.length > 0) {
        // Find the bar closest to buy time
        let bestIdx = 0
        let bestDiff = Infinity
        for (let i = 0; i < timestamps.length; i++) {
          const diff = Math.abs(timestamps[i] * 1000 - buyTime.getTime())
          if (diff < bestDiff) { bestDiff = diff; bestIdx = i }
        }
        const closePrice = closes[bestIdx]
        if (closePrice && closePrice > 0) {
          realPrice = Math.round(closePrice * 100) / 100
          priceTs   = new Date(timestamps[bestIdx] * 1000).toISOString()
        }
      }
    }
  } catch (e) {
    console.error('[fix-entry] Yahoo fetch error:', e)
  }

  // 3. If Yahoo returned no data in that narrow window, try a wider daily chart
  if (!realPrice) {
    try {
      const dateStr = buyTime.toISOString().slice(0, 10)
      const start   = Math.floor(new Date(dateStr + 'T13:00:00Z').getTime() / 1000) // 9am ET
      const end     = Math.floor(new Date(dateStr + 'T21:00:00Z').getTime() / 1000) // 5pm ET
      const yhRes2  = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1m&period1=${start}&period2=${end}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      if (yhRes2.ok) {
        const yhData2 = await yhRes2.json()
        const chart2 = yhData2?.chart?.result?.[0]
        const timestamps2: number[] = chart2?.timestamp ?? []
        const closes2: number[]     = chart2?.indicators?.quote?.[0]?.close ?? []

        if (timestamps2.length > 0) {
          let bestIdx2 = 0
          let bestDiff2 = Infinity
          for (let i = 0; i < timestamps2.length; i++) {
            const diff = Math.abs(timestamps2[i] * 1000 - buyTime.getTime())
            if (diff < bestDiff2) { bestDiff2 = diff; bestIdx2 = i }
          }
          const closePrice2 = closes2[bestIdx2]
          if (closePrice2 && closePrice2 > 0) {
            realPrice = Math.round(closePrice2 * 100) / 100
            priceTs   = new Date(timestamps2[bestIdx2] * 1000).toISOString()
          }
        }
      }
    } catch { /* ignore */ }
  }

  if (!realPrice) {
    return NextResponse.json({
      error: 'Could not fetch Yahoo Finance price for this symbol at buy time. Try setting manually.',
      buy_time: buyTime.toISOString(),
      old_price,
      symbol,
    }, { status: 422 })
  }

  // 4. Update tb_trades
  const { error: updateErr } = await db
    .from('tb_trades')
    .update({ entry_price: realPrice })
    .eq('id', trade.id)

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  // 5. Audit log
  await db.from('tb_alerts').insert({
    type: 'INFO',
    symbol: symbol.toUpperCase(),
    message: `[fix-entry] ${symbol} entry corrected: $${old_price.toFixed(2)} → $${realPrice.toFixed(2)} (Yahoo price at ${priceTs?.slice(11, 16)} UTC, buy recorded at ${buyTime.toISOString().slice(11, 16)} UTC)`,
  })

  return NextResponse.json({
    ok:        true,
    symbol:    symbol.toUpperCase(),
    buy_time:  buyTime.toISOString(),
    price_time: priceTs,
    old_price,
    new_price:  realPrice,
    trade_id:   trade.id,
  })
}
