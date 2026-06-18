/**
 * Tests for Alpaca broker — specifically the closePosition DELETE endpoint
 * and OCC symbol detection in placeOrder. These test the exact bugs that
 * caused broken close buttons and naked shorts in prod.
 */

// Mock fetch before importing the module
const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

// Env vars required by alpaca.ts
process.env.ALPACA_KEY_ID = 'test-key'
process.env.ALPACA_SECRET_KEY = 'test-secret'
process.env.ALPACA_PAPER = 'true'

// We test the OCC + closePosition behaviour directly by inspecting what fetch is called with
// Import after setting up env + fetch mock
import { isOccSymbol } from '../lib/options-exit'

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2'

function mockAlpacaOk(body: unknown = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response)
}

function mockAlpacaFail() {
  mockFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as Response)
}

describe('closePosition via DELETE endpoint', () => {
  beforeEach(() => {
    jest.resetModules()
    mockFetch.mockReset()
  })

  it('calls DELETE /positions/{symbol} for a stock', async () => {
    mockAlpacaOk({ id: 'order-1', status: 'accepted' })
    const { closePosition } = await import('../lib/alpaca')
    const result = await closePosition('COIN')
    expect(mockFetch).toHaveBeenCalledWith(
      `${ALPACA_BASE}/positions/COIN`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result.status).toBe('PLACED')
  })

  it('URL-encodes the OCC symbol (slashes would break URL)', async () => {
    mockAlpacaOk({ id: 'order-2', status: 'accepted' })
    const { closePosition } = await import('../lib/alpaca')
    await closePosition('AMD260724P00485000')
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0]
    // OCC symbols have no special chars, but encoding must not corrupt it
    expect(calledUrl).toContain('AMD260724P00485000')
    expect(calledUrl).not.toContain(' ')
  })

  it('returns FAILED if Alpaca responds with non-ok', async () => {
    mockAlpacaFail()
    const { closePosition } = await import('../lib/alpaca')
    const result = await closePosition('COIN')
    expect(result.status).toBe('FAILED')
    expect(result.error).toMatch(/close position failed/i)
  })

  it('returns PLACED with action SELL', async () => {
    mockAlpacaOk({ id: 'order-3', status: 'accepted' })
    const { closePosition } = await import('../lib/alpaca')
    const result = await closePosition('NVDA')
    expect(result.action).toBe('SELL')
  })
})

describe('placeOrder OCC side detection', () => {
  beforeEach(() => {
    jest.resetModules()
    mockFetch.mockReset()
  })

  it('sends buy_to_open for BUY on an OCC symbol', async () => {
    mockAlpacaOk({ id: 'o1', status: 'accepted', filled_qty: '1' })
    const { placeOrder } = await import('../lib/alpaca')
    await placeOrder('AMD260724P00485000', 1, 'BUY')
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.side).toBe('buy_to_open')
    expect(body.type).toBe('market')
    expect(body.symbol).toBe('AMD260724P00485000')
  })

  it('sends sell_to_close for SELL on an OCC symbol', async () => {
    mockAlpacaOk({ id: 'o2', status: 'accepted', filled_qty: '1' })
    const { placeOrder } = await import('../lib/alpaca')
    await placeOrder('AMD260724P00485000', 1, 'SELL')
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.side).toBe('sell_to_close')
  })

  it('sends buy for BUY on a plain stock symbol', async () => {
    mockAlpacaOk({ id: 'o3', status: 'accepted', filled_qty: '10' })
    const { placeOrder } = await import('../lib/alpaca')
    await placeOrder('COIN', 10, 'BUY')
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.side).toBe('buy')
  })

  it('sends sell for SELL on a plain stock symbol', async () => {
    mockAlpacaOk({ id: 'o4', status: 'accepted', filled_qty: '10' })
    const { placeOrder } = await import('../lib/alpaca')
    await placeOrder('COIN', 10, 'SELL')
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.side).toBe('sell')
  })
})

// Spot-check OCC regex via the shared utility (same regex used in alpaca.ts)
describe('OCC symbol regex (shared with lib/options-exit)', () => {
  const validSymbols = [
    'AMD260724P00485000',
    'NVDA260815C00900000',
    'SPY260718C00520000',
    'TSLA260619P00200000',
  ]
  const invalidSymbols = ['AMD', 'AAPL', 'COIN', '', 'AMD26724P00485000']

  validSymbols.forEach(sym => {
    it(`accepts ${sym}`, () => expect(isOccSymbol(sym)).toBe(true))
  })
  invalidSymbols.forEach(sym => {
    it(`rejects "${sym}"`, () => expect(isOccSymbol(sym)).toBe(false))
  })
})
