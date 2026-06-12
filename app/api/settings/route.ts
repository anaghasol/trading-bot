/**
 * /api/settings — lightweight key/value read+write for UI-driven bot config.
 *
 * GET  ?key=xxx          → { key, value: string | null }
 * POST { key, value }    → upsert to tb_settings (allowlisted keys only)
 *
 * Used by Growth page "Strategy Boost" button to temporarily raise conviction
 * multiplier for a specific strategy type (read back by scan cron each tick).
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

// Only these keys may be written via this endpoint
const WRITE_ALLOWLIST = new Set(['strategy_boost', 'engine_schwab', 'engine_alpaca'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

  const db = createServiceClient()
  const { data } = await db.from('tb_settings').select('value').eq('key', key).single()
  return NextResponse.json({ key, value: data?.value ?? null })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body?.key || !WRITE_ALLOWLIST.has(body.key)) {
    return NextResponse.json({ error: 'key not allowed' }, { status: 400 })
  }

  const db = createServiceClient()
  await db.from('tb_settings').upsert({ key: body.key, value: body.value ?? '' })
  return NextResponse.json({ ok: true })
}
