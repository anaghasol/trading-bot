'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer
} from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────
interface PdtStatus {
  day_trades_used: number; day_trades_remaining: number; can_day_trade: boolean
  is_swing_mode: boolean; balance: number; is_pdt_protected: boolean
  today_trades: string[]
}

interface DashboardData {
  account: { balance: number; daily_pnl: number; total_pnl: number } | null
  trades: Trade[]
  alerts: Alert[]
  daily_summary: DaySummary[]
  cron_log: CronEntry[]
  pnl_chart: PnlPoint[]
  market_open: boolean
  positions?: Position[]
}

interface Trade {
  id: number; symbol: string; action: string; quantity: number
  entry_price: number; exit_price: number | null; pnl: number; pnl_pct: number
  status: string; strategy: string; confidence: number; reason: string
  created_at: string; closed_at: string | null
}

interface Alert {
  id: number; type: string; message: string; symbol: string | null
  pnl: number | null; is_read: boolean; created_at: string
}

interface DaySummary {
  date: string; daily_pnl: number; wins: number; losses: number
  win_rate: number; ending_balance: number
}

interface CronEntry {
  id: number; job: string; status: string; message: string; created_at: string
}

interface PnlPoint { hour: number; daily_pnl: number; balance: number }

interface Position {
  symbol: string; quantity: number; avg_cost: number
  current_price: number; pnl_pct: number; unrealized_pnl: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pnlStr(n: number) { return (n >= 0 ? '+' : '−') + fmt(n) }
function pnlColor(n: number) { return n >= 0 ? 'var(--green)' : 'var(--red)' }
function confLevel(c: number) { return c >= 75 ? 'high' : c >= 60 ? 'medium' : 'low' }

// ── Sub-components ─────────────────────────────────────────────────────────────

function MetricBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="metric-box">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

function PositionsCard({ positions }: { positions: Position[] }) {
  const [closing, setClosing] = useState<string | null>(null)

  async function closePosition(symbol: string, quantity: number) {
    setClosing(symbol)
    await fetch('/api/schwab/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, quantity: Math.abs(quantity), action: 'SELL' }),
    })
    setClosing(null)
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h7l4 9 4-9h3"/><path d="M3 21h18"/></svg>
          Open Positions
        </h3>
        <span className="faint" style={{ fontSize: '0.8rem' }}>{positions.length} active</span>
      </div>
      <div className="card-body">
        {positions.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: '12px 0', margin: 0 }}>No open positions — bot scanning…</p>
        ) : positions.map((p) => (
          <div className="data-row" key={p.symbol}
            style={{ gridTemplateColumns: '1.2fr .8fr 1fr 1fr 1fr 1fr' }}>
            <div className="tabular" style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--blue)' }}>{p.symbol}</div>
            <div><span className="muted">qty </span><span className="tabular">{p.quantity}</span></div>
            <div><span className="muted">avg </span><span className="tabular">${p.avg_cost.toFixed(2)}</span></div>
            <div><span className="muted">cur </span><span className="tabular">${p.current_price.toFixed(2)}</span></div>
            <div className="tabular" style={{ fontWeight: 700, color: pnlColor(p.unrealized_pnl) }}>
              {pnlStr(p.unrealized_pnl)}
            </div>
            <div>
              <button
                onClick={() => closePosition(p.symbol, p.quantity)}
                disabled={closing === p.symbol}
                className="btn red sm"
              >
                {closing === p.symbol ? '…' : 'Close'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MarketScannerCard({ trades }: { trades: Trade[] }) {
  const recent = trades.filter((t) => t.status === 'OPEN').slice(0, 6)
  return (
    <div className="card">
      <div className="card-head"><h3 className="card-title">AI Signals</h3></div>
      <div className="card-body">
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '12px 0' }}>No signals yet today</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {recent.map((t) => (
              <div className={`scan-card ${t.action.toLowerCase() === 'buy' ? 'buy' : 'sell'}`} key={t.id}>
                <div className="scan-top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                  <span className="tabular" style={{ fontWeight: 700, fontSize: '1rem' }}>{t.symbol}</span>
                  <span className={`action ${t.action.toLowerCase()}`}>{t.action}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>
                  <span>${(t.entry_price || 0).toFixed(2)}</span>
                  <span>{t.strategy}</span>
                  <span>{t.confidence}%</span>
                </div>
                <div className="conf-bar">
                  <div className="conf-fill" style={{ width: `${t.confidence}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AlertsCard({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="card blue-border">
      <div className="card-head blue">
        <h3 className="card-title blue">Alerts &amp; Activity</h3>
        <span className="faint" style={{ fontSize: '0.8rem' }}>{alerts.filter((a) => !a.is_read).length} new</span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="log-viewer" style={{ maxHeight: 220, borderRadius: 0, border: 'none' }}>
          {alerts.length === 0 ? (
            <div className="log-line" style={{ color: 'var(--fg-2)' }}>No alerts yet…</div>
          ) : alerts.map((a) => {
            const cls = a.type === 'BUY' ? 'success' : a.type === 'STOP_LOSS' || a.type === 'SELL' ? 'warning' : a.type === 'ERROR' ? 'error' : 'info'
            return (
              <div key={a.id} className={`log-line ${cls}`}>
                [{new Date(a.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}] {a.message}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function PnLChart({ data }: { data: PnlPoint[] }) {
  const chartData = data.map((p) => ({
    time: `${p.hour}:00`,
    pnl: Number(p.daily_pnl.toFixed(2)),
  }))

  const maxPnl = Math.max(...chartData.map((d) => d.pnl), 0)
  const minPnl = Math.min(...chartData.map((d) => d.pnl), 0)
  const isPositive = (chartData.at(-1)?.pnl ?? 0) >= 0

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Intraday P&amp;L</h3>
        <span className="tabular" style={{ fontSize: '0.85rem', color: isPositive ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
          {chartData.length > 0 ? pnlStr(chartData.at(-1)!.pnl) : '$0.00'}
        </span>
      </div>
      <div className="card-body" style={{ paddingTop: 8 }}>
        {chartData.length < 2 ? (
          <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)', fontSize: '0.85rem' }}>
            No intraday data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                tickFormatter={(v) => `$${v}`}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={false} tickLine={false} width={55}
                domain={[Math.min(minPnl * 1.1, -1), Math.max(maxPnl * 1.1, 1)]}
              />
              <Tooltip
                contentStyle={{ background: '#1a1f2e', border: '1px solid #374151', borderRadius: 6, fontSize: 12, fontFamily: 'IBM Plex Mono' }}
                formatter={(v: number) => [pnlStr(v), 'P&L']}
              />
              <Area
                type="monotone" dataKey="pnl"
                stroke={isPositive ? '#10b981' : '#ef4444'} strokeWidth={2}
                fill="url(#pnlGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function CronStatus({ log }: { log: CronEntry[] }) {
  const jobs = ['scan', 'monitor', 'close']
  return (
    <div className="card">
      <div className="card-head"><h3 className="card-title">Bot Engine</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {jobs.map((job) => {
            const last = log.find((l) => l.job === job)
            const ok = last?.status === 'success'
            const time = last ? formatDistanceToNow(new Date(last.created_at), { addSuffix: true }) : 'never'
            return (
              <div key={job} style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px' }}>
                <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-2)', marginBottom: 6 }}>{job}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: last ? (ok ? 'var(--green)' : 'var(--red)') : 'var(--fg-3)',
                    display: 'inline-block'
                  }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--fg-1)' }}>
                    {last ? (ok ? 'OK' : 'ERR') : '—'}
                  </span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>{time}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [data, setData]         = useState<DashboardData | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [pdt, setPdt]           = useState<PdtStatus | null>(null)
  const [loading, setLoading]   = useState(true)
  const [lastUpdate, setLastUpdate] = useState('')
  const [updating, setUpdating] = useState(false)

  const loadData = useCallback(async () => {
    setUpdating(true)
    try {
      const [dash, pos, hist] = await Promise.all([
        fetch('/api/dashboard').then((r) => r.json()),
        fetch('/api/schwab/positions').then((r) => r.json()),
        fetch('/api/schwab/history?days=7').then((r) => r.json()),
      ])
      setData(dash)
      setPositions(pos.positions ?? [])
      if (hist?.pdt) setPdt(hist.pdt)
      setLastUpdate(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
    } catch {
      // keep previous data
    } finally {
      setLoading(false)
      setUpdating(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const iv = setInterval(loadData, 30_000)
    return () => clearInterval(iv)
  }, [loadData])

  const acct    = data?.account
  const balance = acct?.balance ?? 0
  const dayPnl  = acct?.daily_pnl ?? 0
  const totPnl  = acct?.total_pnl ?? 0
  const winRate = data?.daily_summary?.[0]?.win_rate ?? 0
  const openTrades = data?.trades?.filter((t) => t.status === 'OPEN') ?? []
  const isOpen  = data?.market_open ?? false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* ── Navbar ── */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 20,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg-2)', borderBottom: '1px solid var(--border)',
        padding: '12px 22px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--fg-1)', letterSpacing: '-0.01em' }}>MyTrade</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`status-pill ${isOpen ? 'live' : 'closed'}`}>
            <span className="dot-live" style={{ background: isOpen ? undefined : 'var(--fg-3)' }} />
            {isOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </span>
          <button
            onClick={loadData}
            className={`status-pill paper ${updating ? 'updating' : ''}`}
            style={{ cursor: 'pointer', border: 'none' }}
          >
            ↻ {lastUpdate || '—'}
          </button>
        </div>
      </nav>

      {/* ── Page body ── */}
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 22px 40px', width: '100%' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--fg-2)' }}>
            Loading dashboard…
          </div>
        ) : (
          <>
            {/* ── Metrics row ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 14 }}>
              <MetricBox label="Account Balance" value={fmt(balance)} sub="Schwab live" />
              <MetricBox label="Daily P&L" value={pnlStr(dayPnl)} sub="today" color={pnlColor(dayPnl)} />
              <MetricBox label="All-Time P&L" value={pnlStr(totPnl)} sub="realized" color={pnlColor(totPnl)} />
              <MetricBox label="Open Positions" value={`${positions.length} / 3`} sub="max 3" color="var(--fg-1)" />
              <MetricBox label="Win Rate" value={`${winRate.toFixed(0)}%`} sub="7-day" color={winRate >= 50 ? 'var(--green)' : 'var(--red)'} />
              <MetricBox label="Goal $25K" value={`${fmt(25000 - balance)}`} sub="~${Math.ceil((25000 - balance) / 150)}d @ $150/d" color="var(--fg-1)" />
            </div>

            {/* ── PDT Status bar ── */}
            {pdt && (
              <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 14, marginBottom: 14 }}>
                <div className="card">
                  <div className="card-head blue" style={{ padding: '10px 16px' }}>
                    <h3 className="card-title blue" style={{ fontSize: '0.95rem' }}>
                      PDT Status — {pdt.is_pdt_protected ? 'Swing Mode (under $25K)' : 'Unlimited'}
                    </h3>
                    <span style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>
                      {pdt.is_pdt_protected ? `${pdt.day_trades_remaining} day-trade slots left this week` : 'No PDT restrictions'}
                    </span>
                  </div>
                  <div className="card-body" style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                      <div style={{ flex: 1 }}>
                        <div className="meter-top">
                          <span>Day trades used (rolling 5 days)</span>
                          <span style={{ color: pdt.day_trades_used >= 3 ? 'var(--red)' : 'var(--fg-1)' }}>{pdt.day_trades_used} / 3</span>
                        </div>
                        <div className="track" style={{ height: 10 }}>
                          <div className="fill" style={{
                            width: `${(pdt.day_trades_used / 3) * 100}%`,
                            background: pdt.day_trades_used >= 3 ? 'var(--red)' : pdt.day_trades_used >= 2 ? 'var(--amber)' : 'var(--green)'
                          }} />
                        </div>
                        {pdt.today_trades.length > 0 && (
                          <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--amber)' }}>
                            Entered today (hold overnight): {pdt.today_trades.join(', ')}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)', maxWidth: 260 }}>
                        Strategy: Buy setups → hold 1-5 nights → sell at +{10}% target or -{5}% stop.
                        Never same-day sell unless emergency -{7}%.
                      </div>
                    </div>
                  </div>
                </div>
                <div className="card">
                  <div className="card-head" style={{ padding: '10px 16px' }}>
                    <h3 className="card-title" style={{ fontSize: '0.95rem' }}>Daily Goal</h3>
                  </div>
                  <div className="card-body" style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '2rem', fontWeight: 700, color: 'var(--green)', marginBottom: 4 }}>
                      $150
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>target per day</div>
                    <div style={{ marginTop: 10, fontSize: '0.82rem', color: dayPnl >= 150 ? 'var(--green)' : 'var(--fg-2)' }}>
                      Today: {pnlStr(dayPnl)}
                      {dayPnl >= 150 && ' ✓ Goal reached!'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Row 2: Positions (wide) + Alerts ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14, marginBottom: 14 }}>
              <PositionsCard positions={positions} />
              <AlertsCard alerts={data?.alerts ?? []} />
            </div>

            {/* ── Row 3: P&L chart + AI signals + Cron ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr', gap: 14, marginBottom: 14 }}>
              <PnLChart data={data?.pnl_chart ?? []} />
              <MarketScannerCard trades={data?.trades ?? []} />
              <CronStatus log={data?.cron_log ?? []} />
            </div>

            {/* ── Row 4: Risk config + 7-day summary ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {/* Risk config */}
              <div className="card">
                <div className="card-head"><h3 className="card-title">Risk Configuration</h3></div>
                <div className="card-body">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    {[
                      { label: 'Stop Loss', value: '−5.0%' },
                      { label: 'Trailing Stop', value: 'Dynamic (1.5–3.5%)' },
                      { label: 'Position Size', value: '15% / trade' },
                      { label: 'Max Positions', value: '3 concurrent' },
                      { label: 'Daily Loss Limit', value: '−5.0%' },
                      { label: 'EOD Close', value: '3:45 PM ET' },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '11px 13px' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 600, color: 'var(--fg-1)' }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Capacity meter */}
                  <div style={{ marginTop: 16 }}>
                    <div className="meter-top">
                      <span>Trade Capacity</span>
                      <span>{positions.length} / 3</span>
                    </div>
                    <div className="track">
                      <div className="fill" style={{ width: `${(positions.length / 3) * 100}%` }} />
                    </div>
                    <div style={{ marginTop: 8, fontSize: '0.85rem', color: positions.length < 3 ? 'var(--green)' : 'var(--red)' }}>
                      {positions.length < 3 ? '✓ Ready to trade' : '⚠ Max positions reached'}
                    </div>
                  </div>
                </div>
              </div>

              {/* 7-day summary */}
              <div className="card">
                <div className="card-head"><h3 className="card-title">7-Day Performance</h3></div>
                <div className="card-body">
                  {(data?.daily_summary ?? []).length === 0 ? (
                    <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '12px 0' }}>No history yet</p>
                  ) : (data?.daily_summary ?? []).map((d) => (
                    <div key={d.date} className="data-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', marginBottom: 8 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>{d.date}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', color: pnlColor(d.daily_pnl), fontWeight: 600 }}>{pnlStr(d.daily_pnl)}</div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)' }}>{d.wins}W / {d.losses}L</div>
                      <div style={{ fontSize: '0.82rem', color: d.win_rate >= 50 ? 'var(--green)' : 'var(--red)' }}>{d.win_rate.toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
