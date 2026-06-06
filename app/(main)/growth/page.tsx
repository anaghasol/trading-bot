'use client'

import { useEffect, useState } from 'react'
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import { Card, CardHead, Metric, Chip, Meter, Donut, money, signed, pnlColor } from '@/components/ui/kit'


interface DailyRow { date: string; daily_pnl: number; wins: number; losses: number; win_rate: number }

const GOAL = 25000          // PDT threshold — unlimited day-trading unlocks here
const TRADING_DAYS = 252

export default function GrowthPage() {
  const [rows, setRows] = useState<DailyRow[]>([])
  const [balance, setBalance] = useState(2000)
  const [totPnl, setTotPnl] = useState(0)

  useEffect(() => {
    (async () => {
      try {
        const d = await fetch('/api/dashboard?broker=schwab').then((r) => r.json())
        setRows((d?.daily_summary ?? []).slice().reverse())
        setBalance(d?.account?.balance ?? 2000)
        setTotPnl(d?.account?.total_pnl ?? 0)
      } catch { /* ignore */ }
    })()
  }, [])

  // ── derived metrics ────────────────────────────────────────────────
  const days = rows.length
  const avgDaily = days ? rows.reduce((s, r) => s + r.daily_pnl, 0) / days : 0
  const avgDailyPct = balance ? avgDaily / balance : 0
  const wins = rows.reduce((s, r) => s + r.wins, 0)
  const losses = rows.reduce((s, r) => s + r.losses, 0)
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0

  // streak of consecutive green days (most recent first)
  let streak = 0
  for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].daily_pnl > 0) streak++; else break }

  // profit factor & drawdown estimates from daily pnl
  const grossWin = rows.filter((r) => r.daily_pnl > 0).reduce((s, r) => s + r.daily_pnl, 0)
  const grossLoss = Math.abs(rows.filter((r) => r.daily_pnl < 0).reduce((s, r) => s + r.daily_pnl, 0))
  const profitFactor = grossLoss ? grossWin / grossLoss : grossWin > 0 ? 2.5 : 0
  let peak = balance - totPnl, eq = balance - totPnl, maxDD = 0
  for (const r of rows) { eq += r.daily_pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / (peak || 1)) }

  // projection curve: compound avg daily % forward to 1y
  const rate = Math.max(-0.02, Math.min(0.05, avgDailyPct || 0.012))
  const proj: { d: number; v: number }[] = []
  for (let i = 0; i <= TRADING_DAYS; i += 7) proj.push({ d: i, v: Math.round(balance * Math.pow(1 + rate, i)) })
  const projected1y = proj[proj.length - 1]?.v ?? balance
  const toGoal = Math.max(0, GOAL - balance)
  const daysToGoal = avgDaily > 0 ? Math.ceil(toGoal / avgDaily) : null

  const incomeBars = rows.slice(-14).map((r) => ({ date: r.date.slice(5), v: Number(r.daily_pnl.toFixed(2)) }))

  return (
    <>
    
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Growth &amp; Compounding</h1>
          <p className="page-sub">Daily income, reinvested — compounding toward the $25K threshold, then we scale up.</p>
        </div>
        <span className="chip up">⚙ Reinvest: ON</span>
      </div>

      {/* ── Hero projection + side stats ── */}
      <div className="grid rise" style={{ gridTemplateColumns: '1.6fr 1fr', marginBottom: 14 }}>
        <Card>
          <CardHead title="Projected Compounding Curve" tone="plain" right={<Chip tone="blue">@ {(rate * 100).toFixed(2)}%/day reinvested</Chip>} />
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
              <div><div className="hero-label">Projected · 1 year</div><div className="hero-value up" style={{ fontSize: '2.3rem' }}>{money(projected1y)}</div></div>
              <div><div className="metric-label">Starting</div><div className="tabular" style={{ fontSize: '1.1rem' }}>{money(balance)}</div></div>
            </div>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={proj} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <defs><linearGradient id="growG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.32} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="d" tickFormatter={(d) => `${d}d`} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} width={42} />
                <ReferenceLine y={GOAL} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: '$25K', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
                <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid #374151', borderRadius: 6, fontSize: 11, fontFamily: 'IBM Plex Mono' }} formatter={(v: number) => [money(v), 'Equity']} labelFormatter={(d) => `Day ${d}`} />
                <Area type="monotone" dataKey="v" stroke="#10b981" strokeWidth={2.4} fill="url(#growG)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <div className="grid">
          <Metric label="Avg Daily Income" value={signed(avgDaily)} sub={`trailing ${days || 0} days`} color={pnlColor(avgDaily)} />
          <Metric label="Current Streak" value={`🔥 ${streak} ${streak === 1 ? 'day' : 'days'}`} sub="green days in a row" color="var(--amber)" />
          <Card accent="green">
            <CardHead title="Goal · $25K" tone="plain" right={<Chip tone="amber">a little aggressive</Chip>} />
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              <Meter label="Progress to $25K" right={`${((balance / GOAL) * 100).toFixed(0)}%`} pct={(balance / GOAL) * 100} color="var(--green)" />
              <div className="metric-sub">{daysToGoal ? `~${daysToGoal} trading days at current pace` : 'build a positive daily average to project an ETA'} · then switch to efficient long-term growth.</div>
            </div>
          </Card>
        </div>
      </div>

      {/* ── Income bars + growth/protection ── */}
      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr', marginBottom: 14 }}>
        <Card>
          <CardHead title="Daily Income · last 14 days" tone="plain" right={<span className="faint" style={{ fontSize: '0.8rem' }}>{wins}W / {losses}L</span>} />
          <div className="card-body">
            {incomeBars.length < 1 ? <div style={{ height: 150, display: 'grid', placeItems: 'center', color: 'var(--fg-3)' }}>No daily history yet</div>
              : <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={incomeBars} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                    <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v) => `$${v}`} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} contentStyle={{ background: '#1a1f2e', border: '1px solid #374151', borderRadius: 6, fontSize: 11, fontFamily: 'IBM Plex Mono' }} formatter={(v: number) => [signed(v), 'P&L']} />
                    <Bar dataKey="v" radius={[3, 3, 0, 0]}>{incomeBars.map((b, i) => <Cell key={i} fill={b.v >= 0 ? '#10b981' : '#ef4444'} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>}
          </div>
        </Card>
        <Card>
          <CardHead title="Growth vs Protection" tone="plain" />
          <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Donut pct={winRate} label="win rate" color="var(--green)" />
            <div style={{ flex: 1, display: 'grid', gap: 10 }}>
              <Meter label="Profit factor" right={profitFactor.toFixed(2)} pct={Math.min(100, profitFactor * 40)} color="var(--green)" />
              <Meter label="Max drawdown" right={`−${(maxDD * 100).toFixed(1)}%`} pct={Math.min(100, maxDD * 100 * 8)} color="var(--red)" />
              <div className="metric-sub">Aggressive growth only counts if drawdown stays shallow.</div>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Fund-scaling ladder ── */}
      <Card>
        <CardHead title="💰 Fund-Scaling Ladder" tone="plain" right={<span className="faint" style={{ fontSize: '0.8rem' }}>add real money only after proof</span>} />
        <div className="card-body">
          <div className="ladder">
            {[
              { icon: '✅', t: 'Week 1 green', s: totPnl > 0 ? `${signed(totPnl)} · done` : 'in progress', cls: totPnl > 0 ? 'done' : 'active', badge: totPnl > 0 ? 'unlocked' : 'tracking', tone: 'up' },
              { icon: '⏳', t: 'Week 2 green', s: `streak ${streak} days`, cls: 'active', badge: 'in progress', tone: 'amber' },
              { icon: '🔒', t: 'Add funds', s: 'auto-prompt when proven', cls: 'locked', badge: 'locked', tone: 'mut' },
              { icon: '🔒', t: `Scale to $25K`, s: 'unlimited day-trades unlock', cls: 'locked', badge: 'locked', tone: 'mut' },
            ].map((st, i) => (
              <div key={i} className={`ladder-step ${st.cls}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}><span style={{ fontSize: 16 }}>{st.icon}</span><b style={{ fontSize: '0.92rem' }}>{st.t}</b></div>
                <div className="metric-sub" style={{ fontFamily: 'var(--font-mono)', marginBottom: 7 }}>{st.s}</div>
                <Chip tone={st.tone as 'up' | 'amber' | 'mut'}>{st.badge}</Chip>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
    </>
  )
}
