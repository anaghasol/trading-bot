'use client'

import { useEffect, useState } from 'react'

interface Candidate {
  symbol:            string
  sector:            string
  sndk_score:        number
  stage:             0 | 1 | 2 | 3
  deviation_pct:     number
  rsi_current:       number
  rsi_direction:     string
  fundamental_score: number
  stage_score:       number
  rsi_score:         number
  volume_score:      number
  gross_margin_pct:  number
  op_margin_pct:     number
  revenue_growth_pct:number
  eps_revision_30d:  number
  highlights:        string   // JSON string
  price_target:      number
  current_price:     number
  screened_at:       string
}

const STAGE_LABELS: Record<number, string> = {
  0: 'Base',
  1: '🎯 Stage 1',
  2: 'Running',
  3: '🔴 Blowoff',
}
const STAGE_COLORS: Record<number, string> = {
  0: '#8892a4',
  1: '#13c98e',
  2: '#fbbf24',
  3: '#f87171',
}
const SECTOR_LABELS: Record<string, string> = {
  'AI_POWER_GRID':  '⚡ AI Power',
  'AI_COOLING':     '❄️ Cooling',
  'AI_NETWORKING':  '🌐 Networking',
  'ADV_PACKAGING':  '🔬 Adv Pkg',
  'NUCLEAR':        '☢️ Nuclear',
  'MEMORY_ADJ':     '💾 Memory',
  'DEFENSE_TECH':   '🛡 Defense',
  'BIOTECH_INFLEX': '🧬 Biotech',
  'FINTECH_ADJ':    '💳 Fintech',
  'INDUSTRIAL_AI':  '🤖 Quantum/AI',
}

function ScoreBar({ value, max = 100, color = '#13c98e' }: { value: number; max?: number; color?: string }) {
  return (
    <div style={{ background: '#161c27', borderRadius: 3, height: 5, width: '100%', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s' }} />
    </div>
  )
}

export default function DiscoveryPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading]       = useState(true)
  const [scanning, setScanning]     = useState(false)
  const [filter, setFilter]         = useState<'all' | 'stage1' | 'stage2'>('all')
  const [sectorFilter, setSectorFilter] = useState('all')
  const [expanded, setExpanded]     = useState<string | null>(null)
  const [lastRun, setLastRun]       = useState('')

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/discovery/list')
      const data = await res.json() as { candidates: Candidate[]; last_run: string }
      setCandidates(data.candidates ?? [])
      setLastRun(data.last_run ?? '')
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function runScan() {
    setScanning(true)
    try {
      await fetch('/api/cron/discovery', {
        headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET ?? ''}` },
      })
      await load()
    } catch { /* ignore */ }
    setScanning(false)
  }

  useEffect(() => { void load() }, [])

  const sectors   = ['all', ...Array.from(new Set(candidates.map((c) => c.sector)))]
  const filtered  = candidates.filter((c) => {
    if (filter === 'stage1'  && c.stage !== 1) return false
    if (filter === 'stage2'  && c.stage !== 2) return false
    if (sectorFilter !== 'all' && c.sector !== sectorFilter) return false
    return true
  })

  const stage1Count = candidates.filter((c) => c.stage === 1).length
  const avgScore    = candidates.length > 0
    ? Math.round(candidates.reduce((s, c) => s + c.sndk_score, 0) / candidates.length) : 0

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'IBM Plex Mono, monospace', maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, color: '#13c98e', fontSize: '1rem', fontWeight: 700 }}>
            🔭 SNDK Discovery — Find the Next One Early
          </h1>
          <p style={{ margin: '0.3rem 0 0', color: '#8892a4', fontSize: '0.68rem' }}>
            Stage 1 = 0-40% above rising 200DMA + fundamental inflection (GM expansion, OP leverage, EPS revisions).
            Catch it before monthly RSI goes extreme. SNDK today (4,000%+) = Stage 3. We want Stage 1.
          </p>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          style={{ background: scanning ? '#1e2a3a' : '#13c98e', color: scanning ? '#8892a4' : '#0b0f17', border: 'none', borderRadius: 5, padding: '0.45rem 0.9rem', fontWeight: 700, fontSize: '0.72rem', cursor: scanning ? 'not-allowed' : 'pointer', flexShrink: 0, marginLeft: '1rem' }}
        >
          {scanning ? 'Scanning…' : '▶ Run Screener'}
        </button>
      </div>

      {/* Stats strip */}
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', padding: '0.6rem 1rem', background: '#0d1117', borderRadius: 6, border: '1px solid #2a3347', fontSize: '0.72rem' }}>
        <div><span style={{ color: '#8892a4' }}>Total candidates: </span><strong style={{ color: '#e2e8f0' }}>{candidates.length}</strong></div>
        <div><span style={{ color: '#8892a4' }}>Stage 1 (buy zone): </span><strong style={{ color: '#13c98e' }}>{stage1Count}</strong></div>
        <div><span style={{ color: '#8892a4' }}>Avg score: </span><strong style={{ color: '#e2e8f0' }}>{avgScore}/100</strong></div>
        {lastRun && <div style={{ marginLeft: 'auto', color: '#8892a4' }}>Last run: {new Date(lastRun).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {(['all', 'stage1', 'stage2'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background: filter === f ? '#13c98e' : '#161c27',
            color: filter === f ? '#0b0f17' : '#8892a4',
            border: '1px solid #2a3347', borderRadius: 4,
            padding: '0.2rem 0.6rem', fontSize: '0.65rem', cursor: 'pointer',
          }}>
            {f === 'all' ? 'All' : f === 'stage1' ? '🎯 Stage 1 only' : 'Stage 2'}
          </button>
        ))}
        <select
          value={sectorFilter}
          onChange={(e) => setSectorFilter(e.target.value)}
          style={{ background: '#161c27', color: '#8892a4', border: '1px solid #2a3347', borderRadius: 4, padding: '0.2rem 0.5rem', fontSize: '0.65rem', cursor: 'pointer' }}
        >
          {sectors.map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All sectors' : (SECTOR_LABELS[s] ?? s)}</option>
          ))}
        </select>
      </div>

      {/* Stage legend */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem', fontSize: '0.62rem', color: '#8892a4' }}>
        <span>📊 Stage guide:</span>
        {[0,1,2,3].map((s) => (
          <span key={s} style={{ color: STAGE_COLORS[s] }}>
            Stage {s} = {s === 0 ? 'base (not ready)' : s === 1 ? '← TARGET (early breakout)' : s === 2 ? 'running (OK entry)' : 'blowoff (avoid)'}
          </span>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: '#8892a4', padding: '2rem', textAlign: 'center' }}>Loading screener results…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: '#8892a4', padding: '2rem', textAlign: 'center' }}>
          No results yet — click "Run Screener" to scan {candidates.length > 0 ? 'with this filter' : '~200 stocks'}
        </div>
      ) : (
        <div>
          {filtered.map((c) => {
            const highlights = (() => { try { return JSON.parse(c.highlights) as string[] } catch { return [] } })()
            const isOpen = expanded === c.symbol
            const upside = c.price_target > c.current_price
              ? (((c.price_target - c.current_price) / c.current_price) * 100).toFixed(0)
              : null

            return (
              <div key={c.symbol} style={{
                background: '#0d1117',
                border: `1px solid ${isOpen ? '#13c98e44' : '#2a3347'}`,
                borderRadius: 7, marginBottom: '0.5rem', overflow: 'hidden',
              }}>
                {/* Row */}
                <div
                  onClick={() => setExpanded(isOpen ? null : c.symbol)}
                  style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 80px 80px 80px 80px 90px', alignItems: 'center', padding: '0.6rem 0.8rem', cursor: 'pointer', gap: '0.5rem' }}
                >
                  <span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.8rem' }}>{c.symbol}</span>

                  <div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>{SECTOR_LABELS[c.sector] ?? c.sector}</div>
                    <ScoreBar value={c.sndk_score} color={c.sndk_score >= 60 ? '#13c98e' : c.sndk_score >= 35 ? '#fbbf24' : '#8892a4'} />
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: STAGE_COLORS[c.stage], fontSize: '0.65rem', fontWeight: 700 }}>{STAGE_LABELS[c.stage]}</div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>{c.deviation_pct > 0 ? '+' : ''}{c.deviation_pct.toFixed(0)}% vs 200d</div>
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: '#e2e8f0', fontSize: '0.72rem', fontWeight: 700 }}>{c.sndk_score}</div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>score</div>
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: c.rsi_direction === 'rising_early' ? '#13c98e' : c.rsi_direction === 'extreme' ? '#f87171' : '#e2e8f0', fontSize: '0.7rem' }}>{c.rsi_current.toFixed(0)}</div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>RSI</div>
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: c.gross_margin_pct >= 40 ? '#13c98e' : '#e2e8f0', fontSize: '0.7rem' }}>{c.gross_margin_pct.toFixed(0)}%</div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>GM</div>
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: c.eps_revision_30d >= 10 ? '#13c98e' : c.eps_revision_30d >= 0 ? '#e2e8f0' : '#f87171', fontSize: '0.7rem' }}>
                      {c.eps_revision_30d >= 0 ? '+' : ''}{c.eps_revision_30d.toFixed(0)}%
                    </div>
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>EPS rev 30d</div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    {upside && (
                      <div style={{ color: '#13c98e', fontSize: '0.65rem' }}>+{upside}% target</div>
                    )}
                    <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>${c.current_price.toFixed(0)} → ${c.price_target.toFixed(0)}</div>
                  </div>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div style={{ padding: '0 0.8rem 0.8rem', borderTop: '1px solid #2a3347' }}>
                    {highlights.length > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        {highlights.map((h, i) => (
                          <div key={i} style={{ color: '#a0aec0', fontSize: '0.68rem', padding: '0.15rem 0' }}>
                            ✦ {h}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginTop: '0.6rem' }}>
                      {[
                        ['Fundamental', `${c.fundamental_score}/40`],
                        ['Stage',       `${c.stage_score}/30`],
                        ['RSI',         `${c.rsi_score}/20`],
                        ['Volume',      `${c.volume_score}/10`],
                        ['Revenue growth', `+${c.revenue_growth_pct.toFixed(0)}% YoY`],
                        ['Op margin',    `${c.op_margin_pct.toFixed(0)}%`],
                        ['RSI direction', c.rsi_direction.replace('_', ' ')],
                        ['Screened',    new Date(c.screened_at).toLocaleDateString()],
                      ].map(([k, v]) => (
                        <div key={k} style={{ background: '#161c27', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                          <div style={{ color: '#8892a4', fontSize: '0.58rem' }}>{k}</div>
                          <div style={{ color: '#e2e8f0', fontSize: '0.7rem', fontWeight: 600 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
