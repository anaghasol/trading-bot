'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { money, signed, pnlColor } from '@/components/ui/kit'
import { PROFILES } from '@/lib/strategy-profiles'

const NAV: [string, string][] = [['/dashboard', 'Desk'], ['/live', '⚡ Live'], ['/growth', 'Growth'], ['/sleeves', 'Sleeves'], ['/portfolio', 'Portfolio'], ['/trades', 'Trades'], ['/learning', 'Learning'], ['/settings', 'Settings']]

type Broker = 'schwab' | 'alpaca_paper'
interface Position { symbol: string; quantity: number; avg_cost: number; current_price: number; market_value: number; unrealized_pnl: number; pnl_pct: number; asset_type?: string; option_expiry?: string }
interface StrategyStats { trades: number; wins: number; win_rate: number; total_pnl: number; avg_pnl: number; profit_factor: number }
interface AuthStatus { ok: boolean; refresh_expires_at: string | null; hours_left: number | null }
interface Summary { account_value: number; cash: number; stock_buying_power: number; option_buying_power: number; day_trade_buying_power: number; day_pnl?: number; day_pnl_pct?: number; daytrade_count?: number; fetched_at?: string; auth_status?: AuthStatus; error?: string; reauth_url?: string }
interface Quote { symbol: string; price: number; change_pct: number }
interface Trade { id: number; symbol: string; action: string; quantity: number; entry_price: number; exit_price?: number; confidence: number; strategy: string; status: string; created_at: string }
interface Alert { id: number; type: string; message: string; created_at: string }
interface TgSignal { id: number; type: string; message: string; symbol?: string; created_at: string }
interface TgStatus { connected: boolean; cron_alive: boolean; has_session: boolean; last_poll: string | null; last_cron_ping: string | null; minutes_silent: number | null; minutes_since_cron_ping: number | null; tg_status: string | null; last_msg_id: number; signals: TgSignal[] }
interface SchwabOrder { order_id: string; symbol: string; instruction: string; quantity: number; filled_quantity: number; price: number; status: string; entered_time: string; asset_type?: string }
interface Dash { account: { balance: number; daily_pnl: number; total_pnl: number } | null; trades: Trade[]; alerts: Alert[]; market_open: boolean }
interface Pdt { day_trades_remaining: number; is_pdt_protected: boolean; balance: number }
interface Cat { key: string; label: string; leader: string; change_5d: number; change_1d: number; rsi: number; score: number; rank: number; temp: 'HOT' | 'WARM' | 'COOL' | 'COLD'; bias: number }

const WATCH = ['NVDA', 'AMD', 'MSFT', 'PLTR', 'TSLA', 'AMZN', 'META', 'COIN']
const UNIVERSE = ['SPY', 'QQQ', 'NVDA', 'AMD', 'MSFT', 'AAPL', 'PLTR', 'TSLA', 'AMZN', 'META', 'GOOGL', 'COIN', 'SOFI', 'NFLX', 'SHOP']
const GOAL = 25000
const DEFAULT_BAL: Record<Broker, number> = { schwab: 2000, alpaca_paper: 100000 }

const p2 = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n ?? 0).toFixed(2) + '%'
const num = (n: number) => Math.abs(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Exit ladder status — derived purely from current pnl_pct (lower bound; actual may be tighter if peak > current)
function ladderStatus(pnl: number): { floor: string; trail: string; color: string } {
  if (pnl >= 20) return { floor: '+12%', trail: '3%', color: '#13c98e' }
  if (pnl >= 10) return { floor: '+5%',  trail: '4%', color: '#10b981' }
  if (pnl >= 6)  return { floor: '+2%',  trail: '4%', color: '#34d399' }
  if (pnl >= 5)  return { floor: 'BE',   trail: '5%', color: '#6ee7b7' }
  if (pnl >= 3)  return { floor: '~0%',  trail: '5%', color: '#94a3b8' }
  if (pnl >= 0)  return { floor: '—',    trail: '—',  color: '#64748b' }
  return             { floor: 'STOP',  trail: '—',  color: '#f87171' }
}
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
  const [fetchedQuote, setFetchedQuote] = useState<{ price: number; change_pct: number } | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const symRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quoteFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const upper = sym.toUpperCase().trim()
  const liveQ = qmap[upper] ?? fetchedQuote ?? null
  const livePrice = liveQ?.price ?? 0

  // Fetch live price for symbols not already in qmap
  useEffect(() => {
    if (quoteFetchRef.current) clearTimeout(quoteFetchRef.current)
    if (!upper || upper.length < 1 || qmap[upper]) { setFetchedQuote(null); setQuoteLoading(false); return }
    setQuoteLoading(true)
    quoteFetchRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/schwab/quotes?symbols=${upper}`)
        const data = await res.json()
        const q = (data.quotes ?? [])[0]
        setFetchedQuote(q ? { price: q.price, change_pct: q.change_pct } : null)
      } catch { setFetchedQuote(null) }
      setQuoteLoading(false)
    }, 400)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upper])

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
        const errMsg: string = data.error ?? 'Order failed'
        // IPO stocks require LIMIT orders — auto-switch and pre-fill price
        if (errMsg.includes('only limit orders')) {
          setOrderType('LIMIT')
          if (livePrice > 0) setLimitPx(livePrice.toFixed(2))
          setStatus('err'); setMsg(`IPO stock — switched to Limit order. Confirm price and retry.`)
        } else {
          setStatus('err'); setMsg(errMsg)
        }
        setTimeout(() => setStatus('idle'), 5000)
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
          {(livePrice > 0 || quoteLoading) && (
            <div style={{ textAlign: 'right', paddingTop: 18 }}>
              {quoteLoading && !livePrice ? (
                <div style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>…</div>
              ) : livePrice > 0 ? (<>
                <div className="tabular" style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--fg-1)' }}>${num(livePrice)}</div>
                <div className="tabular" style={{ fontSize: '0.7rem', color: (liveQ?.change_pct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{p2(liveQ?.change_pct ?? 0)}</div>
              </>) : null}
            </div>
          )}
        </div>

        {/* Live price + total cost bar */}
        {livePrice > 0 && upper && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-2)', borderRadius: 7, padding: '7px 12px', border: '1px solid var(--divider)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{upper}</span>
              <span className="tabular" style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--fg-1)' }}>${num(livePrice)}</span>
              <span className="tabular" style={{ fontSize: '0.72rem', color: (liveQ?.change_pct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{p2(liveQ?.change_pct ?? 0)}</span>
            </div>
            {shares > 0 && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{action === 'BUY' ? 'Total cost' : 'Proceeds'}</div>
                <div className="tabular" style={{ fontWeight: 700, fontSize: '0.95rem', color: canAfford ? (action === 'BUY' ? 'var(--green)' : 'var(--red)') : 'var(--red)' }}>${num(estCost)}</div>
              </div>
            )}
          </div>
        )}

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

        {/* Execute row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
          <div style={{ flex: 1, fontSize: '0.78rem', color: 'var(--fg-3)' }}>
            {mode === 'dollars' && shares > 0 && livePrice > 0 && (
              <span className="faint">{shares} sh</span>
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
  const [posData, setPosData] = useState<{ broker: Broker; items: Position[] }>({ broker: 'schwab', items: [] })
  const [summaryData, setSummaryData] = useState<{ broker: Broker; data: Summary | null }>({ broker: 'schwab', data: null })
  const pos     = posData.broker     === broker ? posData.items    : []
  const summary = summaryData.broker === broker ? summaryData.data : null
  const [qmap, setQmap] = useState<Record<string, Quote>>({})
  const [pdt, setPdt] = useState<Pdt | null>(null)
  const [orders, setOrders] = useState<SchwabOrder[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [tab, setTab] = useState<'working' | 'filled' | 'canceled'>('filled')
  const [stamp, setStamp] = useState('')
  const [alertOn, setAlertOn] = useState(true)
  const [tg, setTg] = useState<TgStatus | null>(null)
  const [lastScan, setLastScan] = useState<{ ts: string; regime: string; vix: number; market: string; spy_above_sma?: boolean; candidates: number; trades: number } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [showRegimeInfo, setShowRegimeInfo] = useState(false)
  const [perfData, setPerfData] = useState<Record<string, StrategyStats> | null>(null)
  type ScItem = { ticker: string; monthly_rsi: number; pct_above_200dma: number; consecutive_green_months: number; listing_age_years: number | null; rs_vs_spy_6m?: number; avg_dollar_vol_m?: number; score: number; discovered?: boolean; scanned_at: string }
  type WlItem = ScItem & { criteria_met: number }
  const [supercycle, setSupercycle] = useState<ScItem[]>([])
  const [scWatchlist, setScWatchlist] = useState<WlItem[]>([])
  const [streamActive, setStreamActive] = useState(false)
  const esRef = useRef<EventSource | null>(null)
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
    if (p.status === 'fulfilled') setPosData({ broker: b, items: Array.isArray(p.value) ? p.value : (p.value?.positions ?? []) })
    // Accept response even with auth_status warning — only reject hard errors
    if (s.status === 'fulfilled' && s.value && s.value.error !== 'schwab_auth_expired') setSummaryData({ broker: b, data: s.value })
    else if (s.status === 'fulfilled' && s.value?.error === 'schwab_auth_expired') setSummaryData({ broker: b, data: s.value as unknown as Summary })
    if (q.status === 'fulfilled') { const m: Record<string, Quote> = {}; for (const x of (q.value?.quotes ?? [])) m[x.symbol] = x; setQmap(m) }
    if (h.status === 'fulfilled' && h.value?.pdt) setPdt(h.value.pdt)
    if (o.status === 'fulfilled' && o.value?.orders) setOrders(o.value.orders)
    else setOrders([])
    if (r.status === 'fulfilled' && r.value?.categories) setCats(r.value.categories)
    setStamp(new Date().toLocaleTimeString('en-US', { hour12: false }))
    // Telegram status (broker-agnostic — same Railway service for both)
    fetch('/api/telegram/status').then(r => r.json()).then(setTg).catch(() => {})
    // Last scan snapshot for the health bar (cheap Supabase read)
    fetch(`/api/settings?key=last_scan_${b}`).then(r => r.json()).then(({ value }) => {
      try { if (value) setLastScan(JSON.parse(value)) } catch { /* ignore */ }
    }).catch(() => {})
    // Strategy ranking — lazy, non-blocking
    fetch(`/api/performance?broker=${b}&days=30`).then(r => r.json()).then(d => {
      if (d?.by_strategy) setPerfData(d.by_strategy as Record<string, StrategyStats>)
    }).catch(() => {})
    // Supercycle radar — weekly screener results, broker-agnostic
    fetch('/api/supercycle').then(r => r.json()).then(d => {
      if (Array.isArray(d?.candidates)) setSupercycle(d.candidates)
      if (Array.isArray(d?.watchlist)) setScWatchlist(d.watchlist)
    }).catch(() => {})
  }, [])

  // Clear stale data instantly when broker tab switches — no cross-contamination
  useEffect(() => {
    setPosData({ broker, items: [] })
    setSummaryData({ broker, data: null })
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

  // Live price stream via SSE — 2s cadence, replaces watchlist polling during market hours
  // Alpaca: bulk trades/latest WebSocket-equivalent | Schwab: parallel quote polling server-side
  useEffect(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    setStreamActive(false)

    const seen = new Set<string>()
    const symList: string[] = []
    for (const s of [...pos.map((p) => p.asset_type !== 'OPTION' ? p.symbol : '').filter(Boolean), ...UNIVERSE]) {
      if (!seen.has(s)) { seen.add(s); symList.push(s) }
    }
    const symbols = symList.join(',')

    if (!symbols) return

    const es = new EventSource(`/api/quotes/stream?symbols=${symbols}&broker=${broker}`)
    esRef.current = es

    es.onopen  = () => setStreamActive(true)
    es.onerror = () => setStreamActive(false)

    es.onmessage = (e) => {
      try {
        const prices = JSON.parse(e.data) as Record<string, { price: number; change_pct: number }>
        if (Object.keys(prices).length === 0) return  // ping frame
        setQmap((prev) => {
          const next = { ...prev }
          for (const [sym, q] of Object.entries(prices)) {
            next[sym] = { symbol: sym, price: q.price, change_pct: q.change_pct ?? prev[sym]?.change_pct ?? 0 }
          }
          return next
        })
      } catch { /* ignore malformed frames */ }
    }

    return () => { es.close(); esRef.current = null; setStreamActive(false) }
  }, [broker, pos])

  async function forceScan() {
    if (scanning) return
    if (pos.length >= 3) {
      const ok = window.confirm(`Run AI scan with ${pos.length} positions already open?\nEngine will respect position limits — no over-buying.`)
      if (!ok) return
    }
    setScanning(true)
    try {
      await fetch('/api/scan-now', { method: 'POST' })
    } finally {
      setScanning(false)
      load(broker)
    }
  }

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
  const totLive = pos.reduce((s, p) => { const lp = qmap[p.symbol]?.price ?? p.current_price; return s + lp * Math.abs(p.quantity) * (p.asset_type === 'OPTION' ? 100 : 1) }, 0)
  const totDelta = pos.reduce((s, p) => s + (p.asset_type === 'OPTION' ? 0 : p.quantity), 0)

  // indices + watchlist from quote map
  const idx = (sym: string) => qmap[sym]
  const watch = WATCH.map((s) => qmap[s]).filter(Boolean) as Quote[]
  // Top movers: all universe symbols with ≥1% gain, sorted descending — reuses qmap, no extra fetch
  const movers = Object.values(qmap).filter((q) => q.change_pct >= 1).sort((a, b) => b.change_pct - a.change_pct).slice(0, 6)
  // TG signal map: symbol → signal object, so Top Movers can show actual message in tooltip
  const tgSigMap = new Map((tg?.signals ?? []).filter((s) => s.symbol).map((s) => [s.symbol!, s]))
  const tgSymSet = new Set(tgSigMap.keys())

  // activity rows — both brokers now use the live orders state (from Alpaca or Schwab API)
  // Paper mode previously used tb_trades which missed options fills entirely
  type Row = { time: string; side: string; symbol: string; qty: number; price: number; status: string; isOption?: boolean }
  const rows: Row[] = orders.map((o) => ({
    time:     o.entered_time,
    side:     o.instruction,
    symbol:   o.symbol,
    qty:      o.filled_quantity || o.quantity,
    price:    o.price,
    status:   o.status,
    isOption: o.asset_type === 'OPTION',
  }))
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
        {/* Indices — compact, tooltip for label */}
        {idx('SPY') && <div className="desk-idx" title="S&P 500 · SPY"><span className="tabular" style={{ fontSize: '0.78rem' }}>{num(idx('SPY')!.price)}</span><span className="tabular" style={{ fontSize: '0.68rem', color: pnlColor(idx('SPY')!.change_pct) }}>{p2(idx('SPY')!.change_pct)}</span></div>}
        {idx('QQQ') && <div className="desk-idx" title="Nasdaq · QQQ"><span className="tabular" style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>{num(idx('QQQ')!.price)}</span></div>}
        {/* Market status — icon + short text, no ⏱ */}
        <span className={`countdown ${market.open ? 'open' : ''}`} title={market.txt}>
          {market.open ? <span className="dot live" style={{ background: 'var(--green)' }} /> : null}
          {market.open ? market.txt.split('·')[0].trim() : market.txt.split('·')[0].trim()}
        </span>
        {/* Broker switcher */}
        <div className="seg">
          <button className={`seg-btn ${broker === 'schwab' ? 'on-red' : ''}`} onClick={() => setBroker('schwab')} title="Live · Schwab"><span className="dot" style={{ background: broker === 'schwab' ? 'var(--red)' : 'var(--fg-3)' }} /> Live</button>
          <button className={`seg-btn ${isPaper ? 'on-blue' : ''}`} onClick={() => setBroker('alpaca_paper')} title="Paper · Alpaca"><span className="dot" style={{ background: isPaper ? 'var(--blue)' : 'var(--fg-3)' }} /> Paper</button>
        </div>
        {/* ── System health dots — compact, in header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 4 }} className="sys-dots">
          {(() => {
            const etH = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
            const dayName = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' })
            const isWeekend = dayName === 'Saturday' || dayName === 'Sunday'
            const afterHrs = isWeekend || etH >= 18 || etH < 9
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
        <button className="iconbtn" onClick={() => load(broker)}>
          ↻ {stamp || '—'}
          {streamActive && <span title="Live price stream active" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#13c98e', marginLeft: 5, verticalAlign: 'middle', boxShadow: '0 0 4px #13c98e' }} />}
        </button>
        <button
          className="iconbtn"
          onClick={forceScan}
          disabled={scanning || !market.open}
          title={market.open ? 'Force AI scan now' : 'Market closed'}
          style={{ color: scanning ? 'var(--amber)' : market.open ? 'var(--green)' : 'var(--fg-3)', opacity: market.open ? 1 : 0.5 }}
        >{scanning ? '⏳ Scanning…' : '⚡ Scan'}</button>
      </header>

      {/* ── Connection alert strip — full-width red bar for any broken service ── */}
      {(() => {
        const etH = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
        const dayName = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' })
        const isWeekendDay = dayName === 'Saturday' || dayName === 'Sunday'
        const isOffHours = isWeekendDay || etH >= 18 || etH < 9
        const alerts: { msg: React.ReactNode; key: string }[] = []

        // Schwab token expired
        if (!isPaper && summary?.error === 'schwab_auth_expired') {
          alerts.push({ key: 'sch-exp', msg: <>🔴 <b>Schwab disconnected</b> — token expired. <a href="/api/schwab/auth" style={{ color: '#fff', textDecoration: 'underline', fontWeight: 600 }}>Re-authorize now →</a></> })
        }
        // Schwab token expiring soon (< 24 h)
        if (!isPaper && summary?.auth_status?.ok && (summary.auth_status.hours_left ?? 999) < 24) {
          alerts.push({ key: 'sch-soon', msg: <>🟠 <b>Schwab token expires in {summary.auth_status.hours_left}h</b> — <a href="/api/schwab/auth" style={{ color: '#fff', textDecoration: 'underline' }}>refresh before trading stops →</a></> })
        }
        // TG no session at all
        if (tg != null && !tg.has_session) {
          alerts.push({ key: 'tg-nosess', msg: <>🔴 <b>Telegram disconnected</b> — session missing. Go to Settings → Telegram → Re-authenticate.</> })
        }
        // TG session exists but cron/connection broken during market hours
        if (tg?.has_session && !tg.connected && !isOffHours) {
          const detail = tg.tg_status === 'no_session' ? 'session expired' : tg.tg_status?.startsWith('error:') ? tg.tg_status.replace('error:', '').trim() : `silent ${tg.minutes_since_cron_ping ?? '?'}m`
          alerts.push({ key: 'tg-down', msg: <>🔴 <b>Telegram disconnected</b> — {detail}. Core trading continues but SF Trades signals paused.</> })
        }

        if (alerts.length === 0) return null
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {alerts.map(a => (
              <div key={a.key} style={{
                background: a.key.includes('soon') ? 'rgba(220,120,0,0.92)' : 'rgba(200,30,30,0.92)',
                color: '#fff', fontSize: '0.78rem', fontWeight: 500,
                padding: '9px 18px', lineHeight: 1.4, letterSpacing: 0.1,
              }}>
                {a.msg}
              </div>
            ))}
          </div>
        )
      })()}

      <div className="desk-wrap">
        {/* ════ LEFT RAIL ════ */}
        <div className="desk-col">
          {/* Account */}
          <div className="card">
            <div className="card-head plain"><h3 className="card-title neutral">💼 Account <span className="chip mut" style={{ fontSize: '0.6rem' }}>{isPaper ? 'Alpaca · Paper' : 'Schwab · Individual'}</span></h3><span className="eyebrow">{isPaper ? 'PAPER $' : 'REAL $'}</span></div>
            <div className="card-body">
              {/* Schwab auth expired banner */}
              {!isPaper && summary?.error === 'schwab_auth_expired' && (
                <div style={{ background: 'rgba(245,100,100,0.12)', border: '1px solid var(--red)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: '0.73rem' }}>
                  🔐 <b>Schwab token expired</b> — showing stale data.{' '}
                  <a href="/api/schwab/auth" style={{ color: 'var(--green)', textDecoration: 'underline' }}>Re-authenticate now →</a>
                </div>
              )}
              {/* Warn when refresh token expires within 48h */}
              {!isPaper && summary?.auth_status && summary.auth_status.ok && (summary.auth_status.hours_left ?? 999) < 48 && (
                <div style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid var(--amber)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontSize: '0.7rem' }}>
                  ⚠️ Schwab token expires in <b>{summary.auth_status.hours_left}h</b>.{' '}
                  <a href="/api/schwab/auth" style={{ color: 'var(--green)' }}>Refresh now →</a>
                </div>
              )}
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
              {summary?.fetched_at && (
                <div className="kv" style={{ marginTop: 4 }}>
                  <span className="k faint" style={{ fontSize: '0.6rem' }}>Data as of</span>
                  <span className="v faint" style={{ fontSize: '0.6rem' }}>
                    {new Date(summary.fetched_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })} ET
                  </span>
                </div>
              )}
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

          {/* Top Movers — reuses qmap, no extra fetch, refreshes with poll interval */}
          {movers.length > 0 && (
            <div className="card">
              <div className="card-head plain">
                <h3 className="card-title neutral">🚀 Top Movers</h3>
                <span className="eyebrow">universe · gainers</span>
              </div>
              <div className="card-body" style={{ padding: '6px 14px' }}>
                <div className="wl">
                  {movers.map((q) => {
                    const sig = tgSigMap.get(q.symbol)
                    return (
                    <>
                      <span key={q.symbol + '-s'} className="wl sym" title={sig ? `📡 ${sig.message.slice(0, 120)}` : undefined}>
                        {q.symbol}
                        {sig && (
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block', marginLeft: 4, verticalAlign: 'middle', flexShrink: 0 }} />
                        )}
                      </span>
                      <span key={q.symbol + '-p'} className="wl mk"><Flash value={q.price} fmt={num} /></span>
                      <span key={q.symbol + '-c'} className="wl ch" style={{ color: 'var(--green)' }}>{p2(q.change_pct)}</span>
                    </>
                  )
                  })}
                </div>
                {tgSymSet.size > 0 && <div style={{ fontSize: '0.62rem', color: 'var(--fg-3)', marginTop: 6 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block', marginRight: 4, verticalAlign: 'middle' }} />TG signal confirmed</div>}
              </div>
            </div>
          )}

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

          {/* System health bar — last scan time, regime, VIX, candidates */}
          {lastScan && (() => {
            const scanEt = new Date(lastScan.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
            const scanAgeMin = Math.floor((Date.now() - new Date(lastScan.ts).getTime()) / 60000)
            const stale = scanAgeMin > 20
            const mktColor = lastScan.market === 'GOOD' ? 'var(--green)' : lastScan.market === 'TOUGH' ? 'var(--amber)' : 'var(--red)'
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px', background: 'var(--bg-2)', border: '1px solid var(--divider)', borderRadius: 6, fontSize: '0.7rem', color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                <span style={{ color: stale ? 'var(--amber)' : 'var(--fg-2)' }}>⏱ Last scan: <b style={{ color: stale ? 'var(--amber)' : 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>{scanEt} ET</b>{stale ? ` (${scanAgeMin}m ago)` : ''}</span>
                <span style={{ color: 'var(--divider)' }}>·</span>
                <span style={{ position: 'relative' }}>
                  Regime:{' '}
                  <b
                    style={{ color: mktColor, cursor: 'pointer', borderBottom: `1px dashed ${mktColor}` }}
                    onClick={() => setShowRegimeInfo((v) => !v)}
                    title="Click for explanation"
                  >{lastScan.market} ▾</b>
                  {showRegimeInfo && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, background: 'var(--bg-2)', border: `1px solid ${mktColor}`, borderRadius: 7, padding: '10px 13px', width: 260, fontSize: '0.72rem', color: 'var(--fg-2)', lineHeight: 1.6, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
                      <div style={{ fontWeight: 700, color: mktColor, marginBottom: 5 }}>{lastScan.market} regime</div>
                      {lastScan.market === 'GOOD' && <>VIX {lastScan.vix} <span style={{ color: 'var(--green)' }}>(below 22)</span> · SPY above 200-day SMA · Full positions allowed, base confidence gate.</>}
                      {lastScan.market === 'TOUGH' && <>VIX {lastScan.vix} <span style={{ color: 'var(--amber)' }}>(22–28)</span> · Elevated volatility · Confidence gate raised +5pts, same position limit.</>}
                      {lastScan.market === 'BAD' && (lastScan.spy_above_sma === false
                        ? <>SPY <span style={{ color: 'var(--red)' }}>below 200-day SMA</span> · Downtrend risk · Confidence gate +12pts (floor 65%), max positions capped at 6.</>
                        : <>VIX {lastScan.vix} <span style={{ color: 'var(--red)' }}>(above 28)</span> · High fear · Confidence gate +12pts (floor 65%), max positions capped at 6.</>
                      )}
                      <div style={{ marginTop: 8, color: 'var(--fg-3)', cursor: 'pointer', fontSize: '0.65rem' }} onClick={() => setShowRegimeInfo(false)}>✕ close</div>
                    </div>
                  )}
                </span>
                <span style={{ color: 'var(--divider)' }}>·</span>
                <span title="CBOE Volatility Index — below 22 = calm, 22–28 = elevated, above 28 = fear">VIX <b style={{ fontFamily: 'var(--font-mono)' }}>{lastScan.vix}</b></span>
                <span style={{ color: 'var(--divider)' }}>·</span>
                <span><b style={{ fontFamily: 'var(--font-mono)', color: lastScan.candidates > 0 ? 'var(--green)' : 'var(--fg-2)' }}>{lastScan.candidates}</b> candidates · <b style={{ fontFamily: 'var(--font-mono)' }}>{lastScan.trades}</b> trades this tick</span>
                <span style={{ color: 'var(--divider)' }}>·</span>
                <span><b style={{ fontFamily: 'var(--font-mono)' }}>{pos.length}</b> open · Day <b style={{ fontFamily: 'var(--font-mono)', color: pnlColor(dayPnl) }}>{p2(dayPct)}</b></span>
              </div>
            )
          })()}

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
                {isPaper && (
                  <button
                    className="iconbtn"
                    style={{ fontSize: '0.65rem', color: 'var(--amber)' }}
                    title="Fix a wrong entry price using Yahoo Finance historical data at actual buy time"
                    onClick={async () => {
                      const sym = window.prompt('Enter symbol to fix (e.g. SPCX):')?.trim().toUpperCase()
                      if (!sym) return
                      const res = await fetch('/api/alpaca/fix-entry', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ symbol: sym }),
                      })
                      const d = await res.json()
                      if (d.ok) {
                        alert(`✓ ${d.symbol} entry fixed\n\nBuy recorded at: ${new Date(d.buy_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\nYahoo price at that time: $${d.new_price.toFixed(2)}\n\nOld entry: $${d.old_price.toFixed(2)}\nNew entry: $${d.new_price.toFixed(2)}`)
                        load(broker)
                      } else {
                        alert(`Could not fix ${sym}:\n${d.error}\n\nBuy time: ${d.buy_time ? new Date(d.buy_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'unknown'}`)
                      }
                    }}
                  >⚙ Fix Entry</button>
                )}
                <span className="eyebrow" title="Sum of all open position market values (gross, before margin)">Long value</span>
                <span className="tabular" style={{ fontWeight: 700 }}>{money(netLiq)}</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="ptbl" style={{ minWidth: 760 }}>
                <colgroup>
                  <col style={{ minWidth: 110 }} />{/* Symbol */}
                  <col style={{ minWidth: 50 }} /> {/* Qty */}
                  <col style={{ minWidth: 88 }} /> {/* Entry/sh */}
                  <col style={{ minWidth: 100 }} />{/* Live */}
                  <col style={{ minWidth: 90 }} /> {/* P/L Day */}
                  <col style={{ minWidth: 90 }} /> {/* P/L Open */}
                  <col style={{ minWidth: 70 }} /> {/* P/L % */}
                  <col style={{ minWidth: 80 }} /> {/* Trail */}
                  <col style={{ minWidth: 90 }} /> {/* Mkt Value */}
                  <col style={{ minWidth: 80 }} /> {/* Action */}
                </colgroup>
                <thead>
                  <tr>
                    <th className="l">Symbol</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Entry/sh</th>
                    <th style={{ textAlign: 'right' }}>Live Price</th>
                    <th style={{ textAlign: 'right' }}>P/L Day</th>
                    <th style={{ textAlign: 'right' }}>P/L Open</th>
                    <th style={{ textAlign: 'right' }}>P/L %</th>
                    <th style={{ textAlign: 'right' }}>Trail</th>
                    <th style={{ textAlign: 'right' }}>Mkt Value</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pos.length === 0
                    ? <tr><td colSpan={10}><div className="desk-empty">No open positions — engine waiting for a {profile.min_confidence}%+ signal.</div></td></tr>
                    : pos.map((p, i) => {
                        const opt = p.asset_type === 'OPTION'
                        const day = dayChangeOf(p)
                        const cost = p.avg_cost * p.quantity * (opt ? 100 : 1)
                        const dayPnlPct = p.avg_cost > 0 && day != null ? (day / cost) * 100 : null
                        // Prefer qmap live price (7s refresh) over broker snapshot
                        const liveQ = qmap[p.symbol]
                        const livePrice = liveQ?.price ?? p.current_price
                        const liveChg = liveQ?.change_pct ?? null
                        return (
                          <tr key={p.symbol + i}>
                            <td className="l">
                              <span className="psym">{p.symbol}</span>
                              <span className={`pbadge ${opt ? 'opt' : 'eq'}`}>{opt ? 'OPT' : 'EQ'}</span>
                            </td>
                            <td style={{ textAlign: 'right' }}>{p.quantity > 0 ? '+' : ''}{p.quantity}</td>
                            {/* Entry price per share — what we paid */}
                            <td style={{ textAlign: 'right', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>${num(p.avg_cost)}</td>
                            {/* Live price per share — Flash on change, day % in muted sub */}
                            <td style={{ textAlign: 'right' }}>
                              <Flash value={livePrice} fmt={(n) => '$' + num(n)} />
                              {liveChg != null && (
                                <span style={{ fontSize: '0.65rem', marginLeft: 5, color: pnlColor(liveChg) }}>{p2(liveChg)}</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right', color: day == null ? 'var(--fg-3)' : pnlColor(day) }}>
                              {day == null ? '—' : signed(day)}
                              {dayPnlPct != null && <span style={{ fontSize: '0.68rem', marginLeft: 4, opacity: 0.7 }}>{p2(dayPnlPct)}</span>}
                            </td>
                            <td style={{ textAlign: 'right', color: pnlColor(p.unrealized_pnl) }}>{signed(p.unrealized_pnl)}</td>
                            <td style={{ textAlign: 'right' }}>
                              <span style={{ color: pnlColor(p.pnl_pct), fontWeight: 600 }}>{p2(p.pnl_pct)}</span>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {p.asset_type === 'OPTION' ? (() => {
                                const dte = p.option_expiry
                                  ? Math.round((new Date(p.option_expiry + 'T16:00:00').getTime() - Date.now()) / 86_400_000)
                                  : null
                                const dteColor = dte == null ? 'var(--fg-3)' : dte > 14 ? '#13c98e' : dte > 7 ? '#fbbf24' : '#f87171'
                                return (
                                // Options: show profit target (50%) + DTE with color-coding
                                <div style={{ lineHeight: 1.25, cursor: 'default' }}
                                     title={`Target: 50% profit (close at $${(p.avg_cost * 0.5).toFixed(2)} premium) or ≤7 DTE${dte != null ? ` · ${dte}d to expiry` : ''}`}>
                                  <span style={{ color: p.pnl_pct >= 50 ? '#13c98e' : p.pnl_pct < 0 ? '#f87171' : '#fbbf24', fontWeight: 600, fontSize: '0.72rem' }}>
                                    {p.pnl_pct >= 50 ? '✅ target' : p.pnl_pct < 0 ? '▼ debit' : '⏳ hold'}
                                  </span>
                                  <span style={{ color: dteColor, fontSize: '0.65rem', display: 'block' }}>
                                    {dte != null ? `${dte}d DTE` : '50% exit'}
                                  </span>
                                </div>
                                )
                              })()
                               : (() => {
                                const { floor, trail, color } = ladderStatus(p.pnl_pct)
                                const tip = trail === '—'
                                  ? 'Below +3% — initial stop protecting downside'
                                  : `${trail} trailing stop active — floor locked at ${floor} of entry`
                                return (
                                  <div style={{ lineHeight: 1.25, cursor: 'default' }} title={tip}>
                                    <span style={{ color, fontWeight: 600, fontSize: '0.72rem' }}>🔒{floor}</span>
                                    {trail !== '—' && <span style={{ color: 'var(--fg-3)', fontSize: '0.65rem', display: 'block' }}>{trail} trail</span>}
                                  </div>
                                )
                              })()}
                            </td>
                            <td style={{ textAlign: 'right' }}>{money(p.market_value)}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="closex" onClick={() => {
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
                      <td style={{ textAlign: 'right', color: 'var(--fg-3)', fontSize: '0.72rem' }}>{money(totCost)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--fg-2)', fontSize: '0.72rem' }}>{money(totLive)}</td>
                      <td style={{ textAlign: 'right', color: pnlColor(totDay) }}>{signed(totDay)}</td>
                      <td style={{ textAlign: 'right', color: pnlColor(unreal) }}>{signed(unreal)}</td>
                      <td style={{ textAlign: 'right' }}><span style={{ color: pnlColor(totLive - totCost), fontWeight: 600 }}>{p2(totCost > 0 ? ((totLive - totCost) / totCost) * 100 : 0)}</span></td>
                      <td>—</td>
                      <td>—</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
              {/* Exposure split — only visible when options positions exist */}
              {pos.some(p => p.asset_type === 'OPTION') && (() => {
                const eqVal  = pos.filter(p => p.asset_type !== 'OPTION').reduce((s, p) => s + p.market_value, 0)
                const optVal = pos.filter(p => p.asset_type === 'OPTION').reduce((s, p) => s + Math.abs(p.market_value), 0)
                const total  = eqVal + optVal
                const eqPct  = total > 0 ? (eqVal / total) * 100 : 100
                const optPct = total > 0 ? (optVal / total) * 100 : 0
                return (
                  <div title={`Total risk exposure — Equity: ${eqPct.toFixed(0)}% | Options: ${optPct.toFixed(0)}% (max 15% recommended for options)`}
                       style={{ display: 'flex', gap: 16, paddingTop: 10, paddingBottom: 2, fontSize: '0.72rem', color: 'var(--fg-3)', alignItems: 'center', cursor: 'default' }}>
                    <span style={{ fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: '0.65rem' }}>Exposure</span>
                    <span>Equity <strong style={{ color: '#13c98e' }}>{eqPct.toFixed(0)}%</strong></span>
                    <span>Options <strong style={{ color: optPct > 15 ? '#f87171' : '#fbbf24' }}>{optPct.toFixed(0)}%</strong>{optPct > 15 && <span style={{ color: '#f87171', fontSize: '0.65rem', marginLeft: 3 }}>⚠ cap</span>}</span>
                    <div style={{ flex: 1, height: 4, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden', maxWidth: 120 }}>
                      <div style={{ width: `${eqPct}%`, height: '100%', background: '#13c98e', display: 'inline-block' }} />
                      <div style={{ width: `${optPct}%`, height: '100%', background: optPct > 15 ? '#f87171' : '#fbbf24', display: 'inline-block' }} />
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>

          {/* Strategy performance ranking — lazy-loaded, shown when data is available */}
          {perfData && Object.keys(perfData).length > 0 && (() => {
            const sorted = Object.entries(perfData)
              .filter(([, v]) => v.trades >= 2)
              .sort((a, b) => b[1].profit_factor - a[1].profit_factor)
              .slice(0, 6)
            if (sorted.length === 0) return null
            return (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-head plain">
                  <span className="eyebrow">Strategy Ranking</span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--fg-3)' }}>Last 30 days · sorted by profit factor</span>
                </div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  <table className="ptbl" style={{ width: '100%', fontSize: '0.72rem' }}>
                    <thead>
                      <tr>
                        <th className="l" style={{ width: 140 }}>Strategy</th>
                        <th style={{ textAlign: 'right' }}>Trades</th>
                        <th style={{ textAlign: 'right' }}>Win %</th>
                        <th style={{ textAlign: 'right' }}>Avg P/L</th>
                        <th style={{ textAlign: 'right' }}>Total P/L</th>
                        <th style={{ textAlign: 'right' }}>PF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(([key, v], i) => (
                        <tr key={key}>
                          <td className="l">
                            <span style={{ display: 'inline-block', width: 16, textAlign: 'center', marginRight: 6, color: i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : 'var(--fg-3)', fontWeight: 700 }}>
                              {i === 0 ? '★' : i === 1 ? '▲' : `${i + 1}`}
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.69rem', color: 'var(--fg-2)' }}>{key}</span>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{v.trades}</td>
                          <td style={{ textAlign: 'right', color: v.win_rate >= 60 ? '#13c98e' : v.win_rate >= 45 ? '#fbbf24' : '#f87171' }}>{v.win_rate.toFixed(0)}%</td>
                          <td style={{ textAlign: 'right', color: pnlColor(v.avg_pnl) }}>{v.avg_pnl >= 0 ? '+' : ''}${v.avg_pnl.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', color: pnlColor(v.total_pnl), fontWeight: 600 }}>{v.total_pnl >= 0 ? '+' : ''}${v.total_pnl.toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ color: v.profit_factor >= 1.5 ? '#13c98e' : v.profit_factor >= 1 ? '#fbbf24' : '#f87171', fontWeight: 600 }}>
                              {v.profit_factor >= 999 ? '∞' : v.profit_factor.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          {/* 🚀 Supercycle Radar — weekly screener for SNDK-style narrative momentum stocks */}
          {supercycle.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head plain">
                <h3 className="card-title neutral">🚀 Supercycle Radar</h3>
                <span style={{ fontSize: '0.65rem', color: 'var(--fg-3)' }}>
                  Monthly RSI ≥ 80 · +100% above 200MA · 4+ green months · scored weekly
                  {supercycle[0]?.scanned_at && (
                    <> · scanned {new Date(supercycle[0].scanned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>
                  )}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="ptbl" style={{ minWidth: 760, fontSize: '0.72rem' }}>
                  <thead>
                    <tr>
                      <th className="l">Ticker</th>
                      <th style={{ textAlign: 'right' }}>Mo RSI</th>
                      <th style={{ textAlign: 'right' }}>vs 200MA</th>
                      <th style={{ textAlign: 'right' }}>Green</th>
                      <th style={{ textAlign: 'right' }}>RS/SPY 6m</th>
                      <th style={{ textAlign: 'right' }}>Vol $M</th>
                      <th style={{ textAlign: 'right' }}>Age</th>
                      <th style={{ textAlign: 'right' }}>Score</th>
                      <th style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supercycle.slice(0, 8).map((c, i) => {
                      const rsiColor   = c.monthly_rsi >= 90 ? '#f87171' : c.monthly_rsi >= 85 ? '#fbbf24' : '#13c98e'
                      const rsColor    = (c.rs_vs_spy_6m ?? 1) >= 3 ? '#13c98e' : (c.rs_vs_spy_6m ?? 1) >= 1.5 ? '#fbbf24' : 'var(--fg-3)'
                      const scoreColor = c.score >= 70 ? '#13c98e' : c.score >= 40 ? '#fbbf24' : 'var(--fg-2)'
                      const isQueued   = c.score >= 70
                      return (
                        <tr key={c.ticker}>
                          <td className="l">
                            <span className="psym">{c.ticker}</span>
                            {c.discovered && <span className="pbadge" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', marginLeft: 4 }}>NEW</span>}
                            {i === 0 && !c.discovered && <span className="pbadge" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', marginLeft: 4 }}>TOP</span>}
                            {isQueued && <span className="pbadge" style={{ background: 'rgba(19,201,142,0.12)', color: '#13c98e', marginLeft: 4 }}>+10</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ color: rsiColor, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{c.monthly_rsi?.toFixed(1)}</span>
                          </td>
                          <td style={{ textAlign: 'right', color: '#13c98e', fontFamily: 'var(--font-mono)' }}>
                            +{c.pct_above_200dma?.toFixed(0)}%
                          </td>
                          <td style={{ textAlign: 'right', color: c.consecutive_green_months >= 6 ? '#13c98e' : 'var(--fg-2)' }}>
                            {c.consecutive_green_months}mo
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ color: rsColor, fontFamily: 'var(--font-mono)' }}>
                              {c.rs_vs_spy_6m != null ? `${c.rs_vs_spy_6m.toFixed(1)}×` : '—'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                            {c.avg_dollar_vol_m != null ? `$${c.avg_dollar_vol_m.toFixed(0)}M` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: (c.listing_age_years ?? 99) <= 3 ? '#fbbf24' : 'var(--fg-3)' }}>
                            {c.listing_age_years != null ? `${c.listing_age_years.toFixed(1)}y` : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ color: scoreColor, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{c.score}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="closex" style={{ background: 'var(--blue-faint)', color: 'var(--blue)', borderColor: 'var(--blue)' }}
                              onClick={() => {
                                const el = document.querySelector<HTMLInputElement>('input[placeholder*="NVDA"]')
                                if (el) { el.value = c.ticker; el.dispatchEvent(new Event('input', { bubbles: true })) }
                              }}>
                              Trade
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: '0.65rem', color: 'var(--fg-3)', padding: '6px 14px 8px' }}>
                  ⚠ Discovery tool — validate with AI scan before trading. RSI 99 is a sell signal; the edge is 80–85 (early entry).
                  {supercycle.some(c => c.discovered) && <> <span style={{ color: '#a78bfa' }}>NEW</span> = found via Alpaca news spin-off scan, not in base universe.</>}
                  {supercycle.some(c => c.score >= 70) && (
                    <> <span style={{ color: '#13c98e' }}>+10</span> = auto-queued for next scan.</>
                  )}
                </div>

                {/* Early Watch — approaching full criteria */}
                {scWatchlist.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
                    <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--fg-2)', letterSpacing: '0.05em' }}>
                        👀 EARLY WATCH
                      </span>
                      <span style={{ fontSize: '0.63rem', color: 'var(--fg-3)' }}>
                        approaching full criteria — auto-promoted when all 4 gates pass
                      </span>
                    </div>
                    <table className="ptbl" style={{ minWidth: 720, fontSize: '0.70rem' }}>
                      <thead>
                        <tr>
                          <th className="l">Ticker</th>
                          <th style={{ textAlign: 'right' }}>Mo RSI</th>
                          <th style={{ textAlign: 'right' }}>vs 200MA</th>
                          <th style={{ textAlign: 'right' }}>Green</th>
                          <th style={{ textAlign: 'right' }}>RS/SPY 6m</th>
                          <th style={{ textAlign: 'right' }}>Vol $M</th>
                          <th style={{ textAlign: 'right' }}>Gates</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scWatchlist.slice(0, 10).map(w => {
                          const gateColor = w.criteria_met >= 3 ? '#13c98e' : w.criteria_met >= 2 ? '#fbbf24' : 'var(--fg-3)'
                          return (
                            <tr key={w.ticker} style={{ opacity: 0.72 }}>
                              <td className="l">
                                <span className="psym">{w.ticker}</span>
                                {w.discovered && (
                                  <span className="pbadge" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', marginLeft: 4 }}>NEW</span>
                                )}
                                <span className="pbadge" style={{ background: 'rgba(251,191,36,0.10)', color: '#fbbf24', marginLeft: 4 }}>WATCH</span>
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>
                                {w.monthly_rsi?.toFixed(1)}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>
                                +{w.pct_above_200dma?.toFixed(0)}%
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--fg-2)' }}>
                                {w.consecutive_green_months}mo
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>
                                {w.rs_vs_spy_6m != null ? `${w.rs_vs_spy_6m.toFixed(1)}×` : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>
                                {w.avg_dollar_vol_m != null ? `$${w.avg_dollar_vol_m.toFixed(0)}M` : '—'}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span style={{ color: gateColor, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                  {w.criteria_met}/4
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <div style={{ fontSize: '0.63rem', color: 'var(--fg-3)', padding: '4px 14px 10px' }}>
                      <span style={{ color: '#13c98e' }}>3/4</span> = near promotion · <span style={{ color: '#fbbf24' }}>2/4</span> = watching · updated weekly
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

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
                          <td className="l"><span className={`chip ${/SELL|STC|SPREAD/i.test(o.side) ? 'down' : 'up'}`} style={{ fontSize: '0.62rem' }}>{o.side}</span></td>
                          <td className="l">
                            <span className="psym" style={{ fontSize: o.isOption ? '0.67rem' : undefined }}>{o.symbol}</span>
                            {o.isOption && <span className="pbadge opt" style={{ marginLeft: 4 }}>OPT</span>}
                          </td>
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
                  const cronPingAge = tg.last_cron_ping ? Math.round((Date.now() - new Date(tg.last_cron_ping).getTime()) / 60000) : null
                  return (
                    <div style={{ fontSize: '0.75rem', color: '#f5a623', background: 'rgba(245,166,35,0.08)', borderRadius: 6, padding: '6px 10px' }}>
                      {tg.tg_status === 'no_session'
                        ? <>Session expired — re-authenticate via <code>/api/telegram/auth</code></>
                        : tg.tg_status?.startsWith('error:')
                          ? <>Poller error: <b>{tg.tg_status.replace('error:', '').trim()}</b></>
                          : tg.cron_alive
                            ? <>Cron running — TG connect failing · check logs</>
                            : <>Cron silent — {cronPingAge != null ? `${cronPingAge}m since last ping` : 'never reached'}</>}
                      <br /><span className="faint" style={{ fontSize: '0.65rem' }}>
                        {tg.cron_alive ? `Cron alive · TG unreachable` : `Vercel cron may be down — core trading engine unaffected`}
                      </span>
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
