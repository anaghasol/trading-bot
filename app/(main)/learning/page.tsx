'use client'

import { useEffect, useState } from 'react'
import { Card, CardHead, Chip, Meter, Donut, Empty } from '@/components/ui/kit'

interface LearningContext { summary: string; win_rate_7d: number; best_setups: string[]; avoid_setups: string[]; best_times: string[]; regime_performance: Record<string, number>; recent_losses: string[] }
interface Lesson { id?: number; symbol: string; strategy: string; pnl_pct: number; hold_days: number; regime: string; outcome: string; lesson: string; created_at: string }
interface QuantPromptMeta { key: string; name: string; firm: string; focus: string; emoji: string }

export default function LearningPage() {
  const [ctx, setCtx] = useState<LearningContext | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(true)

  // Research Lab state
  const [prompts, setPrompts] = useState<QuantPromptMeta[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [userNotes, setUserNotes] = useState('')
  const [generating, setGenerating] = useState(false)
  const [researchOutput, setResearchOutput] = useState<string | null>(null)
  const [researchMeta, setResearchMeta] = useState<{ name: string; firm: string } | null>(null)
  const [researchError, setResearchError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/learning').then((x) => x.json())
        setCtx(r?.context ?? null)
        setLessons(r?.lessons ?? [])
      } catch { /* ignore */ }
      finally { setLoading(false) }
    })()
    // Load prompt list
    fetch('/api/research/generate').then((r) => r.json()).then((d) => {
      setPrompts(d?.prompts ?? [])
      if (d?.prompts?.length) setSelectedKey(d.prompts[0].key)
    }).catch(() => {})
  }, [])

  async function runResearch() {
    if (!selectedKey || generating) return
    setGenerating(true)
    setResearchOutput(null)
    setResearchError(null)
    try {
      const r = await fetch('/api/research/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptKey: selectedKey, userNotes }),
      }).then((x) => x.json())
      if (r.error) { setResearchError(r.error); return }
      setResearchOutput(r.output)
      setResearchMeta(r.prompt)
    } catch (e) {
      setResearchError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  const wr = ctx?.win_rate_7d ?? 0
  const regimes = Object.entries(ctx?.regime_performance ?? {})

  return (
    <>
    
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

      {/* ── Research Lab ── */}
      <div style={{ marginTop: 24 }}>
        <Card>
          <CardHead
            title="🔬 Research Lab"
            right={<span className="chip violet">Claude · Elite Quant Prompts</span>}
          />
          <div className="card-body" style={{ display: 'grid', gap: 16 }}>
            <p className="metric-sub" style={{ margin: 0 }}>
              Ask Claude to act as a senior quant from Goldman, Renaissance, Two Sigma, Citadel, and more.
              Each prompt generates a strategy memo, risk framework, or signal system — auto-filled with your live market context.
            </p>

            {/* Prompt selector grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {prompts.map((p) => (
                <button
                  key={p.key}
                  onClick={() => { setSelectedKey(p.key); setResearchOutput(null); setResearchError(null) }}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    background: selectedKey === p.key ? 'rgba(19,201,142,0.12)' : 'var(--surface-2)',
                    border: `1px solid ${selectedKey === p.key ? 'var(--green)' : 'var(--border)'}`,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontSize: '1.1rem', marginBottom: 3 }}>{p.emoji}</div>
                  <div style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--fg)' }}>{p.name}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--fg-2)', marginTop: 2 }}>{p.firm}</div>
                </button>
              ))}
            </div>

            {/* Selected prompt detail */}
            {selectedKey && (() => {
              const p = prompts.find((x) => x.key === selectedKey)
              return p ? (
                <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>{p.emoji} {p.firm} · {p.name}</div>
                  <div className="metric-sub" style={{ margin: 0 }}>{p.focus}</div>
                </div>
              ) : null
            })()}

            {/* Optional notes */}
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)', marginBottom: 5 }}>Additional context for Claude (optional)</div>
              <textarea
                value={userNotes}
                onChange={(e) => setUserNotes(e.target.value)}
                placeholder="e.g. I want to focus on momentum strategies for small-caps under $10B market cap…"
                rows={2}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6, resize: 'vertical', boxSizing: 'border-box',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg)',
                  fontFamily: 'var(--font-sans)', fontSize: '0.82rem', outline: 'none',
                }}
              />
            </div>

            {/* Generate button */}
            <button
              onClick={runResearch}
              disabled={generating || !selectedKey}
              style={{
                padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: '0.88rem', cursor: generating ? 'wait' : 'pointer',
                background: generating ? 'var(--surface-2)' : 'var(--green)', color: generating ? 'var(--fg-2)' : '#000',
                border: 'none', transition: 'all 0.15s', width: 'fit-content',
              }}
            >
              {generating ? '⏳ Generating research memo…' : '🚀 Generate Strategy Memo'}
            </button>

            {/* Output */}
            {researchError && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,50,50,0.08)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '0.82rem' }}>
                Error: {researchError}
              </div>
            )}
            {researchOutput && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--green)' }}>
                  ✅ {researchMeta?.firm} · {researchMeta?.name} — Research Memo
                </div>
                <div
                  style={{
                    padding: '16px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)',
                    fontFamily: 'var(--font-mono)', fontSize: '0.78rem', lineHeight: 1.7, color: 'var(--fg-2)',
                    whiteSpace: 'pre-wrap', maxHeight: 600, overflowY: 'auto',
                  }}
                >
                  {researchOutput}
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(researchOutput)}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--fg-2)', cursor: 'pointer', fontSize: '0.78rem', width: 'fit-content' }}
                >
                  📋 Copy to clipboard
                </button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
    </>
  )
}
