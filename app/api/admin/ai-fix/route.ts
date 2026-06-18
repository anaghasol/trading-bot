/**
 * POST /api/admin/ai-fix
 * AI-powered code fix engine. User describes a bug or change →
 * Claude reads relevant source files → generates patch →
 * commits directly to GitHub → Vercel auto-deploys.
 *
 * No local dev environment needed. Fix from the dashboard.
 */

import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { readFiles, writeFile, inferRelevantFiles } from '@/lib/github-api'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 300

interface FixRequest {
  description: string   // user's bug description or change request
  job_id?: string       // optional: for polling status
}

interface FileChange {
  path: string
  content: string
  reason: string
}

interface ClaudeFixResponse {
  analysis: string
  changes: FileChange[]
  no_change_reason?: string
}

async function updateJobStatus(
  db: ReturnType<typeof createServiceClient>,
  jobId: string,
  status: string,
  detail?: string
) {
  try {
    await db.from('tb_settings').upsert({
      key: `aifix_job_${jobId}`,
      value: JSON.stringify({ status, detail: detail ?? '', updated_at: new Date().toISOString() }),
    })
  } catch { /* non-fatal */ }
}

export async function POST(req: Request) {
  const body = await req.json() as FixRequest
  const { description, job_id } = body

  if (!description?.trim()) {
    return NextResponse.json({ error: 'Description required' }, { status: 400 })
  }

  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    return NextResponse.json({ error: 'GITHUB_TOKEN not configured — add it in Vercel env vars' }, { status: 500 })
  }

  const db    = createServiceClient()
  const jobId = job_id ?? `fix_${Date.now()}`

  await updateJobStatus(db, jobId, 'reading_files', 'Identifying relevant source files...')

  // ── Step 1: Infer and read relevant files ────────────────────────────────
  const filePaths = inferRelevantFiles(description)
  console.log(`[ai-fix] Relevant files: ${filePaths.join(', ')}`)

  await updateJobStatus(db, jobId, 'reading_files', `Reading: ${filePaths.join(', ')}`)
  const files = await readFiles(filePaths)

  if (files.length === 0) {
    await updateJobStatus(db, jobId, 'error', 'Could not read source files from GitHub')
    return NextResponse.json({ error: 'Could not read source files' }, { status: 500 })
  }

  // ── Step 2: Build Claude prompt ──────────────────────────────────────────
  const fileContext = files.map((f) =>
    `=== FILE: ${f.path} ===\n${f.content}\n=== END: ${f.path} ===`
  ).join('\n\n')

  const systemPrompt = `You are an expert TypeScript/Next.js developer working on a personal AI trading bot called MyTrade.
The app runs on Vercel (serverless), uses Next.js 14 App Router, Supabase for storage, Alpaca paper trading and Schwab live trading.
Never use Python — always TypeScript.
Minimize code changes — only change what's necessary to fix the specific issue described.
Do not add comments explaining what you changed. Write clean, terse code.
Always return valid JSON.`

  const userPrompt = `The user reported this bug / change request:

"${description}"

Here are the relevant source files:

${fileContext}

Analyze the bug and return a JSON response in EXACTLY this format (no markdown, raw JSON only):

{
  "analysis": "1-2 sentence explanation of what the bug is and how you're fixing it",
  "changes": [
    {
      "path": "exact/file/path.ts",
      "content": "COMPLETE new file content — the entire file, not a diff",
      "reason": "one line: what changed and why"
    }
  ],
  "no_change_reason": "if no code change is needed, explain why here (leave empty string otherwise)"
}

Rules:
- Only include files you actually need to change
- "content" must be the COMPLETE file, not just the changed section
- If the fix requires no code change (e.g., it's a config issue or runtime param), set changes to [] and explain in no_change_reason
- Maximum 3 files per fix — if more are needed, fix the most critical ones
- Do not wrap response in markdown code fences`

  await updateJobStatus(db, jobId, 'analyzing', 'Claude is analyzing the code...')

  // ── Step 3: Call Claude ──────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  let claudeResponse: ClaudeFixResponse
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 16000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    claudeResponse = JSON.parse(cleaned) as ClaudeFixResponse
  } catch (e) {
    await updateJobStatus(db, jobId, 'error', `Claude response parse failed: ${String(e)}`)
    return NextResponse.json({ error: 'Claude response invalid', detail: String(e) }, { status: 500 })
  }

  // ── Step 4: If no changes needed, return early ───────────────────────────
  if (!claudeResponse.changes || claudeResponse.changes.length === 0) {
    await updateJobStatus(db, jobId, 'no_change', claudeResponse.no_change_reason ?? 'No code change required')
    return NextResponse.json({
      job_id:    jobId,
      status:    'no_change',
      analysis:  claudeResponse.analysis,
      reason:    claudeResponse.no_change_reason,
      committed: [],
    })
  }

  // ── Step 5: Commit each changed file to GitHub ───────────────────────────
  await updateJobStatus(db, jobId, 'committing',
    `Committing ${claudeResponse.changes.length} file(s) to GitHub...`)

  const committed: Array<{ path: string; url: string; reason: string }> = []
  const errors: string[] = []

  // Map existing SHAs so we can update (not create) files
  const shaMap = new Map(files.map((f) => [f.path, f.sha]))

  for (const change of claudeResponse.changes) {
    try {
      const commitMsg = `fix(ai): ${change.reason}\n\nRequested: "${description.slice(0, 120)}"\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
      const result = await writeFile(
        change.path,
        change.content,
        commitMsg,
        shaMap.get(change.path)
      )
      committed.push({ path: change.path, url: result.url, reason: change.reason })
      console.log(`[ai-fix] Committed ${change.path}`)
    } catch (e) {
      errors.push(`${change.path}: ${String(e)}`)
      console.error(`[ai-fix] Commit failed for ${change.path}:`, e)
    }
  }

  // ── Step 6: Log to tb_alerts so dashboard history shows it ───────────────
  try {
    await db.from('tb_alerts').insert({
      type: 'INFO',
      symbol: null,
      message: `[AI_FIX] ${claudeResponse.analysis} | Files: ${committed.map((c) => c.path).join(', ')}`,
    })
  } catch { /* non-fatal */ }

  const finalStatus = errors.length === 0 ? 'deployed' : 'partial'
  await updateJobStatus(db, jobId, finalStatus,
    committed.length > 0
      ? `Committed: ${committed.map((c) => c.path).join(', ')} — Vercel deploying now`
      : `No files committed. Errors: ${errors.join('; ')}`)

  return NextResponse.json({
    job_id:    jobId,
    status:    finalStatus,
    analysis:  claudeResponse.analysis,
    committed,
    errors,
    deploying: committed.length > 0,
  })
}

/** GET /api/admin/ai-fix?job=fix_xxx — poll job status */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('job')
  if (!jobId) return NextResponse.json({ error: 'job param required' }, { status: 400 })

  const db = createServiceClient()
  const { data } = await db.from('tb_settings').select('value').eq('key', `aifix_job_${jobId}`).single()
  if (!data?.value) return NextResponse.json({ status: 'not_found' })

  return NextResponse.json(JSON.parse(data.value))
}
