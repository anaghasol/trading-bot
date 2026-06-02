import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getQuote } from '@/lib/schwab'

// GET /api/schwab/quotes?symbols=NVDA,AMD,PLTR  → live marks for the watchlist.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const symbols = (searchParams.get('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25)

  const quotes = await Promise.all(symbols.map((s) => getQuote(s).catch(() => null)))
  return NextResponse.json({ quotes: quotes.filter(Boolean) })
}
