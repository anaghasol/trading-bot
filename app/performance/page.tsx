'use client'
import { useEffect, useState } from 'react'
import TopNav from '@/components/layout/TopNav'

// ── Types ──────────────────────────────────────────────────────────────────────
interface ClosedTrade {
  id: number
  symbol: string
  pnl: number
  pnl_pct: number
  entry_price: number
  exit_price: number
  closed_at: string
  created_at: string
  strategy: string
  reason: string
  broker: string
  quantity: number
}

interface DayPnl { date: string; pnl: number; trades: number; wins: number }
interface SymbolStat {
  symbol: string; trades: number; wins: number; losses: number
  total_pnl: number; avg_pnl: number; best: number; worst: number
  win_rate: number; source: string
}
interface SourceStat {
  source: string; trades: number; wins: number; total_pnl: number; win_rate: number; avg_pnl: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function inferSource(strategy: string, reason: string): string {
  const s = strategy?.toUpperCase() ?? ''
  const r = reason?.toLowerCase() ?? ''
  if (s.includes('OPTION') || s.includes('SPREAD') || s.includes('BULL_PUT')) return 'Options'
  if (r.includes('tg') || r.includes('telegram') || s.includes('TG_')) return 'Telegram'
  if (s.includes('SURGE') || s.includes('MOMENTUM')) return 'Momentum Surge'
  if (s.includes('EMA') || s.includes('BOUNCE') || s.includes('PULLBACK')) return 'EMA Scanner'
  if (s.includes('BREAKOUT')) return 'Breakout'
  if (s.includes('DISCOVERY')) return 'Discovery'
  if (s.includes('RECOVERED')) return 'Recovered'
  return strategy || 'Unknown'
}

const SOURCE_COLOR: Record<string, string> = {
  'Telegram':       '#29b6f6',
  'Momentum Surge': '#ab47bc',
  'EMA Scanner':    '#13c98e',
  'Breakout':       '#ff9800',
  'Options':        '#ffd600',
  'Discovery':      '#ef5350',
  'Recovered':      '#78909c',
  'Unknown':        '#455a64',
}

function pnlColor(v: number) { return v >= 0 ? 'var(--green)' : 'var(--red)' }
function sign(v: number) { return v >= 0 ? '+' : '' }
function num(v: number) { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2) }

// Calendar heatmap intensity
function heatColor(pnl: number): string {
  if (pnl === 0) return 'var(--surface)'
  if (pnl > 0) {
    if (pnl > 500) return 'rgba(19,201,142,0.85)'
    if (pnl > 200) return 'rgba(19,201,142,0.55)'
    if (pnl > 50)  return 'rgba(19,201,142,0.30)'
    return 'rgba(19,201,142,0.15)'
  }
  if (pnl < -500) return 'rgba(239,83,80,0.85)'
  if (pnl < -200) return 'rgba(239,83,80,0.55)'
  if (pnl < -50)  return 'rgba(239,83,80,0.30)'
  return 'rgba(239,83,80,0.15)'
}

// Build calendar grid: last 90 days
function buildCalendar(byDay: Record<string, DayPnl>): { weeks: { date: string; pnl: number; trades: number; wins: number }[][] } {
  const today = new Date()
  // Start from 90 days ago, adjusted to Sunday
  const start = new Date(today)
  start.setDate(start.getDate() - 89)
  start.setDate(start.getDate() - start.getDay()) // go to Sunday

  const weeks: { date: string; pnl: number; trades: number; wins: number }[][] = []
  let week: typeof weeks[0] = []
  const d = new Date(start)
  while (d <= today) {
    const dateStr = d.toISOString().split('T')[0]
    const day = byDay[dateStr]
    week.push({ date: dateStr, pnl: day?.pnl ?? 0, trades: day?.trades ?? 0, wins: day?.wins ?? 0 })
    if (d.getDay() === 6) { weeks.push(week); week = [] }
    d.setDate(d.getDate() + 1)
  }
  if (week.length > 0) weeks.push(week)
  return { weeks }
}

// ── Page ───────────────────────────────────────────────────────────────────────
type SortKey = 'total_pnl' | 'trades' | 'win_rate' | 'avg_pnl'
type ViewMode = 'calendar' | 'symbol' | 'source' | 'monthly'

export default function PerformancePage() {
  const [trades, setTrades] = useState<ClosedTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(90)
  const [broker, setBroker] = useState<'alpaca_paper' | 'schwab'>('alpaca_paper')
  const [view, setView] = useState<ViewMode>('calendar')
  const [sortKey, setSortKey] = useState<SortKey>('total_pnl')
  const [tooltip, setTooltip] = useState<{ date: string; pnl: number; trades: number; wins: number } | null>(null)

  useEffect(() => {
    setLoading(true)
    const from = new Date(Date.now() - days * 86_400_000).toISOString()
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const brokerFilter = broker === 'schwab' ? `broker=eq.schwab` : `or=(broker.eq.alpaca_paper,broker.is.null)`
    fetch(
      `${supaUrl}/rest/v1/tb_trades?status=eq.CLOSED&${brokerFilter}&closed_at=gte.${from}&order=closed_at.desc&limit=500&select=id,symbol,pnl,pnl_pct,entry_price,exit_price,closed_at,created_at,strategy,reason,broker,quantity`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    )
      .then(r => r.json())
      .then((rows: ClosedTrade[]) => { setTrades(rows); setLoading(false) })
      .catch(() => setLoading(false))
  }, [days, broker])

  // ── Derived stats ────────────────────────────────────────────────────────────
  const byDay: Record<string, DayPnl> = {}
  for (const t of trades) {
    const d = (t.closed_at || t.created_at || '').slice(0, 10)
    if (!d) continue
    if (!byDay[d]) byDay[d] = { date: d, pnl: 0, trades: 0, wins: 0 }
    byDay[d].pnl    += t.pnl ?? 0
    byDay[d].trades += 1
    byDay[d].wins   += (t.pnl ?? 0) > 0 ? 1 : 0
  }

  const bySymbol: Record<string, SymbolStat> = {}
  for (const t of trades) {
    const sym = t.symbol
    if (!bySymbol[sym]) bySymbol[sym] = { symbol: sym, trades: 0, wins: 0, losses: 0, total_pnl: 0, avg_pnl: 0, best: -Infinity, worst: Infinity, win_rate: 0, source: inferSource(t.strategy, t.reason) }
    const s = bySymbol[sym]
    s.trades++
    s.total_pnl += t.pnl ?? 0
    if ((t.pnl ?? 0) > 0) s.wins++; else s.losses++
    if ((t.pnl ?? 0) > s.best)  s.best  = t.pnl ?? 0
    if ((t.pnl ?? 0) < s.worst) s.worst = t.pnl ?? 0
  }
  const symList = Object.values(bySymbol).map(s => ({
    ...s, avg_pnl: s.total_pnl / s.trades, win_rate: Math.round(s.wins / s.trades * 100),
    best: s.best === -Infinity ? 0 : s.best, worst: s.worst === Infinity ? 0 : s.worst,
  })).sort((a, b) => {
    if (sortKey === 'total_pnl') return b.total_pnl - a.total_pnl
    if (sortKey === 'trades')    return b.trades - a.trades
    if (sortKey === 'win_rate')  return b.win_rate - a.win_rate
    return b.avg_pnl - a.avg_pnl
  })

  const bySource: Record<string, SourceStat> = {}
  for (const t of trades) {
    const src = inferSource(t.strategy, t.reason)
    if (!bySource[src]) bySource[src] = { source: src, trades: 0, wins: 0, total_pnl: 0, win_rate: 0, avg_pnl: 0 }
    bySource[src].trades++
    bySource[src].total_pnl += t.pnl ?? 0
    if ((t.pnl ?? 0) > 0) bySource[src].wins++
  }
  const srcList = Object.values(bySource).map(s => ({
    ...s, win_rate: Math.round(s.wins / s.trades * 100), avg_pnl: s.total_pnl / s.trades,
  })).sort((a, b) => b.total_pnl - a.total_pnl)

  // Monthly rollup
  const byMonth: Record<string, { pnl: number; trades: number; wins: number }> = {}
  for (const t of trades) {
    const mo = (t.closed_at || '').slice(0, 7)
    if (!mo) continue
    if (!byMonth[mo]) byMonth[mo] = { pnl: 0, trades: 0, wins: 0 }
    byMonth[mo].pnl    += t.pnl ?? 0
    byMonth[mo].trades += 1
    byMonth[mo].wins   += (t.pnl ?? 0) > 0 ? 1 : 0
  }
  const monthList = Object.entries(byMonth).sort(([a], [b]) => b.localeCompare(a))

  const totalPnl  = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins      = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losses    = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate   = trades.length > 0 ? Math.round(wins / trades.length * 100) : 0
  const calendar  = buildCalendar(byDay)
  const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  const thStyle: React.CSSProperties = { textAlign: 'right', cursor: 'pointer', userSelect: 'none', fontSize: '0.68rem', color: 'var(--fg-3)', padding: '4px 8px' }
  const tdStyle: React.CSSProperties = { textAlign: 'right', padding: '5px 8px', fontSize: '0.73rem' }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg-1)', fontFamily: 'var(--font-sans)', padding: '0 0 80px' }}>
      <TopNav />

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>📊 Performance</h1>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {(['alpaca_paper', 'schwab'] as const).map(b => (
              <button key={b} onClick={() => setBroker(b)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: broker === b ? 'var(--green)' : 'var(--surface)', color: broker === b ? '#000' : 'var(--fg-2)', fontSize: '0.72rem', cursor: 'pointer', fontWeight: broker === b ? 700 : 400 }}>
                {b === 'schwab' ? 'Live' : 'Paper'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[30, 60, 90].map(d => (
              <button key={d} onClick={() => setDays(d)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: days === d ? 'rgba(255,255,255,0.07)' : 'var(--surface)', color: days === d ? 'var(--fg-1)' : 'var(--fg-3)', fontSize: '0.72rem', cursor: 'pointer' }}>
                {d}d
              </button>
            ))}
          </div>
        </div>

        {/* Summary chips */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 24 }}>
          {[
            { label: 'Total P&L', value: `${sign(totalPnl)}$${Math.abs(totalPnl).toFixed(2)}`, color: pnlColor(totalPnl) },
            { label: 'Trades',    value: trades.length, color: 'var(--fg-1)' },
            { label: 'Win Rate',  value: `${winRate}%`, color: winRate >= 50 ? 'var(--green)' : 'var(--red)' },
            { label: 'Wins',      value: wins, color: 'var(--green)' },
            { label: 'Losses',    value: losses, color: 'var(--red)' },
            { label: 'Avg/Trade', value: `${sign(totalPnl / (trades.length || 1))}$${Math.abs(totalPnl / (trades.length || 1)).toFixed(2)}`, color: pnlColor(totalPnl) },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)', padding: '10px 14px' }}>
              <div style={{ fontSize: '0.62rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{loading ? '—' : String(value)}</div>
            </div>
          ))}
        </div>

        {/* View tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
          {(['calendar', 'symbol', 'source', 'monthly'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setView(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: view === v ? 'rgba(19,201,142,0.15)' : 'none', color: view === v ? 'var(--green)' : 'var(--fg-3)', fontSize: '0.78rem', cursor: 'pointer', fontWeight: view === v ? 600 : 400, textTransform: 'capitalize' }}>
              {v === 'calendar' ? '📅 Calendar' : v === 'symbol' ? '📈 By Symbol' : v === 'source' ? '🔌 By Source' : '📆 Monthly'}
            </button>
          ))}
        </div>

        {loading && <div style={{ color: 'var(--fg-3)', textAlign: 'center', padding: 40 }}>Loading…</div>}

        {/* ── CALENDAR VIEW ── */}
        {!loading && view === 'calendar' && (
          <div style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', padding: '20px 24px' }}>
            <h2 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 16, color: 'var(--fg-2)' }}>Daily P&L — last {days} days</h2>
            <div style={{ display: 'flex', gap: 3, alignItems: 'flex-start', overflowX: 'auto' }}>
              {/* Day labels */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 18, marginRight: 4 }}>
                {['S','M','T','W','T','F','S'].map((d, i) => (
                  <div key={i} style={{ height: 14, fontSize: '0.6rem', color: 'var(--fg-3)', lineHeight: '14px' }}>{d}</div>
                ))}
              </div>
              {calendar.weeks.map((week, wi) => (
                <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* Month label on first week of month */}
                  <div style={{ height: 14, fontSize: '0.6rem', color: 'var(--fg-3)', lineHeight: '14px', textAlign: 'center' }}>
                    {week[0]?.date && new Date(week[0].date + 'T12:00:00').getDate() <= 7
                      ? MONTHS[new Date(week[0].date + 'T12:00:00').getMonth()]
                      : ''}
                  </div>
                  {week.map((day, di) => {
                    const isFuture = day.date > new Date().toISOString().split('T')[0]
                    return (
                      <div
                        key={di}
                        title={day.trades > 0 ? `${day.date}: ${sign(day.pnl)}$${Math.abs(day.pnl).toFixed(2)} (${day.trades} trades, ${day.wins}W)` : day.date}
                        onMouseEnter={() => day.trades > 0 ? setTooltip(day) : setTooltip(null)}
                        onMouseLeave={() => setTooltip(null)}
                        style={{
                          width: 14, height: 14, borderRadius: 3,
                          background: isFuture ? 'transparent' : heatColor(day.pnl),
                          border: isFuture ? 'none' : '1px solid rgba(255,255,255,0.04)',
                          cursor: day.trades > 0 ? 'pointer' : 'default',
                          transition: 'transform 0.1s',
                        }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: '0.62rem', color: 'var(--fg-3)' }}>
              <span>Loss</span>
              {['rgba(239,83,80,0.85)','rgba(239,83,80,0.55)','rgba(239,83,80,0.15)','var(--surface)','rgba(19,201,142,0.15)','rgba(19,201,142,0.55)','rgba(19,201,142,0.85)'].map((c, i) => (
                <div key={i} style={{ width: 12, height: 12, borderRadius: 2, background: c, border: '1px solid rgba(255,255,255,0.06)' }} />
              ))}
              <span>Profit</span>
            </div>
            {/* Tooltip */}
            {tooltip && (
              <div style={{ marginTop: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '8px 12px', fontSize: '0.75rem', display: 'inline-block' }}>
                <b>{tooltip.date}</b> · {sign(tooltip.pnl)}${Math.abs(tooltip.pnl).toFixed(2)} · {tooltip.trades} trades · {tooltip.wins}W/{tooltip.trades - tooltip.wins}L
              </div>
            )}
            {/* Day list below */}
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Object.entries(byDay).sort(([a],[b]) => b.localeCompare(a)).map(([date, d]) => (
                <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.75rem', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ width: 90, color: 'var(--fg-3)' }}>{date}</span>
                  <span style={{ width: 80, fontWeight: 700, color: pnlColor(d.pnl) }}>{sign(d.pnl)}${Math.abs(d.pnl).toFixed(2)}</span>
                  <span style={{ width: 70, color: 'var(--fg-3)' }}>{d.trades} trades</span>
                  <span style={{ color: 'var(--green)' }}>▲{d.wins}</span>
                  <span style={{ color: 'var(--red)' }}>▼{d.trades - d.wins}</span>
                  <span style={{ color: 'var(--fg-3)' }}>{Math.round(d.wins / d.trades * 100)}% win</span>
                  {/* Mini bar */}
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--bg)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, Math.abs(d.pnl) / 20)}%`, background: d.pnl >= 0 ? 'var(--green)' : 'var(--red)', borderRadius: 2 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── BY SYMBOL ── */}
        {!loading && view === 'symbol' && (
          <div style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 16 }}>Symbol</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Source</th>
                  <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('trades')}>Trades {sortKey === 'trades' ? '▼' : ''}</th>
                  <th style={thStyle}>Wins</th>
                  <th style={thStyle}>Losses</th>
                  <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('win_rate')}>Win% {sortKey === 'win_rate' ? '▼' : ''}</th>
                  <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('total_pnl')}>Total P&L {sortKey === 'total_pnl' ? '▼' : ''}</th>
                  <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('avg_pnl')}>Avg/Trade {sortKey === 'avg_pnl' ? '▼' : ''}</th>
                  <th style={thStyle}>Best</th>
                  <th style={thStyle}>Worst</th>
                </tr>
              </thead>
              <tbody>
                {symList.map((s) => (
                  <tr key={s.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ ...tdStyle, textAlign: 'left', paddingLeft: 16, fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.8rem' }}>{s.symbol}</td>
                    <td style={{ ...tdStyle, textAlign: 'left' }}>
                      <span style={{ fontSize: '0.62rem', padding: '2px 6px', borderRadius: 4, background: `${SOURCE_COLOR[s.source] ?? '#455a64'}22`, color: SOURCE_COLOR[s.source] ?? '#aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {s.source}
                      </span>
                    </td>
                    <td style={tdStyle}>{s.trades}</td>
                    <td style={{ ...tdStyle, color: 'var(--green)' }}>{s.wins}</td>
                    <td style={{ ...tdStyle, color: 'var(--red)' }}>{s.losses}</td>
                    <td style={{ ...tdStyle, color: s.win_rate >= 50 ? 'var(--green)' : 'var(--fg-3)' }}>{s.win_rate}%</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: pnlColor(s.total_pnl) }}>{sign(s.total_pnl)}${Math.abs(s.total_pnl).toFixed(2)}</td>
                    <td style={{ ...tdStyle, color: pnlColor(s.avg_pnl) }}>{sign(s.avg_pnl)}${Math.abs(s.avg_pnl).toFixed(2)}</td>
                    <td style={{ ...tdStyle, color: 'var(--green)' }}>+${s.best.toFixed(2)}</td>
                    <td style={{ ...tdStyle, color: 'var(--red)' }}>${s.worst.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {symList.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>No closed trades in this period.</div>}
          </div>
        )}

        {/* ── BY SOURCE ── */}
        {!loading && view === 'source' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {srcList.map(s => {
              const color = SOURCE_COLOR[s.source] ?? '#455a64'
              const barPct = trades.length > 0 ? (s.trades / trades.length) * 100 : 0
              return (
                <div key={s.source} style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.9rem', color }}>{s.source}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--fg-3)' }}>{s.trades} trades ({barPct.toFixed(0)}% of total)</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '1rem', color: pnlColor(s.total_pnl) }}>{sign(s.total_pnl)}${Math.abs(s.total_pnl).toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 20, fontSize: '0.73rem', marginBottom: 10 }}>
                    <span style={{ color: 'var(--green)' }}>▲ {s.wins} wins</span>
                    <span style={{ color: 'var(--red)' }}>▼ {s.trades - s.wins} losses</span>
                    <span style={{ color: s.win_rate >= 50 ? 'var(--green)' : 'var(--fg-3)' }}>Win rate: {s.win_rate}%</span>
                    <span style={{ color: pnlColor(s.avg_pnl) }}>Avg: {sign(s.avg_pnl)}${Math.abs(s.avg_pnl).toFixed(2)}/trade</span>
                  </div>
                  {/* Win/loss bar */}
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--bg)', overflow: 'hidden', display: 'flex' }}>
                    <div style={{ width: `${s.win_rate}%`, background: color, transition: 'width 0.4s' }} />
                  </div>
                </div>
              )
            })}
            {srcList.length === 0 && <div style={{ color: 'var(--fg-3)', textAlign: 'center', padding: 40 }}>No data.</div>}
          </div>
        )}

        {/* ── MONTHLY ── */}
        {!loading && view === 'monthly' && (
          <div style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', padding: '20px 24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {monthList.map(([mo, d]) => {
                const maxAbs = Math.max(...monthList.map(([,x]) => Math.abs(x.pnl)), 1)
                return (
                  <div key={mo} style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: '0.8rem' }}>
                    <span style={{ width: 70, fontWeight: 600, color: 'var(--fg-2)' }}>{mo}</span>
                    <span style={{ width: 90, fontWeight: 700, color: pnlColor(d.pnl) }}>{sign(d.pnl)}${Math.abs(d.pnl).toFixed(2)}</span>
                    <span style={{ width: 80, color: 'var(--fg-3)', fontSize: '0.72rem' }}>{d.trades} trades</span>
                    <span style={{ color: 'var(--green)', fontSize: '0.72rem' }}>▲{d.wins}</span>
                    <span style={{ color: 'var(--red)', fontSize: '0.72rem', marginLeft: 4 }}>▼{d.trades - d.wins}</span>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(Math.abs(d.pnl) / maxAbs) * 100}%`, background: d.pnl >= 0 ? 'var(--green)' : 'var(--red)', borderRadius: 4, transition: 'width 0.4s' }} />
                    </div>
                    <span style={{ width: 50, fontSize: '0.7rem', color: 'var(--fg-3)' }}>{Math.round(d.wins / d.trades * 100)}% W</span>
                  </div>
                )
              })}
              {monthList.length === 0 && <div style={{ color: 'var(--fg-3)', textAlign: 'center', padding: 30 }}>No closed trades in this period.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
