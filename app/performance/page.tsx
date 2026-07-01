'use client'
import { useEffect, useState } from 'react'
import TopNav from '@/components/layout/TopNav'

type ViewMode = 'day' | 'history' | 'symbol' | 'source'
type SortKey  = 'total_pnl' | 'trades' | 'win_rate' | 'avg_pnl'
type HistSort = 'period' | 'trades' | 'win_rate' | 'total_pnl' | 'profit_factor' | 'avg_pnl' | 'best_trade' | 'worst_trade'
type Preset   = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'ytd' | 'custom'

interface Trade {
  id: number
  symbol: string
  pnl: number | null
  pnl_pct: number | null
  entry_price: number | null
  exit_price: number | null
  closed_at: string | null
  created_at: string
  strategy: string | null
  reason: string | null
  broker: string | null
  quantity: number
  status: string
}

interface PeriodRow {
  period: string
  trades: number; wins: number; losses: number; win_rate: number
  total_pnl: number; gross_win: number; gross_loss: number
  profit_factor: number; avg_pnl: number; best_trade: number; worst_trade: number; cum_pnl: number
}

interface SymbolStat {
  symbol: string; trades: number; wins: number; losses: number
  total_pnl: number; avg_pnl: number; best: number; worst: number; win_rate: number; source: string
}

interface SourceStat {
  source: string; trades: number; wins: number; total_pnl: number; win_rate: number; avg_pnl: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toEtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
}

function presetRange(p: Preset): { from: string; to: string } {
  const now   = new Date()
  const today = toEtDate(now)
  if (p === 'today')     return { from: today, to: today }
  if (p === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); const d = toEtDate(y); return { from: d, to: d } }
  if (p === '7d')        { const f = new Date(now); f.setDate(f.getDate() - 7);  return { from: toEtDate(f), to: today } }
  if (p === '30d')       { const f = new Date(now); f.setDate(f.getDate() - 30); return { from: toEtDate(f), to: today } }
  if (p === '90d')       { const f = new Date(now); f.setDate(f.getDate() - 90); return { from: toEtDate(f), to: today } }
  if (p === 'ytd')       return { from: `${now.getFullYear()}-01-01`, to: today }
  return { from: today, to: today }
}

function shiftDate(d: string, delta: number): string {
  const dt = new Date(d + 'T12:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

function inferSource(strategy: string | null, reason: string | null): string {
  const s = strategy?.toUpperCase() ?? ''
  const r = reason?.toLowerCase() ?? ''
  if (s.includes('OPTION') || s.includes('SPREAD') || s.includes('BULL_PUT')) return 'Options'
  if (r.includes('sf trades (pavan)') || r.includes('sf_pavan') || r.includes('sf pavan')) return 'SF Trades (Pavan)'
  if (r.includes('tg') || r.includes('telegram') || s.includes('TG_')) return 'Telegram'
  if (s.includes('SURGE') || s.includes('MOMENTUM')) return 'Momentum Surge'
  if (s.includes('EMA') || s.includes('BOUNCE') || s.includes('PULLBACK')) return 'EMA Scanner'
  if (s.includes('BREAKOUT')) return 'Breakout'
  if (s.includes('DISCOVERY')) return 'Discovery'
  if (s.includes('RECOVERED')) return 'Recovered'
  return strategy || 'Unknown'
}

const SOURCE_COLOR: Record<string, string> = {
  'SF Trades (Pavan)': '#ffd600',  // gold — highest priority channel
  'Telegram':       '#29b6f6',
  'Momentum Surge': '#ab47bc',
  'EMA Scanner':    '#13c98e',
  'Breakout':       '#ff9800',
  'Options':        '#ffd600',
  'Discovery':      '#ef5350',
  'Recovered':      '#78909c',
  'Unknown':        '#455a64',
}

function dollar(v: number): string {
  const abs = Math.abs(v)
  return (v >= 0 ? '+$' : '-$') + (abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2))
}
function pnlColor(v: number) { return v >= 0 ? 'var(--green)' : 'var(--red)' }

function buildPeriodRows(trades: Trade[], granularity: 'daily' | 'monthly'): PeriodRow[] {
  const map: Record<string, Omit<PeriodRow, 'cum_pnl'>> = {}
  for (const t of trades) {
    if (!t.closed_at) continue
    const key = granularity === 'daily' ? t.closed_at.slice(0, 10) : t.closed_at.slice(0, 7)
    if (!map[key]) map[key] = { period: key, trades: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, gross_win: 0, gross_loss: 0, profit_factor: 0, avg_pnl: 0, best_trade: -Infinity, worst_trade: Infinity }
    const r = map[key]; const p = t.pnl ?? 0
    r.trades++; r.total_pnl += p
    if (p > 0) { r.wins++; r.gross_win += p; if (p > r.best_trade) r.best_trade = p }
    else { r.losses++; r.gross_loss += Math.abs(p); if (p < r.worst_trade) r.worst_trade = p }
  }
  const sorted = Object.values(map).map(r => ({
    ...r,
    win_rate:      r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0,
    profit_factor: r.gross_loss > 0 ? r.gross_win / r.gross_loss : r.gross_win > 0 ? 99 : 0,
    avg_pnl:       r.trades > 0 ? r.total_pnl / r.trades : 0,
    best_trade:    r.best_trade  === -Infinity ? 0 : r.best_trade,
    worst_trade:   r.worst_trade ===  Infinity ? 0 : r.worst_trade,
  })).sort((a, b) => a.period.localeCompare(b.period))
  let cum = 0
  return sorted.map(r => { cum += r.total_pnl; return { ...r, cum_pnl: cum } }).reverse()
}

function downloadCSV(rows: PeriodRow[], filename: string) {
  const hdr   = 'Period,Trades,Wins,Losses,Win%,P&L,PF,Avg/Trade,Best,Worst,Cumulative'
  const lines = rows.map(r =>
    [r.period, r.trades, r.wins, r.losses, r.win_rate + '%',
     r.total_pnl.toFixed(2), r.profit_factor.toFixed(2), r.avg_pnl.toFixed(2),
     r.best_trade.toFixed(2), r.worst_trade.toFixed(2), r.cum_pnl.toFixed(2)].join(',')
  )
  const blob = new Blob([[hdr, ...lines].join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function BarChart({ rows }: { rows: PeriodRow[] }) {
  const last14 = [...rows].sort((a, b) => a.period.localeCompare(b.period)).slice(-14)
  if (!last14.length) return null
  const max = Math.max(...last14.map(r => Math.abs(r.total_pnl)), 1)
  const H = 52; const W = 100; const bw = (W / last14.length) * 0.72
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {last14.map((r, i) => {
        const bh = Math.max(0.8, (Math.abs(r.total_pnl) / max) * (H - 4))
        const x  = (i / last14.length) * W + ((W / last14.length) - bw) / 2
        return (
          <g key={r.period}>
            <rect x={x} y={H - bh} width={bw} height={bh} rx={0.5}
              fill={r.total_pnl >= 0 ? 'rgba(19,201,142,0.72)' : 'rgba(239,83,80,0.72)'} />
            <title>{r.period}: {dollar(r.total_pnl)}</title>
          </g>
        )
      })}
    </svg>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PerformancePage() {
  const etToday = toEtDate(new Date())

  // Range state (for History / Symbol / Source)
  const [preset,   setPreset]   = useState<Preset>('30d')
  const [fromDate, setFromDate] = useState<string>(() => presetRange('30d').from)
  const [toDate,   setToDate]   = useState<string>(etToday)
  const [customFrom, setCustomFrom] = useState<string>(etToday)
  const [customTo,   setCustomTo]   = useState<string>(etToday)

  // Day view state (independent single-day fetch)
  const [selDate,   setSelDate]   = useState<string>(etToday)
  const [dayTrades, setDayTrades] = useState<Trade[]>([])
  const [dayLoading, setDayLoading] = useState(false)

  // Range data
  const [trades,  setTrades]  = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)

  const [broker,  setBroker]  = useState<'alpaca_paper' | 'schwab'>('alpaca_paper')
  const [view,    setView]    = useState<ViewMode>('day')
  const [sortKey, setSortKey] = useState<SortKey>('total_pnl')
  const [gran,    setGran]    = useState<'daily' | 'monthly'>('daily')
  const [hSort,   setHSort]   = useState<HistSort>('period')
  const [hAsc,    setHAsc]    = useState(false)

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const hdrs    = { apikey: supaKey, Authorization: `Bearer ${supaKey}` }
  const SEL     = 'id,symbol,pnl,pnl_pct,entry_price,exit_price,closed_at,created_at,strategy,reason,broker,quantity'

  function brokerFilter(b: string) {
    return b === 'schwab' ? 'broker=eq.schwab' : 'or=(broker.eq.alpaca_paper,broker.is.null)'
  }

  // Fetch range trades (History / Symbol / Source tabs)
  useEffect(() => {
    if (preset === 'custom') return  // wait for Apply
    setLoading(true)
    const fromStr = fromDate + 'T00:00:00.000Z'
    const toStr   = toDate   + 'T23:59:59.999Z'
    const bf = brokerFilter(broker)
    fetch(
      `${supaUrl}/rest/v1/tb_trades?${bf}&closed_at=gte.${fromStr}&closed_at=lte.${toStr}&order=closed_at.desc&limit=1000&select=${SEL}`,
      { headers: hdrs }
    )
      .then(r => r.json())
      .then((rows: unknown) => { setTrades(Array.isArray(rows) ? rows : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [fromDate, toDate, broker, preset])  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch single-day trades (Day tab)
  useEffect(() => {
    if (view !== 'day') return
    setDayLoading(true)
    const fromStr = selDate + 'T00:00:00.000Z'
    const toStr   = selDate + 'T23:59:59.999Z'
    const bf = brokerFilter(broker)
    fetch(
      `${supaUrl}/rest/v1/tb_trades?${bf}&closed_at=gte.${fromStr}&closed_at=lte.${toStr}&order=closed_at.desc&limit=500&select=${SEL}`,
      { headers: hdrs }
    )
      .then(r => r.json())
      .then((rows: unknown) => { setDayTrades(Array.isArray(rows) ? rows : []); setDayLoading(false) })
      .catch(() => setDayLoading(false))
  }, [selDate, broker, view])  // eslint-disable-line react-hooks/exhaustive-deps

  function applyPreset(p: Preset) {
    setPreset(p)
    if (p !== 'custom') {
      const { from, to } = presetRange(p)
      setFromDate(from); setToDate(to)
      // For "today/yesterday" presets, also set Day view date
      if (p === 'today')     setSelDate(to)
      if (p === 'yesterday') setSelDate(from)
    }
  }

  function applyCustom() {
    setFromDate(customFrom); setToDate(customTo)
  }

  function drillToDay(date: string) {
    setSelDate(date)
    setView('day')
  }

  // Day stats
  const dayPnl    = dayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const dayWins   = dayTrades.filter(t => (t.pnl ?? 0) > 0).length
  const dayLoss   = dayTrades.filter(t => (t.pnl ?? 0) < 0).length
  const dayWr     = dayTrades.length > 0 ? Math.round(dayWins / dayTrades.length * 100) : 0
  const dayBest   = dayTrades.length > 0 ? Math.max(...dayTrades.map(t => t.pnl ?? 0)) : 0
  const dayWorst  = dayTrades.length > 0 ? Math.min(...dayTrades.map(t => t.pnl ?? 0)) : 0
  const dayGW     = dayTrades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
  const dayGL     = dayTrades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  const dayPF     = dayGL > 0 ? dayGW / dayGL : dayGW > 0 ? 99 : 0
  const dayAvg    = dayTrades.length > 0 ? dayPnl / dayTrades.length : 0

  // Range stats
  const periodRows = buildPeriodRows(trades, gran)
  const sortedRows = [...periodRows].sort((a, b) => {
    const v = hSort === 'period'        ? a.period.localeCompare(b.period)
            : hSort === 'trades'        ? a.trades - b.trades
            : hSort === 'win_rate'      ? a.win_rate - b.win_rate
            : hSort === 'total_pnl'     ? a.total_pnl - b.total_pnl
            : hSort === 'profit_factor' ? a.profit_factor - b.profit_factor
            : hSort === 'avg_pnl'       ? a.avg_pnl - b.avg_pnl
            : hSort === 'best_trade'    ? a.best_trade - b.best_trade
            : hSort === 'worst_trade'   ? a.worst_trade - b.worst_trade
            : 0
    return hAsc ? v : -v
  })

  const bySymbol: Record<string, SymbolStat> = {}
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { symbol: t.symbol, trades: 0, wins: 0, losses: 0, total_pnl: 0, avg_pnl: 0, best: -Infinity, worst: Infinity, win_rate: 0, source: inferSource(t.strategy, t.reason) }
    const s = bySymbol[t.symbol]; const p = t.pnl ?? 0
    s.trades++; s.total_pnl += p
    if (p > 0) s.wins++; else s.losses++
    if (p > s.best) s.best = p; if (p < s.worst) s.worst = p
  }
  const symList = Object.values(bySymbol).map(s => ({
    ...s, avg_pnl: s.total_pnl / s.trades, win_rate: Math.round(s.wins / s.trades * 100),
    best: s.best === -Infinity ? 0 : s.best, worst: s.worst === Infinity ? 0 : s.worst,
  })).sort((a, b) => {
    if (sortKey === 'total_pnl') return b.total_pnl - a.total_pnl
    if (sortKey === 'trades')    return b.trades    - a.trades
    if (sortKey === 'win_rate')  return b.win_rate  - a.win_rate
    return b.avg_pnl - a.avg_pnl
  })

  const bySource: Record<string, SourceStat> = {}
  for (const t of trades) {
    const src = inferSource(t.strategy, t.reason)
    if (!bySource[src]) bySource[src] = { source: src, trades: 0, wins: 0, total_pnl: 0, win_rate: 0, avg_pnl: 0 }
    bySource[src].trades++; bySource[src].total_pnl += t.pnl ?? 0
    if ((t.pnl ?? 0) > 0) bySource[src].wins++
  }
  const srcList = Object.values(bySource).map(s => ({
    ...s, win_rate: Math.round(s.wins / s.trades * 100), avg_pnl: s.total_pnl / s.trades,
  })).sort((a, b) => b.total_pnl - a.total_pnl)

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins     = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losses   = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate  = trades.length > 0 ? Math.round(wins / trades.length * 100) : 0

  // ── Style shortcuts ─────────────────────────────────────────────────────
  const th: React.CSSProperties = { textAlign: 'right', fontSize: '0.66rem', color: 'var(--fg-3)', padding: '5px 8px', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 8px', fontSize: '0.73rem' }

  function TH({ k, label, left }: { k: HistSort; label: string; left?: boolean }) {
    const on = hSort === k
    return (
      <th style={{ ...th, textAlign: left ? 'left' : 'right', paddingLeft: left ? 14 : undefined, color: on ? 'var(--fg-1)' : 'var(--fg-3)' }}
        onClick={() => { if (hSort === k) setHAsc(v => !v); else { setHSort(k); setHAsc(false) } }}>
        {label}{on ? (hAsc ? ' ↑' : ' ↓') : ''}
      </th>
    )
  }

  function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', minWidth: 0 }}>
        <div style={{ fontSize: '0.59rem', textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--fg-3)', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 800, color: color ?? 'var(--fg-1)', lineHeight: 1 }}>{value}</div>
        {sub && <div style={{ fontSize: '0.62rem', color: 'var(--fg-3)', marginTop: 3 }}>{sub}</div>}
      </div>
    )
  }

  function WrPill({ v }: { v: number }) {
    return <span style={{ display: 'inline-block', padding: '1px 5px', borderRadius: 3, fontSize: '0.67rem', fontWeight: 600, background: v >= 50 ? 'rgba(19,201,142,0.12)' : 'rgba(239,83,80,0.12)', color: v >= 50 ? 'var(--green)' : 'var(--red)' }}>{v}%</span>
  }

  function TradeTable({ rows, loading: l }: { rows: Trade[]; loading: boolean }) {
    if (l) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>Loading…</div>
    if (rows.length === 0) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)', fontSize: '0.82rem' }}>No closed trades.</div>
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'left', paddingLeft: 14 }}>Time</th>
              <th style={{ ...th, textAlign: 'left' }}>Symbol</th>
              <th style={{ ...th, textAlign: 'left' }}>Source</th>
              <th style={th}>Entry</th>
              <th style={th}>Exit</th>
              <th style={th}>P&L $</th>
              <th style={th}>P&L %</th>
              <th style={th}>Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const p   = t.pnl ?? 0
              const pp  = t.pnl_pct ?? 0
              const src = inferSource(t.strategy, t.reason)
              const clr = SOURCE_COLOR[src] ?? '#455a64'
              const time = t.closed_at
                ? new Date(t.closed_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
                : '—'
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                  <td style={{ ...td, textAlign: 'left', paddingLeft: 14, fontFamily: 'var(--font-mono)', fontSize: '0.69rem', color: 'var(--fg-3)' }}>{time}</td>
                  <td style={{ ...td, textAlign: 'left', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.8rem' }}>{t.symbol}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <span style={{ fontSize: '0.59rem', padding: '1px 5px', borderRadius: 3, background: `${clr}22`, color: clr, fontWeight: 600 }}>{src}</span>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{t.entry_price != null ? `$${t.entry_price.toFixed(2)}` : '—'}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{t.exit_price  != null ? `$${t.exit_price.toFixed(2)}`  : '—'}</td>
                  <td style={{ ...td, fontWeight: 700, fontSize: '0.8rem', color: pnlColor(p) }}>{dollar(p)}</td>
                  <td style={{ ...td, color: pnlColor(pp) }}>{pp >= 0 ? '+' : ''}{pp.toFixed(2)}%</td>
                  <td style={{ ...td, color: 'var(--fg-3)', fontSize: '0.7rem' }}>{t.quantity}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg-1)', fontFamily: 'var(--font-sans)', padding: '0 0 80px' }}>
      <TopNav />
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px' }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '1rem', fontWeight: 700 }}>Performance</span>

          {/* Broker toggle */}
          <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginLeft: 'auto' }}>
            {(['alpaca_paper', 'schwab'] as const).map(b => (
              <button key={b} onClick={() => setBroker(b)} style={{ padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: '0.72rem', fontWeight: broker === b ? 700 : 400, background: broker === b ? (b === 'schwab' ? 'rgba(239,83,80,0.18)' : 'rgba(19,201,142,0.14)') : 'transparent', color: broker === b ? (b === 'schwab' ? '#ef5350' : 'var(--green)') : 'var(--fg-3)', transition: 'all 0.15s' }}>
                {b === 'schwab' ? '🔴 Live' : '🟢 Paper'}
              </button>
            ))}
          </div>
        </div>

        {/* ── Date range presets ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 5, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['today','yesterday','7d','30d','90d','ytd','custom'] as Preset[]).map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              style={{ padding: '4px 11px', borderRadius: 6, border: `1px solid ${preset === p ? 'var(--green)' : 'var(--border)'}`, cursor: 'pointer', fontSize: '0.71rem', fontWeight: preset === p ? 600 : 400, background: preset === p ? 'rgba(19,201,142,0.1)' : 'var(--surface)', color: preset === p ? 'var(--green)' : 'var(--fg-3)' }}>
              {p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday' : p === 'ytd' ? 'YTD' : p === 'custom' ? '📅 Custom' : p}
            </button>
          ))}
          {preset === 'custom' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--fg-1)', fontSize: '0.71rem', padding: '3px 7px' }} />
              <span style={{ color: 'var(--fg-3)', fontSize: '0.7rem' }}>→</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--fg-1)', fontSize: '0.71rem', padding: '3px 7px' }} />
              <button onClick={applyCustom}
                style={{ padding: '4px 11px', borderRadius: 5, border: '1px solid var(--green)', background: 'rgba(19,201,142,0.12)', color: 'var(--green)', fontSize: '0.71rem', fontWeight: 600, cursor: 'pointer' }}>
                Apply
              </button>
            </div>
          )}
          {preset !== 'custom' && preset !== 'today' && preset !== 'yesterday' && (
            <span style={{ fontSize: '0.65rem', color: 'var(--fg-3)', marginLeft: 4 }}>{fromDate} → {toDate}</span>
          )}
        </div>

        {/* ── Tabs ───────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 18 }}>
          {([['day','Day'], ['history','History'], ['symbol','By Symbol'], ['source','By Source']] as [ViewMode,string][]).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)}
              style={{ padding: '6px 16px', border: 'none', borderBottom: view === v ? '2px solid var(--green)' : '2px solid transparent', background: 'none', color: view === v ? 'var(--green)' : 'var(--fg-3)', fontSize: '0.78rem', cursor: 'pointer', fontWeight: view === v ? 600 : 400, marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>

        {/* ── DAY VIEW ───────────────────────────────────────────────────── */}
        {view === 'day' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Date navigation */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setSelDate(shiftDate(selDate, -1))}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-2)', cursor: 'pointer', fontSize: '0.85rem' }}>←</button>
              <input type="date" value={selDate} onChange={e => setSelDate(e.target.value)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--fg-1)', fontSize: '0.85rem', fontWeight: 600, padding: '5px 11px', fontFamily: 'var(--font-mono)' }} />
              <button onClick={() => setSelDate(shiftDate(selDate, 1))} disabled={selDate >= etToday}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: selDate >= etToday ? 'var(--fg-4)' : 'var(--fg-2)', cursor: selDate >= etToday ? 'default' : 'pointer', fontSize: '0.85rem' }}>→</button>
              <button onClick={() => setSelDate(etToday)}
                style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-3)', cursor: 'pointer', fontSize: '0.68rem' }}>Today</button>
              {dayLoading && <span style={{ fontSize: '0.7rem', color: 'var(--fg-3)', marginLeft: 4 }}>Loading…</span>}
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
              <Stat label="Day P&L"    value={dollar(dayPnl)}    color={pnlColor(dayPnl)} sub={selDate} />
              <Stat label="Trades"     value={String(dayTrades.length)} sub="closed" />
              <Stat label="Win Rate"   value={`${dayWr}%`}       color={dayWr >= 50 ? 'var(--green)' : 'var(--red)'} sub={`${dayWins}W / ${dayLoss}L`} />
              <Stat label="Prof. Factor" value={dayPF >= 99 ? '—' : dayPF.toFixed(2)} color={dayPF >= 1 ? 'var(--green)' : 'var(--fg-3)'} />
              <Stat label="Avg / Trade" value={dollar(dayAvg)}   color={pnlColor(dayAvg)} />
              <Stat label="Best Trade"  value={dayBest  > 0 ? dollar(dayBest)  : '—'} color="var(--green)" />
              <Stat label="Worst Trade" value={dayWorst < 0 ? dollar(dayWorst) : '—'} color="var(--red)" />
            </div>

            {/* Trade table */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>Trades — {selDate}</span>
                <span style={{ fontSize: '0.67rem', color: 'var(--fg-3)' }}>{dayTrades.length} closed</span>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: pnlColor(dayPnl) }}>{dollar(dayPnl)}</span>
              </div>
              <TradeTable rows={dayTrades} loading={dayLoading} />
            </div>
          </div>
        )}

        {/* ── HISTORY ────────────────────────────────────────────────────── */}
        {view === 'history' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {loading ? <div style={{ textAlign: 'center', padding: 60, color: 'var(--fg-3)' }}>Loading…</div> : (
              <>
                {/* Bar chart */}
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-2)' }}>Daily P&L — last {Math.min(14, periodRows.length)} days</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700, color: pnlColor(totalPnl) }}>{dollar(totalPnl)}</span>
                    <span style={{ fontSize: '0.67rem', color: 'var(--fg-3)' }}>{trades.length} trades · {winRate}% win</span>
                  </div>
                  <BarChart rows={periodRows} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.6rem', color: 'var(--fg-3)' }}>
                    <span>older</span><span>newer</span>
                  </div>
                </div>

                {/* Breakdown table */}
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{gran === 'daily' ? 'Daily' : 'Monthly'} Breakdown</span>
                    <span style={{ fontSize: '0.67rem', color: 'var(--fg-3)' }}>{sortedRows.length} {gran === 'daily' ? 'days' : 'months'}</span>
                    {gran === 'daily' && <span style={{ fontSize: '0.62rem', color: 'var(--fg-4)' }}>click a row → see trades</span>}
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                      {(['daily','monthly'] as const).map(g => (
                        <button key={g} onClick={() => setGran(g)} style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', cursor: 'pointer', fontSize: '0.68rem', fontWeight: gran === g ? 600 : 400, background: gran === g ? 'rgba(19,201,142,0.12)' : 'var(--surface)', color: gran === g ? 'var(--green)' : 'var(--fg-3)' }}>
                          {g === 'daily' ? 'Daily' : 'Monthly'}
                        </button>
                      ))}
                      <button onClick={() => downloadCSV(sortedRows, `pnl-${gran}-${broker}-${fromDate}-${toDate}.csv`)} style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', cursor: 'pointer', fontSize: '0.68rem', background: 'var(--surface)', color: 'var(--fg-3)' }}>CSV</button>
                    </div>
                  </div>
                  {sortedRows.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>No closed trades in this period.</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                            <TH k="period"        label={gran === 'daily' ? 'Date' : 'Month'} left />
                            <TH k="trades"        label="Trades" />
                            <th style={{ ...th, color: 'var(--green)' }}>W</th>
                            <th style={{ ...th, color: 'var(--red)' }}>L</th>
                            <TH k="win_rate"      label="Win %" />
                            <TH k="total_pnl"     label="P&L" />
                            <TH k="profit_factor" label="PF" />
                            <TH k="avg_pnl"       label="Avg/Trade" />
                            <TH k="best_trade"    label="Best" />
                            <TH k="worst_trade"   label="Worst" />
                            <th style={{ ...th, borderLeft: '1px solid var(--border)', color: 'var(--fg-2)' }}>Cumulative</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedRows.map((r, i) => {
                            const up = r.total_pnl >= 0; const cu = r.cum_pnl >= 0
                            const clickable = gran === 'daily'
                            return (
                              <tr key={r.period}
                                onClick={clickable ? () => drillToDay(r.period) : undefined}
                                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)', cursor: clickable ? 'pointer' : 'default', transition: 'background 0.1s' }}
                                onMouseEnter={e => clickable && ((e.currentTarget as HTMLElement).style.background = 'rgba(19,201,142,0.05)')}
                                onMouseLeave={e => clickable && ((e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}>
                                <td style={{ ...td, textAlign: 'left', paddingLeft: 14, fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '0.75rem', color: 'var(--fg-2)' }}>
                                  {r.period}
                                  {clickable && <span style={{ marginLeft: 5, fontSize: '0.55rem', color: 'var(--fg-4)' }}>↗</span>}
                                </td>
                                <td style={td}>{r.trades}</td>
                                <td style={{ ...td, color: 'var(--green)' }}>{r.wins}</td>
                                <td style={{ ...td, color: 'var(--red)' }}>{r.losses}</td>
                                <td style={td}><WrPill v={r.win_rate} /></td>
                                <td style={{ ...td, fontWeight: 700, color: up ? 'var(--green)' : 'var(--red)' }}>{dollar(r.total_pnl)}</td>
                                <td style={{ ...td, color: r.profit_factor >= 1 ? 'var(--green)' : 'var(--fg-3)' }}>{r.profit_factor >= 99 ? '—' : r.profit_factor.toFixed(2)}</td>
                                <td style={{ ...td, color: r.avg_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{dollar(r.avg_pnl)}</td>
                                <td style={{ ...td, color: 'var(--green)' }}>{r.best_trade  > 0 ? dollar(r.best_trade)  : '—'}</td>
                                <td style={{ ...td, color: 'var(--red)'   }}>{r.worst_trade < 0 ? dollar(r.worst_trade) : '—'}</td>
                                <td style={{ ...td, fontWeight: 600, color: cu ? 'var(--green)' : 'var(--red)', borderLeft: '1px solid var(--border)' }}>{dollar(r.cum_pnl)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                            <td style={{ ...td, textAlign: 'left', paddingLeft: 14, fontWeight: 700, color: 'var(--fg-2)' }}>TOTAL</td>
                            <td style={{ ...td, fontWeight: 700 }}>{trades.length}</td>
                            <td style={{ ...td, fontWeight: 700, color: 'var(--green)' }}>{wins}</td>
                            <td style={{ ...td, fontWeight: 700, color: 'var(--red)' }}>{losses}</td>
                            <td style={td}><WrPill v={winRate} /></td>
                            <td style={{ ...td, fontWeight: 700, color: pnlColor(totalPnl) }}>{dollar(totalPnl)}</td>
                            <td style={td} /><td style={td} /><td style={td} /><td style={td} />
                            <td style={{ ...td, fontWeight: 700, color: pnlColor(totalPnl), borderLeft: '1px solid var(--border)' }}>{dollar(totalPnl)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── BY SYMBOL ──────────────────────────────────────────────────── */}
        {view === 'symbol' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 5 }}>
              {(['total_pnl','trades','win_rate','avg_pnl'] as SortKey[]).map(k => (
                <button key={k} onClick={() => setSortKey(k)} style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', cursor: 'pointer', fontSize: '0.68rem', fontWeight: sortKey === k ? 600 : 400, background: sortKey === k ? 'rgba(19,201,142,0.12)' : 'var(--surface)', color: sortKey === k ? 'var(--green)' : 'var(--fg-3)' }}>
                  {k === 'total_pnl' ? 'P&L' : k === 'win_rate' ? 'Win %' : k === 'avg_pnl' ? 'Avg' : 'Trades'}
                </button>
              ))}
            </div>
            {loading ? <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>Loading…</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                      <th style={{ ...th, textAlign: 'left', paddingLeft: 14 }}>Symbol</th>
                      <th style={{ ...th, textAlign: 'left' }}>Source</th>
                      <th style={th}>Trades</th>
                      <th style={{ ...th, color: 'var(--green)' }}>W</th>
                      <th style={{ ...th, color: 'var(--red)' }}>L</th>
                      <th style={th}>Win %</th>
                      <th style={th}>Total P&L</th>
                      <th style={th}>Avg/Trade</th>
                      <th style={{ ...th, color: 'var(--green)' }}>Best</th>
                      <th style={{ ...th, color: 'var(--red)' }}>Worst</th>
                    </tr>
                  </thead>
                  <tbody>
                    {symList.map((s, i) => {
                      const clr = SOURCE_COLOR[s.source] ?? '#455a64'
                      return (
                        <tr key={s.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                          <td style={{ ...td, textAlign: 'left', paddingLeft: 14, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{s.symbol}</td>
                          <td style={{ ...td, textAlign: 'left' }}><span style={{ fontSize: '0.59rem', padding: '1px 5px', borderRadius: 3, background: `${clr}22`, color: clr, fontWeight: 600 }}>{s.source}</span></td>
                          <td style={td}>{s.trades}</td>
                          <td style={{ ...td, color: 'var(--green)' }}>{s.wins}</td>
                          <td style={{ ...td, color: 'var(--red)' }}>{s.losses}</td>
                          <td style={td}><WrPill v={s.win_rate} /></td>
                          <td style={{ ...td, fontWeight: 700, color: pnlColor(s.total_pnl) }}>{dollar(s.total_pnl)}</td>
                          <td style={{ ...td, color: pnlColor(s.avg_pnl) }}>{dollar(s.avg_pnl)}</td>
                          <td style={{ ...td, color: 'var(--green)' }}>{s.best  > 0 ? dollar(s.best)  : '—'}</td>
                          <td style={{ ...td, color: 'var(--red)'   }}>{s.worst < 0 ? dollar(s.worst) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {symList.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>No closed trades.</div>}
              </div>
            )}
          </div>
        )}

        {/* ── BY SOURCE ──────────────────────────────────────────────────── */}
        {view === 'source' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {loading ? <div style={{ textAlign: 'center', padding: 60, color: 'var(--fg-3)' }}>Loading…</div> : (
              <>
                {srcList.map(s => {
                  const clr = SOURCE_COLOR[s.source] ?? '#455a64'
                  return (
                    <div key={s.source} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: clr }}>{s.source}</span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--fg-3)' }}>{s.trades} trades</span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '0.95rem', color: pnlColor(s.total_pnl) }}>{dollar(s.total_pnl)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 16, fontSize: '0.7rem', marginBottom: 8 }}>
                        <span style={{ color: 'var(--green)' }}>{s.wins}W</span>
                        <span style={{ color: 'var(--red)' }}>{s.trades - s.wins}L</span>
                        <span style={{ color: s.win_rate >= 50 ? 'var(--green)' : 'var(--fg-3)' }}>{s.win_rate}% win</span>
                        <span style={{ color: pnlColor(s.avg_pnl) }}>{dollar(s.avg_pnl)}/trade</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 3, background: 'var(--bg)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${s.win_rate}%`, background: clr, transition: 'width 0.4s' }} />
                      </div>
                    </div>
                  )
                })}
                {srcList.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>No data.</div>}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
