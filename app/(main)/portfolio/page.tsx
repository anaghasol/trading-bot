'use client'

import { useEffect, useState } from 'react'

type Source = 'sf_trades' | 'ai_scan'
type Filter = 'all' | Source

interface Position {
  symbol: string; broker: string; qty: number
  pl_day: number; pl_open: number; pl_pct: number
  avg_cost: number; net_liq: number; mark: number
  source: Source; confidence: number
  stop_loss: number | null; target_price: number | null
}
interface ClosedTrade {
  id: number; symbol: string; broker: string; quantity: number
  entry_price: number; exit_price: number | null
  pnl: number | null; pnl_pct: number | null
  confidence: number; created_at: string; closed_at: string | null
  source: Source
}

const num = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
const pnlColor = (n: number) => n >= 0 ? 'var(--green)' : 'var(--red)'

function SourceTag({ s }: { s: Source }) {
  return s === 'sf_trades'
    ? <span style={{ fontSize: '0.58rem', padding: '1px 6px', borderRadius: 20, background: 'rgba(99,179,237,0.15)', color: '#63b3ed', border: '1px solid rgba(99,179,237,0.3)', fontWeight: 700, letterSpacing: '0.02em' }}>SF TRADES</span>
    : <span style={{ fontSize: '0.58rem', padding: '1px 6px', borderRadius: 20, background: 'rgba(19,201,142,0.12)', color: 'var(--green)', border: '1px solid rgba(19,201,142,0.3)', fontWeight: 700, letterSpacing: '0.02em' }}>OUR AI</span>
}

function SummaryRow({ label, positions, closed, color }: { label: string; positions: Position[]; closed: ClosedTrade[]; color: string }) {
  const totalNetLiq  = positions.reduce((s, p) => s + p.net_liq, 0)
  const totalPlOpen  = positions.reduce((s, p) => s + p.pl_open, 0)
  const totalPlDay   = positions.reduce((s, p) => s + p.pl_day, 0)
  const closedPnl    = closed.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins  = closed.filter(t => (t.pnl ?? 0) > 0).length
  const losses = closed.filter(t => (t.pnl ?? 0) <= 0).length
  return (
    <div style={{ flex: 1, background: 'var(--card)', border: `1px solid ${color}44`, borderRadius: 10, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
        <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--fg-1)' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--fg-3)' }}>{positions.length} open · {closed.length} closed (30d)</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
        {[
          { l: 'Net Liq', v: '$' + totalNetLiq.toLocaleString('en-US', { maximumFractionDigits: 0 }), c: 'var(--fg-1)' },
          { l: 'P/L Open', v: (totalPlOpen >= 0 ? '+' : '') + '$' + num(totalPlOpen), c: pnlColor(totalPlOpen) },
          { l: 'P/L Day', v: (totalPlDay >= 0 ? '+' : '') + '$' + num(totalPlDay), c: pnlColor(totalPlDay) },
          { l: 'Closed P&L (30d)', v: (closedPnl >= 0 ? '+' : '') + '$' + Math.abs(closedPnl).toLocaleString('en-US', { maximumFractionDigits: 0 }), c: pnlColor(closedPnl) },
          { l: 'Win Rate', v: (wins + losses) > 0 ? `${Math.round(wins / (wins + losses) * 100)}%  ${wins}W/${losses}L` : '—', c: 'var(--fg-1)' },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: 'var(--bg-2)', borderRadius: 7, padding: '8px 10px' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{l}</div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: c }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PortfolioPage() {
  const [positions, setPositions] = useState<Position[]>([])
  const [history,   setHistory]   = useState<ClosedTrade[]>([])
  const [filter,    setFilter]    = useState<Filter>('all')
  const [tab,       setTab]       = useState<'open' | 'closed'>('open')
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    fetch('/api/portfolio').then(r => r.json()).then(d => {
      setPositions(d.positions ?? [])
      setHistory(d.history ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const sfPos   = positions.filter(p => p.source === 'sf_trades')
  const aiPos   = positions.filter(p => p.source === 'ai_scan')
  const sfClosed = history.filter(t => t.source === 'sf_trades')
  const aiClosed = history.filter(t => t.source === 'ai_scan')

  const visiblePos = filter === 'all' ? positions : positions.filter(p => p.source === filter)
  const visibleHist = filter === 'all' ? history : history.filter(t => t.source === filter)

  const thStyle: React.CSSProperties = { padding: '9px 12px', textAlign: 'right', fontSize: '0.65rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }
  const tdStyle: React.CSSProperties = { padding: '10px 12px', textAlign: 'right', fontSize: '0.8rem', borderBottom: '1px solid var(--border)' }

  return (
    <div style={{ padding: '20px 20px' }}>

        {/* Summary row */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
          <SummaryRow label="SF Trades" positions={sfPos} closed={sfClosed} color="#63b3ed" />
          <SummaryRow label="Our AI"    positions={aiPos} closed={aiClosed} color="var(--green)" />
        </div>

        {/* Filter + tab bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          {/* Source filter */}
          {(['all', 'sf_trades', 'ai_scan'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600, background: filter === f ? (f === 'sf_trades' ? '#63b3ed' : f === 'ai_scan' ? 'var(--green)' : 'var(--bg-3)') : 'var(--bg-3)', color: filter === f && f !== 'all' ? '#fff' : filter === f ? 'var(--fg-1)' : 'var(--fg-3)', border: '1px solid ' + (filter === f ? (f === 'sf_trades' ? '#63b3ed' : f === 'ai_scan' ? 'var(--green)' : 'var(--border)') : 'var(--border)') }}>
              {f === 'all' ? 'All Sources' : f === 'sf_trades' ? '📡 SF Trades' : '🤖 Our AI'}
            </button>
          ))}
          <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
          {/* Open / Closed tab */}
          {(['open', 'closed'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600, background: tab === t ? 'var(--bg-2)' : 'transparent', color: tab === t ? 'var(--fg-1)' : 'var(--fg-3)', border: '1px solid ' + (tab === t ? 'var(--border)' : 'transparent') }}>
              {t === 'open' ? `Open Positions (${visiblePos.length})` : `Closed Trades (${visibleHist.length})`}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--fg-3)' }}>
            NET LIQ <span style={{ color: 'var(--fg-1)', fontWeight: 700 }}>${visiblePos.reduce((s, p) => s + p.net_liq, 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </span>
        </div>

        {/* Table */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {loading
            ? <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>Loading…</div>
            : tab === 'open'
              ? visiblePos.length === 0
                ? <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>No open positions</div>
                : <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, textAlign: 'left' }}>Symbol</th>
                        <th style={thStyle}>Qty</th>
                        <th style={thStyle}>P/L Day</th>
                        <th style={thStyle}>P/L Open</th>
                        <th style={thStyle}>P/L %</th>
                        <th style={thStyle}>Avg Cost</th>
                        <th style={thStyle}>Net Liq</th>
                        <th style={thStyle}>Mark</th>
                        <th style={thStyle}>SL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePos.sort((a, b) => b.net_liq - a.net_liq).map(p => (
                        <tr key={p.symbol + p.broker} style={{ background: 'var(--card)' }}>
                          <td style={{ ...tdStyle, textAlign: 'left' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 700 }}>{p.symbol}</span>
                              <span className="chip mut" style={{ fontSize: '0.58rem' }}>EQ</span>
                              <SourceTag s={p.source} />
                            </div>
                            <div style={{ fontSize: '0.62rem', color: 'var(--fg-3)', marginTop: 2 }}>
                              {p.broker === 'schwab' ? '🔴 Live' : '🔵 Paper'}{p.confidence > 0 ? ` · ${p.confidence}%` : ''}
                            </div>
                          </td>
                          <td style={tdStyle}>+{p.qty}</td>
                          <td style={{ ...tdStyle, color: pnlColor(p.pl_day) }}>{p.pl_day !== 0 ? (p.pl_day >= 0 ? '+' : '') + '$' + num(p.pl_day) : '—'}</td>
                          <td style={{ ...tdStyle, color: pnlColor(p.pl_open) }}>{(p.pl_open >= 0 ? '+' : '') + '$' + num(p.pl_open)}</td>
                          <td style={{ ...tdStyle, color: pnlColor(p.pl_pct), fontWeight: 600 }}>{pct(p.pl_pct)}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-3)' }}>${num(p.avg_cost)}</td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>${num(p.net_liq)}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-2)' }}>{p.mark.toFixed(2)}</td>
                          <td style={{ ...tdStyle, color: 'var(--red)', fontSize: '0.75rem' }}>{p.stop_loss ? '$' + p.stop_loss.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              : visibleHist.length === 0
                ? <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>No closed trades</div>
                : <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, textAlign: 'left' }}>Symbol</th>
                        <th style={thStyle}>Qty</th>
                        <th style={thStyle}>Entry</th>
                        <th style={thStyle}>Exit</th>
                        <th style={thStyle}>P/L $</th>
                        <th style={thStyle}>P/L %</th>
                        <th style={thStyle}>Conf</th>
                        <th style={thStyle}>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleHist.map(t => (
                        <tr key={t.id} style={{ background: 'var(--card)' }}>
                          <td style={{ ...tdStyle, textAlign: 'left' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 700 }}>{t.symbol}</span>
                              <SourceTag s={t.source} />
                            </div>
                            <div style={{ fontSize: '0.62rem', color: 'var(--fg-3)', marginTop: 2 }}>{t.broker === 'schwab' ? '🔴 Live' : '🔵 Paper'}</div>
                          </td>
                          <td style={tdStyle}>{t.quantity}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-3)' }}>${t.entry_price.toFixed(2)}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-3)' }}>{t.exit_price ? '$' + t.exit_price.toFixed(2) : '—'}</td>
                          <td style={{ ...tdStyle, color: pnlColor(t.pnl ?? 0), fontWeight: 700 }}>{t.pnl != null ? (t.pnl >= 0 ? '+' : '') + '$' + num(t.pnl) : '—'}</td>
                          <td style={{ ...tdStyle, color: pnlColor(t.pnl_pct ?? 0) }}>{t.pnl_pct != null ? pct(t.pnl_pct) : '—'}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-3)' }}>{t.confidence > 0 ? t.confidence + '%' : '—'}</td>
                          <td style={{ ...tdStyle, color: 'var(--fg-3)', fontSize: '0.72rem' }}>{t.closed_at ? new Date(t.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>}
        </div>
      </div>
  )
}
