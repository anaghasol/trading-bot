'use client'

import { useEffect, useState } from 'react'
import type { PdtStatus } from '@/lib/pdt'
import TopNav from '@/components/layout/TopNav'

interface RoundTrip { symbol: string; pnl: number; pnl_pct: number; buy_date: string; sell_date: string; held_days: number }
interface SchwabOrder { symbol: string; instruction: string; quantity: number; price: number; entered_time: string; status: string; order_type: string }
interface HistoryData {
  orders: SchwabOrder[]
  round_trips: RoundTrip[]
  summary: { total_pnl: number; total_trades: number; wins: number; losses: number; win_rate: number; balance: number }
  pdt: PdtStatus
}

function fmt(n: number) { return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function pnlColor(n: number) { return n >= 0 ? 'var(--green)' : 'var(--red)' }

function PdtBar({ pdt }: { pdt: PdtStatus }) {
  const used = pdt.day_trades_used
  const max  = 3
  const pct  = (used / max) * 100

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head blue">
        <h3 className="card-title blue">PDT Status — Pattern Day Trader Rule</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--fg-2)' }}>
          {pdt.is_pdt_protected ? `Under $25K — SWING MODE` : 'Over $25K — Unlimited day trades'}
        </span>
      </div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px', textAlign: 'center' }}>
            <div className="metric-label">Day Trades Used</div>
            <div className="metric-value" style={{ color: used >= 3 ? 'var(--red)' : used >= 2 ? 'var(--amber)' : 'var(--green)' }}>{used} / 3</div>
            <div className="metric-sub">rolling 5 days</div>
          </div>
          <div style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px', textAlign: 'center' }}>
            <div className="metric-label">Remaining</div>
            <div className="metric-value" style={{ color: pdt.day_trades_remaining === 0 ? 'var(--red)' : 'var(--green)' }}>{pdt.day_trades_remaining}</div>
            <div className="metric-sub">day-trade slots</div>
          </div>
          <div style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px', textAlign: 'center' }}>
            <div className="metric-label">Account Balance</div>
            <div className="metric-value" style={{ color: 'var(--fg-1)', fontSize: '1.3rem' }}>{fmt(pdt.balance)}</div>
            <div className="metric-sub">need {fmt(25000 - pdt.balance)} more for unlimited</div>
          </div>
          <div style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px', textAlign: 'center' }}>
            <div className="metric-label">Strategy Mode</div>
            <div className="metric-value" style={{ fontSize: '1.1rem', color: 'var(--blue)' }}>SWING</div>
            <div className="metric-sub">hold 1-5 days</div>
          </div>
        </div>

        <div className="meter-top">
          <span>Day-trade capacity used this week</span>
          <span>{used}/3</span>
        </div>
        <div className="track" style={{ height: 10, marginBottom: 10 }}>
          <div className="fill" style={{ width: `${Math.min(pct, 100)}%`, background: used >= 3 ? 'var(--red)' : used >= 2 ? 'var(--amber)' : 'var(--green)' }} />
        </div>

        <div style={{ fontSize: '0.83rem', color: 'var(--fg-2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--fg-1)' }}>PDT Rule:</strong> Under $25K → max 3 day-trades in any 5 business days.
          A &quot;day trade&quot; = buying AND selling the same stock on the same calendar day.
          <br />
          <strong style={{ color: 'var(--green)' }}>Our strategy:</strong> We buy and hold overnight (1-5 days), selling next morning at target or at stop. No same-day sells unless emergency -7%.
          {pdt.today_trades.length > 0 && (
            <><br /><strong style={{ color: 'var(--amber)' }}>Entered today (do NOT same-day sell):</strong> {pdt.today_trades.join(', ')}</>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TradesPage() {
  const [data, setData]     = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab]       = useState<'roundtrips' | 'orders'>('roundtrips')
  const [days, setDays]     = useState(30)

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/schwab/history?days=${days}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [days])

  const s = data?.summary
  const pdt = data?.pdt

  return (
    <>
    <TopNav />
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 22px 40px' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontWeight: 700, fontSize: '1.5rem', color: 'var(--fg-1)', margin: '0 0 4px' }}>Trade History</h1>
        <p style={{ color: 'var(--fg-2)', margin: 0, fontSize: '0.9rem' }}>Live from Schwab account — source of truth</p>
      </div>

      {/* PDT Status */}
      {pdt && <PdtBar pdt={pdt} />}

      {/* Summary metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        <div className="metric-box">
          <div className="metric-label">Round Trips</div>
          <div className="metric-value" style={{ color: 'var(--fg-1)' }}>{s?.total_trades ?? 0}</div>
          <div className="metric-sub">{days}-day window</div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Realized P&L</div>
          <div className="metric-value" style={{ color: pnlColor(s?.total_pnl ?? 0) }}>
            {(s?.total_pnl ?? 0) >= 0 ? '+' : '−'}{fmt(s?.total_pnl ?? 0)}
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Win Rate</div>
          <div className="metric-value" style={{ color: (s?.win_rate ?? 0) >= 50 ? 'var(--green)' : 'var(--red)' }}>
            {(s?.win_rate ?? 0).toFixed(0)}%
          </div>
          <div className="metric-sub">{s?.wins ?? 0}W / {s?.losses ?? 0}L</div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Goal to $25K</div>
          <div className="metric-value" style={{ color: 'var(--fg-1)', fontSize: '1.3rem' }}>
            {fmt(25000 - (pdt?.balance ?? 2000))}
          </div>
          <div className="metric-sub">~{Math.ceil((25000 - (pdt?.balance ?? 2000)) / 150)} days @ $150/day</div>
        </div>
      </div>

      {/* Tabs + period selector */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['roundtrips', 'orders'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '7px 16px', borderRadius: 'var(--r-pill)',
              background: tab === t ? 'var(--green)' : 'var(--bg-2)',
              color: tab === t ? '#fff' : 'var(--fg-2)',
              fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
              border: tab === t ? '1px solid transparent' : '1px solid var(--border)',
            }}>
              {t === 'roundtrips' ? 'Round Trips' : 'All Orders'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[7, 14, 30].map((d) => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '5px 12px', borderRadius: 'var(--r-md)',
              background: days === d ? 'var(--bg-3)' : 'transparent',
              color: days === d ? 'var(--fg-1)' : 'var(--fg-3)',
              border: `1px solid ${days === d ? 'var(--border-soft)' : 'transparent'}`,
              fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}>{d}d</button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">{tab === 'roundtrips' ? 'Completed Round Trips' : 'Raw Orders (Schwab)'}</h3>
          <span className="faint" style={{ fontSize: '0.8rem' }}>
            {tab === 'roundtrips' ? (data?.round_trips?.length ?? 0) : (data?.orders?.length ?? 0)} records
          </span>
        </div>
        <div className="card-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--fg-2)' }}>Loading from Schwab…</div>
          ) : tab === 'roundtrips' ? (
            (data?.round_trips ?? []).length === 0 ? (
              <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '16px 0' }}>No completed round trips yet</p>
            ) : (data?.round_trips ?? []).map((t, i) => (
              <div key={i} className="data-row" style={{ gridTemplateColumns: '1.2fr 1fr 1fr 1fr .8fr .8fr' }}>
                <div className="tabular" style={{ fontWeight: 700, color: 'var(--blue)', fontSize: '1rem' }}>{t.symbol}</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                  {t.buy_date} → {t.sell_date}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)' }}>Held {t.held_days}d</div>
                <div className="tabular" style={{ fontWeight: 700, color: pnlColor(t.pnl) }}>
                  {t.pnl >= 0 ? '+' : '−'}{fmt(t.pnl)}
                </div>
                <div className="tabular" style={{ fontWeight: 700, color: pnlColor(t.pnl_pct) }}>
                  {t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct.toFixed(1)}%
                </div>
                <div>
                  <span style={{
                    padding: '4px 8px', borderRadius: 'var(--r-sm)', fontSize: '0.75rem', fontWeight: 600,
                    background: t.held_days === 0 ? 'var(--red-dim)' : 'var(--green-dim)',
                    color: t.held_days === 0 ? 'var(--red)' : 'var(--green)',
                  }}>
                    {t.held_days === 0 ? 'DAY TRADE' : 'SWING'}
                  </span>
                </div>
              </div>
            ))
          ) : (
            (data?.orders ?? []).length === 0 ? (
              <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '16px 0' }}>No orders found</p>
            ) : (data?.orders ?? []).map((o, i) => (
              <div key={i} className="data-row" style={{ gridTemplateColumns: '1.2fr .8fr 1fr 1fr 1fr .8fr' }}>
                <div className="tabular" style={{ fontWeight: 700, color: 'var(--blue)', fontSize: '1rem' }}>{o.symbol}</div>
                <div><span className={`action ${o.instruction.toLowerCase()}`}>{o.instruction}</span></div>
                <div className="tabular" style={{ color: 'var(--fg-1)' }}>${(o.price || 0).toFixed(2)} × {o.quantity}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(o.entered_time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)' }}>{o.order_type}</div>
                <div>
                  <span style={{
                    padding: '4px 8px', borderRadius: 'var(--r-sm)', fontSize: '0.75rem', fontWeight: 600,
                    background: o.status === 'FILLED' ? 'var(--green-dim)' : 'var(--blue-dim)',
                    color: o.status === 'FILLED' ? 'var(--green)' : 'var(--blue)',
                  }}>{o.status}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
    </>
  )
}
