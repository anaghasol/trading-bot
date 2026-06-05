'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { money, signed, pnlColor } from '@/components/ui/kit'
import { PROFILES } from '@/lib/strategy-profiles'

const NAV: [string, string][] = [['/dashboard', 'Desk'], ['/growth', 'Growth'], ['/sleeves', 'Sleeves'], ['/portfolio', 'Portfolio'], ['/trades', 'Trades'], ['/learning', 'Learning'], ['/settings', 'Settings']]

type Broker = 'schwab' | 'alpaca_paper'
interface Position { symbol: string; quantity: number; avg_cost: number; current_price: number; market_value: number; unrealized_pnl: number; pnl_pct: number; asset_type?: string }
interface Summary { account_value: number; cash: number; stock_buying_power: number; option_buying_power: number; day_trade_buying_power: number; day_pnl?: number; day_pnl_pct?: number; daytrade_count?: number }
interface Quote { symbol: string; price: number; change_pct: number }
interface Trade { id: number; symbol: string; action: string; quantity: number; entry_price: number; exit_price?: number; confidence: number; strategy: string; status: string; created_at: string }
interface Alert { id: number; type: string; message: string; created_at: string }
interface TgSignal { id: number; type: string; message: string; symbol?: string; created_at: string }
interface TgStatus { connected: boolean; has_session: boolean; last_poll: string | null; minutes_silent: number | null; tg_status: string | null; last_msg_id: number; signals: TgSignal[] }
interface SchwabOrder { order_id: string; symbol: string; instruction: string; quantity: number; filled_quantity: number; price: number; status: string; entered_time: string }
interface Dash { account: { balance: number; daily_pnl: number; total_pnl: number } | null; trades: Trade[]; alerts: Alert[]; market_open: boolean }
interface Pdt { day_trades_remaining: number; is_pdt_protected: boolean; balance: number }
interface Cat { key: string; label: string; leader: string; change_5d: number; change_1d: number; rsi: number; score: number; rank: number; temp: 'HOT' | 'WARM' | 'COOL' | 'COLD'; bias: number }

const WATCH = ['NVDA', 'AMD', 'MSFT', 'PLTR', 'TSLA', 'AMZN', 'META', 'COIN']
const UNIVERSE = ['SPY', 'QQQ', 'NVDA', 'AMD', 'MSFT', 'AAPL', 'PLTR', 'TSLA', 'AMZN', 'META', 'GOOGL', 'COIN', 'SOFI', 'NFLX', 'SHOP']
const GOAL = 25000
const DEFAULT_BAL: Record<Broker, number> = { schwab: 2000, alpaca_paper: 100000 }

const p2 = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n ?? 0).toFixed(2) + '%'
const num = (n: number) => Math.abs(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hhmmss = (iso: string) => { try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }) } catch { return '—' } }

// ── flashing number cell ────────────────────────────────────────────────────
function Flash({ value, fmt, className = '' }: { value: number; fmt: (n: number) => string; className?: string }) {
  const prev = useRef(value)
  const [cls, setCls] = useState('')
  useEffect(() => {
    if (value !== prev.current) {
      setCls(value > prev.current ? 'flash-up' : 'flash-dn')
      prev.current = value
      const t = setTimeout(() => setCls(''), 700)
      return () => clearTimeout(t)
    }
  }, [value])
  return <span className={`tabular ${className} ${cls}`}>{fmt(value)}</span>
}

// ── market countdown ────────────────────────────────────────────────────────
function useMarketClock() {
  const [txt, setTxt] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const tick = () => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
      const o = new Date(et); o.setHours(9, 30, 0, 0)
      const c = new Date(et); c.setHours(16, 0, 0, 0)
      const day = et.getDay()
      const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
      if (day === 0 || day === 6) { setOpen(false); setTxt('Market closed · weekend') }
      else if (et >= o && et < c) { setOpen(true); setTxt(`Market open · ${fmt(c.getTime() - et.getTime())} left`) }
      else if (et < o) { setOpen(false); setTxt(`${fmt(o.getTime() - et.getTime())} until open`) }
      else { setOpen(false); setTxt('After hours · closed') }
    }
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [])
  return { txt, open }
}

// ── quick-trade panel ────────────────────────────────────────────────────────
function QuickTrade({ broker, cash, qmap, onDone }: { broker: string; cash: number; qmap: Record<string, { price: number; change_pct: number }>; onDone: () => void }) {
  const [sym, setSym] = useState('')
  const [action, setAction] = useState<'BUY' | 'SELL'>('BUY')
  const [mode, setMode] = useState<'shares' | 'dollars'>('shares')
  const [qty, setQty] = useState('')
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [limitPx, setLimitPx] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const [msg, setMsg] = useState('')
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([])
  const [sugIdx, setSugIdx] = useState(-1)
  const [showSug, setShowSug] = useState(false)
  const symRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const upper = sym.toUpperCase().trim()
  const liveQ = qmap[upper]
  const livePrice = liveQ?.price ?? 0

  const shares = mode === 'shares'
    ? parseFloat(qty) || 0
    : livePrice > 0 ? Math.floor((parseFloat(qty) || 0) / livePrice) : 0
  const estCost = shares * (orderType === 'LIMIT' && parseFloat(limitPx) > 0 ? parseFloat(limitPx) : livePrice)
  const canAfford = action === 'SELL' || cash <= 0 || estCost <= cash

  function onSymChange(val: string) {
    const v = val.toUpperCase()
    setSym(v); setSugIdx(-1)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (v.length === 0) { setSuggestions([]); setShowSug(false); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/alpaca/search?q=${encodeURIComponent(v)}`)
        const data = await res.json()
        setSuggestions(data.results ?? [])
        setShowSug((data.results ?? []).length > 0)
      } catch { /* ignore */ }
    }, 180)
  }

  function pickSuggestion(s: { symbol: string; name: string }) {
    setSym(s.symbol); setSuggestions([]); setShowSug(false); setSugIdx(-1)
    symRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!showSug) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSugIdx(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSugIdx(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); pickSuggestion(suggestions[sugIdx]) }
    else if (e.key === 'Escape') { setShowSug(false) }
  }

  async function submit() {
    if (!upper || shares <= 0) return
    setStatus('loading'); setMsg('')
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: upper, quantity: shares, action, broker, orderType, limitPrice: orderType === 'LIMIT' ? parseFloat(limitPx) : undefined }),
      })
      const data = await res.json()
      if (data.status === 'PLACED') {
        setStatus('ok'); setMsg(`✓ ${action} ${shares} ${upper} placed`)
        setSym(''); setQty(''); setLimitPx('')
        setTimeout(() => { setStatus('idle'); setMsg(''); onDone() }, 2500)
      } else {
        setStatus('err'); setMsg(data.error ?? 'Order failed')
        setTimeout(() => setStatus('idle'), 4000)
      }
    } catch {
      setStatus('err'); setMsg('Network error')
      setTimeout(() => setStatus('idle'), 4000)
    }
  }

  const isPaper = broker === 'alpaca_paper'
  const accent = isPaper ? 'var(--blue)' : action === 'BUY' ? 'var(--green)' : 'var(--red)'

  return (
    <div className="card">
      <div className="card-head plain">
        <h3 className="card-title neutral">⚡ Quick Trade <span className="chip mut" style={{ fontSize: '0.6rem' }}>{isPaper ? 'Paper · Alpaca' : 'Live · Schwab'}</span></h3>
        <span className="eyebrow">Buying power: <b style={{ color: 'var(--fg-1)' }}>${Math.floor(cash).toLocaleString()}</b></span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Symbol row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <div className="eyebrow" style={{ marginBottom: 3 }}>Symbol</div>
            <input
              ref={symRef}
              value={sym}
              onChange={(e) => onSymChange(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSug(true)}
              onBlur={() => setTimeout(() => setShowSug(false), 150)}
              placeholder="NVDA, OKLO, SPY…"
              autoComplete="off"
              style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--divider)', borderRadius: 6, padding: '6px 10px', color: 'var(--fg-1)', fontSize: '0.88rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
            {/* Autocomplete dropdown */}
            {showSug && suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--bg-3)', border: '1px solid var(--divider)', borderRadius: 6, marginTop: 2, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                {suggestions.map((s, i) => (
                  <div
                    key={s.symbol}
                    onMouseDown={() => pickSuggestion(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', cursor: 'pointer',
                      background: i === sugIdx ? 'var(--bg-2)' : 'transparent',
                      borderBottom: i < suggestions.length - 1 ? '1px solid var(--divider)' : 'none',
                    }}
                  >
                    <span className="tabular" style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--fg-1)', minWidth: 52 }}>{s.symbol}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {livePrice > 0 && (
            <div style={{ textAlign: 'right', paddingTop: 18 }}>
              <div className="tabular" style={{ fontWeight: 700, fontSize: '0.95rem' }}>${num(livePrice)}</div>
              <div className="tabular" style={{ fontSize: '0.7rem', color: liveQ.change_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>{p2(liveQ.change_pct)}</div>
            </div>
          )}
        </div>

        {/* Action + Order type */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="seg" style={{ flex: 1 }}>
            <button className={`seg-btn ${action === 'BUY' ? 'on' : ''}`} style={action === 'BUY' ? { background: 'var(--green-faint)', color: 'var(--green)', borderColor: 'var(--green)' } : {}} onClick={() => setAction('BUY')}>BUY</button>
            <button className={`seg-btn ${action === 'SELL' ? 'on-red' : ''}`} onClick={() => setAction('SELL')}>SELL</button>
          </div>
          <div className="seg">
            <button className={`seg-btn ${orderType === 'MARKET' ? 'on' : ''}`} onClick={() => setOrderType('MARKET')}>Market</button>
            <button className={`seg-btn ${orderType === 'LIMIT' ? 'on' : ''}`} onClick={() => setOrderType('LIMIT')}>Limit</button>
          </div>
        </div>

        {/* Qty row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <div className="eyebrow" style={{ marginBottom: 3 }}>
              {mode === 'shares' ? 'Shares' : 'Dollar amount'}
            </div>
            <input
              type="number" min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={mode === 'shares' ? '10' : '500'}
              style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--divider)', borderRadius: 6, padding: '6px 10px', color: 'var(--fg-1)', fontSize: '0.88rem', fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <button
            onClick={() => setMode(m => m === 'shares' ? 'dollars' : 'shares')}
            style={{ padding: '6px 10px', background: 'var(--bg-2)', border: '1px solid var(--divider)', borderRadius: 6, fontSize: '0.72rem', color: 'var(--fg-3)', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: 1 }}
          >{mode === 'shares' ? '$ switch' : '# switch'}</button>
        </div>

        {/* Limit price */}
        {orderType === 'LIMIT' && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 3 }}>Limit price</div>
            <input
              type="number" min="0" step="0.01"
              value={limitPx}
              onChange={(e) => setLimitPx(e.target.value)}
              placeholder={livePrice > 0 ? livePrice.toFixed(2) : '0.00'}
              style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--divider)', borderRadius: 6, padding: '6px 10px', color: 'var(--fg-1)', fontSize: '0.88rem', fontFamily: 'var(--font-mono)' }}
            />
          </div>
        )}

        {/* Cost estimate + execute */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
          <div style={{ flex: 1, fontSize: '0.78rem', color: 'var(--fg-3)' }}>
            {shares > 0 && livePrice > 0 && (
              <span>Est. {action === 'BUY' ? 'cost' : 'proceeds'}: <b style={{ color: canAfford ? accent : 'var(--red)' }}>${num(estCost)}</b>
                {mode === 'dollars' && <span className="faint"> · {shares} sh</span>}
              </span>
            )}
          </div>
          <button
            disabled={!upper || shares <= 0 || status === 'loading' || !canAfford}
            onClick={submit}
            style={{
              padding: '8px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', fontWeight: 700,
              fontSize: '0.82rem', letterSpacing: '0.04em',
              background: status === 'loading' ? 'var(--bg-3)' : !canAfford ? 'var(--bg-3)' : accent,
              color: status === 'loading' || !canAfford ? 'var(--fg-3)' : '#fff',
              opacity: (!upper || shares <= 0) ? 0.5 : 1,
              transition: 'all 0.15s',
            }}
          >
            {status === 'loading' ? '…' : `${action} ${shares > 0 ? shares + ' sh' : ''}`}
          </button>
        </div>

        {/* Status message */}
        {msg && (
          <div style={{ fontSize: '0.78rem', padding: '6px 10px', borderRadius: 6, background: status === 'ok' ? 'var(--green-faint)' : 'var(--red-faint)', color: status === 'ok' ? 'var(--green)' : 'var(--red)', border: `1px solid ${status === 'ok' ? 'var(--green)' : 'var(--red)'}` }}>
            {msg}
          </div>
        )}

        {!canAfford && shares > 0 && (
          <div style={{ fontSize: '0.72rem', color: 'var(--red)' }}>
            Insufficient buying power — need {money(estCost)}, have {money(cash)}
          </div>
        )}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [broker, setBroker] = useState<Broker>('schwab')
  const [dash, setDash] = useState<Record<Broker, Dash | null>>({ schwab: null, alpaca_paper: null })
  const [pos, setPos] = useState<Position[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [qmap, setQmap] = useState<Record<string, Quote>>({})
  const [pdt, setPdt] = useState<Pdt | null>(null)
  const [orders, setOrders] = useState<SchwabOrder[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [tab, setTab] = useState<'working' | 'filled' | 'canceled'>('filled')
  const [stamp, setStamp] = useState('')
  const [alertOn, setAlertOn] = useState(true)
  const [tg, setTg] = useState<TgStatus | null>(null)
  const market = useMarketClock()
  const profile = PROFILES[broker]

  const load = useCallback(async (b: Broker) => {
    const paper = b === 'alpaca_paper'
    // Each tab fetches ONLY from its own broker — no cross-contamination
    const [d, p, s, q, h, o, r] = await Promise.allSettled([
      fetch(`/api/dashboard?broker=${b}`).then((r) => r.json()),
      paper ? fetch('/api/alpaca/positions').then((r) => r.json())
            : fetch('/api/schwab/positions').then((r) => r.json()),
      paper ? fetch('/api/alpaca/account').then((r) => r.json())
            : fetch('/api/schwab/account').then((r) => r.json()),
      fetch(`/api/schwab/quotes?symbols=${UNIVERSE.join(',')}`).then((r) => r.json()),
      paper ? Promise.resolve(null)  // Alpaca PDT = unlimited
            : fetch('/api/schwab/history?days=7').then((r) => r.json()),
      paper ? fetch('/api/alpaca/orders?days=5').then((r) => r.json())
            : fetch('/api/schwab/activity?days=3').then((r) => r.json()),
      fetch('/api/rotation').then((r) => r.json()),
    ])
    if (d.status === 'fulfilled') setDash((prev) => ({ ...prev, [b]: d.value }))
    if (p.status === 'fulfilled') setPos(Array.isArray(p.value) ? p.value : (p.value?.positions ?? []))
    if (s.status === 'fulfilled' && s.value && !s.value.error) setSummary(s.value)
    if (q.status === 'fulfilled') { const m: Record<string, Quote> = {}; for (const x of (q.value?.quotes ?? [])) m[x.symbol] = x; setQmap(m) }
    if (h.status === 'fulfilled' && h.value?.pdt) setPdt(h.value.pdt)
    if (o.status === 'fulfilled' && o.value?.orders) setOrders(o.value.orders)
    else setOrders([])
    if (r.status === 'fulfilled' && r.value?.categories) setCats(r.value.categories)
    setStamp(new Date().toLocaleTimeString('en-US', { hour12: false }))
    // Telegram status (broker-agnostic — same Railway service for both)
    fetch('/api/telegram/status').then(r => r.json()).then(setTg).catch(() => {})
  }, [])

  // Clear stale data instantly when broker tab switches — no cross-contamination
  useEffect(() => {
    setPos([])
    setSummary(null)
    setOrders([])
    setPdt(null)
  }, [broker])

  // market-hours-aware polling: fast when open, slow when closed
  useEffect(() => {
    load(broker)
    const ms = market.open ? 7000 : 60000
    const iv = setInterval(() => load(broker), ms)
    return () => clearInterval(iv)
  }, [broker, market.open, load])

  const data = dash[broker]
  const isPaper = broker === 'alpaca_paper'

  // Account value: always from live broker API (summary), never from stale Supabase
  const acctValue = summary?.account_value ?? DEFAULT_BAL[broker]

  // Day P/L: from live broker API — Alpaca has day_pnl, Schwab uses summary equity change
  const dayPnl = (summary as Record<string, number> | null)?.day_pnl ?? 0

  const unreal = pos.reduce((s, p) => s + p.unrealized_pnl, 0)
  const netLiq = pos.reduce((s, p) => s + Math.abs(p.market_value), 0)
  const dayPct = acctValue ? (dayPnl / acctValue) * 100 : 0
  const up = dayPnl >= 0
  const cash = summary?.cash ?? Math.max(0, acctValue - netLiq)
  const deployedPct = acctValue ? Math.min(100, (netLiq / acctValue) * 100) : 0
  const breakerUsed = dayPnl < 0 ? Math.min(100, (Math.abs(dayPnl) / (acctValue * profile.daily_loss_stop_pct)) * 100) : 2
  const goalPct = Math.min(100, (acctValue / GOAL) * 100)
  const dtLeft = isPaper ? '∞' : (pdt?.day_trades_remaining ?? 0)

  // per-position day change from live quotes
  const dayChangeOf = (p: Position) => {
    const q = qmap[p.symbol]; if (!q || !q.change_pct) return null
    const prev = p.current_price / (1 + q.change_pct / 100)
    return (p.current_price - prev) * p.quantity * (p.asset_type === 'OPTION' ? 100 : 1)
  }
  const totDay = pos.reduce((s, p) => s + (dayChangeOf(p) ?? 0), 0)
  const totCost = pos.reduce((s, p) => s + p.avg_cost * p.quantity * (p.asset_type === 'OPTION' ? 100 : 1), 0)
  const totDelta = pos.reduce((s, p) => s + (p.asset_type === 'OPTION' ? 0 : p.quantity), 0)

  // indices + watchlist from quote map
  const idx = (sym: string) => qmap[sym]
  const watch = WATCH.map((s) => qmap[s]).filter(Boolean) as Quote[]

  // activity rows (schwab → real order book; paper → recorded trades)
  type Row = { time: string; side: string; symbol: string; qty: number; price: number; status: string }
  const rows: Row[] = broker === 'schwab'
    ? orders.map((o) => ({ time: o.entered_time, side: o.instruction, symbol: o.symbol, qty: o.filled_quantity || o.quantity, price: o.price, status: o.status }))
    : (data?.trades ?? []).map((t) => ({ time: t.created_at, side: t.action, symbol: t.symbol, qty: t.quantity, price: t.status === 'CLOSED' ? (t.exit_price ?? t.entry_price) : t.entry_price, status: t.status === 'OPEN' ? 'FILLED' : t.status }))
  const filled = rows.filter((r) => /FILLED|OPEN|CLOSED/i.test(r.status))
  const working = rows.filter((r) => /WORK|PENDING|QUEUED|ACCEPTED|NEW/i.test(r.status))
  const canceled = rows.filter((r) => /CANCEL|REJECT|EXPIRED/i.test(r.status))
  const tabRows = tab === 'filled' ? filled : tab === 'working' ? working : canceled

  // AI signal queue from open trades
  const signals = (data?.trades ?? []).filter((t) => t.status === 'OPEN').slice(0, 4)

  return (
    <div>
      {/* ════ TOP STRIP ════ */}
      <header className="desk-top">
        <div className="desk-brand">
          <div className="bmark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg></div>
          <div><div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1 }}>MyTrade</div><div className="eyebrow" style={{ marginTop: 2 }}>Live Desk</div></div>
        </div>
        <nav className="desk-nav">{NAV.map(([href, label]) => <Link key={href} href={href} className={href === '/dashboard' ? 'on' : ''}>{label}</Link>)}</nav>
        <div className="desk-spacer" />
        {idx('SPY') && <div className="desk-idx"><span className="lab">S&amp;P · SPY</span><span className="tabular">{num(idx('SPY')!.price)}</span><span className="tabular" style={{ fontSize: '0.72rem', color: pnlColor(idx('SPY')!.change_pct) }}>{p2(idx('SPY')!.change_pct)}</span></div>}
        {idx('QQQ') && <div className="desk-idx"><span className="lab">NDQ · QQQ</span><span className="tabular">{num(idx('QQQ')!.price)}</span></div>}
        <div className="desk-rt"><span className="dot live" style={{ background: 'var(--green)' }} /> Realtime data</div>
        <span className={`countdown ${market.open ? 'open' : ''}`}>{market.open && <span className="dot live" style={{ background: 'var(--green)' }} />}⏱ {market.txt}</span>
        <div className="seg">
          <button className={`seg-btn ${broker === 'schwab' ? 'on-red' : ''}`} onClick={() => setBroker('schwab')}><span className="dot" style={{ background: broker === 'schwab' ? 'var(--red)' : 'var(--fg-3)' }} /> Live · Schwab</button>
          <button className={`seg-btn ${isPaper ? 'on-blue' : ''}`} onClick={() => setBroker('alpaca_paper')}><span className="dot" style={{ background: isPaper ? 'var(--blue)' : 'var(--fg-3)' }} /> Paper · Alpaca</button>
        </div>
        {/* ── System health dots — compact, in header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 4 }} className="sys-dots">
          {(() => {
            const etH = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
            const afterHrs = etH >= 18 || etH < 9
            const tgOk = tg?.connected
            const tgColor = tg == null ? 'var(--fg-3)' : tgOk ? 'var(--green)' : afterHrs ? '#888' : 'var(--red)'
            const alpOk = !!summary
            const mktColor = market.open ? 'var(--green)' : '#888'
            const dots = [
              { label: 'TG', color: tgColor, title: tgOk ? 'TG: connected' : afterHrs ? 'TG: market closed' : `TG: ${tg?.minutes_silent ?? '?'}m silent` },
              { label: 'ALP', color: alpOk ? 'var(--green)' : 'var(--red)', title: alpOk ? 'Alpaca: ok' : 'Alpaca: error' },
              { label: 'SCH', color: broker === 'schwab' && alpOk ? 'var(--green)' : '#888', title: 'Schwab' },
              { label: 'AI', color: 'var(--green)', title: 'Claude AI: ok' },
              { label: 'MKT', color: mktColor, title: market.open ? 'Market open' : 'Market closed' },
            ]
            return dots.map(({ label, color, title }) => (
              <span key={label} title={title} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.6rem', color: 'var(--fg-3)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
                <span className="sys-label">{label}</span>
              </span>
            ))
          })()}
        </div>
        <button className="iconbtn" onClick={() => load(broker)}>↻ {stamp || '—'}</button>
      </header>

      <div className="desk-wrap">
        {/* ════ LEFT RAIL ════ */}
        <div className="desk-col">
          {/* Account */}
          <div className="card">
            <div className="card-head plain"><h3 className="card-title neutral">💼 Account <span className="chip mut" style={{ fontSize: '0.6rem' }}>{isPaper ? 'Alpaca · Paper' : 'Schwab · Individual'}</span></h3><span className="eyebrow">{isPaper ? 'PAPER $' : 'REAL $'}</span></div>
            <div className="card-body">
              <div className="eyebrow">Account value</div>
              <div className="acctval" style={{ margin: '4px 0 10px' }}><Flash value={acctValue} fmt={(n) => '$' + num(n)} /></div>
              <div style={{ marginBottom: 12 }}><span className={`chip ${up ? 'up' : 'down'}`} style={{ fontSize: '0.76rem' }}>{up ? '▲' : '▼'} {signed(dayPnl)} ({p2(dayPct)}) day</span></div>
              <div className="kv"><span className="k">Cash</span><span className="v">{money(cash)}</span></div>
              <div className="kv"><span className="k">Stock buying power</span><span className="v">{money(summary?.stock_buying_power ?? cash)}</span></div>
              <div className="kv"><span className="k">Option buying power</span><span className="v" style={{ color: (summary?.option_buying_power ?? 0) < 0 ? 'var(--red)' : undefined }}>{summary ? (summary.option_buying_power < 0 ? '−' : '') + '$' + num(summary.option_buying_power) : money(cash)}</span></div>
              <div className="kv"><span className="k">Day-trade buying power</span><span className="v">{money(summary?.day_trade_buying_power ?? 0)}</span></div>
              <div className="kv"><span className="k">Day trades left</span><span className="v" style={{ color: isPaper ? 'var(--green)' : (Number(dtLeft) > 0 ? 'var(--green)' : 'var(--amber)') }}>{dtLeft} <span className="faint" style={{ fontSize: '0.62rem' }}>{isPaper ? 'unlimited' : '/ 3'}</span></span></div>
              <div className="kv"><span className="k">P/L Day</span><span className="v" style={{ color: pnlColor(dayPnl) }}>{signed(dayPnl)}</span></div>
              <div className="kv"><span className="k">P/L Open</span><span className="v" style={{ color: pnlColor(unreal) }}>{signed(unreal)}</span></div>
            </div>
          </div>

          {/* Protection & Goal */}
          <div className="card">
            <div className="card-head plain"><h3 className="card-title neutral">🛡 Protection &amp; Goal</h3><span className="chip up">ACTIVE</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><div className="meter-top"><span>Progress to $25K goal</span><span>{goalPct.toFixed(0)}%</span></div><div className="track"><div className="fill" style={{ width: `${goalPct}%`, background: 'var(--grad-conf)' }} /></div></div>
              <div><div className="meter-top"><span>Daily loss breaker</span><span>{p2(dayPct)} / −{(profile.daily_loss_stop_pct * 100).toFixed(0)}%</span></div><div className="track"><div className="fill" style={{ width: `${breakerUsed}%`, background: breakerUsed > 70 ? 'var(--red)' : 'var(--green)' }} /></div></div>
              <div className="spread" style={{ fontSize: '0.78rem' }}><span className="muted">Risk / trade</span><span className={`chip ${isPaper ? 'blue' : 'up'}`}>{(profile.risk_pct * 100).toFixed(1)}% equity · dynamic</span></div>
              <div className="spread" style={{ fontSize: '0.78rem' }}><span className="muted">Profits recorded</span><span className="chip up"><span className="dot live" style={{ background: 'var(--green)' }} /> synced → Supabase</span></div>
            </div>
          </div>

          {/* Watchlist */}
          <div className="card">
            <div className="card-head plain"><h3 className="card-title neutral">📈 Watchlist</h3><span className="eyebrow">Live quotes</span></div>
            <div className="card-body" style={{ padding: '6px 14px' }}>
              {watch.length === 0
                ? <div className="desk-empty">Quotes load during market hours</div>
                : <div className="wl">
                    {watch.map((q) => (
                      <>
                        <span key={q.symbol + '-s'} className="wl sym">{q.symbol}</span>
                        <span key={q.symbol + '-p'} className="wl mk"><Flash value={q.price} fmt={num} /></span>
                        <span key={q.symbol + '-c'} className="wl ch" style={{ color: pnlColor(q.change_pct) }}>{p2(q.change_pct)}</span>
                      </>
                    ))}
                  </div>}
            </div>
          </div>

          {/* Category Trends (rotation engine) */}
          <div className="card">
            <div className="card-head plain"><h3 className="card-title neutral">🧭 Category Trends</h3><span className="eyebrow">lean into heat</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {cats.length === 0 ? <div className="desk-empty">Rotation runs on the next scan</div>
                : cats.map((c) => {
                  const dn = c.change_5d < 0
                  const w = Math.max(6, Math.min(100, ((c.score + 6) / 16) * 100))
                  return (
                    <div key={c.key} className="cat-row" style={{ opacity: c.bias === 0 ? 0.5 : 1 }}>
                      <div className="cat-top"><span>{c.temp === 'HOT' ? '🔥 ' : ''}{c.label}</span><span className="tabular" style={{ fontSize: '0.72rem', color: dn ? 'var(--red)' : 'var(--green)' }}>{p2(c.change_5d)}</span></div>
                      <div className="track" style={{ height: 6 }}><div className="fill" style={{ width: `${w}%`, background: dn ? 'var(--red)' : (c.temp === 'HOT' ? 'var(--grad-conf)' : 'var(--green)') }} /></div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>

        {/* ════ MAIN ════ */}
        <div className="desk-col">
          {/* profile banner */}
          <div className="profile-banner" style={{ background: isPaper ? 'var(--blue-faint)' : 'var(--green-faint)', border: `1px solid ${isPaper ? 'var(--blue)' : 'var(--green)'}` }}>
            <b style={{ color: isPaper ? 'var(--blue)' : 'var(--green)' }}>{isPaper ? '🧪 Aggressive Lab' : '🛡 Protected'}</b>
            <span className="muted" style={{ fontSize: '0.78rem' }}>{isPaper ? 'Alpaca paper $' : 'Schwab real $'} · {(profile.risk_pct * 100).toFixed(1)}% risk/trade · up to {profile.max_positions} positions · {profile.allow_day_trades ? 'day-trades ON (no PDT)' : 'PDT-safe swing (1–5d holds)'} · −{(profile.daily_loss_stop_pct * 100).toFixed(0)}% daily breaker · {profile.min_confidence}% AI gate</span>
            {isPaper && <span className="chip blue" style={{ marginLeft: 'auto' }}>big balance — test hard</span>}
          </div>

          {/* PDT equity-call alert (real money, protected) */}
          {!isPaper && alertOn && pdt?.is_pdt_protected !== false && (
            <div className="desk-alert">
              <div className="ico">!</div>
              <div><b>Day-Trade Equity Call · {money(acctValue)}</b><div className="muted" style={{ marginTop: 2 }}>Account under $25K — MyTrade is in <b style={{ color: 'var(--fg-1)' }}>SWING MODE</b> (1–5 day holds, no same-day round-trips) until equity clears $25K. Protection enforced automatically.</div></div>
              <button className="x" onClick={() => setAlertOn(false)}>×</button>
            </div>
          )}

          {/* Quick Trade */}
          <QuickTrade broker={broker} cash={summary?.stock_buying_power ?? cash} qmap={qmap} onDone={() => load(broker)} />

          {/* Positions */}
          <div className="card">
            <div className="card-head plain">
              <h3 className="card-title neutral">📊 Positions <span className="chip mut" style={{ fontSize: '0.6rem' }}>{pos.length} open</span></h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="eyebrow">Net liq</span>
                <span className="tabular" style={{ fontWeight: 700 }}>{money(netLiq)}</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="ptbl" style={{ minWidth: 680 }}>
                <colgroup>
                  <col style={{ minWidth: 110 }} />{/* Symbol */}
                  <col style={{ minWidth: 50 }} /> {/* Qty */}
                  <col style={{ minWidth: 90 }} /> {/* P/L Day */}
                  <col style={{ minWidth: 90 }} /> {/* P/L Open */}
                  <col style={{ minWidth: 70 }} /> {/* P/L % */}
                  <col style={{ minWidth: 90 }} /> {/* Avg Cost */}
                  <col style={{ minWidth: 90 }} /> {/* Net Liq */}
                  <col style={{ minWidth: 80 }} /> {/* Mark */}
                  <col style={{ minWidth: 80 }} /> {/* Action */}
                </colgroup>
                <thead>
                  <tr>
                    <th className="l">Symbol</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>P/L Day</th>
                    <th style={{ textAlign: 'right' }}>P/L Open</th>
                    <th style={{ textAlign: 'right' }}>P/L %</th>
                    <th style={{ textAlign: 'right' }}>Avg Cost</th>
                    <th style={{ textAlign: 'right' }}>Net Liq</th>
                    <th style={{ textAlign: 'right' }}>Mark</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pos.length === 0
                    ? <tr><td colSpan={9}><div className="desk-empty">No open positions — engine waiting for a {profile.min_confidence}%+ signal.</div></td></tr>
                    : pos.map((p, i) => {
                        const opt = p.asset_type === 'OPTION'
                        const day = dayChangeOf(p)
                        const cost = p.avg_cost * p.quantity * (opt ? 100 : 1)
                        const dayPnlPct = p.avg_cost > 0 && day != null ? (day / cost) * 100 : null
                        return (
                          <tr key={p.symbol + i}>
                            <td className="l">
                              <span className="psym">{p.symbol}</span>
                              <span className={`pbadge ${opt ? 'opt' : 'eq'}`}>{opt ? 'OPT' : 'EQ'}</span>
                            </td>
                            <td style={{ textAlign: 'right' }}>{p.quantity > 0 ? '+' : ''}{p.quantity}</td>
                            <td style={{ textAlign: 'right', color: day == null ? 'var(--fg-3)' : pnlColor(day) }}>
                              {day == null ? '—' : signed(day)}
                              {dayPnlPct != null && <span style={{ fontSize: '0.68rem', marginLeft: 4, opacity: 0.7 }}>{p2(dayPnlPct)}</span>}
                            </td>
                            <td style={{ textAlign: 'right', color: pnlColor(p.unrealized_pnl) }}>{signed(p.unrealized_pnl)}</td>
                            <td style={{ textAlign: 'right' }}>
                              <span style={{ color: pnlColor(p.pnl_pct), fontWeight: 600 }}>{p2(p.pnl_pct)}</span>
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{money(cost)}</td>
                            <td style={{ textAlign: 'right' }}>{money(p.market_value)}</td>
                            <td style={{ textAlign: 'right' }}><Flash value={p.current_price} fmt={num} /></td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="closex" onClick={() => {
                                const api = isPaper ? '/api/alpaca/trade' : '/api/schwab/trade'
                                fetch('/api/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: p.symbol, quantity: Math.abs(p.quantity), action: 'SELL', broker }) }).then(() => setTimeout(() => load(broker), 1500))
                              }}>Close</button>
                            </td>
                          </tr>
                        )
                      })}
                </tbody>
                {pos.length > 0 && (
                  <tfoot>
                    <tr>
                      <td className="l" style={{ fontWeight: 600 }}>Totals</td>
                      <td style={{ textAlign: 'right' }}>{pos.reduce((s, p) => s + p.quantity, 0)}</td>
                      <td style={{ textAlign: 'right', color: pnlColor(totDay) }}>{signed(totDay)}</td>
                      <td style={{ textAlign: 'right', color: pnlColor(unreal) }}>{signed(unreal)}</td>
                      <td>—</td>
                      <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{money(totCost)}</td>
                      <td style={{ textAlign: 'right' }}>{money(netLiq)}</td>
                      <td>—</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="section-row">
            {/* Activity */}
            <div className="card">
              <div className="card-head plain">
                <div className="atabs">
                  <button className={`atab ${tab === 'working' ? 'on' : ''}`} onClick={() => setTab('working')}>Working <span className="cnt">{working.length}</span></button>
                  <button className={`atab ${tab === 'filled' ? 'on' : ''}`} onClick={() => setTab('filled')}>Filled <span className="cnt">{filled.length}</span></button>
                  <button className={`atab ${tab === 'canceled' ? 'on' : ''}`} onClick={() => setTab('canceled')}>Canceled <span className="cnt">{canceled.length}</span></button>
                </div>
                <span className="eyebrow">Today's activity</span>
              </div>
              <div className="card-body" style={{ minHeight: 150, paddingTop: 8 }}>
                {tabRows.length === 0 ? (
                  <div className="desk-empty">{tab === 'working' ? <>No working orders.<br /><span className="faint">Bot places a protective stop on every fill.</span></> : tab === 'canceled' ? 'No canceled orders today.' : 'No fills yet today.'}</div>
                ) : (
                  <table className="ptbl" style={{ width: '100%' }}>
                    <colgroup>
                      <col style={{ width: 70 }} />
                      <col style={{ width: 72 }} />
                      <col style={{ minWidth: 80 }} />
                      <col style={{ width: 50 }} />
                      <col style={{ width: 80 }} />
                      <col style={{ width: 80 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="l">Time</th>
                        <th className="l">Side</th>
                        <th className="l">Symbol</th>
                        <th style={{ textAlign: 'right' }}>Qty</th>
                        <th style={{ textAlign: 'right' }}>Price</th>
                        <th style={{ textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tabRows.slice(0, 12).map((o, i) => (
                        <tr key={i}>
                          <td className="l" style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>{hhmmss(o.time)}</td>
                          <td className="l"><span className={`chip ${/SELL|STC/i.test(o.side) ? 'down' : 'up'}`} style={{ fontSize: '0.62rem' }}>{o.side}</span></td>
                          <td className="l"><span className="psym">{o.symbol}</span></td>
                          <td style={{ textAlign: 'right' }}>{o.qty}</td>
                          <td style={{ textAlign: 'right' }}>${num(o.price)}</td>
                          <td style={{ textAlign: 'right' }}><span className="chip mut" style={{ fontSize: '0.62rem' }}>{o.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Telegram live feed */}
            <div className="card">
              <div className="card-head plain" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 className="card-title neutral" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: tg == null ? 'var(--fg-3)' : tg.connected ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
                  Telegram · SF Trades
                </h3>
                <span className="faint" style={{ fontSize: '0.68rem' }}>
                  {tg?.last_poll ? `${Math.round((Date.now() - new Date(tg.last_poll).getTime()) / 60000)}m ago` : 'no heartbeat'}
                </span>
              </div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 100 }}>
                {tg == null && <div className="desk-empty">Loading…</div>}
                {tg != null && !tg.has_session && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--red)' }}>
                    Not authenticated. Run:<br />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--fg-3)', wordBreak: 'break-all' }}>
                      /api/telegram/auth?secret=tradebot-cron-2026-secure&phone=+1XXXXXXXXXX
                    </span>
                  </div>
                )}
                {tg != null && tg.has_session && !tg.connected && (() => {
                  const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
                  const h = parseInt(etHour)
                  const isAfterHours = h >= 18 || h < 9
                  if (isAfterHours) return (
                    <div style={{ fontSize: '0.75rem', color: 'var(--fg-3)', background: 'var(--bg-3)', borderRadius: 6, padding: '6px 10px' }}>
                      🌙 Market closed — poller resumes 9 AM ET
                      <br /><span className="faint" style={{ fontSize: '0.65rem' }}>Last active: {tg.last_poll ? new Date(tg.last_poll).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET' : '—'}</span>
                    </div>
                  )
                  return (
                    <div style={{ fontSize: '0.75rem', color: '#f5a623', background: 'rgba(245,166,35,0.08)', borderRadius: 6, padding: '6px 10px' }}>
                      {tg.tg_status?.startsWith('error:')
                        ? <>Poller error: <b>{tg.tg_status.replace('error:', '')}</b></>
                        : <>Poller silent — {tg.minutes_silent ?? '?'}min since last poll</>}
                      <br /><span className="faint" style={{ fontSize: '0.65rem' }}>Vercel cron may be down · check Vercel dashboard</span>
                    </div>
                  )
                })()}
                {tg != null && tg.signals.length === 0 && tg.connected && (
                  <div className="desk-empty">No signals yet — watching channel.</div>
                )}
                {(tg?.signals ?? []).slice(0, 6).map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.72rem' }}>
                    <span className={`chip ${s.type === 'BUY' ? 'up' : s.type === 'SELL' ? 'down' : 'mut'}`} style={{ fontSize: '0.6rem', flexShrink: 0 }}>{s.type}</span>
                    {s.symbol && <b style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>{s.symbol}</b>}
                    <span className="faint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message.replace(/^\[.*?\]\s*/, '').slice(0, 60)}</span>
                    <span className="faint" style={{ flexShrink: 0 }}>{hhmmss(s.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* AI signal queue */}
            <div className="card">
              <div className="card-head blue"><h3 className="card-title blue">🤖 AI Signal Queue</h3><span className="chip blue">{profile.min_confidence}%+ to fire</span></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {signals.length === 0 ? <div className="desk-empty">No live signals — scanning {profile.scan_universe} universe.</div>
                  : signals.map((t) => (
                    <div key={t.id} className="sig">
                      <div className="spread"><span><b className="tabular" style={{ color: 'var(--blue)' }}>{t.symbol}</b> <span className="chip up" style={{ fontSize: '0.6rem', marginLeft: 6 }}>{t.action}</span></span><span className="tabular" style={{ fontSize: '0.76rem' }}>{t.confidence}%</span></div>
                      <div className="sigbar"><div className="sigfill" style={{ width: `${t.confidence}%` }} /></div>
                      <span className="faint" style={{ fontSize: '0.66rem' }}>{t.strategy}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
