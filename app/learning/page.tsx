'use client'

import { useEffect, useState } from 'react'
import { Card, CardHead, Chip, Meter, Donut, Empty } from '@/components/ui/kit'
import TopNav from '@/components/layout/TopNav'

interface LearningContext { summary: string; win_rate_7d: number; best_setups: string[]; avoid_setups: string[]; best_times: string[]; regime_performance: Record<string, number>; recent_losses: string[] }
interface Lesson { id?: number; symbol: string; strategy: string; pnl_pct: number; hold_days: number; regime: string; outcome: string; lesson: string; created_at: string }

export default function LearningPage() {
  const [ctx, setCtx] = useState<LearningContext | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/learning').then((x) => x.json())
        setCtx(r?.context ?? null)
        setLessons(r?.lessons ?? [])
      } catch { /* ignore */ }
      finally { setLoading(false) }
    })()
  }, [])

  const wr = ctx?.win_rate_7d ?? 0
  const regimes = Object.entries(ctx?.regime_performance ?? {})

  return (
    <>
    <TopNav />
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Learning</h1>
          <p className="page-sub">Every closed trade writes a lesson to Supabase. Claude reads these before each pick — the bot learns from its own mistakes.</p>
        </div>
        <span className="chip violet">🧠 tb_learnings · Supabase</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1.7fr' }}>
        {/* ── Left: memory summary ── */}
        <div className="grid">
          <Card>
            <CardHead title="7-Day Memory" tone="plain" />
            <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <Donut pct={wr} label="win rate" color="var(--green)" />
              <div style={{ flex: 1, display: 'grid', gap: 6 }}>
                <div className="metric-sub" style={{ lineHeight: 1.5 }}>{ctx?.summary ?? (loading ? 'Loading memory…' : 'No trade history yet.')}</div>
              </div>
            </div>
          </Card>
          <Card>
            <CardHead title="✅ Best Setups" tone="plain" />
            <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(ctx?.best_setups ?? []).length ? ctx!.best_setups.map((s) => <Chip key={s} tone="up">{s}</Chip>) : <Empty>None yet</Empty>}
            </div>
          </Card>
          <Card>
            <CardHead title="⚠ Avoid Setups" tone="plain" />
            <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(ctx?.avoid_setups ?? []).length ? ctx!.avoid_setups.map((s) => <Chip key={s} tone="down">{s}</Chip>) : <span className="metric-sub">No underperformers flagged — good.</span>}
            </div>
          </Card>
          <Card>
            <CardHead title="⏱ Best Times" tone="plain" />
            <div className="card-body" style={{ display: 'grid', gap: 5, fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--fg-2)' }}>
              {(ctx?.best_times ?? []).map((t) => <span key={t}>{t}</span>)}
            </div>
          </Card>
        </div>

        {/* ── Right: journal + regime ── */}
        <div className="grid">
          <Card>
            <CardHead title="📓 Lessons Journal" right={<span className="faint" style={{ fontSize: '0.8rem' }}>{lessons.length} recorded</span>} />
            <div className="card-body" style={{ display: 'grid', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
              {lessons.length === 0 ? <Empty>{loading ? 'Loading lessons…' : 'No lessons yet — they appear as trades close.'}</Empty>
                : lessons.map((l, i) => {
                  const win = l.outcome === 'WIN' || l.pnl_pct >= 0
                  return (
                    <div key={l.id ?? i} className={`lesson ${win ? 'win' : 'loss'}`}>
                      <div className="spread" style={{ marginBottom: 5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <b className="tabular" style={{ color: 'var(--blue)' }}>{l.symbol}</b>
                          <span className="chip mut" style={{ fontSize: '0.64rem' }}>{l.strategy}</span>
                          {l.regime && <span className="chip mut" style={{ fontSize: '0.64rem' }}>{l.regime}</span>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`chip ${win ? 'up' : 'down'}`}>{win ? 'WIN' : 'LOSS'}</span>
                          <span className="tabular" style={{ fontWeight: 700, color: win ? 'var(--green)' : 'var(--red)' }}>{l.pnl_pct >= 0 ? '+' : ''}{l.pnl_pct.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div className="lesson-text">“{l.lesson}”</div>
                    </div>
                  )
                })}
            </div>
          </Card>
          <Card>
            <CardHead title="📈 Regime Performance" tone="plain" />
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              {regimes.length === 0 ? <Empty>No regime data yet</Empty>
                : regimes.map(([r, v]) => (
                  <Meter key={r} label={`${r} regime`} right={`${v > 0 ? '+' : ''}${v}%`} pct={Math.min(100, Math.abs(v) * 18 + 5)} color={v >= 0 ? 'var(--green)' : 'var(--red)'} />
                ))}
              <div className="metric-sub">The bot sizes down ~40% in CAUTION and sits out RISK_OFF entirely.</div>
            </div>
          </Card>
        </div>
      </div>
    </div>
    </>
  )
}
