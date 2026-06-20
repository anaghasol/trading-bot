/**
 * Earnings calendar guard — uses Yahoo Finance quote response which includes
 * earningsTimestamp for the next scheduled earnings event.
 *
 * Buy guard:  skip stocks with earnings within SKIP_WINDOW_DAYS (default 2).
 * Stop guard: positions with earnings within TIGHTEN_WINDOW_DAYS (default 1)
 *             get a tighter trailing stop applied by the monitor.
 */

const SKIP_WINDOW_DAYS    = 2   // don't enter new positions this many days before/after earnings
const TIGHTEN_WINDOW_DAYS = 1   // tighten stop if earnings within this many days

interface EarningsInfo {
  symbol:        string
  earningsDate:  Date | null
  daysAway:      number | null  // negative = past earnings, positive = future
  hasSoon:       boolean        // within SKIP_WINDOW_DAYS
  approachingSoon: boolean      // within TIGHTEN_WINDOW_DAYS
}

/** Fetch earnings dates for a batch of symbols via Yahoo Finance.
 *  Returns a map of symbol → EarningsInfo. Symbols with no earnings data
 *  are included with earningsDate=null (treated as safe to trade). */
export async function batchEarningsCheck(symbols: string[]): Promise<Map<string, EarningsInfo>> {
  const result = new Map<string, EarningsInfo>()
  if (symbols.length === 0) return result

  // Yahoo Finance batch quote — up to 100 symbols per call, returns earningsTimestamp
  const chunks: string[][] = []
  for (let i = 0; i < symbols.length; i += 50) chunks.push(symbols.slice(i, i + 50))

  for (const chunk of chunks) {
    try {
      const qs  = chunk.map(encodeURIComponent).join(',')
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=earningsTimestamp,earningsTimestampStart,earningsTimestampEnd,symbol`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' },
      )
      if (!res.ok) {
        // On failure, mark all chunk symbols as safe (don't block trades on data outage)
        for (const sym of chunk) result.set(sym, safe(sym))
        continue
      }

      const data = await res.json() as {
        quoteResponse?: { result?: Array<{
          symbol: string
          earningsTimestamp?: number
          earningsTimestampStart?: number
          earningsTimestampEnd?: number
        }> }
      }

      const bySymbol = new Map((data.quoteResponse?.result ?? []).map((q) => [q.symbol, q]))

      for (const sym of chunk) {
        const q = bySymbol.get(sym)
        if (!q) { result.set(sym, safe(sym)); continue }

        // Use earningsTimestamp (confirmed date) first, fall back to estimate window midpoint
        const ts = q.earningsTimestamp
          ?? (q.earningsTimestampStart && q.earningsTimestampEnd
               ? Math.floor((q.earningsTimestampStart + q.earningsTimestampEnd) / 2)
               : null)

        if (!ts) { result.set(sym, safe(sym)); continue }

        const earningsDate = new Date(ts * 1000)
        const nowMs        = Date.now()
        const daysAway     = (earningsDate.getTime() - nowMs) / 86_400_000

        result.set(sym, {
          symbol:          sym,
          earningsDate,
          daysAway,
          hasSoon:         Math.abs(daysAway) <= SKIP_WINDOW_DAYS,
          approachingSoon: Math.abs(daysAway) <= TIGHTEN_WINDOW_DAYS,
        })
      }
    } catch {
      // Network error — mark all as safe, don't block trading
      for (const sym of chunk) result.set(sym, safe(sym))
    }
  }

  return result
}

function safe(symbol: string): EarningsInfo {
  return { symbol, earningsDate: null, daysAway: null, hasSoon: false, approachingSoon: false }
}

export function formatEarningsWarning(info: EarningsInfo): string {
  if (!info.earningsDate || info.daysAway == null) return ''
  const abs = Math.abs(info.daysAway)
  const dir = info.daysAway < 0 ? 'ago' : 'away'
  return `EARNINGS ${abs < 1 ? 'TODAY' : `${Math.ceil(abs)}d ${dir}`} (${info.earningsDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
}
