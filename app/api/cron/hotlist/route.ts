/**
 * Hot List Cron — runs every 30 min during market hours (vercel.json schedule)
 *
 * Fetches Alpaca snapshots for the ~260-symbol SUPERCYCLE_UNIVERSE, ranks by
 * intraday momentum (change%) × volume surge vs yesterday. Top 50 gainers
 * stored as HOT_LIST in tb_alerts, replacing previous batch.
 *
 * The daily scan cron picks these up and adds +6 confidence to hot symbols
 * before the gate — catching momentum breakouts the static AI scan might miss.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { SUPERCYCLE_UNIVERSE } from '@/lib/supercycle'

export const runtime = 'nodejs'
export const maxDuration = 30

const ALPACA_DATA = 'https://data.alpaca.markets'

interface Snapshot {
  dailyBar?:     { c: number; v: number }
  prevDailyBar?: { c: number; v: number }
  latestTrade?:  { p: number }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Market hours gate: 9:25 AM – 4:15 PM ET, Mon–Fri
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const day = et.getDay()
  const etMins = et.getHours() * 60 + et.getMinutes()
  if (day === 0 || day === 6 || etMins < 565 || etMins > 975) {
    return NextResponse.json({ status: 'skipped', reason: 'market_closed' })
  }

  const db = createServiceClient()
  const headers = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }

  // Skip ETFs/benchmarks — only rank individual stocks
  const universe = SUPERCYCLE_UNIVERSE.filter(s => !['SPY', 'QQQ', 'IWM'].includes(s))

  const snaps: Record<string, Snapshot> = {}
  const BATCH = 100

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH)
    try {
      const res = await fetch(
        `${ALPACA_DATA}/v2/stocks/snapshots?symbols=${batch.join(',')}&feed=sip`,
        { headers, signal: AbortSignal.timeout(10000) }
      )
      if (res.ok) {
        const data = await res.json() as Record<string, Snapshot>
        Object.assign(snaps, data)
      }
    } catch { /* skip batch on timeout — non-fatal */ }
  }

  // Rank by intraday momentum × volume surge
  const items: { symbol: string; price: number; change_pct: number; vol_ratio: number; hot_score: number }[] = []

  for (const [sym, snap] of Object.entries(snaps)) {
    const price    = snap.latestTrade?.p ?? snap.dailyBar?.c ?? 0
    const prevClose = snap.prevDailyBar?.c ?? 0
    const todayVol  = snap.dailyBar?.v ?? 0
    const prevVol   = snap.prevDailyBar?.v ?? 1

    if (price < 5 || prevClose <= 0 || todayVol === 0) continue

    const change_pct = (price - prevClose) / prevClose * 100
    if (change_pct <= 0.3) continue  // filter noise / flat movers

    const vol_ratio = todayVol / prevVol

    // 65% momentum + 35% volume surge, both capped at 1.0 before weighting
    const hot_score = Math.round(
      (0.65 * Math.min(change_pct / 10, 1) + 0.35 * Math.min(vol_ratio / 3, 1)) * 100
    ) / 100

    items.push({
      symbol:     sym,
      price:      Math.round(price * 100) / 100,
      change_pct: Math.round(change_pct * 100) / 100,
      vol_ratio:  Math.round(vol_ratio * 100) / 100,
      hot_score,
    })
  }

  items.sort((a, b) => b.hot_score - a.hot_score)
  const top = items.slice(0, 50)

  if (top.length === 0) {
    return NextResponse.json({ status: 'ok', count: 0, reason: 'no gainers found' })
  }

  // Atomic replace — wipe old then insert fresh batch
  await db.from('tb_alerts').delete().eq('type', 'HOT_LIST')
  await db.from('tb_alerts').insert(
    top.map(h => ({
      type:    'HOT_LIST',
      symbol:  h.symbol,
      broker:  'alpaca_paper',
      message: JSON.stringify({
        price:      h.price,
        change_pct: h.change_pct,
        vol_ratio:  h.vol_ratio,
        hot_score:  h.hot_score,
      }),
    }))
  )

  return NextResponse.json({
    status: 'ok',
    count:  top.length,
    top5:   top.slice(0, 5).map(h => `${h.symbol} +${h.change_pct.toFixed(1)}% vol${h.vol_ratio.toFixed(1)}×`),
  })
}
