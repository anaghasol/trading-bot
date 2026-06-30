'use client'

import { useEffect, useState } from 'react'

type Step = 'phone' | 'code' | 'done' | 'error'

export default function TgConnectPage() {
  const [step,    setStep]    = useState<Step>('phone')
  const [phone,   setPhone]   = useState('+1')
  const [code,    setCode]    = useState('')
  const [secret,  setSecret]  = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [status,  setStatus]  = useState<{ connected: boolean; tg_status: string | null; relay_minutes_ago: number | null } | null>(null)

  useEffect(() => {
    // Pre-fill secret from URL if provided
    const p = new URLSearchParams(window.location.search)
    if (p.get('secret')) setSecret(p.get('secret')!)
    // Load current TG status
    fetch('/api/telegram/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  async function sendCode() {
    if (!secret || !phone.match(/^\+\d{7,15}$/)) {
      setMessage('Enter a valid phone number (e.g. +15125551234) and your CRON_SECRET.')
      return
    }
    setLoading(true)
    setMessage('')
    try {
      const res  = await fetch(`/api/telegram/auth?secret=${encodeURIComponent(secret)}&phone=${encodeURIComponent(phone)}`)
      const data = await res.json() as { ok?: boolean; error?: string; msg?: string }
      if (data.ok) {
        setMessage('Code sent! Check your Telegram app.')
        setStep('code')
      } else {
        setMessage(`Error: ${data.error ?? 'Unknown error'}`)
        setStep('error')
      }
    } catch (e) {
      setMessage(`Network error: ${String(e)}`)
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode() {
    if (!code.match(/^\d{5,6}$/)) {
      setMessage('Enter the 5-6 digit code from your Telegram app.')
      return
    }
    setLoading(true)
    setMessage('')
    try {
      const res  = await fetch(`/api/telegram/auth?secret=${encodeURIComponent(secret)}&phone=${encodeURIComponent(phone)}&code=${code}`)
      const data = await res.json() as { ok?: boolean; error?: string; msg?: string }
      if (data.ok) {
        setMessage('✅ Connected! The relay will be active within 60 seconds.')
        setStep('done')
        fetch('/api/telegram/status').then(r => r.json()).then(setStatus).catch(() => {})
      } else if (data.error?.includes('2FA') || data.error?.includes('SESSION_PASSWORD')) {
        setMessage('2FA enabled — add your Telegram password in the box below and press Verify again.')
      } else {
        setMessage(`Error: ${data.error ?? 'Unknown error'} — try requesting a new code.`)
        setStep('error')
      }
    } catch (e) {
      setMessage(`Network error: ${String(e)}`)
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  const connColor = status == null ? '#888' : status.connected ? '#13c98e' : '#f87171'
  const connLabel = status == null ? 'Loading…' : status.connected ? 'Connected ✓' : `Disconnected — ${status.tg_status ?? 'unknown'}`

  return (
    <div style={{ minHeight: '100vh', background: '#0b0f17', color: '#e2e8f0', fontFamily: 'IBM Plex Sans, sans-serif', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '60px 16px' }}>
      <div style={{ width: '100%', maxWidth: 480 }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <a href="/dashboard" style={{ color: '#64748b', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to Dashboard</a>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: '12px 0 4px', color: '#f1f5f9' }}>📡 Telegram Relay Connect</h1>
          <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0 }}>Authenticate your Telegram account to restore the US Equities → SF Trades Relay pipeline.</p>
        </div>

        {/* Current status */}
        <div style={{ background: '#13182a', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: connColor, flexShrink: 0, display: 'inline-block' }} />
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: connColor }}>{connLabel}</div>
            {status?.relay_minutes_ago != null && (
              <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 2 }}>Last relay: {status.relay_minutes_ago}m ago</div>
            )}
          </div>
        </div>

        {/* Form */}
        {step !== 'done' && (
          <div style={{ background: '#13182a', border: '1px solid #1e293b', borderRadius: 10, padding: '20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* CRON_SECRET */}
            <div>
              <label style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginBottom: 6 }}>CRON_SECRET (from Vercel env)</label>
              <input
                type="password"
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder="your-cron-secret"
                style={{ width: '100%', background: '#0b0f17', border: '1px solid #2d3748', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: '0.82rem', boxSizing: 'border-box' }}
              />
            </div>

            {/* Phone number */}
            {step === 'phone' && (
              <div>
                <label style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginBottom: 6 }}>Phone number (with country code)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+15125551234"
                  style={{ width: '100%', background: '#0b0f17', border: '1px solid #2d3748', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: '0.82rem', boxSizing: 'border-box' }}
                />
              </div>
            )}

            {/* OTP code */}
            {step === 'code' && (
              <div>
                <label style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginBottom: 6 }}>Telegram OTP code (check your TG app)</label>
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="12345"
                  maxLength={6}
                  autoFocus
                  style={{ width: '100%', background: '#0b0f17', border: '1px solid #2d3748', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: '1.2rem', fontFamily: 'IBM Plex Mono, monospace', letterSpacing: 8, boxSizing: 'border-box' }}
                />
              </div>
            )}

            {/* Error retry */}
            {step === 'error' && (
              <button
                onClick={() => { setStep('phone'); setMessage(''); setCode('') }}
                style={{ background: 'transparent', border: '1px solid #4b5563', color: '#94a3b8', borderRadius: 6, padding: '8px', fontSize: '0.8rem', cursor: 'pointer' }}
              >
                ← Start over
              </button>
            )}

            {/* Message */}
            {message && (
              <div style={{ fontSize: '0.78rem', color: step === 'error' ? '#f87171' : '#13c98e', background: step === 'error' ? 'rgba(248,113,113,0.08)' : 'rgba(19,201,142,0.08)', border: `1px solid ${step === 'error' ? '#f87171' : '#13c98e'}`, borderRadius: 6, padding: '8px 10px' }}>
                {message}
              </div>
            )}

            {/* Action button */}
            <button
              onClick={step === 'phone' ? sendCode : verifyCode}
              disabled={loading || step === 'error'}
              style={{ background: loading || step === 'error' ? '#1e293b' : '#13c98e', color: loading || step === 'error' ? '#64748b' : '#0b0f17', border: 'none', borderRadius: 6, padding: '10px 16px', fontSize: '0.85rem', fontWeight: 700, cursor: loading || step === 'error' ? 'default' : 'pointer' }}
            >
              {loading ? 'Please wait…' : step === 'phone' ? 'Send OTP Code →' : 'Verify & Connect →'}
            </button>
          </div>
        )}

        {/* Success */}
        {step === 'done' && (
          <div style={{ background: 'rgba(19,201,142,0.08)', border: '1px solid #13c98e', borderRadius: 10, padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 700, color: '#13c98e', marginBottom: 4 }}>Relay restored</div>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: 16 }}>US Equities → SF Trades Relay will be live within 60 seconds.</div>
            <a href="/dashboard" style={{ background: '#13c98e', color: '#0b0f17', borderRadius: 6, padding: '8px 20px', fontSize: '0.82rem', fontWeight: 700, textDecoration: 'none' }}>Back to Dashboard →</a>
          </div>
        )}

        {/* How it works */}
        <div style={{ marginTop: 28, fontSize: '0.72rem', color: '#475569', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, color: '#64748b', marginBottom: 6 }}>How it works</div>
          <div>1. Your Telegram user account reads the US Equities channel (you must be a member)</div>
          <div>2. Every new message is forwarded to SF Trades Relay group via the myapp bot</div>
          <div>3. The session is stored encrypted in Supabase — Vercel crons use it every minute</div>
          <div>4. If session expires (Telegram security), just reconnect here</div>
        </div>
      </div>
    </div>
  )
}
