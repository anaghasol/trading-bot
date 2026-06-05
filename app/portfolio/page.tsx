'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

const NAV: [string, string][] = [['/dashboard', 'Desk'], ['/growth', 'Growth'], ['/sleeves', 'Sleeves'], ['/portfolio', 'Portfolio'], ['/trades', 'Trades'], ['/learning', 'Learning'], ['/settings', 'Settings']]

type Source = 'sf_trades' | 'ai_scan'
interface Trade {
  id: number
  symbol: string
  broker: string
  action: string
  quantity: number
  entry_price: number
  exit_price: number | null
  stop_loss: number | null
  target_price: number | null
  confidence: number
  status: string
  pnl: number | null
  pnl_pct: number | null
  reason: string | null
  created_at: string
  closed_at: string | null
  source: Source
}

function isTgTrade(reason: string | null): boolean {
  return !!(reason?.toLowerCase().includes('tg:') || reason?.toLowerCase().includes('sf essential') || reason?.toLowerCase().includes('sf_essential'))
}

function pnlColor(n: number) { return n >= 0 ? 'var(--green)' : 'var(--red)' }
function fmt(n: number) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) }
function fmtPct(n: number) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%' }

function SourceBadge({ source }: { source: Source }) {
  return source === 'sf_trades'
    ? <span style={{ fontSize: '0.6rem', padding: '2px 7px', borderRadius: 20, background: 'rgba(99,179,237,0.15)', color: '#63b3ed', border: '1px solid rgba(99,179,237,0.3)', fontWeight: 600 }}>SF Trades</span>
    : <span style={{ fontSize: '0.6rem', padding: '2px 7px', borderRadius: 20, background: 'rgba(19,201,142,0.12)', color: 'var(--green)', border: '1px solid rgba(19,201,142,0.25)', fontWeight: 600 }}>AI Scan</span>
}

function SummaryCard({ label, trades, color }: { label: string; trades: Trade[]; color: string }) {
  const open   = trades.filter(t => t.status === 'OPEN')
  const closed = trades.filter(t => t.status === 'CLOSED')
  const totalPnl     = closed.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const openPnl      = open.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins  = closed.filter(t => (t.pnl ?? 0) > 0).length
  const losses = closed.filter(t => (t.pnl ?? 0) <= 0).length
  const winRate = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0
  const invested = open.reduce((s, t) => s + (t.entry_price * t.quantity), 0)

  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${color}33`, borderRadius: 10, padding: 18, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{label}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 4 }}>
        {[
          { label: 'Open Positions', value: open.length.toString(), sub: `$${invested.toLocaleString('en-US', { maximumFractionDigits: 0 })} deployed` },
          { label: 'Closed P&L', value: fmt(totalPnl), sub: `${wins}W / ${losses}L — ${winRate}% win rate`, valueColor: pnlColor(totalPnl) },
          { label: 'Unrealised', value: fmt(openPnl), sub: 'current open positions', valueColor: pnlColor(openPnl) },
        ].map(({ label: l, value, sub, valueColor }) => (
          <div key={l} style={{ background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{l}</div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: valueColor ?? 'var(--fg-1)' }}>{value}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)', marginTop: 2 }}>{sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TradeRow({ t }: { t: Trade }) {
  const isOpen  = t.status === 'OPEN'
  const pnl     = t.pnl ?? 0
  const pnlPct  = t.pnl_pct ?? 0
  const cost    = t.entry_price * t.quantity

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '9px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{t.symbol}</span>
          <SourceBadge source={t.source} />
        </div>
        <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)', marginTop: 2 }}>{t.broker === 'schwab' ? '🔴 Live' : '🔵 Paper'}</div>
      </td>
      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
        <div style={{ fontSize: '0.82rem' }}>{t.quantity} sh</div>
        <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)' }}>@${t.entry_price.toFixed(2)}</div>
      </td>
      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
        <div style={{ fontSize: '0.82rem' }}>${cost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
        {t.stop_loss && <div style={{ fontSize: '0.65rem', color: 'var(--red)' }}>SL ${t.stop_loss.toFixed(2)}</div>}
      </td>
      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
        {isOpen
          ? <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 20, background: 'rgba(19,201,142,0.1)', color: 'var(--green)', border: '1px solid var(--green)' }}>OPEN</span>
          : <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 20, background: 'var(--bg-3)', color: 'var(--fg-3)', border: '1px solid var(--border)' }}>CLOSED</span>}
      </td>
      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
        {isOpen
          ? <span style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>—</span>
          : <div>
              <div style={{ fontWeight: 700, color: pnlColor(pnl) }}>{fmt(pnl)}</div>
              <div style={{ fontSize: '0.65rem', color: pnlColor(pnlPct) }}>{fmtPct(pnlPct)}</div>
            </div>}
      </td>
      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--fg-3)' }}>
          {new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </div>
        {t.confidence > 0 && <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)' }}>{t.confidence}% conf</div>}
      </td>
    </tr>
  )
}

export default function PortfolioPage() {
  const [trades, setTrades]   = useState<Trade[]>([])
  const [filter, setFilter]   = useState<'all' | 'open' | 'closed'>('all')
  const [source, setSource]   = useState<'all' | Source>('all')
  const [broker, setBroker]   = useState<'all' | 'alpaca_paper' | 'schwab'>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/portfolio')
      .then(r => r.json())
      .then(d => { setTrades(d.trades ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const tgTrades  = trades.filter(t => t.source === 'sf_trades')
  const aiTrades  = trades.filter(t => t.source === 'ai_scan')

  const visible = trades.filter(t =>
    (filter === 'all' || t.status.toUpperCase() === filter.toUpperCase()) &&
    (source === 'all' || t.source === source) &&
    (broker === 'all' || t.broker === broker)
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-1)', color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}>
      <header className="desk-top">
        <div className="desk-brand">
          <div className="bmark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg></div>
          <div><div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1 }}>MyTrade</div><div className="eyebrow" style={{ marginTop: 2 }}>Portfolio</div></div>
        </div>
        <nav className="desk-nav">{NAV.map(([href, label]) => <Link key={href} href={href} className={href === '/portfolio' ? 'on' : ''}>{label}</Link>)}</nav>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>

        {/* Summary cards side by side */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          <SummaryCard label="SF Trades — Pavan's Picks" trades={tgTrades} color="#63b3ed" />
          <SummaryCard label="AI Scanner — Our Picks"   trades={aiTrades}  color="var(--green)" />
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {(['all', 'open', 'closed'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600, background: filter === f ? 'var(--green)' : 'var(--bg-3)', color: filter === f ? '#fff' : 'var(--fg-2)', border: '1px solid ' + (filter === f ? 'var(--green)' : 'var(--border)') }}>
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
          <div style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
          {([['all', 'All Sources'], ['sf_trades', '📡 SF Trades'], ['ai_scan', '🤖 AI Scan']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setSource(v)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600, background: source === v ? '#63b3ed' : 'var(--bg-3)', color: source === v ? '#fff' : 'var(--fg-2)', border: '1px solid ' + (source === v ? '#63b3ed' : 'var(--border)') }}>
              {l}
            </button>
          ))}
          <div style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
          {([['all', 'Both'], ['alpaca_paper', '🔵 Paper'], ['schwab', '🔴 Live']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setBroker(v)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600, background: broker === v ? 'var(--bg-2)' : 'var(--bg-3)', color: 'var(--fg-1)', border: '1px solid ' + (broker === v ? 'var(--green)' : 'var(--border)') }}>
              {l}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--fg-3)', alignSelf: 'center' }}>{visible.length} trades</span>
        </div>

        {/* Trade table */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {loading
            ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>Loading…</div>
            : visible.length === 0
              ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>No trades match filters</div>
              : <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-2)', fontSize: '0.65rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <th style={{ padding: '10px', textAlign: 'left' }}>Symbol</th>
                      <th style={{ padding: '10px', textAlign: 'right' }}>Size</th>
                      <th style={{ padding: '10px', textAlign: 'right' }}>Cost / SL</th>
                      <th style={{ padding: '10px', textAlign: 'right' }}>Status</th>
                      <th style={{ padding: '10px', textAlign: 'right' }}>P&amp;L</th>
                      <th style={{ padding: '10px', textAlign: 'right' }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(t => <TradeRow key={t.id} t={t} />)}
                  </tbody>
                </table>}
        </div>
      </div>
    </div>
  )
}
