/**
 * GitHub API helpers for the AI Fix engine.
 * Reads source files and commits changes — this is how the dashboard
 * can push code fixes without a local dev environment.
 */

const OWNER = 'anaghasol'
const REPO  = 'trading-bot'
const BRANCH = 'main'

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN env var not set')
  return {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/vnd.github+json',
    'Content-Type':  'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export interface GHFile {
  path: string
  content: string  // raw UTF-8 text
  sha: string      // needed to update existing file
}

/** Read a single file. Returns null if not found. */
export async function readFile(path: string): Promise<GHFile | null> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`
  const res = await fetch(url, { headers: ghHeaders() })
  if (!res.ok) return null
  const data = await res.json() as { content: string; sha: string; encoding: string }
  const content = Buffer.from(data.content, 'base64').toString('utf-8')
  return { path, content, sha: data.sha }
}

/** Read multiple files in parallel. Returns only the ones that exist. */
export async function readFiles(paths: string[]): Promise<GHFile[]> {
  const results = await Promise.all(paths.map(readFile))
  return results.filter((f): f is GHFile => f !== null)
}

export interface CommitResult {
  path: string
  sha: string
  url: string
}

/** Create or update a single file on the branch. */
export async function writeFile(
  path: string,
  content: string,
  message: string,
  existingSha?: string
): Promise<CommitResult> {
  const url  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch:  BRANCH,
  }
  if (existingSha) body.sha = existingSha

  const res = await fetch(url, {
    method:  'PUT',
    headers: ghHeaders(),
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub write failed for ${path}: ${res.status} ${err}`)
  }
  const data = await res.json() as { content: { sha: string; html_url: string } }
  return { path, sha: data.content.sha, url: data.content.html_url }
}

/** Infer which source files are relevant based on keywords in the user's message. */
export function inferRelevantFiles(description: string): string[] {
  const d = description.toLowerCase()
  const files = new Set<string>()

  // Always include project context and profiles
  files.add('CLAUDE.md')
  files.add('lib/strategy-profiles.ts')

  if (d.includes('monitor') || d.includes('close') || d.includes('stop') || d.includes('exit') || d.includes('auto')) {
    files.add('app/api/cron/monitor/route.ts')
    files.add('lib/options-exit.ts')
    files.add('lib/risk.ts')
  }
  if (d.includes('option') || d.includes('occ') || d.includes('put') || d.includes('call') || d.includes('amd')) {
    files.add('lib/options-exit.ts')
    files.add('app/api/cron/monitor/route.ts')
  }
  if (d.includes('scan') || d.includes('entry') || d.includes('enter') || d.includes('find') || d.includes('signal')) {
    files.add('app/api/cron/scan/route.ts')
    files.add('lib/ai-advisor.ts')
  }
  if (d.includes('fast') || d.includes('volume') || d.includes('surge') || d.includes('1 min')) {
    files.add('app/api/cron/fast/route.ts')
  }
  if (d.includes('dashboard') || d.includes('ui') || d.includes('button') || d.includes('display') || d.includes('tab')) {
    files.add('app/dashboard/page.tsx')
  }
  if (d.includes('balance') || d.includes('account') || d.includes('alpaca')) {
    files.add('lib/alpaca.ts')
  }
  if (d.includes('schwab') || d.includes('live') || d.includes('real money')) {
    files.add('lib/schwab.ts')
  }
  if (d.includes('risk') || d.includes('size') || d.includes('position size') || d.includes('aggressive')) {
    files.add('lib/risk.ts')
  }
  if (d.includes('eod') || d.includes('summary') || d.includes('report') || d.includes('tune')) {
    files.add('app/api/cron/eod/route.ts')
    files.add('lib/runtime-config.ts')
  }
  if (d.includes('config') || d.includes('runtime') || d.includes('param')) {
    files.add('lib/runtime-config.ts')
  }
  if (d.includes('profit') || d.includes('partial') || d.includes('trail')) {
    files.add('lib/risk.ts')
    files.add('app/api/cron/monitor/route.ts')
  }
  if (d.includes('telegram') || d.includes('tg') || d.includes('signal')) {
    files.add('app/api/telegram/poll/route.ts')
    files.add('lib/tg-intentions.ts')
  }
  if (d.includes('notify') || d.includes('sms') || d.includes('alert')) {
    files.add('lib/notify.ts')
  }
  if (d.includes('broker') || d.includes('route')) {
    files.add('lib/broker.ts')
  }

  // Default: if nothing matched beyond the base set, add the most commonly changed files
  if (files.size <= 2) {
    files.add('app/api/cron/monitor/route.ts')
    files.add('lib/alpaca.ts')
    files.add('lib/risk.ts')
  }

  return Array.from(files)
}
