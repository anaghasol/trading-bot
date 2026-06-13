'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'


export default function SettingsPage() {
  const searchParams = useSearchParams()
  const schwabStatus = searchParams.get('schwab')

  const [balance, setBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [closing, setClosing] = useState(false)
  const [scanResult, setScanResult] = useState<string>('')
  const [maxPos, setMaxPos] = useState<string | null>(null)
  const [maxPosSaving, setMaxPosSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings?key=schwab_max_pos')
      .then(r => r.json())
      .then(d => setMaxPos(d.value || null))
      .catch(() => {})
  }, [])

  async function saveMaxPos(val: string) {
    setMaxPosSaving(true)
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'schwab_max_pos', value: val }) })
    setMaxPos(val)
    setMaxPosSaving(false)
  }

  async function clearMaxPos() {
    setMaxPosSaving(true)
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'schwab_max_pos', value: '' }) })
    setMaxPos(null)
    setMaxPosSaving(false)
  }

  async function testBalance() {
    setBalanceLoading(true)
    const res = await fetch('/api/schwab/balance')
    const data = await res.json()
    setBalance(data.balance)
    setBalanceLoading(false)
  }

  const cronHeaders = {
    'Authorization': 'Bearer tradebot-cron-2026-secure',
  }

  async function triggerScan() {
    setScanning(true)
    setScanResult('')
    const res = await fetch('/api/cron/scan', { headers: cronHeaders })
    const data = await res.json()
    setScanResult(JSON.stringify(data, null, 2))
    setScanning(false)
  }

  async function triggerMonitor() {
    setMonitoring(true)
    setScanResult('')
    const res = await fetch('/api/cron/monitor', { headers: cronHeaders })
    const data = await res.json()
    setScanResult(JSON.stringify(data, null, 2))
    setMonitoring(false)
  }

  async function triggerClose() {
    setClosing(true)
    setScanResult('')
    const res = await fetch('/api/cron/close', { headers: cronHeaders })
    const data = await res.json()
    setScanResult(JSON.stringify(data, null, 2))
    setClosing(false)
  }

  function connectSchwab() {
    window.location.href = `/api/schwab/auth`
  }

  return (
    <>
    
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 22px 40px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontWeight: 700, fontSize: '1.5rem', color: 'var(--fg-1)', margin: '0 0 4px' }}>Settings</h1>
        <p style={{ color: 'var(--fg-2)', margin: 0, fontSize: '0.9rem' }}>Configure Schwab connection, test cron jobs, manage bot</p>
      </div>

      {/* Schwab Connection */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3 className="card-title">Schwab API Connection</h3></div>
        <div className="card-body">
          {schwabStatus === 'connected' && (
            <div style={{ background: 'var(--green-dim)', border: '1px solid var(--green)', borderRadius: 'var(--r-md)', padding: '10px 14px', marginBottom: 16, color: 'var(--green)', fontSize: '0.9rem' }}>
              ✓ Schwab authorized successfully! Tokens saved to Supabase.
            </div>
          )}
          {schwabStatus === 'error' && (
            <div style={{ background: 'var(--red-dim)', border: '1px solid var(--red)', borderRadius: 'var(--r-md)', padding: '10px 14px', marginBottom: 16, color: 'var(--red)', fontSize: '0.9rem' }}>
              ✗ Schwab authorization failed. Please try again.
            </div>
          )}

          <p style={{ color: 'var(--fg-2)', fontSize: '0.9rem', margin: '0 0 16px' }}>
            Tokens are stored securely in Supabase and auto-refreshed. Re-authorize only if the refresh token expires (~7 days of inactivity).
          </p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={testBalance} disabled={balanceLoading} className="btn green">
              {balanceLoading ? '…' : '✓ Test Connection'}
            </button>
            <button onClick={connectSchwab} className="btn blue">
              ↻ Re-authorize Schwab
            </button>
          </div>

          {balance !== null && (
            <div style={{ marginTop: 14, fontFamily: 'var(--font-mono)', fontSize: '1.1rem', color: 'var(--green)' }}>
              Account Balance: ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
          )}
        </div>
      </div>

      {/* Manual Cron Triggers */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3 className="card-title">Manual Engine Triggers</h3></div>
        <div className="card-body">
          <p style={{ color: 'var(--fg-2)', fontSize: '0.9rem', margin: '0 0 16px' }}>
            These run the same logic as the Vercel cron jobs. Use to test or trigger manually outside market hours.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <button onClick={triggerScan} disabled={scanning} className="btn green">
              {scanning ? '…' : '▶ Run Market Scan'}
            </button>
            <button onClick={triggerMonitor} disabled={monitoring} className="btn blue">
              {monitoring ? '…' : '⚡ Monitor Positions'}
            </button>
            <button onClick={triggerClose} disabled={closing} className="btn red">
              {closing ? '…' : '✕ EOD Close All'}
            </button>
          </div>

          {scanResult && (
            <div className="log-viewer" style={{ maxHeight: 280 }}>
              <pre style={{ margin: 0, color: 'var(--green)', fontSize: '0.8rem' }}>{scanResult}</pre>
            </div>
          )}
        </div>
      </div>

      {/* Live Trading Controls */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3 className="card-title">Live Trading Controls</h3></div>
        <div className="card-body">
          <p style={{ color: 'var(--fg-2)', fontSize: '0.88rem', margin: '0 0 16px' }}>
            For a cautious first-week start, cap the number of simultaneous live Schwab positions.
            Set to <b>1</b> or <b>2</b> while verifying everything works. Remove the cap once confident.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.88rem', color: 'var(--fg-2)' }}>Schwab max positions:</span>
            {['1','2','3'].map(v => (
              <button
                key={v}
                onClick={() => saveMaxPos(v)}
                disabled={maxPosSaving}
                className="btn"
                style={{
                  background: maxPos === v ? 'var(--green)' : 'var(--bg-3)',
                  color: maxPos === v ? '#000' : 'var(--fg-2)',
                  border: `1px solid ${maxPos === v ? 'var(--green)' : 'var(--border)'}`,
                  padding: '6px 18px', fontWeight: 600,
                }}
              >{v}</button>
            ))}
            <button
              onClick={clearMaxPos}
              disabled={maxPosSaving || !maxPos}
              className="btn"
              style={{ background: 'transparent', color: 'var(--fg-3)', border: '1px solid var(--border)', padding: '6px 14px' }}
            >Default (profile)</button>
          </div>
          <div style={{ marginTop: 10, fontSize: '0.82rem', color: maxPos ? 'var(--yellow)' : 'var(--fg-3)' }}>
            {maxPos
              ? `Active cap: ${maxPos} position${maxPos === '1' ? '' : 's'} max on Schwab Live`
              : 'No cap — using profile default (3 positions max)'}
          </div>
        </div>
      </div>

      {/* Cron Schedule Info */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3 className="card-title">Vercel Cron Schedule (UTC)</h3></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {[
              { name: 'Market Scan + Entry', schedule: '*/15 13-20 * * 1-5', et: 'Every 15 min, 9:00 AM – 4:00 PM ET' },
              { name: 'Position Monitor', schedule: '*/5 13-21 * * 1-5', et: 'Every 5 min during market hours' },
              { name: 'EOD Close All', schedule: '45 19 * * 1-5', et: '3:45 PM ET (Mon–Fri)' },
            ].map(({ name, schedule, et }) => (
              <div key={name} style={{ background: 'var(--inset)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--fg-1)', marginBottom: 8 }}>{name}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--green)', marginBottom: 6 }}>{schedule}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--fg-3)' }}>{et}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '0.82rem', color: 'var(--fg-3)', margin: '14px 0 0' }}>
            ⚠ Requires Vercel Pro plan for sub-daily cron frequency. Each function checks market hours before executing.
          </p>
        </div>
      </div>

      {/* Environment Variables */}
      <div className="card">
        <div className="card-head"><h3 className="card-title">Required Environment Variables</h3></div>
        <div className="card-body">
          <div className="log-viewer" style={{ maxHeight: 'none' }}>
            {[
              'NEXT_PUBLIC_SUPABASE_URL          # Your Supabase project URL',
              'NEXT_PUBLIC_SUPABASE_ANON_KEY     # Supabase anon key',
              'SUPABASE_SERVICE_ROLE_KEY         # Supabase service role key',
              'SCHWAB_CLIENT_ID                  # From developer.schwab.com',
              'SCHWAB_CLIENT_SECRET              # From developer.schwab.com',
              'SCHWAB_REDIRECT_URI               # https://your-app.vercel.app/api/schwab/callback',
              'SCHWAB_ACCOUNT_ID                 # Your Schwab account number',
              'ANTHROPIC_API_KEY                 # From console.anthropic.com',
              'CRON_SECRET                       # Random 32-char string',
            ].map((line) => (
              <div key={line} className="log-line info">{line}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
