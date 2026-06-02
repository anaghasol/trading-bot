'use client'

import { useEffect, useState } from 'react'
import { Card, Chip, Meter, money } from '@/components/ui/kit'

type Key = 'aggressive' | 'short' | 'little_long' | 'long'
interface SleeveMeta { key: Key; name: string; color: string; tone: 'down' | 'amber' | 'blue' | 'up'; horizon: string; risk: number; setups: string; note: string }

const META: SleeveMeta[] = [
  { key: 'aggressive',  name: '🔥 Aggressive',      color: 'var(--red)',   tone: 'down',  horizon: '1–3 days',   risk: 85, setups: 'MOMENTUM_BREAKOUT', note: 'Hot momentum. Tight stops, fast exits — drives daily income.' },
  { key: 'short',       name: '⚡ Short-term',       color: 'var(--amber)', tone: 'amber', horizon: '1–5 days',   risk: 60, setups: 'REVERSAL · swing',   note: 'Oversold bounces and multi-day swings.' },
  { key: 'little_long', name: '🌱 Little Long-term', color: 'var(--blue)',  tone: 'blue',  horizon: '1–3 weeks',  risk: 38, setups: 'TREND',              note: 'Steady grinders riding an established trend.' },
  { key: 'long',        name: '🧱 Long-term',        color: 'var(--green)', tone: 'up',    horizon: '1–3 months', risk: 18, setups: 'core hold',          note: 'Compounding base. Rarely sold — the foundation.' },
]
const DEFAULT_ALLOC: Record<Key, number> = { aggressive: 40, short: 30, little_long: 20, long: 10 }

interface CatRow { key: string; label: string; leader: string; change_5d: number; change_1d: number; rsi: number; score: number; rank: number; temp: 'HOT' | 'WARM' | 'COOL' | 'COLD'; bias: number }
const TEMP_TONE: Record<CatRow['temp'], 'up' | 'amber' | 'mut' | 'down'> = { HOT: 'up', WARM: 'amber', COOL: 'mut', COLD: 'down' }

export default function SleevesPage() {
  const [alloc, setAlloc] = useState<Record<Key, number>>(DEFAULT_ALLOC)
  const [balance, setBalance] = useState(2000)
  const [saved, setSaved] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cats, setCats] = useState<CatRow[]>([])

  useEffect(() => {
    (async () => {
      try {
        const [s, d, rot] = await Promise.all([
          fetch('/api/sleeves').then((r) => r.json()).catch(() => null),
          fetch('/api/dashboard?broker=schwab').then((r) => r.json()).catch(() => null),
          fetch('/api/rotation').then((r) => r.json()).catch(() => null),
        ])
        if (s?.alloc) setAlloc({ ...DEFAULT_ALLOC, ...s.alloc })
        if (d?.account?.balance) setBalance(d.account.balance)
        if (rot?.categories) setCats(rot.categories)
      } catch { /* ignore */ }
    })()
  }, [])

  const total = Object.values(alloc).reduce((a, b) => a + b, 0)
  function set(k: Key, v: number) { setAlloc((p) => ({ ...p, [k]: v })); setSaved(false) }

  async function save() {
    setSaving(true)
    try { await fetch('/api/sleeves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alloc }) }); setSaved(true) }
    finally { setSaving(false) }
  }
  function rebalance() {
    // normalize to 100, rounded
    const t = total || 1
    const next = {} as Record<Key, number>
    META.forEach((m) => { next[m.key] = Math.round((alloc[m.key] / t) * 100) })
    setAlloc(next); setSaved(false)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Strategy Sleeves</h1>
          <p className="page-sub">Split your capital across time-horizons so the bot plays each market accordingly. Reinvested profit flows back by performance.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost sm" onClick={rebalance}>↻ Normalize to 100%</button>
          <button className="btn green sm" onClick={save} disabled={saving || saved}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save splits'}</button>
        </div>
      </div>

      {/* total capital + allocation bar */}
      <Card style={{ marginBottom: 14 }}>
        <div className="card-body">
          <div className="spread" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
            <div><div className="hero-label">Total capital allocated</div><div className="hero-value" style={{ fontSize: '1.9rem' }}>{money(balance)}</div></div>
            <Chip tone={total === 100 ? 'up' : 'amber'}>{total}% assigned{total !== 100 ? ' · normalize to 100%' : ''}</Chip>
          </div>
          <div className="alloc-bar">
            {META.map((m) => alloc[m.key] > 0 && (
              <div key={m.key} className="alloc-seg" style={{ width: `${(alloc[m.key] / (total || 1)) * 100}%`, background: m.color, opacity: 0.85 }}>{alloc[m.key]}%</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 9 }}>
            {META.map((m) => (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 11, height: 11, borderRadius: 3, background: m.color }} />
                <span className="metric-label" style={{ textTransform: 'none', letterSpacing: 0 }}>{m.name}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* live market rotation — what the engine is leaning into today */}
      <Card style={{ marginBottom: 14 }}>
        <div className="card-head plain">
          <h3 className="card-title neutral">🔥 Market Rotation · live</h3>
          <span className="faint" style={{ fontSize: '0.8rem' }}>{cats.length ? 'engine biases size toward hot themes' : 'loading themes…'}</span>
        </div>
        <div className="card-body">
          {cats.length === 0 ? (
            <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--fg-3)', fontSize: '0.86rem' }}>No rotation data yet — runs on the next scan.</div>
          ) : (
            <div className="rot-grid">
              {cats.map((c) => (
                <div key={c.key} className="rot-row" style={{ opacity: c.bias === 0 ? 0.5 : 1 }}>
                  <span className="rot-rank tabular">#{c.rank}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <b style={{ fontSize: '0.92rem' }}>{c.label}</b>
                      <span className="faint tabular" style={{ fontSize: '0.72rem' }}>{c.leader}</span>
                    </div>
                    <div className="metric-sub tabular" style={{ marginTop: 1 }}>
                      <span style={{ color: c.change_5d >= 0 ? 'var(--green)' : 'var(--red)' }}>{c.change_5d >= 0 ? '+' : ''}{c.change_5d.toFixed(1)}% 5d</span>
                      <span className="faint"> · RSI {c.rsi.toFixed(0)}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <Chip tone={TEMP_TONE[c.temp]}>{c.temp}</Chip>
                    <span className="faint tabular" style={{ fontSize: '0.72rem' }}>{c.bias === 0 ? 'skip' : `size ×${c.bias.toFixed(2)}`}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* sleeve cards */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 14 }}>
        {META.map((m) => (
          <div key={m.key} className="sleeve" style={{ '--accent': m.color } as React.CSSProperties}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: '1.05rem', color: m.color }}>{m.name}</b>
              <Chip tone={m.tone}>{alloc[m.key]}% · {money(balance * alloc[m.key] / 100)}</Chip>
            </div>
            <div style={{ display: 'flex', gap: 18, marginBottom: 12 }}>
              <div><div className="metric-label">Horizon</div><div className="tabular" style={{ fontSize: '0.95rem' }}>{m.horizon}</div></div>
              <div><div className="metric-label">Setups</div><div><span className={`chip ${m.tone}`} style={{ fontSize: '0.66rem' }}>{m.setups}</span></div></div>
            </div>
            <Meter label="Risk / aggression" right={`${m.risk}%`} pct={m.risk} color={m.color} />
            <div style={{ margin: '12px 0 8px' }}>
              <div className="meter-top"><span>Allocation</span><span>{alloc[m.key]}%</span></div>
              <input type="range" min={0} max={100} step={5} value={alloc[m.key]} onChange={(e) => set(m.key, Number(e.target.value))}
                style={{ width: '100%', accentColor: m.color, cursor: 'pointer' }} />
            </div>
            <div className="metric-sub" style={{ lineHeight: 1.45 }}>{m.note}</div>
          </div>
        ))}
      </div>

      {/* reinvest rule */}
      <Card accent="green">
        <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <span className="chip up" style={{ fontSize: '0.8rem' }}>↻ Reinvest rule</span>
          <p className="page-sub" style={{ flex: 1, minWidth: 280, margin: 0 }}>
            Daily profit auto-tops the best-performing sleeve; a losing sleeve is throttled until it recovers.
            <strong style={{ color: 'var(--fg-1)' }}> Under $25K we lean aggressive</strong> to record fast profits, then shift weight toward the long-term sleeves to grow efficiently from there.
          </p>
        </div>
      </Card>
    </div>
  )
}
