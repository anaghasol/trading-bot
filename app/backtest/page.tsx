'use client'
import { useState } from 'react'
import Link from 'next/link'

const NAV: [string, string][] = [['/dashboard', 'Desk'], ['/backtest', '🧪 Backtest'], ['/dashboard', 'Growth'], ['/dashboard', 'Trades'], ['/settings', 'Settings']]

interface Params {
  gap_pct: number
  profit_pct: number
  stop_pct: number
  direction: 'both' | 'gap_up' | 'gap_down'
  days_back: number
}

interface Stats {
  trades: number; wins: number; losses: number; timeouts: number
  win_rate: number; avg_win_pct: number; avg_loss_pct: number
  profit_factor: number; total_pnl_pct: number; max_drawdown: number
  best_trade: number; worst_trade: number; avg_gap_pct: number
}

interface Trade {
  date: string; symbol: string; direction: string; gap_pct: number
  entry: number; exit: number; pnl_pct: number; result: string
}

interface EquityPoint { date: string; pnl: number }
interface SymbolStat { symbol: string; trades: number; wins: number; losses: number; win_rate: number; total_pnl_pct: number; profit_factor: number; avg_win_pct: number; avg_loss_pct: number }

interface BacktestResult {
  params: Params & { min_price: number; min_volume: number }
  symbols_tested: number
  days_back: number
  stats: Stats
  equity_curve: EquityPoint[]
  top_symbols: SymbolStat[]
  worst_symbols: SymbolStat[]
  recent_trades: Trade[]
}

const DEFAULT_SYMBOLS = [
  'NVDA', 'AMD', 'TSLA', 'MSTR', 'COIN', 'SMCI', 'META', 'AAPL', 'AMZN', 'MSFT',
  'GOOGL', 'ARM', 'PLTR', 'CRWD', 'SOFI', 'RIVN', 'MRVL', 'MU', 'INTC', 'NFLX',
  'SHOP', 'SQ', 'UPST', 'APP', 'ABNB', 'UBER', 'SNAP', 'SPOT', 'ZM', 'HOOD',
].join(', ')

export default function BacktestPage() {
  const [params, setParams] = useState<Params>({
    gap_pct: 8, profit_pct: 10, stop_pct: 5, direction: 'both', days_back: 180,
  })
  const [symbolsText, setSymbolsText] = useState(DEFAULT_SYMBOLS)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'symbols' | 'trades'>('overview')

  async function runBacktest() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const symbols = symbolsText.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'gap_fade', symbols, days_back: params.days_back, params }),
      })
      const data = await res.json() as BacktestResult & { error?: string }
      if (data.error) { setError(data.error); return }
      setResult(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const s = result?.stats

  // Mini equity curve — simple SVG sparkline
  function EquityCurve({ points }: { points: EquityPoint[] }) {
    if (points.length < 2) return null
    const vals = points.map((p) => p.pnl)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const range = max - min || 1
    const W = 500, H = 120, PAD = 8
    const xs = points.map((_, i) => PAD + (i / (points.length - 1)) * (W - PAD * 2))
    const ys = vals.map((v) => H - PAD - ((v - min) / range) * (H - PAD * 2))
    const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
    const area = `${path} L${xs[xs.length-1].toFixed(1)},${H} L${PAD},${H} Z`
    const isPositive = vals[vals.length - 1] >= 0
    const color = isPositive ? '#13c98e' : '#f0556a'
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 120, display: 'block' }}>
        <defs>
          <linearGradient id="ecg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Zero line */}
        {(() => { const zy = H - PAD - ((0 - min) / range) * (H - PAD * 2); return <line x1={PAD} y1={zy} x2={W - PAD} y2={zy} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" /> })()}
        <path d={area} fill="url(#ecg)" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    )
  }

  return (
    <div style={{ background: 'var(--bg-0)', minHeight: '100vh', color: 'var(--fg-0)', fontFamily: 'var(--font-sans)', fontSize: 14 }}>

      {/* Nav */}
      <header style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--border)', padding: '0 20px', display: 'flex', alignItems: 'center', gap: 16, height: 48 }}>
        <span style={{ fontWeight: 700, color: 'var(--green)', fontSize: 15, fontFamily: 'var(--font-mono)' }}>MyTrade</span>
        <nav className="desk-nav">
          {[['/dashboard','Desk'],['/backtest','🧪 Backtest'],['/settings','Settings']].map(([href, label]) => (
            <Link key={href} href={href} className={href === '/backtest' ? 'on' : ''}>{label}</Link>
          ))}
        </nav>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Strategy Backtester</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--fg-2)', fontSize: 13 }}>
            Gap Fade — Short stocks that gap up 8%+ overnight, long stocks that gap down. Mean reversion play.
          </p>
        </div>

        {/* Config panel */}
        <div className="card" style={{ marginBottom: 20, padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 16 }}>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Min Gap Size (%)</span>
              <input type="number" value={params.gap_pct} min={1} max={30} step={0.5}
                onChange={(e) => setParams({ ...params, gap_pct: parseFloat(e.target.value) })}
                style={inputStyle} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Only trade gaps ≥ this size</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Take Profit (%)</span>
              <input type="number" value={params.profit_pct} min={1} max={50} step={0.5}
                onChange={(e) => setParams({ ...params, profit_pct: parseFloat(e.target.value) })}
                style={inputStyle} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Close at this % gain</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Stop Loss (%)</span>
              <input type="number" value={params.stop_pct} min={1} max={30} step={0.5}
                onChange={(e) => setParams({ ...params, stop_pct: parseFloat(e.target.value) })}
                style={inputStyle} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Exit if wrong by this %</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Direction</span>
              <select value={params.direction} onChange={(e) => setParams({ ...params, direction: e.target.value as Params['direction'] })} style={inputStyle}>
                <option value="both">Both (gap up + gap down)</option>
                <option value="gap_up">Gap Up only (short)</option>
                <option value="gap_down">Gap Down only (long)</option>
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Lookback (days)</span>
              <input type="number" value={params.days_back} min={30} max={365} step={30}
                onChange={(e) => setParams({ ...params, days_back: parseInt(e.target.value) })}
                style={inputStyle} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Historical period to test</span>
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Symbols (comma-separated)</span>
            <textarea value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={runBacktest} disabled={loading}
              style={{ background: loading ? 'var(--bg-3)' : 'var(--green)', color: loading ? 'var(--fg-2)' : '#000', border: 'none', borderRadius: 8, padding: '10px 28px', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? '⏳ Running...' : '▶ Run Backtest'}
            </button>
            {result && <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>Tested {result.symbols_tested} symbols over {result.days_back} days · {result.stats.trades} gap events found</span>}
          </div>
          {error && <div style={{ marginTop: 12, color: 'var(--red)', fontSize: 13 }}>Error: {error}</div>}
        </div>

        {/* Strategy explanation */}
        {!result && !loading && (
          <div className="card" style={{ padding: 20, borderColor: 'var(--blue)', borderWidth: 1.5 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--blue)', marginBottom: 12 }}>📖 How Gap Fade Works (Kranthi&apos;s Strategy)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 8 }}>Gap Up → SHORT</div>
                <div style={{ color: 'var(--fg-2)', lineHeight: 1.7, fontSize: 13 }}>
                  Stock opens 8%+ above yesterday close<br/>
                  → Short at open price<br/>
                  → Take profit: price drops 10% from open<br/>
                  → Stop loss: price rises 5% from open<br/>
                  → Timeout: exit at day close if neither hit
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--green)', fontWeight: 600, marginBottom: 8 }}>Gap Down → LONG</div>
                <div style={{ color: 'var(--fg-2)', lineHeight: 1.7, fontSize: 13 }}>
                  Stock opens 8%+ below yesterday close<br/>
                  → Long at open price<br/>
                  → Take profit: price rises 10% from open<br/>
                  → Stop loss: price drops 5% from open<br/>
                  → Timeout: exit at day close if neither hit
                </div>
              </div>
            </div>
            <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--bg-3)', borderRadius: 8, fontSize: 12, color: 'var(--fg-2)' }}>
              <b>Note:</b> Simulation uses daily OHLCV (open/high/low/close). Intraday order of high vs low is unknown — when both profit target and stop were hit same day, we conservatively record a loss. Real results with intraday data may be better.
            </div>
          </div>
        )}

        {/* Results */}
        {result && s && (
          <>
            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
              {[
                { label: 'Total Trades', value: s.trades, fmt: (v: number) => v.toString() },
                { label: 'Win Rate', value: s.win_rate, fmt: (v: number) => `${v}%`, color: s.win_rate >= 55 ? 'var(--green)' : s.win_rate >= 45 ? 'var(--fg-0)' : 'var(--red)' },
                { label: 'Profit Factor', value: s.profit_factor, fmt: (v: number) => v.toFixed(2), color: s.profit_factor >= 1.5 ? 'var(--green)' : s.profit_factor >= 1 ? 'var(--fg-0)' : 'var(--red)' },
                { label: 'Total P&L', value: s.total_pnl_pct, fmt: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, color: s.total_pnl_pct >= 0 ? 'var(--green)' : 'var(--red)' },
                { label: 'Avg Win', value: s.avg_win_pct, fmt: (v: number) => `+${v.toFixed(1)}%`, color: 'var(--green)' },
                { label: 'Avg Loss', value: s.avg_loss_pct, fmt: (v: number) => `-${v.toFixed(1)}%`, color: 'var(--red)' },
                { label: 'Max Drawdown', value: s.max_drawdown, fmt: (v: number) => `-${v.toFixed(1)}%`, color: 'var(--red)' },
                { label: 'Avg Gap', value: s.avg_gap_pct, fmt: (v: number) => `${v.toFixed(1)}%` },
              ].map(({ label, value, fmt, color }) => (
                <div key={label} className="card" style={{ padding: '12px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: color ?? 'var(--fg-0)' }}>{fmt(value)}</div>
                </div>
              ))}
            </div>

            {/* Equity curve */}
            {result.equity_curve.length > 1 && (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>Cumulative P&L</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>Equal-weighted per trade · {result.equity_curve.length} trading days</span>
                </div>
                <div style={{ padding: '8px 0' }}>
                  <EquityCurve points={result.equity_curve} />
                </div>
                <div style={{ padding: '6px 16px 12px', display: 'flex', gap: 20, fontSize: 12, color: 'var(--fg-2)' }}>
                  <span>Start: {result.equity_curve[0]?.date}</span>
                  <span>End: {result.equity_curve[result.equity_curve.length - 1]?.date}</span>
                  <span style={{ color: result.equity_curve[result.equity_curve.length - 1]?.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    Final: {result.equity_curve[result.equity_curve.length - 1]?.pnl > 0 ? '+' : ''}{result.equity_curve[result.equity_curve.length - 1]?.pnl.toFixed(1)}%
                  </span>
                </div>
              </div>
            )}

            {/* Sub tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {(['overview', 'symbols', 'trades'] as const).map((tab) => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: activeTab === tab ? 'var(--green-faint)' : 'var(--bg-2)', color: activeTab === tab ? 'var(--green)' : 'var(--fg-2)', cursor: 'pointer', fontSize: 13, fontWeight: activeTab === tab ? 600 : 400, textTransform: 'capitalize' }}>
                  {tab === 'overview' ? 'Summary' : tab === 'symbols' ? `By Symbol (${result.top_symbols.length})` : `Trades (${result.stats.trades})`}
                </button>
              ))}
            </div>

            {/* Summary */}
            {activeTab === 'overview' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="card">
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, color: 'var(--green)' }}>Top Performers</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                      <th style={th}>Symbol</th><th style={th}>Trades</th><th style={th}>WR</th><th style={th}>P&L%</th><th style={th}>PF</th>
                    </tr></thead>
                    <tbody>
                      {result.top_symbols.map((sym) => (
                        <tr key={sym.symbol} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={td}><b>{sym.symbol}</b></td>
                          <td style={td}>{sym.trades}</td>
                          <td style={{ ...td, color: sym.win_rate >= 55 ? 'var(--green)' : sym.win_rate < 40 ? 'var(--red)' : 'var(--fg-0)' }}>{sym.win_rate}%</td>
                          <td style={{ ...td, color: sym.total_pnl_pct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>{sym.total_pnl_pct > 0 ? '+' : ''}{sym.total_pnl_pct.toFixed(1)}%</td>
                          <td style={{ ...td, color: sym.profit_factor >= 1.5 ? 'var(--green)' : 'var(--fg-0)', fontFamily: 'var(--font-mono)' }}>{sym.profit_factor.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="card">
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, color: 'var(--red)' }}>Worst Performers</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                      <th style={th}>Symbol</th><th style={th}>Trades</th><th style={th}>WR</th><th style={th}>P&L%</th><th style={th}>PF</th>
                    </tr></thead>
                    <tbody>
                      {result.worst_symbols.map((sym) => (
                        <tr key={sym.symbol} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={td}><b>{sym.symbol}</b></td>
                          <td style={td}>{sym.trades}</td>
                          <td style={{ ...td, color: sym.win_rate >= 55 ? 'var(--green)' : sym.win_rate < 40 ? 'var(--red)' : 'var(--fg-0)' }}>{sym.win_rate}%</td>
                          <td style={{ ...td, color: sym.total_pnl_pct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>{sym.total_pnl_pct > 0 ? '+' : ''}{sym.total_pnl_pct.toFixed(1)}%</td>
                          <td style={{ ...td, color: sym.profit_factor >= 1.5 ? 'var(--green)' : 'var(--fg-0)', fontFamily: 'var(--font-mono)' }}>{sym.profit_factor.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* By symbol */}
            {activeTab === 'symbols' && (
              <div className="card" style={{ overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ color: 'var(--fg-2)', fontSize: 12, background: 'var(--bg-3)' }}>
                    <th style={th}>Symbol</th><th style={th}>Trades</th><th style={th}>W</th><th style={th}>L</th><th style={th}>Win Rate</th><th style={th}>Avg Win</th><th style={th}>Avg Loss</th><th style={th}>Total P&L</th><th style={th}>Prof Factor</th>
                  </tr></thead>
                  <tbody>
                    {[...result.top_symbols, ...result.worst_symbols].sort((a, b) => b.total_pnl_pct - a.total_pnl_pct).map((sym) => (
                      <tr key={sym.symbol} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...td, fontWeight: 600 }}>{sym.symbol}</td>
                        <td style={td}>{sym.trades}</td>
                        <td style={{ ...td, color: 'var(--green)' }}>{sym.wins}</td>
                        <td style={{ ...td, color: 'var(--red)' }}>{sym.losses ?? sym.trades - sym.wins}</td>
                        <td style={{ ...td, color: sym.win_rate >= 55 ? 'var(--green)' : sym.win_rate < 40 ? 'var(--red)' : 'var(--fg-0)' }}>{sym.win_rate}%</td>
                        <td style={{ ...td, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>+{sym.avg_win_pct?.toFixed(1) ?? '—'}%</td>
                        <td style={{ ...td, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>-{sym.avg_loss_pct?.toFixed(1) ?? '—'}%</td>
                        <td style={{ ...td, color: sym.total_pnl_pct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{sym.total_pnl_pct > 0 ? '+' : ''}{sym.total_pnl_pct.toFixed(1)}%</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', color: sym.profit_factor >= 1.5 ? 'var(--green)' : sym.profit_factor < 1 ? 'var(--red)' : 'var(--fg-0)' }}>{sym.profit_factor.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Trades */}
            {activeTab === 'trades' && (
              <div className="card" style={{ overflow: 'auto' }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--fg-2)' }}>
                  Showing most recent 50 trades of {result.stats.trades} total
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ color: 'var(--fg-2)', background: 'var(--bg-3)' }}>
                    <th style={th}>Date</th><th style={th}>Symbol</th><th style={th}>Dir</th><th style={th}>Gap</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>P&L</th><th style={th}>Result</th>
                  </tr></thead>
                  <tbody>
                    {result.recent_trades.map((t, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...td, color: 'var(--fg-2)' }}>{t.date}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{t.symbol}</td>
                        <td style={{ ...td, color: t.direction === 'SHORT' ? 'var(--red)' : 'var(--green)', fontFamily: 'var(--font-mono)' }}>{t.direction}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{t.gap_pct.toFixed(1)}%</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>${t.entry.toFixed(2)}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>${t.exit.toFixed(2)}</td>
                        <td style={{ ...td, color: t.pnl_pct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{t.pnl_pct > 0 ? '+' : ''}{t.pnl_pct.toFixed(1)}%</td>
                        <td style={td}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                            background: t.result === 'WIN' ? 'var(--green-dim)' : t.result === 'LOSS' ? 'var(--red-dim)' : 'var(--bg-3)',
                            color: t.result === 'WIN' ? 'var(--green)' : t.result === 'LOSS' ? 'var(--red)' : 'var(--fg-2)' }}>
                            {t.result}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg-0)',
  padding: '7px 10px', fontSize: 14, fontFamily: 'var(--font-sans)', width: '100%', boxSizing: 'border-box',
}
const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontWeight: 500, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '8px 12px', whiteSpace: 'nowrap' }
