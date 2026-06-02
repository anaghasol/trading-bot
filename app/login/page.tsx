'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Lock, Mail, Eye, EyeOff } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')

  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const fn = mode === 'login'
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/api/auth/callback` } })
    const { error: authError } = await fn
    if (authError) setError(authError.message)
    else if (mode === 'login') window.location.href = '/dashboard'
    else setError('Check your email for a confirmation link.')
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)', padding: 16, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '22%', left: '50%', transform: 'translateX(-50%)', width: 640, height: 420, background: 'radial-gradient(circle, rgba(16,185,129,0.10), transparent 70%)', filter: 'blur(40px)', pointerEvents: 'none' }} />

      <div style={{ position: 'relative', width: '100%', maxWidth: 410 }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 26, justifyContent: 'center' }}>
          <div style={{ width: 42, height: 42, borderRadius: 13, background: 'var(--green-dim)', border: '1px solid rgba(16,185,129,0.3)', display: 'grid', placeItems: 'center' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>
          </div>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: '1.3rem', lineHeight: 1 }}>MyTrade</div>
            <div style={{ color: 'var(--fg-2)', fontSize: '0.74rem', marginTop: 3 }}>Autonomous daily trading · compounded</div>
          </div>
        </div>

        <div className="card" style={{ padding: 30 }}>
          <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
          <p style={{ color: 'var(--fg-2)', fontSize: '0.86rem', margin: '0 0 22px' }}>{mode === 'login' ? 'Access your trading dashboard' : 'Set up your trading account'}</p>

          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 15 }}>
            <div>
              <label className="field-label" style={{ textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.05em', color: 'var(--fg-2)' }}>Email</label>
              <div style={{ position: 'relative' }}>
                <Mail style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--fg-3)' }} />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required className="field-input" style={{ paddingLeft: 36, fontFamily: 'var(--font-sans)' }} />
              </div>
            </div>
            <div>
              <label className="field-label" style={{ textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.05em', color: 'var(--fg-2)' }}>Password</label>
              <div style={{ position: 'relative' }}>
                <Lock style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--fg-3)' }} />
                <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required className="field-input" style={{ paddingLeft: 36, paddingRight: 38, fontFamily: 'var(--font-sans)' }} />
                <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--fg-3)', cursor: 'pointer' }}>
                  {showPw ? <EyeOff style={{ width: 16, height: 16 }} /> : <Eye style={{ width: 16, height: 16 }} />}
                </button>
              </div>
            </div>

            {error && (
              <div style={{ fontSize: '0.78rem', padding: '9px 12px', borderRadius: 'var(--r-md)', background: error.includes('Check your email') ? 'var(--green-faint)' : 'var(--red-faint)', border: `1px solid ${error.includes('Check your email') ? 'var(--green)' : 'var(--red)'}`, color: error.includes('Check your email') ? 'var(--green)' : 'var(--red)' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn green full" style={{ padding: '11px 16px' }}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in →' : 'Create account'}
            </button>
          </form>

          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--fg-2)', fontSize: '0.78rem', cursor: 'pointer' }}>
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>

        <p style={{ textAlign: 'center', color: 'var(--fg-3)', fontSize: '0.74rem', marginTop: 22 }}>Secured by Supabase Auth · data encrypted at rest</p>
      </div>
    </div>
  )
}
