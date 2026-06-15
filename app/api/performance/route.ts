import { NextResponse } from 'next/server'
import { getPerformanceStats } from '@/lib/performance'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const days   = parseInt(searchParams.get('days')   ?? '30', 10)
  const broker = searchParams.get('broker') ?? undefined  // 'schwab' | 'alpaca_paper' | undefined (all)

  const stats = await getPerformanceStats(days, broker)
  return NextResponse.json({ ...stats, broker: broker ?? 'all', days })
}
