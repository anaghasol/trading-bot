'use client'

/**
 * MyTrade shared UI kit — presentational components used across pages.
 * Dark "quant terminal" styling driven by the CSS variables in globals.css.
 */
import { ReactNode } from 'react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'

// ── Formatters ─────────────────────────────────────────────────────────────
export const money = (n: number) =>
  '$' + Math.abs(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const signed = (n: number) => (n >= 0 ? '+' : '−') + money(n)
export const pct = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n ?? 0).toFixed(1) + '%'
export const pnlColor = (n: number) => (n >= 0 ? 'var(--green)' : 'var(--red)')

// ── Card ───────────────────────────────────────────────────────────────────
export function Card({ children, accent, className = '', style }: { children: ReactNode; accent?: 'green' | 'blue'; className?: string; style?: React.CSSProperties }) {
  return <div className={`card ${accent === 'blue' ? 'blue-border' : ''} ${className}`} style={style}>{children}</div>
}
export function CardHead({ title, icon, right, tone = 'green' }: { title: string; icon?: ReactNode; right?: ReactNode; tone?: 'green' | 'blue' | 'plain' }) {
  return (
    <div className={`card-head ${tone === 'blue' ? 'blue' : tone === 'plain' ? 'plain' : ''}`}>
      <h3 className={`card-title ${tone === 'blue' ? 'blue' : tone === 'plain' ? 'neutral' : ''}`}>{icon}{title}</h3>
      {right}
    </div>
  )
}

// ── Metric box ─────────────────────────────────────────────────────────────
export function Metric({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="metric-box rise">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={color ? { color } : undefined}>{value}</div>
      {sub != null && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

// ── Chip ───────────────────────────────────────────────────────────────────
export function Chip({ children, tone = 'mut' }: { children: ReactNode; tone?: 'up' | 'down' | 'blue' | 'amber' | 'violet' | 'mut' }) {
  return <span className={`chip ${tone}`}>{children}</span>
}

// ── Live dot ───────────────────────────────────────────────────────────────
export function LiveDot({ on = true, color = 'var(--green)' }: { on?: boolean; color?: string }) {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? color : 'var(--fg-3)', display: 'inline-block', animation: on ? 'pulse 1.4s infinite' : 'none' }} />
}

// ── Meter ──────────────────────────────────────────────────────────────────
export function Meter({ pct: p, color = 'var(--green)', label, right, height = 8 }: { pct: number; color?: string; label?: string; right?: ReactNode; height?: number }) {
  return (
    <div>
      {(label || right) && <div className="meter-top"><span>{label}</span><span>{right}</span></div>}
      <div className="track" style={{ height }}>
        <div className="fill" style={{ width: `${Math.max(0, Math.min(100, p))}%`, background: color }} />
      </div>
    </div>
  )
}

// ── Donut ──────────────────────────────────────────────────────────────────
export function Donut({ pct: p, size = 96, color = 'var(--green)', label, big }: { pct: number; size?: number; color?: string; label?: string; big?: string }) {
  const r = size / 2 - 8, C = 2 * Math.PI * r
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--inset)" strokeWidth="8" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${(Math.max(0, Math.min(100, p)) / 100) * C} ${C}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .5s' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: size > 110 ? '1.4rem' : '1.05rem', color }}>{big ?? `${Math.round(p)}%`}</div>
          {label && <div className="metric-label" style={{ fontSize: '0.6rem' }}>{label}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Sparkline (recharts mini area) ─────────────────────────────────────────
export function Spark({ data, up = true, height = 36 }: { data: number[]; up?: boolean; height?: number }) {
  const d = data.map((v, i) => ({ i, v }))
  const col = up ? '#10b981' : '#ef4444'
  if (d.length < 2) return <div style={{ height, opacity: 0.4, display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--fg-3)' }}>—</div>
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={d} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`sp-${col}-${height}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity={0.35} />
            <stop offset="100%" stopColor={col} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={col} strokeWidth={2} fill={`url(#sp-${col}-${height})`} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Segmented toggle ───────────────────────────────────────────────────────
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: ReactNode; on?: 'green' | 'blue' | 'red' }[]; onChange: (k: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.key} className={`seg-btn ${value === o.key ? (o.on ? `on-${o.on}` : 'on') : ''}`} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────
export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ margin: 0, textAlign: 'center', padding: '18px 0', fontSize: '0.88rem' }}>{children}</p>
}
