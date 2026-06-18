'use client'

import { useState, useRef } from 'react'

interface CommittedFile {
  path: string
  url: string
  reason: string
}

interface FixResult {
  job_id: string
  status: 'deployed' | 'partial' | 'no_change' | 'error'
  analysis: string
  committed: CommittedFile[]
  errors: string[]
  deploying: boolean
  reason?: string
}

type Step = 'idle' | 'reading_files' | 'analyzing' | 'committing' | 'done' | 'error'

const STEP_LABELS: Record<Step, string> = {
  idle:          'Ready',
  reading_files: 'Reading source files…',
  analyzing:     'Claude is analyzing the code…',
  committing:    'Committing fix to GitHub…',
  done:          'Fix deployed!',
  error:         'Error',
}

const QUICK_PROMPTS = [
  'Auto-close is not firing for losing positions — investigate and fix',
  'Options stop is not triggering — check options exit logic',
  'Scanner is finding 0 trades — too few entries today',
  'Dashboard Cut Losers button is broken',
  'Monitor is skipping positions without a journal entry',
  'Trailing stop is not protecting gains properly',
]

export default function FixPage() {
  const [description, setDescription] = useState('')
  const [step, setStep]               = useState<Step>('idle')
  const [stepDetail, setStepDetail]   = useState('')
  const [result, setResult]           = useState<FixResult | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function pollStatus(jobId: string) {
    try {
      const r = await fetch(`/api/admin/ai-fix?job=${jobId}`)
      const d = await r.json() as { status: string; detail: string }
      setStepDetail(d.detail ?? '')

      if (d.status === 'reading_files') setStep('reading_files')
      else if (d.status === 'analyzing') setStep('analyzing')
      else if (d.status === 'committing') setStep('committing')
      else if (['deployed', 'partial', 'no_change', 'error'].includes(d.status)) {
        setStep('done')
        stopPolling()
      }
    } catch { /* ignore poll errors */ }
  }

  async function runFix() {
    if (!description.trim() || step !== 'idle') return

    setStep('reading_files')
    setStepDetail('Starting…')
    setResult(null)
    stopPolling()

    const jobId = `fix_${Date.now()}`
    jobIdRef.current = jobId

    // Start polling while the request is in flight
    pollRef.current = setInterval(() => pollStatus(jobId), 2000)

    try {
      const res = await fetch('/api/admin/ai-fix', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ description, job_id: jobId }),
      })
      const data = await res.json() as FixResult
      stopPolling()
      setResult(data)
      setStep('done')
      setStepDetail('')
    } catch (e) {
      stopPolling()
      setStep('error')
      setStepDetail(String(e))
    }
  }

  const isRunning = step !== 'idle' && step !== 'done' && step !== 'error'

  return (
    <div style={{ padding: '2rem', maxWidth: 800, margin: '0 auto', fontFamily: 'IBM Plex Mono, monospace' }}>

      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ color: '#13c98e', fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>
          ⚡ AI Runtime Fix
        </h1>
        <p style={{ color: '#8892a4', fontSize: '0.75rem', margin: '0.4rem 0 0' }}>
          Describe a bug or change → Claude reads the code → commits fix → Vercel deploys automatically
        </p>
      </div>

      {/* Quick prompts */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ color: '#8892a4', fontSize: '0.65rem', marginBottom: '0.4rem' }}>QUICK PROMPTS</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => setDescription(p)}
              disabled={isRunning}
              style={{
                background: '#161c27',
                border: '1px solid #2a3347',
                color: '#a0aec0',
                borderRadius: 4,
                padding: '0.25rem 0.5rem',
                fontSize: '0.65rem',
                cursor: 'pointer',
              }}
            >
              {p.slice(0, 42)}{p.length > 42 ? '…' : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe the bug or change you need…&#10;e.g. 'Options at -10% are not auto-closing' or 'Scanner found 0 trades today'"
        disabled={isRunning}
        rows={5}
        style={{
          width: '100%',
          background: '#0d1117',
          border: '1px solid #2a3347',
          borderRadius: 6,
          color: '#e2e8f0',
          fontSize: '0.78rem',
          padding: '0.75rem',
          resize: 'vertical',
          boxSizing: 'border-box',
          fontFamily: 'IBM Plex Mono, monospace',
        }}
      />

      {/* Submit */}
      <button
        onClick={runFix}
        disabled={isRunning || !description.trim()}
        style={{
          marginTop: '0.75rem',
          background: isRunning ? '#1e2a3a' : '#13c98e',
          color: isRunning ? '#8892a4' : '#0b0f17',
          border: 'none',
          borderRadius: 6,
          padding: '0.6rem 1.4rem',
          fontWeight: 700,
          fontSize: '0.8rem',
          cursor: isRunning ? 'not-allowed' : 'pointer',
          width: '100%',
        }}
      >
        {isRunning ? `${STEP_LABELS[step]}` : '⚡ Analyze & Fix'}
      </button>

      {/* Progress */}
      {(isRunning || stepDetail) && step !== 'done' && (
        <div style={{
          marginTop: '1rem',
          background: '#0d1117',
          border: '1px solid #2a3347',
          borderRadius: 6,
          padding: '0.75rem',
        }}>
          <div style={{ color: '#13c98e', fontSize: '0.72rem', fontWeight: 700 }}>
            {STEP_LABELS[step]}
          </div>
          {stepDetail && (
            <div style={{ color: '#8892a4', fontSize: '0.68rem', marginTop: '0.25rem' }}>
              {stepDetail}
            </div>
          )}
          {/* Animated progress dots */}
          <div style={{ color: '#13c98e', fontSize: '0.9rem', marginTop: '0.4rem', letterSpacing: 4 }}>
            {'•••'}
          </div>
        </div>
      )}

      {/* Result */}
      {result && step === 'done' && (
        <div style={{ marginTop: '1.25rem' }}>

          {/* Status badge */}
          <div style={{
            display: 'inline-block',
            background: result.status === 'deployed' ? '#0d2a1f' : result.status === 'no_change' ? '#1a1f2e' : '#2a1f0d',
            border: `1px solid ${result.status === 'deployed' ? '#13c98e' : result.status === 'no_change' ? '#4a5568' : '#e07b4a'}`,
            color: result.status === 'deployed' ? '#13c98e' : result.status === 'no_change' ? '#8892a4' : '#e07b4a',
            borderRadius: 4,
            padding: '0.2rem 0.6rem',
            fontSize: '0.68rem',
            fontWeight: 700,
            marginBottom: '0.75rem',
          }}>
            {result.status === 'deployed' ? '✅ DEPLOYED' : result.status === 'no_change' ? 'ℹ️ NO CHANGE NEEDED' : '⚠️ PARTIAL'}
          </div>

          {/* Analysis */}
          <div style={{
            background: '#0d1117',
            border: '1px solid #2a3347',
            borderRadius: 6,
            padding: '0.75rem',
            marginBottom: '0.75rem',
          }}>
            <div style={{ color: '#8892a4', fontSize: '0.62rem', marginBottom: '0.3rem' }}>ANALYSIS</div>
            <div style={{ color: '#e2e8f0', fontSize: '0.75rem', lineHeight: 1.5 }}>{result.analysis}</div>
            {result.reason && (
              <div style={{ color: '#8892a4', fontSize: '0.72rem', marginTop: '0.4rem' }}>{result.reason}</div>
            )}
          </div>

          {/* Files changed */}
          {result.committed.length > 0 && (
            <div style={{
              background: '#0d1117',
              border: '1px solid #2a3347',
              borderRadius: 6,
              padding: '0.75rem',
              marginBottom: '0.75rem',
            }}>
              <div style={{ color: '#8892a4', fontSize: '0.62rem', marginBottom: '0.5rem' }}>
                FILES CHANGED ({result.committed.length})
              </div>
              {result.committed.map((f) => (
                <div key={f.path} style={{ marginBottom: '0.5rem' }}>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#13c98e', fontSize: '0.72rem', textDecoration: 'none' }}
                  >
                    📄 {f.path}
                  </a>
                  <div style={{ color: '#8892a4', fontSize: '0.65rem', marginTop: '0.1rem' }}>
                    {f.reason}
                  </div>
                </div>
              ))}
              {result.deploying && (
                <div style={{
                  marginTop: '0.5rem',
                  color: '#13c98e',
                  fontSize: '0.68rem',
                  padding: '0.4rem',
                  background: '#0d2a1f',
                  borderRadius: 4,
                }}>
                  🚀 Vercel is deploying — live in ~1 minute
                </div>
              )}
            </div>
          )}

          {/* Errors */}
          {result.errors && result.errors.length > 0 && (
            <div style={{
              background: '#1a0d0d',
              border: '1px solid #7b3333',
              borderRadius: 6,
              padding: '0.75rem',
              marginBottom: '0.75rem',
            }}>
              <div style={{ color: '#e07b7b', fontSize: '0.62rem', marginBottom: '0.3rem' }}>ERRORS</div>
              {result.errors.map((e, i) => (
                <div key={i} style={{ color: '#e07b7b', fontSize: '0.68rem' }}>{e}</div>
              ))}
            </div>
          )}

          {/* Reset */}
          <button
            onClick={() => { setResult(null); setStep('idle'); setDescription('') }}
            style={{
              background: 'transparent',
              border: '1px solid #2a3347',
              color: '#8892a4',
              borderRadius: 4,
              padding: '0.4rem 0.8rem',
              fontSize: '0.68rem',
              cursor: 'pointer',
            }}
          >
            New Fix
          </button>
        </div>
      )}

      {step === 'error' && (
        <div style={{
          marginTop: '1rem',
          background: '#1a0d0d',
          border: '1px solid #7b3333',
          borderRadius: 6,
          padding: '0.75rem',
        }}>
          <div style={{ color: '#e07b7b', fontSize: '0.75rem' }}>⚠️ {stepDetail || 'Unknown error'}</div>
          <button
            onClick={() => { setStep('idle'); setStepDetail('') }}
            style={{ marginTop: '0.5rem', background: 'transparent', border: '1px solid #7b3333', color: '#e07b7b', borderRadius: 4, padding: '0.3rem 0.6rem', fontSize: '0.68rem', cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  )
}
