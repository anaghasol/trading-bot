/**
 * Tests for Pavan signal parsing — this drives live exit behavior.
 *
 * 90% of his structured calls are marked "purchase type as: Investment",
 * meaning a multi-year thesis with a wide stop. The bot previously journaled
 * every one as hold_mode=swing and applied day-trade exit logic to them:
 * AA (a stated 2027-2028 hold) was rotated out at -0.7% ten minutes after entry.
 *
 * holdModeFor() is what keeps that from happening, so the mapping is pinned here.
 * Message text below is taken verbatim from the channel.
 */
import { parsePavan, holdModeFor } from '../lib/pavan-parse'

describe('parsePavan — structured entries', () => {
  const AA = 'Trade ID:10122 - Buying AA at 52.4 With SL of 49 Which has max risk of -6.49% for purchase type as: Investment. Additional Notes: One of the best Aluminium companies trading in USA. target is above 80$.'

  it('extracts the full structured call', () => {
    const p = parsePavan(AA)
    expect(p.kind).toBe('entry')
    expect(p.trade_id).toBe('10122')
    expect(p.symbol).toBe('AA')
    expect(p.entry_price).toBe(52.4)
    expect(p.stop_loss).toBe(49)
    expect(p.purchase_type).toBe('Investment')
    expect(p.risk_pct).toBe(-6.49)
  })

  it('maps Investment to a trend hold, not a swing', () => {
    expect(holdModeFor(parsePavan(AA).purchase_type)).toBe('trend')
  })

  it('maps an explicit Trade to swing', () => {
    const t = 'Trade ID:10140 - Buying WOLF at 28.6 With SL of 25.5 for purchase type as: Trade.'
    const p = parsePavan(t)
    expect(p.symbol).toBe('WOLF')
    expect(holdModeFor(p.purchase_type)).toBe('swing')
  })

  it('defaults to swing when he states no purchase type', () => {
    expect(holdModeFor(null)).toBe('swing')
    expect(holdModeFor(parsePavan('Buying XYZ at 10 with SL of 9').purchase_type)).toBe('swing')
  })

  it('treats a structured buy as an entry even when the notes discuss selling', () => {
    const p = parsePavan(
      'Trade ID:10121 - Buying HYLN at 3.9 With SL of 3.4 for purchase type as: Investment. ' +
      'Additional Notes: 9$ is T1 and T2 is 24$. Do not sell early, give it time.'
    )
    expect(p.kind).toBe('entry')
    expect(p.symbol).toBe('HYLN')
    expect(p.stop_loss).toBe(3.4)
  })
})

describe('parsePavan — exits and commentary', () => {
  it('classifies a plain exit', () => {
    expect(parsePavan('sold TEAM at $192').kind).toBe('exit')
    expect(parsePavan('We did book profits already from RBRK').kind).toBe('exit')
    expect(parsePavan('trim around 200 ish and we can rebuy lower levels').kind).toBe('exit')
  })

  it('classifies a hold', () => {
    expect(parsePavan('Trader recommends holding LPTH and watching its performance.').kind).toBe('hold')
  })

  it('classifies macro noise as commentary, not a signal', () => {
    expect(parsePavan('US inflation remains at 3.4%.').kind).toBe('commentary')
    expect(parsePavan('Good Morning Friends!').kind).toBe('commentary')
  })

  it('leaves price fields null when there is no structured call', () => {
    const p = parsePavan('AA tracking with 47$ stop.. on closing basis.')
    expect(p.symbol).toBeNull()
    expect(p.entry_price).toBeNull()
    expect(p.stop_loss).toBeNull()
  })
})
