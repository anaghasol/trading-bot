/**
 * Engine control — start/stop Schwab or Alpaca independently.
 * GET  /api/engine          → status of both
 * POST /api/engine          → {broker:'schwab'|'alpaca_paper', action:'start'|'stop'}
 */
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const { data } = await db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca'])

  const status = {
    schwab:       (data?.find((r) => r.key === 'engine_schwab')?.value ?? 'running') as 'running' | 'stopped',
    alpaca_paper: (data?.find((r) => r.key === 'engine_alpaca')?.value ?? 'running') as 'running' | 'stopped',
  }

  return NextResponse.json(status)
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { broker, action } = await req.json()
  if (!broker || !action) return NextResponse.json({ error: 'Missing broker or action' }, { status: 400 })

  const key  = broker === 'schwab' ? 'engine_schwab' : 'engine_alpaca'
  const value = action === 'start' ? 'running' : 'stopped'

  const db = createServiceClient()
  await db.from('tb_context').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

  await db.from('tb_alerts').insert({
    type: 'INFO',
    message: `Engine ${broker.toUpperCase()} ${action.toUpperCase()}PED by user`,
    broker: broker === 'schwab' ? 'schwab' : 'alpaca_paper',
  })

  return NextResponse.json({ broker, status: value })
}
