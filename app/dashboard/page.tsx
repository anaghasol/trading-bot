'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, CardHead, Metric, Chip, Meter, LiveDot, Seg, Empty, money, signed, pct, pnlColor } from '@/components/ui/kit'
import { PROFILES } from '@/lib/strategy-profiles'

type Broker = 'schwab' | 'alpaca_paper'
interface Position { symbol: string; quantity: number; avg_cost: number; current_price: number; market_value: number; unrealized_pnl: number; pnl_pct: number; asset_type?: string }
interface Summary { account_value: number; cash: number; stock_buying_power: number; option_buying_power: number; day_trade_buying_power: number }
interface Quote { symbol: string; price: number; change_pct: number }
interface Trade { id: number; symbol: string; action: string; confidence: number; strategy: string; status: string }
interface Alert { id: number; type: string; message: string; created_at: string }
interface Dash { account: { balance: number; daily_pnl: number; total_pnl: number } | null; trades: Trade[]; alerts: Alert[]; pnl_chart: { hour: number; daily_pnl: number }[]; market_open: boolean }
interface Pdt { day_trades_remaining: number; is_pdt_protected: boolean; balance: number }

const WATCH = ['NVDA', 'AMD', 'MSFT', 'PLTR', 'TSLA', 'AMZN', 'META', 'COIN']
const GOAL = 25000
const DEFAULT_BAL: Record<Broker, number> = { schwab: 2000, alpaca_paper: 100000 }

// ── flashing number cell ────────────────────────────────────────────────────
function Flash({ value, fmt, className = '' }: { value: number; fmt: (n: number) => string; className?: string }) {
  const prev = useRef(value)
  const [cls, setCls] = useState('')
  useEffect(() => {
    if (value !== prev.current) {
      setCls(value > prev.current ? 'flash-up' : 'flash-dn')
      prev.current = value
      const t = setTimeout(() => setCls(''), 700)
      return () => clearTimeout(t)
    }
  }, [value])
  return <span className={`tabular ${className} ${cls}`}>{fmt(value)}</span>
}

// ── market countdown ────────────────────────────────────────────────────────
function useMarketClock() {
  const [txt, setTxt] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const tick = () => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
      const o = new Date(et); o.setHours(9, 30, 0, 0)
      const c = new Date(et); c.setHours(16, 0, 0, 0)
      const day = et.getDay()
      const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
      if (day === 0 || day === 6) { setOpen(false); setTxt('Market closed · weekend') }
      else if (et >= o && et < c) { setOpen(true); setTxt(`Market open · ${fmt(c.getTime() - et.getTime())} left`) }
      else if (et < o) { setOpen(false); setTxt(`${fmt(o.getTime() - et.getTime())} until open`) }
      else { setOpen(false); setTxt('After hours · closed') }
    }
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [])
  return { txt, open }
}

export default function DashboardPage() {
  const [broker, setBroker] = useState<Broker>('schwab')
  const [dash, setDash] = useState<Record<Broker, Dash | null>>({ schwab: null, alpaca_paper: null })
  const [pos, setPos] = useState<Position[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [pdt, setPdt] = useState<Pdt | null>(null)
  const [stamp, setStamp] = useState('')
  const market = useMarketClock()
  const profile = PROFILES[broker]

  const load = useCallback(async (b: Broker) => {
    const [d, p, s, q, h] = await Promise.allSettled([
      fetch(`/api/dashboard?broker=${b}`).then((r) => r.json()),
      fetch('/api/schwab/positions').then((r) => r.json()),
      b === 'schwab' ? fetch('/api/schwab/account').then((r) => r.json()) : Promise.resolve(null),
      fetch(`/api/schwab/quotes?symbols=${WATCH.join(',')}`).then((r) => r.json()),
      b === 'schwab' ? fetch('/api/schwab/history?days=7').then((r) => r.json()) : Promise.resolve(null),
    ])
    if (d.status === 'fulfilled') setDash((prev) => ({ ...prev, [b]: d.value }))
    if (p.status === 'fulfilled') setPos(Array.isArray(p.value) ? p.value : (p.value?.positions ?? []))
    if (s.status === 'fulfilled' && s.value && !s.value.error) setSummary(s.value); else if (b !== 'schwab') setSummary(null)
    if (q.status === 'fulfilled') setQuotes(q.value?.quotes ?? [])
    if (h.status === 'fulfilled' && h.value?.pdt) setPdt(h.value.pdt)
    setStamp(new Date().toLocaleTimeString('en-US', { hour12: false }))
  }, [])

  // market-hours-aware polling: fast when open, slow when closed
  useEffect(() => {
    load(broker)
    const ms = market.open ? 7000 : 60000
    const iv = setInterval(() => load(broker), ms)
    return () => clearInterval(iv)
  }, [broker, market.open, load])

  const data = dash[broker]
  const acctValue = summary?.account_value ?? data?.account?.balance ?? DEFAULT_BAL[broker]
  const dayPnl = data?.account?.daily_pnl ?? 0
  const totPnl = data?.account?.total_pnl ?? 0
  const dayPct = acctValue ? (dayPnl / acctValue) * 100 : 0
  const up = dayPnl >= 0
  const totMV = pos.reduce((s, p) => s + Math.abs(p.market_value), 0)
  const unreal = pos.reduce((s, p) => s + p.unrealized_pnl, 0)
  const deployedPct = acctValue ? Math.min(100, (totMV / acctValue) * 100) : 0
  const breakerUsed = dayPnl < 0 ? Math.min(100, (Math.abs(dayPnl) / (acctValue * profile.daily_loss_stop_pct)) * 100) : 3
  const goalPct = Math.min(100, (acctValue / GOAL) * 100)
  const chart = (data?.pnl_chart ?? []).map((p) => ({ t: `${p.hour}:00`, v: Number((p.daily_pnl ?? 0).toFixed(2)) }))
  const signals = (data?.trades ?? []).filter((t) => t.status === 'OPEN').slice(0, 4)
  const alerts = (data?.alerts ?? []).slice(0, 7)
  const dtLeft = broker === 'alpaca_paper' ? '∞' : (pdt?.day_trades_remaining ?? 0)

  return (
    <div>
      {/* ── top bar ── */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--bg-1)', borderBottom: '1px solid var(--border)', padding: '11px 26px', flexWrap: 'wrap' }}>
        <Seg<Broker> value={broker} onChange={setBroker} options={[
          { key: 'schwab', label: <><LiveDot color="var(--red)" /> Live · Schwab</>, on: 'red' },
          { key: 'alpaca_paper', label: <><LiveDot color="var(--blue)" /> Paper · Alpaca</>, on: 'blue' },
        ]} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className={`status-pill ${market.open ? 'live' : 'closed'}`}><LiveDot on={market.open} /> {market.txt}</span>
          <span className="chip mut" style={{ fontFamily: 'var(--font-mono)' }}>↻ {stamp || '—'}</span>
        </div>
      </nav>

      <div className="page">
        {/* ── profile banner ── */}
        <div className="rise" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderRadius: 'var(--r-lg)', marginBottom: 14, background: profile.vibe === 'aggressive' ? 'var(--blue-faint)' : 'var(--green-faint)', border: `1px solid ${profile.vibe === 'aggressive' ? 'var(--blue)' : 'var(--green)'}`, flexWrap: 'wrap' }}>
          <b style={{ color: profile.vibe === 'aggressive' ? 'var(--blue)' : 'var(--green)' }}>{profile.vibe === 'aggressive' ? '🧪 Aggressive Lab' : '🛡 Protected'}</b>
          <span className="mut" style={{ fontSize: '0.82rem' }}>
            {profile.label} · risk {(profile.risk_pct * 100).toFixed(1)}%/trade · up to {profile.max_positions} positions · {profile.allow_day_trades ? 'day-trades ON' : 'PDT-safe swing'} · breaker −{(profile.daily_loss_stop_pct * 100).toFixed(0)}% · AI gate {profile.min_confidence}%
          </span>
          {broker === 'alpaca_paper' && <span className="chip blue" style={{ marginLeft: 'auto' }}>big paper balance — test hard</span>}
        </div>

        {/* ── hero + chart ── */}
        <div className="grid" style={{ gridTemplateColumns: '1.15fr 1fr', marginBottom: 14 }}>
          <div className="hero">
            <div className="hero-label">Account value · {broker === 'schwab' ? 'Schwab (real $)' : 'Alpaca (paper $)'}</div>
            <div className="hero-value" style={{ margin: '6px 0 8px' }}><Flash value={acctValue} fmt={money} /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className={`chip ${up ? 'up' : 'down'}`} style={{ fontSize: '0.92rem', padding: '5px 12px' }}>{up ? '▲' : '▼'} {signed(dayPnl)} ({pct(dayPct)}) today</span>
              <span className="metric-label">your daily income</span>
            </div>
          </div>
          <Card>
            <CardHead title="Today's P&L" tone="plain" right={<span className="tabular" style={{ fontWeight: 700, color: pnlColor(dayPnl) }}>{signed(dayPnl)}</span>} />
            <div className="card-body" style={{ paddingTop: 10 }}>
              {chart.length < 2 ? <div style={{ height: 116, display: 'grid', placeItems: 'center', color: 'var(--fg-3)', fontSize: '0.85rem' }}>No intraday data yet</div>
                : <ResponsiveContainer width="100%" height={116}><AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0.3} /><stop offset="100%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0} /></linearGradient></defs>
                    <XAxis dataKey="t" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={(v) => `$${v}`} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} width={46} />
                    <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid #374151', borderRadius: 6, fontSize: 11, fontFamily: 'IBM Plex Mono' }} formatter={(v: number) => [signed(v), 'P&L']} />
                    <Area type="monotone" dataKey="v" stroke={up ? '#10b981' : '#ef4444'} strokeWidth={2} fill="url(#hg)" />
                  </AreaChart></ResponsiveContainer>}
            </div>
          </Card>
        </div>

        {/* ── metric grid (live balances) ── */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)', marginBottom: 14 }}>
          <Metric label="Account Value" value={<Flash value={acctValue} fmt={money} />} sub={broker === 'schwab' ? 'real $' : 'paper $'} color="var(--fg-1)" />
          <Metric label="Cash" value={money(summary?.cash ?? (acctValue - totMV))} sub="available" color="var(--fg-1)" />
          <Metric label="Stock BP" value={money(summary?.stock_buying_power ?? (acctValue - totMV))} sub="buying power" color="var(--fg-1)" />
          <Metric label="Day Trades Left" value={`${dtLeft}`} sub={broker === 'alpaca_paper' ? 'no PDT cap' : '/ 3 · PDT'} color={broker === 'alpaca_paper' ? 'var(--green)' : (Number(dtLeft) > 0 ? 'var(--green)' : 'var(--amber)')} />
          <Metric label="Today P&L" value={signed(dayPnl)} sub={pct(dayPct)} color={pnlColor(dayPnl)} />
          <Metric label="Open P&L" value={signed(unreal)} sub={`${pos.length}/${profile.max_positions} pos`} color={pnlColor(unreal)} />
        </div>

        {/* ── positions + rail ── */}
        <div className="grid" style={{ gridTemplateColumns: '1.75fr 1fr' }}>
          <div className="grid">
            <Card>
              <CardHead title="📊 Positions" right={<span className="faint" style={{ fontSize: '0.8rem' }}>{pos.length} open · net liq {money(totMV)}</span>} />
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right' }}>
                    {['Symbol', 'Qty', 'Avg', 'Mark', 'Mkt Value', 'Open P&L', '%', 'Δ', ''].map((h, i) => <th key={h} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', textAlign: i === 0 ? 'left' : 'right', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {pos.length === 0 ? <tr><td colSpan={9}><Empty>No open positions — engine waiting for a {profile.min_confidence}%+ signal.</Empty></td></tr>
                      : pos.map((p) => (
                        <tr key={p.symbol} style={{ fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)', textAlign: 'left', fontWeight: 700, color: 'var(--blue)' }}>{p.symbol} <span style={{ fontSize: '0.6rem', padding: '1px 5px', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--fg-3)', marginLeft: 4 }}>{p.asset_type === 'OPTION' ? 'OPT' : 'EQ'}</span></td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)' }}>{p.quantity}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)', color: 'var(--fg-2)' }}>${p.avg_cost.toFixed(2)}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)' }}><Flash value={p.current_price} fmt={(n) => '$' + n.toFixed(2)} /></td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)' }}>{money(p.market_value)}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)', fontWeight: 700, color: pnlColor(p.unrealized_pnl) }}>{signed(p.unrealized_pnl)}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)', color: pnlColor(p.pnl_pct) }}>{pct(p.pnl_pct)}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)', color: 'var(--fg-2)' }}>{p.asset_type === 'OPTION' ? '—' : p.quantity.toFixed(2)}</td>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)' }}><button onClick={() => fetch('/api/schwab/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: p.symbol, quantity: Math.abs(p.quantity), action: 'SELL' }) }).then(() => setTimeout(() => load(broker), 1500))} className="btn red sm">Close</button></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHead title="📡 Live Activity" tone="blue" right={<span className="faint" style={{ fontSize: '0.8rem' }}>{alerts.length}</span>} />
              <div className="log-viewer" style={{ maxHeight: 200, borderRadius: 0, border: 'none' }}>
                {alerts.length === 0 ? <div className="log-line" style={{ color: 'var(--fg-3)' }}>Waiting for bot activity…</div>
                  : alerts.map((a) => { const cls = a.type === 'BUY' ? 'success' : a.type === 'STOP_LOSS' ? 'error' : a.type === 'SELL' ? 'warning' : 'info'; return <div key={a.id} className={`log-line ${cls}`}>[{new Date(a.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}] {a.message}</div> })}
              </div>
            </Card>
          </div>

          <div className="grid">
            <Card accent={profile.vibe === 'aggressive' ? 'blue' : 'green'}>
              <CardHead title={profile.vibe === 'aggressive' ? '🧪 Lab Risk' : '🛡 Protection'} tone={profile.vibe === 'aggressive' ? 'blue' : 'green'} right={<span className={`chip ${profile.vibe === 'aggressive' ? 'blue' : 'up'}`}>ACTIVE</span>} />
              <div className="card-body" style={{ display: 'grid', gap: 12 }}>
                <Meter label={`Daily breaker (−${(profile.daily_loss_stop_pct * 100).toFixed(0)}%)`} right={pct(dayPct)} pct={breakerUsed} color={breakerUsed > 70 ? 'var(--red)' : 'var(--green)'} />
                <Meter label="Capital deployed" right={`${deployedPct.toFixed(0)}%`} pct={deployedPct} color="var(--blue)" />
                <div className="spread"><span className="metric-label">To $25K goal</span><span className="chip mut">{goalPct.toFixed(0)}%</span></div>
                <div className="spread"><span className="metric-label">Risk / trade</span><span className={`chip ${profile.vibe === 'aggressive' ? 'blue' : 'up'}`}>{(profile.risk_pct * 100).toFixed(1)}% dynamic</span></div>
              </div>
            </Card>
            <Card>
              <CardHead title="📈 Watchlist" tone="plain" />
              <div className="card-body" style={{ display: 'grid', gap: 0 }}>
                {quotes.length === 0 ? <Empty>Connect Schwab for live quotes</Empty>
                  : quotes.map((q) => (
                    <div key={q.symbol} className="spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--divider)' }}>
                      <span className="tabular" style={{ fontWeight: 600 }}>{q.symbol}</span>
                      <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Flash value={q.price} fmt={(n) => n.toFixed(2)} /><span className="tabular" style={{ fontSize: '0.78rem', color: pnlColor(q.change_pct), minWidth: 56, textAlign: 'right' }}>{pct(q.change_pct)}</span></span>
                    </div>
                  ))}
              </div>
            </Card>
            <Card>
              <CardHead title="🤖 AI Signals" tone="blue" right={<span className="chip blue">{profile.min_confidence}%+ to fire</span>} />
              <div className="card-body" style={{ display: 'grid', gap: 8 }}>
                {signals.length === 0 ? <Empty>No open signals</Empty>
                  : signals.map((t) => (
                    <div key={t.id} className="spread"><span><b className="tabular" style={{ color: 'var(--blue)' }}>{t.symbol}</b> <span className="chip mut" style={{ fontSize: '0.62rem', marginLeft: 6 }}>{t.strategy}</span></span><span className="chip up">{t.confidence}%</span></div>
                  ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
