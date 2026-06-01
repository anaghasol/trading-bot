'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase-client'
import { TrendingUp, Lock, Mail, Eye, EyeOff } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [mode, setMode]       = useState<'login' | 'signup'>('login')

  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const fn = mode === 'login'
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/api/auth/callback` } })

    const { error: authError } = await fn

    if (authError) {
      setError(authError.message)
    } else if (mode === 'login') {
      window.location.href = '/dashboard'
    } else {
      setError('Check your email for a confirmation link.')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070b14] px-4">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative w-full max-w-[400px]">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-accent" />
          </div>
          <div>
            <div className="text-white font-semibold text-lg leading-none">TradeBot</div>
            <div className="text-[#848d97] text-xs">AI-Powered Schwab Trading</div>
          </div>
        </div>

        {/* Card */}
        <div className="card p-8">
          <h1 className="text-lg font-semibold text-white mb-1">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </h1>
          <p className="text-[#848d97] text-sm mb-6">
            {mode === 'login' ? 'Access your trading dashboard' : 'Set up your trading account'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-[#8b949e] mb-1.5 font-medium uppercase tracking-wide">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#848d97]" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full bg-[#161b22] border border-[#30363d] rounded-lg py-2.5 pl-10 pr-4 text-sm text-white placeholder-[#484f58] focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8b949e] mb-1.5 font-medium uppercase tracking-wide">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#848d97]" />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-[#161b22] border border-[#30363d] rounded-lg py-2.5 pl-10 pr-10 text-sm text-white placeholder-[#484f58] focus:outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#848d97] hover:text-white"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className={`text-xs px-3 py-2 rounded-lg ${
                error.includes('Check your email')
                  ? 'bg-profit/10 border border-profit/20 text-profit'
                  : 'bg-loss/10 border border-loss/20 text-loss'
              }`}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
            >
              {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}
              className="text-[#848d97] hover:text-white text-xs transition-colors"
            >
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>

        <p className="text-center text-[#484f58] text-xs mt-6">
          Secured by Supabase Auth · Data encrypted at rest
        </p>
      </div>
    </div>
  )
}
