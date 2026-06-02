import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'

/**
 * Strategy-sleeve allocation, persisted in tb_context under key "sleeves".
 * No new table required — reuses the existing key/value context store.
 *   GET  /api/sleeves        → { alloc: { aggressive, short, little_long, long } }
 *   POST /api/sleeves { alloc } → { ok: true }
 */
const KEY = 'sleeves'
const DEFAULT = { aggressive: 40, short: 30, little_long: 20, long: 10 }

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const { data } = await db.from('tb_context').select('value').eq('key', KEY).single()

  let alloc = DEFAULT
  if (data?.value) {
    try { alloc = { ...DEFAULT, ...JSON.parse(data.value) } } catch { /* keep default */ }
  }
  return NextResponse.json({ alloc })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const alloc = { ...DEFAULT, ...(body?.alloc ?? {}) }

  const db = createServiceClient()
  await db.from('tb_context').upsert({ key: KEY, value: JSON.stringify(alloc) }, { onConflict: 'key' })

  return NextResponse.json({ ok: true, alloc })
}
