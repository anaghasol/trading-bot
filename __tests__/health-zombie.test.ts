/**
 * Tests for the health cron zombie-position guard.
 *
 * Root cause: SWBI (Schwab) hit its stop → monitor marked tb_trades CLOSED
 * → but the actual Schwab sell order didn't clear the position → health found
 * SWBI still live at Schwab → auto-journaled as RECOVERED → monitor fired
 * stop-loss again → closed tb_trades again → repeat every 30 min all day.
 * Each cycle: phantom $-4 STOP_LOSS alert + real Schwab sell attempt.
 *
 * Fix: health cron now checks if the symbol was CLOSED in tb_trades within
 * the last 90 minutes before auto-journaling. If yes, it sends a TG alert
 * ("ZOMBIE position") and skips re-journaling.
 */

interface FakeTrade { symbol: string; status: string; closed_at?: string }

function isZombie(symbol: string, recentlyClosed: FakeTrade[], nowMs: number): boolean {
  const cutoffMs = nowMs - 90 * 60_000
  return recentlyClosed.some(
    t => t.symbol === symbol && t.status === 'CLOSED' && new Date(t.closed_at ?? 0).getTime() > cutoffMs
  )
}

describe('health cron zombie detection', () => {
  const now = Date.now()

  it('flags symbol closed 30 min ago as zombie', () => {
    const closed: FakeTrade[] = [{ symbol: 'SWBI', status: 'CLOSED', closed_at: new Date(now - 30 * 60_000).toISOString() }]
    expect(isZombie('SWBI', closed, now)).toBe(true)
  })

  it('flags symbol closed 89 min ago as zombie (within 90 min window)', () => {
    const closed: FakeTrade[] = [{ symbol: 'SWBI', status: 'CLOSED', closed_at: new Date(now - 89 * 60_000).toISOString() }]
    expect(isZombie('SWBI', closed, now)).toBe(true)
  })

  it('does NOT flag symbol closed 91 min ago (outside window)', () => {
    const closed: FakeTrade[] = [{ symbol: 'SWBI', status: 'CLOSED', closed_at: new Date(now - 91 * 60_000).toISOString() }]
    expect(isZombie('SWBI', closed, now)).toBe(false)
  })

  it('does NOT flag different symbol', () => {
    const closed: FakeTrade[] = [{ symbol: 'COIN', status: 'CLOSED', closed_at: new Date(now - 10 * 60_000).toISOString() }]
    expect(isZombie('SWBI', closed, now)).toBe(false)
  })

  it('does NOT flag when no recent closes', () => {
    expect(isZombie('SWBI', [], now)).toBe(false)
  })

  it('correctly identifies non-zombie when same symbol was closed long ago', () => {
    // SWBI closed yesterday — a fresh position today is legitimate
    const closed: FakeTrade[] = [{ symbol: 'SWBI', status: 'CLOSED', closed_at: new Date(now - 24 * 60 * 60_000).toISOString() }]
    expect(isZombie('SWBI', closed, now)).toBe(false)
  })
})
