/**
 * GET /api/quotes/stream?symbols=X,Y&broker=alpaca_paper|schwab
 *
 * Server-Sent Events stream — pushes live quote prices every 2s.
 * Browser subscribes with EventSource; no API keys exposed to client.
 *
 * Alpaca: quotes/latest bid/ask midpoint (SIP feed) — always current even
 *   for thin ETFs/stocks. trades/latest was stale for symbols that don't
 *   trade every tick (SPCX showed $199 vs Schwab $212 because the last
 *   actual trade was 20+ min ago; the live bid/ask is always current).
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
    // quotes/latest returns current bid/ask (NBBO equivalent) — always live even for
    // thin ETFs. trades/latest only updates when a trade actually executes, so it was
    // stale for low-volume symbols like SPCX.
    // Midpoint = (bid + ask) / 2 — matches what Schwab displays.
    const res = await fetch(
      `${ALPACA_DATA}/stocks/quotes/latest?symbols=${symbols.join(',')}&feed=sip`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }, cache: 'no-store',
        signal: AbortSignal.timeout(3000) }
    )
    if (!res.ok) return {}
    const data = await res.json() as { quotes?: Record<string, { bp: number; ap: number }> }
    const out: PriceMap = {}
    for (const [sym, q] of Object.entries(data.quotes ?? {})) {
      const bp = q.bp ?? 0, ap = q.ap ?? 0
      if (bp > 0 && ap > 0) {
        out[sym] = { price: Math.round((bp + ap) / 2 * 10000) / 10000, change_pct: 0 }
      }
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
