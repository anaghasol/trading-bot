'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────
type Broker = 'schwab' | 'alpaca_paper'

interface EngineStatus { schwab: 'running' | 'stopped'; alpaca_paper: 'running' | 'stopped' }
interface Position { symbol: string; quantity: number; avg_cost: number; current_price: number; market_value: number; unrealized_pnl: number; pnl_pct: number }
interface Trade { id: number; symbol: string; action: string; quantity: number; entry_price: number; exit_price: number | null; pnl: number; pnl_pct: number; status: string; strategy: string; confidence: number; reason: string; created_at: string; broker?: string }
interface Alert { id: number; type: string; message: string; symbol: string | null; pnl: number | null; created_at: string; broker?: string }
interface DashData { account: { balance: number; daily_pnl: number; total_pnl: number } | null; trades: Trade[]; alerts: Alert[]; daily_summary: { date: string; daily_pnl: number; wins: number; losses: number; win_rate: number }[]; cron_log: { id: number; job: string; status: string; message: string; created_at: string }[]; pnl_chart: { hour: number; daily_pnl: number; balance: number }[]; market_open: boolean; engine_status: EngineStatus }

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmt     = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pnlStr  = (n: number) => (n >= 0 ? '+' : '−') + fmt(n)
const pnlColor = (n: number) => n >= 0 ? 'var(--green)' : 'var(--red)'

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

function EngineToggle({ broker, status, onToggle }: { broker: Broker; status: 'running' | 'stopped'; onToggle: (b: Broker, a: 'start' | 'stop') => void }) {
  const isRunning = status === 'running'
  const label = broker === 'schwab' ? 'Schwab Live' : 'Alpaca Paper'
  return (
    <button
      onClick={() => onToggle(broker, isRunning ? 'stop' : 'start')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 16px', borderRadius: 'var(--r-pill)', border: 'none',
        background: isRunning ? 'var(--green-dim)' : 'var(--red-dim)',
        color: isRunning ? 'var(--green)' : 'var(--red)',
        fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: isRunning ? 'var(--green)' : 'var(--red)', display: 'inline-block', animation: isRunning ? 'pulse 1.4s infinite' : 'none' }} />
      {label}: {isRunning ? 'RUNNING' : 'STOPPED'}
      <span style={{ opacity: 0.7, fontSize: '0.75rem' }}>{isRunning ? '⏸ Pause' : '▶ Start'}</span>
    </button>
  )
}

function PositionsPanel({ positions, onClose }: { positions: Position[]; onClose: (s: string, q: number) => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Open Positions</h3>
        <span className="faint" style={{ fontSize: '0.8rem' }}>{positions.length} active</span>
      </div>
      <div className="card-body">
        {positions.length === 0
          ? <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '12px 0' }}>No open positions</p>
          : positions.map((p) => (
            <div key={p.symbol} className="data-row" style={{ gridTemplateColumns: '1.2fr .7fr 1fr 1fr 1fr .8fr' }}>
              <div className="tabular" style={{ fontWeight: 700, color: 'var(--blue)', fontSize: '1rem' }}>{p.symbol}</div>
              <div><span className="muted">qty </span><span className="tabular">{p.quantity}</span></div>
              <div><span className="muted">avg </span><span className="tabular">${p.avg_cost.toFixed(2)}</span></div>
              <div><span className="muted">cur </span><span className="tabular">${p.current_price.toFixed(2)}</span></div>
              <div className="tabular" style={{ fontWeight: 700, color: pnlColor(p.unrealized_pnl) }}>
                {p.unrealized_pnl >= 0 ? '+' : '−'}{fmt(p.unrealized_pnl)}
                <span style={{ fontSize: '0.75rem', marginLeft: 4, opacity: 0.8 }}>({p.pnl_pct.toFixed(1)}%)</span>
              </div>
              <div>
                <button onClick={() => onClose(p.symbol, p.quantity)} className="btn red sm">Close</button>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

function AlertsLog({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="card blue-border">
      <div className="card-head blue">
        <h3 className="card-title blue">Live Activity</h3>
        <span className="faint" style={{ fontSize: '0.8rem' }}>{alerts.length} recent</span>
      </div>
      <div className="log-viewer" style={{ maxHeight: 200, borderRadius: 0, border: 'none' }}>
        {alerts.length === 0
          ? <div className="log-line" style={{ color: 'var(--fg-2)' }}>No alerts yet…</div>
          : alerts.map((a) => {
            const cls = a.type === 'BUY' ? 'success' : a.type === 'STOP_LOSS' ? 'error' : a.type === 'SELL' ? 'warning' : 'info'
            return (
              <div key={a.id} className={`log-line ${cls}`}>
                [{new Date(a.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}] {a.message}
              </div>
            )
          })}
      </div>
    </div>
  )
}

function PnLChart({ data, broker }: { data: { hour: number; daily_pnl: number }[]; broker: Broker }) {
  const chartData = data.map((p) => ({ time: `${p.hour}:00`, pnl: Number(p.daily_pnl.toFixed(2)) }))
  const last = chartData.at(-1)?.pnl ?? 0
  const pos  = last >= 0

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Today's P&L</h3>
        <span className="tabular" style={{ fontSize: '0.9rem', fontWeight: 700, color: pnlColor(last) }}>{pnlStr(last)}</span>
      </div>
      <div className="card-body" style={{ paddingTop: 8 }}>
        {chartData.length < 2
          ? <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)', fontSize: '0.85rem' }}>No intraday data yet</div>
          : <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={`g-${broker}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={pos ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={pos ? '#10b981' : '#ef4444'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `$${v}`} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
                <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid #374151', borderRadius: 6, fontSize: 11, fontFamily: 'IBM Plex Mono' }} formatter={(v: number) => [pnlStr(v), 'P&L']} />
                <Area type="monotone" dataKey="pnl" stroke={pos ? '#10b981' : '#ef4444'} strokeWidth={2} fill={`url(#g-${broker})`} />
              </AreaChart>
            </ResponsiveContainer>}
      </div>
    </div>
  )
}

function BrokerPanel({ broker, data, positions, onClose }: {
  broker: Broker; data: DashData | null; positions: Position[]; onClose: (s: string, q: number) => void
}) {
  const trades = (data?.trades ?? []).filter((t) => t.status === 'OPEN').slice(0, 5)
  const alerts = (data?.alerts ?? []).slice(0, 8)
  const balance = data?.account?.balance ?? (broker === 'schwab' ? 2000 : 100000)
  const dayPnl  = data?.account?.daily_pnl ?? 0
  const totPnl  = data?.account?.total_pnl ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricBox label="Balance" value={fmt(balance)} sub={broker === 'schwab' ? 'Real $' : 'Paper $'} />
        <MetricBox label="Daily P&L" value={pnlStr(dayPnl)} color={pnlColor(dayPnl)} />
        <MetricBox label="Total P&L" value={pnlStr(totPnl)} color={pnlColor(totPnl)} />
        <MetricBox label="Positions" value={`${positions.length}/3`} sub="max 3" color="var(--fg-1)" />
      </div>

      {/* Positions + Chart */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
        <PositionsPanel positions={positions} onClose={onClose} />
        <AlertsLog alerts={alerts} />
      </div>

      {/* P&L chart + Recent trades */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
        <PnLChart data={data?.pnl_chart ?? []} broker={broker} />
        <div className="card">
          <div className="card-head"><h3 className="card-title">Recent Signals</h3></div>
          <div className="card-body">
            {trades.length === 0
              ? <p className="muted" style={{ margin: 0 }}>No open trades</p>
              : trades.map((t) => (
                <div key={t.id} className="data-row" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginBottom: 8 }}>
                  <div className="tabular" style={{ fontWeight: 700, color: 'var(--blue)' }}>{t.symbol}</div>
                  <div><span className={`action ${t.action.toLowerCase()}`}>{t.action}</span></div>
                  <div><span className="conf-badge high">{t.confidence}%</span></div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [activeBroker, setActiveBroker] = useState<Broker>('schwab')
  const [dataByBroker, setDataByBroker] = useState<Record<Broker, DashData | null>>({ schwab: null, alpaca_paper: null })
  const [positionsByBroker, setPosByBroker] = useState<Record<Broker, Position[]>>({ schwab: [], alpaca_paper: [] })
  const [engines, setEngines] = useState<EngineStatus>({ schwab: 'running', alpaca_paper: 'running' })
  const [lastUpdate, setLastUpdate] = useState('')
  const [updating, setUpdating] = useState(false)

  const loadData = useCallback(async () => {
    setUpdating(true)
    try {
      const [schwabDash, alpacaDash, schwabPos, alpacaPos, engineStatus] = await Promise.allSettled([
        fetch('/api/dashboard?broker=schwab').then((r) => r.json()),
        fetch('/api/dashboard?broker=alpaca_paper').then((r) => r.json()),
        fetch('/api/schwab/positions').then((r) => r.json()),    // Schwab live positions
        fetch('/api/schwab/positions').then((r) => r.json()),    // Alpaca positions via same endpoint (broker routes to correct one)
        fetch('/api/engine').then((r) => r.json()),
      ])

      if (schwabDash.status === 'fulfilled') setDataByBroker((p) => ({ ...p, schwab: schwabDash.value }))
      if (alpacaDash.status === 'fulfilled') setDataByBroker((p) => ({ ...p, alpaca_paper: alpacaDash.value }))

      // Positions: use dashboard shared data for now
      if (schwabDash.status === 'fulfilled') {
        const d = schwabDash.value as DashData
        if (d.engine_status) setEngines(d.engine_status)
      }
      if (engineStatus.status === 'fulfilled') setEngines(engineStatus.value)

      setLastUpdate(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
    } catch { }
    finally { setUpdating(false) }
  }, [])

  useEffect(() => {
    loadData()
    const iv = setInterval(loadData, 30_000)
    return () => clearInterval(iv)
  }, [loadData])

  async function toggleEngine(broker: Broker, action: 'start' | 'stop') {
    await fetch('/api/engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, action }) })
    setEngines((p) => ({ ...p, [broker]: action === 'start' ? 'running' : 'stopped' }))
  }

  async function closePosition(symbol: string, quantity: number) {
    await fetch('/api/schwab/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, quantity: Math.abs(quantity), action: 'SELL' }),
    })
    setTimeout(loadData, 1500)
  }

  const data = dataByBroker[activeBroker]
  const positions = positionsByBroker[activeBroker]
  const isOpen = dataByBroker.schwab?.market_open ?? false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* ── Top Nav ── */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-2)', borderBottom: '1px solid var(--border)', padding: '11px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>MyTrade</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`status-pill ${isOpen ? 'live' : 'closed'}`}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: isOpen ? 'var(--green)' : 'var(--fg-3)', display: 'inline-block', animation: isOpen ? 'pulse 1.4s infinite' : 'none' }} />
            {isOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </span>
          <button onClick={loadData} style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '5px 12px', color: updating ? 'var(--green)' : 'var(--fg-2)', cursor: 'pointer', fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }}>
            {updating ? '↻ …' : `↻ ${lastUpdate || '—'}`}
          </button>
        </div>
      </nav>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '20px 22px 40px', width: '100%' }}>

        {/* ── Engine Controls ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <EngineToggle broker="schwab" status={engines.schwab} onToggle={toggleEngine} />
          <EngineToggle broker="alpaca_paper" status={engines.alpaca_paper} onToggle={toggleEngine} />
          <span style={{ fontSize: '0.78rem', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>Both run concurrently · GitHub Actions every 5 min</span>
        </div>

        {/* ── Broker Tabs ── */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, background: 'var(--bg-2)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 4, width: 'fit-content' }}>
          {([
            { key: 'schwab' as Broker,       label: '🔴 Schwab Live',   sub: '$2K Real' },
            { key: 'alpaca_paper' as Broker,  label: '🔵 Alpaca Paper',  sub: '$100K Sim' },
          ]).map(({ key, label, sub }) => (
            <button
              key={key}
              onClick={() => setActiveBroker(key)}
              style={{
                padding: '9px 22px', borderRadius: 'var(--r-md)', border: 'none', cursor: 'pointer',
                background: activeBroker === key ? (key === 'schwab' ? '#ef444422' : '#3b82f622') : 'transparent',
                color: activeBroker === key ? (key === 'schwab' ? 'var(--red)' : 'var(--blue)') : 'var(--fg-3)',
                fontWeight: activeBroker === key ? 700 : 400, fontSize: '0.9rem', transition: 'all .15s',
                borderBottom: activeBroker === key ? `2px solid ${key === 'schwab' ? 'var(--red)' : 'var(--blue)'}` : '2px solid transparent',
              }}
            >
              {label}
              <span style={{ marginLeft: 8, fontSize: '0.72rem', opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                [{engines[key] === 'running' ? '●' : '○'}] {sub}
              </span>
            </button>
          ))}
        </div>

        {/* ── Active broker panel ── */}
        <BrokerPanel broker={activeBroker} data={data} positions={positions} onClose={closePosition} />

        {/* ── Combined 7-day history ── */}
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head"><h3 className="card-title">7-Day Summary ({activeBroker === 'schwab' ? 'Schwab' : 'Alpaca'})</h3></div>
          <div className="card-body">
            {(data?.daily_summary ?? []).length === 0
              ? <p className="muted" style={{ margin: 0 }}>No history yet</p>
              : (data?.daily_summary ?? []).map((d) => (
                <div key={d.date} className="data-row" style={{ gridTemplateColumns: '1fr 1.2fr 1fr .8fr', marginBottom: 8 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>{d.date}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: pnlColor(d.daily_pnl) }}>{pnlStr(d.daily_pnl)}</div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)' }}>{d.wins}W / {d.losses}L</div>
                  <div style={{ fontSize: '0.82rem', color: d.win_rate >= 50 ? 'var(--green)' : 'var(--red)' }}>{d.win_rate.toFixed(0)}%</div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
