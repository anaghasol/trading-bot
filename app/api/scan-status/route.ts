/**
 * GET /api/scan-status
 *
 * Returns the last scan snapshot for each broker from tb_settings.
 * The scan cron saves `last_scan_schwab` and `last_scan_alpaca_paper` after
 * every run. Dashboard polls this every 30s for the "Live Signals" card.
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()
  const { data } = await db
    .from('tb_settings')
    .select('key, value')
    .in('key', ['last_scan_schwab', 'last_scan_alpaca_paper'])

  const result: Record<string, unknown> = {}
  for (const row of data ?? []) {
    try {
      result[row.key.replace('last_scan_', '')] = JSON.parse(row.value as string)
    } catch { /* skip malformed row */ }
  }

  return NextResponse.json(result)
}
