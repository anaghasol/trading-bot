/**
 * GET /api/quotes/stream?symbols=X,Y&broker=alpaca_paper|schwab
 *
 * Server-Sent Events stream — pushes live quote prices every 2s.
 * Browser subscribes with EventSource; no API keys exposed to client.
 *
 * Alpaca: bulk trades/latest (IEX feed, free, sub-second data)
 * Schwab: parallel getQuote() calls (no public streaming API, 2s poll)
 *
 * Vercel Pro streams up to 300s; EventSource auto-reconnects on close.
 */
import { getQuote as schwabQuote } from '@/lib/schwab'

export const runtime    = 'nodejs'
export const maxDuration = 290   // just under Vercel 300s limit

const ALPACA_DATA = 'https://data.alpaca.markets/v2'
const KEY  = process.env.ALPACA_KEY_ID    ?? ''
const SEC  = process.env.ALPACA_SECRET_KEY ?? ''

type PriceMap = Record<string, { price: number; change_pct: number }>

async function alpacaPrices(symbols: string[]): Promise<PriceMap> {
  try {
    // Bulk latest-trade prices — faster and cheaper than bar endpoint
    const res = await fetch(
      `${ALPACA_DATA}/stocks/trades/latest?symbols=${symbols.join(',')}&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }, cache: 'no-store',
        signal: AbortSignal.timeout(3000) }
    )
    if (!res.ok) return {}
    const data = await res.json() as { trades?: Record<string, { p: number; s: number; t: string }> }
    const out: PriceMap = {}
    for (const [sym, t] of Object.entries(data.trades ?? {})) {
      out[sym] = { price: t.p, change_pct: 0 }
    }
    return out
  } catch { return {} }
}

async function schwabPrices(symbols: string[]): Promise<PriceMap> {
  try {
    const results = await Promise.allSettled(symbols.map((s) => schwabQuote(s)))
    const out: PriceMap = {}
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        out[r.value.symbol] = { price: r.value.price, change_pct: r.value.change_pct }
      }
    }
    return out
  } catch { return {} }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbols = (searchParams.get('symbols') ?? '')
    .split(',').map((s) => s.trim()).filter((s) => /^[A-Z]{1,10}$/.test(s)).slice(0, 30)
  const broker = searchParams.get('broker') ?? 'alpaca_paper'

  if (symbols.length === 0) return new Response('no symbols', { status: 400 })

  const enc = new TextEncoder()
  let closed = false
  req.signal.addEventListener('abort', () => { closed = true })

  const stream = new ReadableStream({
    async start(controller) {
      const push = (prices: PriceMap) => {
        if (closed) return
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(prices)}\n\n`)) }
        catch { closed = true }
      }

      // Send initial ping so client knows connection is live
      push({})

      while (!closed) {
        const prices = broker === 'schwab'
          ? await schwabPrices(symbols)
          : await alpacaPrices(symbols)

        if (Object.keys(prices).length > 0) push(prices)

        // 2s cadence during market hours — fast enough to feel live
        await new Promise((r) => setTimeout(r, 2000))
      }

      try { controller.close() } catch { /* already closed */ }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering on Vercel
    },
  })
}
