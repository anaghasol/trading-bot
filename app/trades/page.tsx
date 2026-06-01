'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-client'

interface Trade {
  id: number; symbol: string; action: string; quantity: number
  entry_price: number; exit_price: number | null; pnl: number; pnl_pct: number
  status: string; strategy: string; confidence: number; reason: string
  created_at: string; closed_at: string | null
}

function fmt(n: number) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function confLevel(c: number) { return c >= 75 ? 'high' : c >= 60 ? 'medium' : 'low' }

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const db = createClient()
    db.from('tb_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        setTrades(data ?? [])
        setLoading(false)
      })
  }, [])

  const filtered = filter === 'ALL' ? trades : trades.filter((t) => t.status === filter)

  const totalPnl  = trades.filter((t) => t.status === 'CLOSED').reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins      = trades.filter((t) => t.status === 'CLOSED' && t.pnl > 0).length
  const losses    = trades.filter((t) => t.status === 'CLOSED' && t.pnl < 0).length
  const winRate   = wins + losses > 0 ? (wins / (wins + losses) * 100) : 0

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 22px 40px' }}>
      {/* Header */}
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontWeight: 700, fontSize: '1.5rem', color: 'var(--fg-1)', margin: '0 0 4px' }}>Trade History</h1>
        <p style={{ color: 'var(--fg-2)', margin: 0, fontSize: '0.9rem' }}>All executed trades via Schwab AI engine</p>
      </div>

      {/* Summary metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 22 }}>
        <div className="metric-box">
          <div className="metric-label">Total Trades</div>
          <div className="metric-value" style={{ color: 'var(--fg-1)' }}>{trades.length}</div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Total P&L</div>
          <div className="metric-value" style={{ color: totalPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {totalPnl >= 0 ? '+' : '−'}{fmt(totalPnl)}
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Win Rate</div>
          <div className="metric-value" style={{ color: winRate >= 50 ? 'var(--green)' : 'var(--red)' }}>
            {winRate.toFixed(0)}%
          </div>
          <div className="metric-sub">{wins}W / {losses}L</div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Open Now</div>
          <div className="metric-value" style={{ color: 'var(--fg-1)' }}>
            {trades.filter((t) => t.status === 'OPEN').length}
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['ALL', 'OPEN', 'CLOSED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '7px 16px', borderRadius: 'var(--r-pill)',
              background: filter === f ? 'var(--green)' : 'var(--bg-2)',
              color: filter === f ? '#fff' : 'var(--fg-2)',
              fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
              border: filter === f ? '1px solid transparent' : '1px solid var(--border)',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Trades list */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {filter === 'ALL' ? 'All Trades' : filter === 'OPEN' ? 'Open Trades' : 'Closed Trades'}
          </h3>
          <span className="faint" style={{ fontSize: '0.8rem' }}>{filtered.length} records</span>
        </div>
        <div className="card-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--fg-2)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '16px 0' }}>No trades</p>
          ) : filtered.map((t) => {
            const isBuy = t.action === 'BUY'
            const isClosed = t.status === 'CLOSED'
            return (
              <div key={t.id} className="data-row" style={{ gridTemplateColumns: '1.2fr .7fr 1.2fr 1fr 1fr .9fr .8fr' }}>
                <div className="tabular" style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--blue)' }}>{t.symbol}</div>
                <div><span className={`action ${isBuy ? 'buy' : 'sell'}`}>{t.action}</span></div>
                <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>
                  ${(t.entry_price || 0).toFixed(2)} × {t.quantity}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
                <div>
                  <span className={`conf-badge ${confLevel(t.confidence || 0)}`}>{t.confidence || 0}%</span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: isClosed ? (t.pnl >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--fg-2)' }}>
                  {isClosed ? `${t.pnl >= 0 ? '+' : '−'}${fmt(t.pnl)}` : '—'}
                </div>
                <div>
                  <span style={{
                    padding: '4px 9px', borderRadius: 'var(--r-sm)',
                    fontSize: '0.75rem', fontWeight: 600,
                    background: t.status === 'OPEN' ? 'var(--blue-dim)' : t.pnl >= 0 ? 'var(--green-dim)' : 'var(--red-dim)',
                    color: t.status === 'OPEN' ? 'var(--blue)' : t.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                  }}>
                    {t.status}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
