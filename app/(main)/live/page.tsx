'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Card, CardHead, Chip, LiveDot } from '@/components/ui/kit'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScanSnap {
  ts: string; broker: string; regime: string; vix: number
  market: 'GOOD' | 'TOUGH' | 'BAD'
  scanned: number; candidates: number; ranked: number; trades: number
  picks:       { symbol: string; confidence: number; setup: string; score: number }[]
  discoveries: { symbol: string; signal: string }[]
}

interface MonitorData {
  ts: string
  health: Record<string, 'ok' | 'slow' | 'down' | 'unknown'>
  scans:  { schwab: ScanSnap | null; alpaca: ScanSnap | null }
  cron:   { last_run: Record<string, string>; recent: { job: string; status: string; trades_made: number; message: string; created_at: string }[] }
  trades: { open_count: number; open: { symbol: string; quantity: number; entry_price: number; strategy: string; broker: string; created_at: string }[] }
  alerts: { type: string; message: string; symbol: string | null; created_at: string }[]
  tg:     { macro_stance: string; macro_set_at: string | null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ago(ts: string | null | undefined) {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function healthStatus(h: string): { color: string; cls: string } {
  if (h === 'ok')   return { color: 'var(--green)', cls: 'up' }
  if (h === 'slow') return { color: 'var(--amber)', cls: 'amber' }
  return { color: 'var(--red)', cls: 'down' }
}

// ── Animated flow connector ────────────────────────────────────────────────────

function FlowLine({ active }: { active: boolean }) {
  return (
    <div style={{ position: 'relative', width: 48, height: 2, background: active ? 'var(--green-dim)' : 'var(--border)', alignSelf: 'center', flexShrink: 0, overflow: 'visible' }}>
      {active && [0, 1, 2].map((i) => (
        <span key={i} style={{
          position: 'absolute', top: '50%', width: 6, height: 6, borderRadius: '50%',
          background: 'var(--green)', transform: 'translateY(-50%)',
          boxShadow: '0 0 6px var(--green)',
          animation: `liveFlow 1.8s ease-in-out infinite`,
          animationDelay: `${i * 0.55}s`,
        }} />
      ))}
    </div>
  )
}

// ── Pipeline node ─────────────────────────────────────────────────────────────

function PipeNode({ icon, label, sub, count, color, active, detail }: {
  icon: string; label: string; sub: string; count: number | string
  color: string; active: boolean; detail?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, minWidth: 90, opacity: active ? 1 : 0.32, transition: 'opacity 0.4s' }}>
      <div style={{
        width: 50, height: 50, borderRadius: 14,
        background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'var(--inset)',
        border: `1.5px solid ${active ? color : 'var(--border)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, position: 'relative',
        boxShadow: active ? `0 0 14px color-mix(in srgb, ${color} 30%, transparent)` : 'none',
        transition: 'all 0.4s',
      }}>
        {icon}
        {active && Number(count) > 0 && (
          <span style={{
            position: 'absolute', top: -7, right: -7,
            background: color, color: '#000', borderRadius: 8, fontWeight: 800,
            fontSize: '0.58rem', padding: '1px 5px', fontFamily: 'var(--font-mono)', lineHeight: '14px',
          }}>{count}</span>
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.72rem', color: active ? 'var(--fg-1)' : 'var(--fg-3)', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.6rem', color: 'var(--fg-3)', marginTop: 1 }}>{sub}</div>
        {detail && active && <div style={{ fontSize: '0.6rem', color, marginTop: 2, fontFamily: 'var(--font-mono)' }}>{detail}</div>}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LiveMonitorPage() {
  const [data, setData]     = useState<MonitorData | null>(null)
  const [broker, setBroker] = useState<'schwab' | 'alpaca'>('alpaca')
  const [loading, setLoading] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor')
      if (r.ok) setData(await r.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 15_000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  const snap     = broker === 'schwab' ? data?.scans.schwab : data?.scans.alpaca
  const scanAge  = snap?.ts ? (Date.now() - new Date(snap.ts).getTime()) / 60000 : 999
  const fresh    = scanAge < 25

  const hasDisc  = (snap?.discoveries?.length ?? 0) > 0
  const hasCand  = (snap?.candidates ?? 0) > 0
  const hasAI    = (snap?.ranked ?? 0) > 0
  const hasTrade = (snap?.trades ?? 0) > 0

  // Cron health: stale if last run > threshold (market-hours only jobs get generous window)
  function cronOk(job: string) {
    const last = data?.cron.last_run[job]
    if (!last) return false
    const m = (Date.now() - new Date(last).getTime()) / 60000
    if (job === 'scan')    return m < 45
    if (job === 'monitor') return m < 60
    return m < 1440  // EOD close: once per day
  }

  return (
    <>
      <style>{`
        @keyframes liveFlow {
          0%   { left: -4px; opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { left: calc(100% + 4px); opacity: 0; }
        }
        @keyframes liveBlink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.25; }
        }
        .live-pulse { animation: liveBlink 1.4s ease-in-out infinite; }
      `}</style>

      <div className="page" style={{ maxWidth: 1120 }}>

        {/* ── Header ── */}
        <div className="page-head" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LiveDot on={!loading} />
            <h1 className="page-title">Live Monitor</h1>
            <span className="faint" style={{ fontSize: '0.72rem', marginLeft: 4 }}>
              {loading ? 'loading…' : data ? `refreshed ${ago(data.ts)}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['schwab', 'alpaca'] as const).map((b) => (
              <button key={b} onClick={() => setBroker(b)}
                className={`seg-btn ${broker === b ? (b === 'schwab' ? 'on-red' : 'on-blue') : ''}`}
                style={{ padding: '4px 12px', fontSize: '0.72rem' }}>
                {b === 'schwab' ? '● Schwab Live' : '● Alpaca Paper'}
              </button>
            ))}
            <button onClick={load} className="iconbtn" title="Refresh">↻</button>
          </div>
        </div>

        {/* ── System health row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 8, marginBottom: 16 }}>
          {[
            { key: 'schwab',    label: 'Schwab API',   icon: '📈' },
            { key: 'alpaca',    label: 'Alpaca API',   icon: '📊' },
            { key: 'claude',    label: 'Claude AI',    icon: '🤖' },
            { key: 'tg_poller', label: 'TG Poller',    icon: '📡' },
          ].map(({ key, label, icon }) => {
            const h  = data?.health[key] ?? 'unknown'
            const st = healthStatus(h)
            return (
              <div key={key} className="metric-box" style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left' }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <div>
                  <div className="metric-label">{label}</div>
                  <span className={`chip ${st.cls}`} style={{ fontSize: '0.6rem', marginTop: 3 }}>{h.toUpperCase()}</span>
                </div>
              </div>
            )
          })}
          {[
            { key: 'scan',    label: 'Scan Cron',    icon: '🔍', note: 'every 15m' },
            { key: 'monitor', label: 'Monitor Cron', icon: '👁',  note: 'every 5m'  },
            { key: 'close',   label: 'EOD Close',    icon: '🔒', note: '3:45pm ET' },
          ].map(({ key, label, icon, note }) => {
            const ok   = cronOk(key)
            const last = data?.cron.last_run[key]
            return (
              <div key={key} className="metric-box" style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left' }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <div>
                  <div className="metric-label">{label}</div>
                  <span className={`chip ${ok ? 'up' : last ? 'amber' : 'mut'}`} style={{ fontSize: '0.6rem', marginTop: 3 }}>
                    {last ? ago(last) : '—'}
                  </span>
                  <div className="metric-sub" style={{ fontSize: '0.58rem', marginTop: 2 }}>{note}</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Pipeline card ── */}
        <Card style={{ marginBottom: 16 }}>
          <CardHead tone="plain" title="AI Pipeline"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {snap && <span className={`chip ${snap.market === 'GOOD' ? 'up' : snap.market === 'TOUGH' ? 'amber' : 'down'}`}>{snap.market}</span>}
                {snap && <span className="faint mono" style={{ fontSize: '0.68rem' }}>VIX {snap.vix} · {snap.regime} · {fresh ? ago(snap.ts) : <span style={{ color: 'var(--amber)' }}>stale {ago(snap.ts)}</span>}</span>}
                {!snap && !loading && <span className="faint" style={{ fontSize: '0.72rem' }}>No scan data — runs every 15 min during market hours</span>}
              </div>
            }
          />
          <div className="card-body">
            {/* Node row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
              <PipeNode icon="📡" label="Discovery"  sub="Yahoo trending"   count={snap?.discoveries?.length ?? 0} color="var(--violet)" active={hasDisc && fresh} detail={snap?.discoveries?.[0]?.symbol} />
              <FlowLine active={hasDisc && fresh} />
              <PipeNode icon="⚡" label="Momentum"   sub="Intraday spikes"  count={snap?.candidates ?? 0}          color="var(--amber)"  active={hasCand && fresh} detail={`${snap?.candidates ?? 0} found`} />
              <FlowLine active={hasCand && fresh} />
              <PipeNode icon="📈" label="EMA Scan"   sub="Pullback setups"  count={snap?.scanned ?? 0}             color="var(--blue)"   active={!!snap && fresh}  detail={`${snap?.scanned ?? 0} scanned`} />
              <FlowLine active={hasCand && fresh} />
              <PipeNode icon="🤖" label="AI Gate"    sub="Claude + GPT-4o"  count={snap?.ranked ?? 0}              color="var(--green)"  active={hasAI && fresh}   detail={snap?.picks?.[0] ? `${snap.picks[0].symbol} ${snap.picks[0].confidence}%` : undefined} />
              <FlowLine active={hasAI && fresh} />
              <PipeNode icon="💰" label="Trade"      sub="Executed"         count={hasTrade ? snap!.trades : (data?.trades.open_count ?? 0)} color="var(--green)" active={hasTrade && fresh} detail={hasTrade ? `${snap!.trades} placed` : `${data?.trades.open_count ?? 0} open`} />
            </div>

            {/* Funnel summary */}
            {snap && fresh && (
              <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                {[
                  { label: 'Scanned',    v: snap.scanned,    c: 'var(--blue)'  },
                  { label: 'Candidates', v: snap.candidates, c: 'var(--amber)' },
                  { label: 'AI Picks',   v: snap.ranked,     c: 'var(--green)' },
                  { label: 'Traded',     v: snap.trades,     c: snap.trades > 0 ? 'var(--green)' : 'var(--fg-3)' },
                ].map(({ label, v, c }) => (
                  <div key={label} className="metric-box" style={{ padding: '7px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div className="metric-value" style={{ color: c, fontSize: '1.2rem' }}>{v}</div>
                    <div className="metric-label" style={{ marginTop: 2 }}>{label}</div>
                  </div>
                ))}
                {snap.scanned > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 4 }}>
                    <span className="faint" style={{ fontSize: '0.72rem' }}>
                      {((snap.ranked / snap.scanned) * 100).toFixed(1)}% pass rate
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* ── Bottom 2×2 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

          {/* Last AI picks */}
          <Card>
            <CardHead tone="plain" title="Last AI Picks"
              right={snap?.ts && <span className="faint mono" style={{ fontSize: '0.68rem' }}>{ago(snap.ts)}</span>}
            />
            <div className="card-body" style={{ minHeight: 120 }}>
              {!snap?.picks?.length
                ? <div className="faint" style={{ fontSize: '0.8rem' }}>No picks in last scan</div>
                : snap.picks.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: i < snap.picks.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: 44, fontSize: '0.82rem' }}>{p.symbol}</span>
                      <span className="chip mut" style={{ fontSize: '0.6rem' }}>{p.setup.replace('_', ' ')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 52, height: 4, borderRadius: 2, background: 'var(--inset)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${p.confidence}%`, background: p.confidence >= 80 ? 'var(--green)' : 'var(--amber)', borderRadius: 2, transition: 'width 0.6s' }} />
                      </div>
                      <span className="mono" style={{ fontSize: '0.72rem', color: p.confidence >= 80 ? 'var(--green)' : 'var(--amber)', minWidth: 32, textAlign: 'right' }}>{p.confidence}%</span>
                    </div>
                  </div>
                ))
              }
              {(snap?.discoveries?.length ?? 0) > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="metric-label" style={{ marginBottom: 6 }}>Discoveries</div>
                  {snap!.discoveries.map((d, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                      <span className="mono" style={{ color: 'var(--violet)', minWidth: 42, fontSize: '0.72rem', fontWeight: 700 }}>{d.symbol}</span>
                      <span className="faint" style={{ fontSize: '0.68rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.signal}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* Activity feed */}
          <Card>
            <CardHead tone="plain" title="Activity Feed" />
            <div className="card-body" style={{ minHeight: 120 }}>
              {!data?.alerts.length
                ? <div className="faint" style={{ fontSize: '0.8rem' }}>No recent activity</div>
                : data.alerts.map((a, i) => {
                  const tone = a.type === 'BUY' ? 'up' : a.type === 'SELL' ? 'down' : 'amber'
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderBottom: i < data.alerts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <span className={`chip ${tone}`} style={{ fontSize: '0.58rem', flexShrink: 0, marginTop: 1 }}>{a.type}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--fg-2)', lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.message}</div>
                        <div className="faint mono" style={{ fontSize: '0.6rem', marginTop: 2 }}>{ago(a.created_at)}</div>
                      </div>
                    </div>
                  )
                })
              }
            </div>
          </Card>

          {/* Open positions */}
          <Card>
            <CardHead tone="plain" title="Open Positions"
              right={<span className="chip up" style={{ fontSize: '0.65rem' }}>{data?.trades.open_count ?? 0} open</span>}
            />
            <div className="card-body" style={{ minHeight: 100 }}>
              {!data?.trades.open.length
                ? <div className="faint" style={{ fontSize: '0.8rem' }}>No open positions</div>
                : data.trades.open.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: i < data.trades.open.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: 44 }}>{t.symbol}</span>
                      <Chip tone={t.broker === 'schwab' ? 'down' : 'blue'}>{t.broker === 'schwab' ? 'LIVE' : 'PAPER'}</Chip>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--fg-1)' }}>{t.quantity}× ${t.entry_price.toFixed(2)}</div>
                      <div className="faint mono" style={{ fontSize: '0.6rem', marginTop: 1 }}>{ago(t.created_at)}</div>
                    </div>
                  </div>
                ))
              }
            </div>
          </Card>

          {/* Cron log */}
          <Card>
            <CardHead tone="plain" title="Cron Log" />
            <div className="card-body" style={{ minHeight: 100 }}>
              {!data?.cron.recent.length
                ? <div className="faint" style={{ fontSize: '0.8rem' }}>No cron history</div>
                : data.cron.recent.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderBottom: i < data.cron.recent.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <span className={`chip ${r.status === 'success' ? 'up' : 'down'}`} style={{ fontSize: '0.58rem', flexShrink: 0, minWidth: 42, textAlign: 'center' }}>{r.job}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.68rem', color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.trades_made > 0 && <span style={{ color: 'var(--green)', marginRight: 4 }}>+{r.trades_made} 🔥</span>}
                        {r.message.replace(/^\[[^\]]+\]\s*/, '').slice(0, 90)}
                      </div>
                      <div className="faint mono" style={{ fontSize: '0.58rem', marginTop: 2 }}>{ago(r.created_at)}</div>
                    </div>
                  </div>
                ))
              }
            </div>
          </Card>

        </div>
      </div>
    </>
  )
}
