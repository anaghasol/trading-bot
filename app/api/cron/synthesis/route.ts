/**
 * CRON: /api/cron/synthesis — weekly lesson synthesis
 * Runs Sunday 6 AM ET (11:00 UTC). Reads last 30 trade narratives,
 * asks Claude to extract explicit rules from patterns, saves to
 * tb_settings['learned_rules']. Injected into every AI scan prompt.
 *
 * Goal: the bot learns from its own mistakes. After 50+ trades it
 * knows "BREAKOUT without TG in CAUTION regime = skip" as a rule,
 * not just a statistic.
 */
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  // Rate-limit: only synthesize once per 6 days (avoid re-running on re-deploy)
  try {
    const { data: lastRun } = await db.from('tb_settings').select('value').eq('key', 'synthesis_last_run').single()
    if (lastRun?.value) {
      const daysSince = (Date.now() - new Date(lastRun.value).getTime()) / 86_400_000
      if (daysSince < 6) {
        return NextResponse.json({ status: 'skipped', reason: `ran ${daysSince.toFixed(1)}d ago — next run in ${(6 - daysSince).toFixed(1)}d` })
      }
    }
  } catch { /* first run — proceed */ }

  // Pull last 30 trade narratives from both brokers
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: narratives } = await db
    .from('tb_learnings')
    .select('lesson, outcome, created_at')
    .gte('created_at', thirtyDaysAgo)
    .not('lesson', 'is', null)
    .order('created_at', { ascending: false })
    .limit(40)

  const tradeLines = (narratives ?? [])
    .filter((r) => r.lesson?.startsWith('WIN') || r.lesson?.startsWith('LOSS'))
    .map((r) => r.lesson as string)

  if (tradeLines.length < 5) {
    return NextResponse.json({ status: 'skipped', reason: `only ${tradeLines.length} trade narratives — need 5+ to synthesize` })
  }

  // Also pull the previous rules so Claude can build on them, not replace them
  const { data: prevRulesRow } = await db.from('tb_settings').select('value').eq('key', 'learned_rules').single()
  const prevRules = prevRulesRow?.value ?? 'None yet.'

  const wins  = tradeLines.filter((l) => l.startsWith('WIN')).length
  const losses = tradeLines.filter((l) => l.startsWith('LOSS')).length

  const prompt = `You are analyzing a trading bot's own trade history to extract actionable rules it should follow.

PREVIOUS RULES (already in effect — refine or confirm these, don't duplicate):
${prevRules}

RECENT TRADE OUTCOMES (${tradeLines.length} trades: ${wins} wins, ${losses} losses):
${tradeLines.join('\n')}

Your job: find patterns in what's winning and losing. Extract 3-6 clear, specific rules the bot should follow.

Rules must be based on actual patterns you see in the data above — not general trading wisdom.
Focus on: which setups + conditions = consistent wins, which = consistent losses.
Be specific about confidence levels, TG confirmation, regime, hold_mode, exit type.

Format each rule EXACTLY like this (one per line, no extra text):
RULE|name|condition|action|confidence_level

Examples of the format:
RULE|no-breakout-caution|BREAKOUT setup + regime=CAUTION + TG=no|SKIP — 0/4 wins in data|HIGH
RULE|ema-bounce-tg-works|EMA20_BOUNCE + TG=yes + regime=GOOD|ENTER — 6/7 wins in data|HIGH
RULE|trend-hold-pays|hold_mode=TREND + pnl>6%|hold through pullbacks — breakeven floor protects|MEDIUM

Return ONLY the RULE lines, one per line. No explanation, no preamble.`

  let rulesText = ''
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })
    rulesText = (msg.content[0] as { type: string; text: string }).text.trim()
  } catch (e) {
    console.error('[synthesis] Claude error:', e)
    return NextResponse.json({ status: 'error', error: String(e) }, { status: 500 })
  }

  // Validate — only keep lines that match the RULE| format
  const validRules = rulesText
    .split('\n')
    .filter((l) => l.trim().startsWith('RULE|') && l.split('|').length >= 5)
    .join('\n')

  if (!validRules) {
    return NextResponse.json({ status: 'error', error: 'Claude returned no valid RULE lines', raw: rulesText })
  }

  // Save rules + metadata
  await db.from('tb_settings').upsert({ key: 'learned_rules', value: validRules })
  await db.from('tb_settings').upsert({ key: 'synthesis_last_run', value: new Date().toISOString() })
  await db.from('tb_settings').upsert({
    key: 'synthesis_meta',
    value: JSON.stringify({ trades_analyzed: tradeLines.length, wins, losses, rules_count: validRules.split('\n').length, synthesized_at: new Date().toISOString() }),
  })

  // Log to alerts so it shows in dashboard
  const ruleCount = validRules.split('\n').filter(Boolean).length
  await db.from('tb_alerts').insert({
    type: 'INFO',
    message: `📚 Weekly synthesis: ${ruleCount} rules extracted from ${tradeLines.length} trades (${wins}W/${losses}L)\n${validRules}`,
  })

  // TG notification
  const BOT = process.env.TELEGRAM_BOT_TOKEN
  const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (BOT && GID) {
    const tgText = `📚 *Weekly Lesson Synthesis*\n${tradeLines.length} trades analyzed (${wins}W/${losses}L)\n\n*New rules:*\n${validRules.split('\n').map((r) => {
      const parts = r.split('|')
      return parts.length >= 5 ? `• *${parts[1]}*: ${parts[3]}` : ''
    }).filter(Boolean).join('\n')}`
    fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GID, text: tgText, parse_mode: 'Markdown' }),
    }).catch(() => {})
  }

  console.log(`[synthesis] Done — ${ruleCount} rules from ${tradeLines.length} trades`)
  return NextResponse.json({ status: 'ok', trades_analyzed: tradeLines.length, wins, losses, rules: validRules.split('\n').filter(Boolean) })
}
