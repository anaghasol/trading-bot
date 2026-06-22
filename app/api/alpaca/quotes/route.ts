import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getQuote } from '@/lib/alpaca'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const symbols = (searchParams.get('symbols') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  if (symbols.length === 0) return NextResponse.json({ quotes: [] })

  const results = await Promise.all(
    symbols.map(async (sym) => {
      const q = await getQuote(sym)
      return q ? { symbol: sym, price: q.price, change_pct: q.change_pct } : null
    })
  )

  return NextResponse.json({ quotes: results.filter(Boolean) })
}
