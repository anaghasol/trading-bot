'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScanSnap {
  ts:          string
  broker:      string
  regime:      string
  vix:         number
  market:      'GOOD' | 'TOUGH' | 'BAD'
  scanned:     number
  candidates:  number
  ranked:      number
  trades:      number
  picks:       { symbol: string; confidence: number; setup: string; score: number }[]
  discoveries: { symbol: string; signal: string }[]
}

interface MonitorData {
  ts:     string
  health: Record<string, 'ok' | 'slow' | 'down' | 'unknown'>
  scans:  { schwab: ScanSnap | null; alpaca: ScanSnap | null }
  cron:   { last_run: Record<string, string>; recent: { job: string; status: string; trades_made: number; message: string; created_at: string }[] }
  trades: { open_count: number; open: { symbol: string; action: string; quantity: number; entry_price: number; strategy: string; broker: string; created_at: string }[] }
  alerts: { type: string; message: string; symbol: string | null; created_at: string }[]
  tg:     { macro_stance: string; macro_set_at: string | null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ago(ts: string | null | undefined): string {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function healthColor(h: string) {
  if (h === 'ok')   return '#13c98e'
  if (h === 'slow') return '#f59e0b'
  return '#ef4444'
}

function healthDot(h: string) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: healthColor(h), marginRight: 6, flexShrink: 0, boxShadow: h === 'ok' ? '0 0 6px #13c98e88' : 'none' }} />
}

function marketBadge(m: string) {
  const c = m === 'GOOD' ? '#13c98e' : m === 'TOUGH' ? '#f59e0b' : '#ef4444'
  return <span style={{ fontSize: '0.65rem', padding: '2px 8px', borderRadius: 12, background: c + '22', color: c, border: `1px solid ${c}44`, fontFamily: 'IBM Plex Mono', fontWeight: 700 }}>{m}</span>
}

// ── Animated pipeline connector ───────────────────────────────────────────────

function FlowLine({ active, count }: { active: boolean; count: number }) {
  const color = active ? '#13c98e' : '#1f2737'
  return (
    <div style={{ position: 'relative', width: 56, height: 2, background: color + '44', alignSelf: 'center', flexShrink: 0, overflow: 'visible' }}>
      {active && count > 0 && [0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: '50%',
            width: 7, height: 7,
            borderRadius: '50%',
            background: '#13c98e',
            transform: 'translateY(-50%)',
            boxShadow: '0 0 8px #13c98e',
            animation: `flowDot 1.6s ease-in-out infinite`,
            animationDelay: `${i * 0.5}s`,
          }}
        />
      ))}
    </div>
  )
}

// ── Pipeline node ─────────────────────────────────────────────────────────────

function PipeNode({
  icon, label, sub, count, color, active, pulse, detail,
}: {
  icon: string; label: string; sub: string; count: number | string; color: string; active: boolean; pulse?: boolean; detail?: string
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 100,
      opacity: active ? 1 : 0.38, transition: 'opacity 0.4s',
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 14,
        background: active ? color + '18' : '#0d1219',
        border: `1.5px solid ${active ? color : '#1f2737'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22,
        boxShadow: active && pulse ? `0 0 18px ${color}55` : 'none',
        animation: active && pulse ? 'pulseBorder 2s ease-in-out infinite' : 'none',
        transition: 'all 0.4s',
        position: 'relative',
      }}>
        {icon}
        {active && count !== 0 && (
          <span style={{
            position: 'absolute', top: -6, right: -6,
            background: color, color: '#000', borderRadius: 8,
            fontSize: '0.6rem', fontWeight: 800, padding: '1px 5px',
            fontFamily: 'IBM Plex Mono', lineHeight: '14px',
          }}>{count}</span>
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.72rem', color: active ? '#e2e8f0' : '#4b5563', fontWeight: 600, letterSpacing: '0.02em' }}>{label}</div>
        <div style={{ fontSize: '0.62rem', color: '#6b7280', marginTop: 1 }}>{sub}</div>
        {detail && active && <div style={{ fontSize: '0.6rem', color, marginTop: 2, fontFamily: 'IBM Plex Mono' }}>{detail}</div>}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LiveMonitorPage() {
  const [data, setData]     = useState<MonitorData | null>(null)
  const [tick, setTick]     = useState(0)
  const [broker, setBroker] = useState<'schwab' | 'alpaca'>('alpaca')
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor')
      if (r.ok) { setData(await r.json()); setTick((t) => t + 1) }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, 15_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [load])

  const snap = broker === 'schwab' ? data?.scans.schwab : data?.scans.alpaca

  // Pipeline active flags
  const hasDisc     = (snap?.discoveries?.length ?? 0) > 0
  const hasMomentum = (snap?.candidates ?? 0) > 0
  const hasEMA      = (snap?.candidates ?? 0) > 0
  const hasAI       = (snap?.ranked ?? 0) > 0
  const hasTrade    = (snap?.trades ?? 0) > 0

  const scanAge = snap?.ts ? (Date.now() - new Date(snap.ts).getTime()) / 60000 : 999
  const scanFresh = scanAge < 20  // consider stale after 20 min

  return (
    <>
      <style>{`
        @keyframes flowDot {
          0%   { left: -4px;  opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { left: calc(100% + 4px); opacity: 0; }
        }
        @keyframes pulseBorder {
          0%, 100% { box-shadow: 0 0 8px var(--pulse-color, #13c98e55); }
          50%       { box-shadow: 0 0 22px var(--pulse-color, #13c98e99); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
        .live-dot {
          width: 8px; height: 8px; border-radius: 50%; background: #13c98e;
          animation: blink 1.4s ease-in-out infinite;
          box-shadow: 0 0 8px #13c98e;
        }
        .fade-in { animation: fadeIn 0.4s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>

      <div className="page" style={{ maxWidth: 1140 }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="live-dot" />
            <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Live Monitor</h1>
            {loading && <span style={{ fontSize: '0.72rem', color: '#6b7280', marginLeft: 8 }}>Loading…</span>}
            {!loading && data && <span style={{ fontSize: '0.68rem', color: '#6b7280', marginLeft: 8, fontFamily: 'IBM Plex Mono' }}>refreshed {ago(data.ts)}</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['schwab', 'alpaca'] as const).map((b) => (
              <button key={b} onClick={() => setBroker(b)} style={{
                padding: '4px 12px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'IBM Plex Mono',
                background: broker === b ? (b === 'schwab' ? '#ef444422' : '#3b82f622') : 'transparent',
                color:      broker === b ? (b === 'schwab' ? '#ef4444'   : '#60a5fa')   : '#6b7280',
                border: `1px solid ${broker === b ? (b === 'schwab' ? '#ef4444' : '#3b82f6') : '#1f2737'}`,
                transition: 'all 0.2s',
              }}>
                {b === 'schwab' ? '🔴 Schwab Live' : '🔵 Alpaca Paper'}
              </button>
            ))}
            <button onClick={load} style={{ padding: '4px 10px', borderRadius: 8, fontSize: '0.72rem', background: '#141a26', border: '1px solid #1f2737', color: '#9ca3af', cursor: 'pointer' }}>↻</button>
          </div>
        </div>

        {/* ── System Health ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 18 }}>
          {[
            { key: 'schwab',    label: 'Schwab API',   icon: '📈' },
            { key: 'alpaca',    label: 'Alpaca API',   icon: '📊' },
            { key: 'claude',    label: 'Claude AI',    icon: '🤖' },
            { key: 'tg_poller', label: 'TG Poller',    icon: '📡' },
          ].map(({ key, label, icon }) => {
            const h = data?.health[key] ?? 'unknown'
            return (
              <div key={key} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10,
                background: '#0d1219', border: `1px solid ${h === 'ok' ? '#13c98e22' : h === 'slow' ? '#f59e0b22' : '#1f2737'}`,
                transition: 'border-color 0.4s',
              }}>
                <span style={{ fontSize: 16 }}>{icon}</span>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>{healthDot(h)}<span style={{ fontSize: '0.72rem', color: '#e2e8f0', fontWeight: 600 }}>{label}</span></div>
                  <div style={{ fontSize: '0.62rem', color: healthColor(h), fontFamily: 'IBM Plex Mono', marginTop: 1 }}>{h.toUpperCase()}</div>
                </div>
              </div>
            )
          })}
          {/* Cron status */}
          {[
            { key: 'scan',    label: 'Scan Cron',    icon: '🔍', interval: '15m' },
            { key: 'monitor', label: 'Monitor Cron', icon: '👁',  interval: '5m' },
            { key: 'close',   label: 'EOD Close',    icon: '🔒', interval: '3:45pm' },
          ].map(({ key, label, icon, interval }) => {
            const last = data?.cron.last_run[key]
            const ageMin = last ? (Date.now() - new Date(last).getTime()) / 60000 : 999
            const healthy = ageMin < (key === 'scan' ? 20 : key === 'monitor' ? 8 : 1440)
            return (
              <div key={key} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10,
                background: '#0d1219', border: `1px solid ${healthy ? '#13c98e22' : '#ef444422'}`,
              }}>
                <span style={{ fontSize: 16 }}>{icon}</span>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {healthDot(healthy ? 'ok' : 'down')}
                    <span style={{ fontSize: '0.72rem', color: '#e2e8f0', fontWeight: 600 }}>{label}</span>
                  </div>
                  <div style={{ fontSize: '0.62rem', color: '#6b7280', fontFamily: 'IBM Plex Mono', marginTop: 1 }}>
                    {last ? ago(last) : '—'} · every {interval}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Pipeline ── */}
        <div style={{ background: '#0a0d14', border: '1px solid #1f2737', borderRadius: 16, padding: '22px 24px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase' }}>AI Pipeline</span>
            {snap && marketBadge(snap.market)}
            {snap && <span style={{ fontSize: '0.68rem', color: '#6b7280', fontFamily: 'IBM Plex Mono' }}>VIX {snap.vix} · {snap.regime} · {scanFresh ? ago(snap.ts) : <span style={{ color: '#ef4444' }}>stale {ago(snap.ts)}</span>}</span>}
            {!snap && !loading && <span style={{ fontSize: '0.68rem', color: '#6b7280' }}>No scan data yet — runs every 15 min during market hours</span>}
          </div>

          {/* Pipeline row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', paddingBottom: 8 }}>
            <PipeNode
              icon="📡" label="Discovery" sub="Yahoo trending"
              count={snap?.discoveries?.length ?? 0}
              color="#a78bfa" active={hasDisc && scanFresh}
              detail={snap?.discoveries?.[0]?.symbol ?? undefined}
            />
            <FlowLine active={hasDisc && scanFresh} count={snap?.discoveries?.length ?? 0} />

            <PipeNode
              icon="⚡" label="Momentum" sub="Intraday spikes"
              count={snap?.candidates ?? 0}
              color="#f59e0b" active={hasMomentum && scanFresh}
              pulse={hasMomentum && scanFresh}
              detail={`${snap?.candidates ?? 0} found`}
            />
            <FlowLine active={hasMomentum && scanFresh} count={snap?.candidates ?? 0} />

            <PipeNode
              icon="📈" label="EMA Scan" sub="Pullback setups"
              count={snap?.scanned ?? 0}
              color="#60a5fa" active={!!snap && scanFresh}
              detail={`${snap?.scanned ?? 0} scanned`}
            />
            <FlowLine active={hasEMA && scanFresh} count={snap?.candidates ?? 0} />

            <PipeNode
              icon="🤖" label="AI Gate" sub="Claude + GPT-4o"
              count={snap?.ranked ?? 0}
              color="#13c98e" active={hasAI && scanFresh}
              pulse={hasAI && scanFresh}
              detail={snap?.picks?.[0] ? `${snap.picks[0].symbol} ${snap.picks[0].confidence}%` : undefined}
            />
            <FlowLine active={hasAI && scanFresh} count={snap?.ranked ?? 0} />

            <PipeNode
              icon="💰" label="Trade" sub="Executed"
              count={hasTrade ? (snap?.trades ?? 0) : data?.trades.open_count ?? 0}
              color="#13c98e" active={hasTrade && scanFresh}
              pulse={hasTrade && scanFresh}
              detail={hasTrade ? `${snap?.trades} placed` : `${data?.trades.open_count ?? 0} open`}
            />
          </div>

          {/* Funnel summary bar */}
          {snap && scanFresh && (
            <div style={{ marginTop: 18, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { label: 'Scanned',    v: snap.scanned,    c: '#60a5fa' },
                { label: 'Candidates', v: snap.candidates, c: '#f59e0b' },
                { label: 'AI Picks',   v: snap.ranked,     c: '#13c98e' },
                { label: 'Traded',     v: snap.trades,     c: snap.trades > 0 ? '#13c98e' : '#6b7280' },
              ].map(({ label, v, c }) => (
                <div key={label} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: '#0d1219', borderRadius: 8, padding: '6px 14px', border: '1px solid #1f2737',
                }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: c, fontFamily: 'IBM Plex Mono' }}>{v}</div>
                  <div style={{ fontSize: '0.6rem', color: '#6b7280', marginTop: 1, letterSpacing: '0.04em' }}>{label.toUpperCase()}</div>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
                <span style={{ fontSize: '0.68rem', color: '#6b7280' }}>
                  {snap.scanned > 0 ? `${((snap.ranked / snap.scanned) * 100).toFixed(1)}% pass rate` : ''}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Bottom grid ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

          {/* Last Picks */}
          <div style={{ background: '#0a0d14', border: '1px solid #1f2737', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
              Last AI Picks
            </div>
            {(!snap?.picks?.length) ? (
              <div style={{ color: '#4b5563', fontSize: '0.78rem' }}>No picks in last scan</div>
            ) : snap.picks.map((p, i) => (
              <div key={i} className="fade-in" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '7px 0', borderBottom: i < snap.picks.length - 1 ? '1px solid #1f2737' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'IBM Plex Mono', fontSize: '0.82rem', fontWeight: 700, color: '#e2e8f0', minWidth: 48 }}>{p.symbol}</span>
                  <span style={{ fontSize: '0.62rem', color: '#6b7280', background: '#141a26', padding: '2px 6px', borderRadius: 6 }}>{p.setup}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 56, height: 4, borderRadius: 2, background: '#1f2737', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${p.confidence}%`, background: p.confidence >= 80 ? '#13c98e' : p.confidence >= 70 ? '#f59e0b' : '#6b7280', borderRadius: 2, transition: 'width 0.6s' }} />
                  </div>
                  <span style={{ fontSize: '0.72rem', fontFamily: 'IBM Plex Mono', color: p.confidence >= 80 ? '#13c98e' : '#f59e0b', minWidth: 30, textAlign: 'right' }}>{p.confidence}%</span>
                </div>
              </div>
            ))}

            {/* Discoveries */}
            {(snap?.discoveries?.length ?? 0) > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid #1f2737', paddingTop: 10 }}>
                <div style={{ fontSize: '0.6rem', color: '#6b7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Discoveries</div>
                {snap!.discoveries.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontFamily: 'IBM Plex Mono', fontSize: '0.72rem', color: '#a78bfa', minWidth: 40 }}>{d.symbol}</span>
                    <span style={{ fontSize: '0.68rem', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.signal}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div style={{ background: '#0a0d14', border: '1px solid #1f2737', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
              Activity Feed
            </div>
            {data?.alerts.length === 0 && <div style={{ color: '#4b5563', fontSize: '0.78rem' }}>No recent activity</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data?.alerts.map((a, i) => {
                const isBuy  = a.type === 'BUY'
                const isSell = a.type === 'SELL'
                const color  = isBuy ? '#13c98e' : isSell ? '#ef4444' : '#f59e0b'
                return (
                  <div key={i} className="fade-in" style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                    padding: '6px 0', borderBottom: i < (data?.alerts.length ?? 0) - 1 ? '1px solid #0d1219' : 'none',
                  }}>
                    <span style={{ fontSize: '0.65rem', fontFamily: 'IBM Plex Mono', color, background: color + '18', border: `1px solid ${color}33`, borderRadius: 5, padding: '1px 5px', minWidth: 32, textAlign: 'center', marginTop: 1, flexShrink: 0 }}>{a.type}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.72rem', color: '#d1d5db', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.message}</div>
                      <div style={{ fontSize: '0.6rem', color: '#6b7280', marginTop: 2, fontFamily: 'IBM Plex Mono' }}>{ago(a.created_at)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Open positions */}
          <div style={{ background: '#0a0d14', border: '1px solid #1f2737', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Open Positions</div>
              <span style={{ fontSize: '0.68rem', fontFamily: 'IBM Plex Mono', color: '#13c98e' }}>{data?.trades.open_count ?? 0} total</span>
            </div>
            {data?.trades.open.length === 0 ? (
              <div style={{ color: '#4b5563', fontSize: '0.78rem' }}>No open positions</div>
            ) : data?.trades.open.map((t, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 0', borderBottom: i < (data?.trades.open.length ?? 0) - 1 ? '1px solid #1f2737' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'IBM Plex Mono', fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0', minWidth: 44 }}>{t.symbol}</span>
                  <span style={{ fontSize: '0.6rem', color: t.broker === 'schwab' ? '#ef4444' : '#60a5fa', background: (t.broker === 'schwab' ? '#ef4444' : '#3b82f6') + '18', borderRadius: 4, padding: '1px 5px', fontFamily: 'IBM Plex Mono' }}>{t.broker === 'schwab' ? 'LIVE' : 'PAPER'}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.72rem', color: '#d1d5db', fontFamily: 'IBM Plex Mono' }}>{t.quantity}×  ${t.entry_price.toFixed(2)}</div>
                  <div style={{ fontSize: '0.6rem', color: '#6b7280', marginTop: 1 }}>{ago(t.created_at)}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Cron log */}
          <div style={{ background: '#0a0d14', border: '1px solid #1f2737', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>Cron Log</div>
            {data?.cron.recent.length === 0 ? (
              <div style={{ color: '#4b5563', fontSize: '0.78rem' }}>No cron history</div>
            ) : data?.cron.recent.map((r, i) => (
              <div key={i} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                padding: '5px 0', borderBottom: i < (data?.cron.recent.length ?? 0) - 1 ? '1px solid #0d1219' : 'none',
              }}>
                <span style={{
                  fontSize: '0.6rem', fontFamily: 'IBM Plex Mono', padding: '1px 5px', borderRadius: 4, minWidth: 44, textAlign: 'center',
                  background: r.status === 'success' ? '#13c98e18' : '#ef444418',
                  color: r.status === 'success' ? '#13c98e' : '#ef4444',
                  border: `1px solid ${r.status === 'success' ? '#13c98e33' : '#ef444433'}`,
                }}>{r.job}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.68rem', color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.trades_made > 0 && <span style={{ color: '#13c98e', marginRight: 4 }}>+{r.trades_made}🔥</span>}
                    {r.message.replace(/^\[[^\]]+\]\s*/, '').slice(0, 80)}
                  </div>
                  <div style={{ fontSize: '0.58rem', color: '#4b5563', marginTop: 1, fontFamily: 'IBM Plex Mono' }}>{ago(r.created_at)}</div>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </>
  )
}
