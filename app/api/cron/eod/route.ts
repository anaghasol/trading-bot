/**
 * CRON: /api/cron/eod — End-of-day analysis + auto-tuner.
 * Runs at 4:15 PM ET daily (after market close + close cron).
 *
 * 1. Reads today's trades, alerts, cron logs from Supabase.
 * 2. Diagnoses: stop failures, low entry rate, poor win rate, stuck positions.
 * 3. Auto-corrects: writes new params to tb_settings (no code deploy needed).
 * 4. Sends Telegram report with P&L summary + what was changed.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { getRuntimeConfig, setRuntimeConfig, RuntimeConfig } from '@/lib/runtime-config'
import { profileFor } from '@/lib/strategy-profiles'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function today() { return new Date().toISOString().split('T')[0] }

interface DiagnosticIssue {
  code: string
  severity: 'warn' | 'critical'
  message: string
  fix?: string
}

interface EODReport {
  date: string
  broker: string
  // Performance
  total_trades: number
  wins: number
  losses: number
  win_rate: number
  total_pnl: number
  avg_win: number
  avg_loss: number
  biggest_winner: string
  biggest_loser: string
  // Activity
  entries_today: number
  peak_positions: number
  stops_fired: number
  partials_taken: number
  // Issues
  issues: DiagnosticIssue[]
  // Config changes
  config_before: Partial<RuntimeConfig>
  config_after: Partial<RuntimeConfig>
  config_changes: string[]
}

async function analyzeBroker(
  broker: 'alpaca_paper' | 'schwab',
  db: ReturnType<typeof createServiceClient>
): Promise<EODReport> {
  const dateStr   = today()
  const dayStart  = dateStr + 'T00:00:00Z'
  const profile   = profileFor(broker)
  const config    = await getRuntimeConfig(broker)

  // ── Pull today's closed trades ────────────────────────────────────────────
  const { data: closedTrades } = await db
    .from('tb_trades')
    .select('symbol, pnl, pnl_pct, entry_price, exit_price, strategy, reason, created_at, closed_at')
    .eq('status', 'CLOSED')
    .gte('closed_at', dayStart)
    .or(`broker.eq.${broker},broker.is.null`)

  const trades = closedTrades ?? []
  const wins   = trades.filter((t) => (t.pnl as number) > 0)
  const losses = trades.filter((t) => (t.pnl as number) <= 0)

  const totalPnl  = trades.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const avgWin    = wins.length   > 0 ? wins.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0) / wins.length : 0
  const avgLoss   = losses.length > 0 ? losses.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0) / losses.length : 0
  const winRate   = trades.length > 0 ? wins.length / trades.length : 0

  const sortedByPnl   = [...trades].sort((a, b) => ((b.pnl as number) ?? 0) - ((a.pnl as number) ?? 0))
  const biggestWinner = sortedByPnl[0]  ? `${sortedByPnl[0].symbol} +$${(sortedByPnl[0].pnl as number)?.toFixed(0)}` : 'none'
  const biggestLoser  = sortedByPnl[sortedByPnl.length - 1]
    ? `${sortedByPnl[sortedByPnl.length - 1].symbol} $${(sortedByPnl[sortedByPnl.length - 1].pnl as number)?.toFixed(0)}`
    : 'none'

  // ── Pull today's entries (BUY alerts) ────────────────────────────────────
  const { data: buyAlerts } = await db
    .from('tb_alerts')
    .select('id')
    .eq('type', 'BUY')
    .gte('created_at', dayStart)
    .or(`broker.eq.${broker},broker.is.null`)

  const entriesCount = (buyAlerts ?? []).length

  // ── Pull today's stop-loss alerts ────────────────────────────────────────
  const { data: stopAlerts } = await db
    .from('tb_alerts')
    .select('id')
    .eq('type', 'STOP_LOSS')
    .gte('created_at', dayStart)
    .or(`broker.eq.${broker},broker.is.null`)

  const stopsFired = (stopAlerts ?? []).length

  // ── Pull today's partial (SELL) alerts ───────────────────────────────────
  const { data: sellAlerts } = await db
    .from('tb_alerts')
    .select('message')
    .eq('type', 'SELL')
    .gte('created_at', dayStart)
    .or(`broker.eq.${broker},broker.is.null`)

  const partialsTaken = (sellAlerts ?? []).filter((a) =>
    String(a.message ?? '').includes('PARTIAL')
  ).length

  // ── Detect issues ─────────────────────────────────────────────────────────
  const issues: DiagnosticIssue[] = []

  // Too few entries
  if (entriesCount < 5 && broker === 'alpaca_paper') {
    issues.push({
      code: 'LOW_ENTRY_RATE',
      severity: 'warn',
      message: `Only ${entriesCount} entries today (target: 10+). AI gate or volume filter too restrictive.`,
      fix: 'Lower min_confidence',
    })
  }

  // Too many entries with bad win rate
  if (entriesCount >= 10 && winRate < 0.35 && trades.length >= 5) {
    issues.push({
      code: 'POOR_WIN_RATE',
      severity: 'critical',
      message: `Win rate ${(winRate * 100).toFixed(0)}% on ${trades.length} closed trades. AI gate too low or wrong setups.`,
      fix: 'Raise min_confidence',
    })
  }

  // Avg loss too large (stops not tight enough)
  if (avgLoss < -150 && losses.length >= 3) {
    issues.push({
      code: 'LARGE_AVG_LOSS',
      severity: 'critical',
      message: `Avg loss $${avgLoss.toFixed(0)} on ${losses.length} losing trades. Stops too wide.`,
      fix: 'Tighten stop_pct',
    })
  }

  // Avg win too small relative to avg loss (bad risk/reward)
  if (avgLoss < 0 && avgWin > 0 && avgWin < Math.abs(avgLoss) * 0.8 && trades.length >= 5) {
    issues.push({
      code: 'POOR_RISK_REWARD',
      severity: 'warn',
      message: `Avg win $${avgWin.toFixed(0)} vs avg loss $${Math.abs(avgLoss).toFixed(0)}. Risk:reward < 0.8.`,
      fix: 'Tighten stop or let winners run longer (reduce trail)',
    })
  }

  // Good performance — can be more aggressive
  if (winRate >= 0.6 && totalPnl > 0 && trades.length >= 5) {
    issues.push({
      code: 'STRONG_DAY',
      severity: 'warn',
      message: `Strong day: ${(winRate * 100).toFixed(0)}% win rate, +$${totalPnl.toFixed(0)} P&L. Strategy working.`,
      fix: 'Can add more positions or increase risk_pct slightly',
    })
  }

  // No trades at all (scanner broken or market too quiet)
  if (entriesCount === 0 && broker === 'alpaca_paper') {
    issues.push({
      code: 'ZERO_ENTRIES',
      severity: 'critical',
      message: 'Zero entries today. Scanner may be broken or market data failing.',
      fix: 'Check cron logs and volume surge threshold',
    })
  }

  // ── Auto-correct config ────────────────────────────────────────────────────
  const configBefore: Partial<RuntimeConfig> = {
    min_confidence: config.min_confidence,
    stop_pct:       config.stop_pct,
    trail_pct:      config.trail_pct,
    max_positions:  config.max_positions,
    risk_pct:       config.risk_pct,
  }

  const patch: Partial<RuntimeConfig> = {}
  const changes: string[] = []

  const minConf  = profile.min_confidence  // floor — never go below profile default
  const maxConf  = 0.85                    // ceiling

  for (const issue of issues) {
    if (issue.code === 'LOW_ENTRY_RATE') {
      const newConf = Math.max(minConf, Math.min(maxConf, config.min_confidence - 0.05))
      if (newConf !== config.min_confidence) {
        patch.min_confidence = newConf
        changes.push(`min_confidence ${(config.min_confidence * 100).toFixed(0)}% → ${(newConf * 100).toFixed(0)}% (too few entries)`)
      }
    }

    if (issue.code === 'POOR_WIN_RATE') {
      const newConf = Math.max(minConf, Math.min(maxConf, config.min_confidence + 0.05))
      if (newConf !== config.min_confidence) {
        patch.min_confidence = newConf
        changes.push(`min_confidence ${(config.min_confidence * 100).toFixed(0)}% → ${(newConf * 100).toFixed(0)}% (poor win rate)`)
      }
    }

    if (issue.code === 'LARGE_AVG_LOSS') {
      const newStop = Math.max(0.01, Math.min(0.05, config.stop_pct - 0.005))
      if (newStop !== config.stop_pct) {
        patch.stop_pct = newStop
        changes.push(`stop_pct ${(config.stop_pct * 100).toFixed(1)}% → ${(newStop * 100).toFixed(1)}% (large avg loss)`)
      }
    }

    if (issue.code === 'POOR_RISK_REWARD' && !patch.stop_pct) {
      const newTrail = Math.max(0.03, Math.min(0.08, config.trail_pct - 0.005))
      if (newTrail !== config.trail_pct) {
        patch.trail_pct = newTrail
        changes.push(`trail_pct ${(config.trail_pct * 100).toFixed(1)}% → ${(newTrail * 100).toFixed(1)}% (let winners run further)`)
      }
    }

    if (issue.code === 'STRONG_DAY') {
      const newMax = Math.min(50, config.max_positions + 5)
      if (newMax !== config.max_positions) {
        patch.max_positions = newMax
        changes.push(`max_positions ${config.max_positions} → ${newMax} (strong performance — expand)`)
      }
    }

    if (issue.code === 'ZERO_ENTRIES') {
      // Loosen everything to avoid another dead day
      const newConf = Math.max(minConf, config.min_confidence - 0.08)
      patch.min_confidence = newConf
      changes.push(`min_confidence ${(config.min_confidence * 100).toFixed(0)}% → ${(newConf * 100).toFixed(0)}% (zero entries — scanner too tight)`)
    }
  }

  let configAfter: Partial<RuntimeConfig> = configBefore
  const reason = changes.length > 0
    ? `EOD auto-tune ${dateStr}: ${changes.join('; ')}`
    : `EOD no change ${dateStr}: strategy on track`

  if (changes.length > 0 && broker === 'alpaca_paper') {
    const updated = await setRuntimeConfig(broker, patch, reason)
    configAfter = {
      min_confidence: updated.min_confidence,
      stop_pct:       updated.stop_pct,
      trail_pct:      updated.trail_pct,
      max_positions:  updated.max_positions,
      risk_pct:       updated.risk_pct,
    }
  }

  // ── Snapshot today's EOD data ─────────────────────────────────────────────
  await db.from('tb_eod_reports').upsert({
    date:          dateStr,
    broker,
    total_trades:  trades.length,
    wins:          wins.length,
    losses:        losses.length,
    win_rate:      Math.round(winRate * 1000) / 10,
    total_pnl:     Math.round(totalPnl * 100) / 100,
    avg_win:       Math.round(avgWin * 100) / 100,
    avg_loss:      Math.round(avgLoss * 100) / 100,
    entries:       entriesCount,
    stops_fired:   stopsFired,
    partials_taken: partialsTaken,
    issues:        JSON.stringify(issues),
    config_changes: JSON.stringify(changes),
    new_config:    JSON.stringify(configAfter),
  }, { onConflict: 'date,broker' })

  return {
    date: dateStr,
    broker,
    total_trades:   trades.length,
    wins:           wins.length,
    losses:         losses.length,
    win_rate:       winRate,
    total_pnl:      totalPnl,
    avg_win:        avgWin,
    avg_loss:       avgLoss,
    biggest_winner: biggestWinner,
    biggest_loser:  biggestLoser,
    entries_today:  entriesCount,
    peak_positions: 0,
    stops_fired:    stopsFired,
    partials_taken: partialsTaken,
    issues,
    config_before:  configBefore,
    config_after:   configAfter,
    config_changes: changes,
  }
}

function buildTelegramReport(report: EODReport): string {
  const sign = report.total_pnl >= 0 ? '+' : ''
  const pnlEmoji = report.total_pnl >= 0 ? '🟢' : '🔴'
  const wr = (report.win_rate * 100).toFixed(0)

  const lines: string[] = [
    `📊 *EOD Report — ${report.date}* (${report.broker === 'alpaca_paper' ? 'Paper' : 'Live'})`,
    `${pnlEmoji} P&L: *${sign}$${report.total_pnl.toFixed(0)}*  |  Win rate: *${wr}%* (${report.wins}W/${report.losses}L)`,
    `Entries: ${report.entries_today}  |  Stops fired: ${report.stops_fired}  |  Partials: ${report.partials_taken}`,
    `🏆 Best: ${report.biggest_winner}   💀 Worst: ${report.biggest_loser}`,
  ]

  if (report.issues.length > 0) {
    lines.push('')
    lines.push('*Issues detected:*')
    for (const issue of report.issues) {
      const icon = issue.severity === 'critical' ? '🚨' : '⚠️'
      lines.push(`${icon} ${issue.message}`)
    }
  }

  if (report.config_changes.length > 0) {
    lines.push('')
    lines.push('*Auto-corrections applied:*')
    for (const ch of report.config_changes) {
      lines.push(`🔧 ${ch}`)
    }
    lines.push('_Changes take effect on next scan cycle — no deploy needed._')
  } else {
    lines.push('')
    lines.push('✅ _Strategy on track — no config changes._')
  }

  return lines.join('\n')
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db      = createServiceClient()
  const reports: Record<string, EODReport> = {}

  // Analyze paper (and live if Schwab tokens valid)
  try { reports.alpaca_paper = await analyzeBroker('alpaca_paper', db) } catch (e) { console.error('[eod] paper error:', e) }
  try { reports.schwab       = await analyzeBroker('schwab', db)       } catch (e) { console.error('[eod] schwab error:', e) }

  // Send Telegram report
  const tgBot  = process.env.TELEGRAM_BOT_TOKEN
  const tgChat = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (tgBot && tgChat) {
    for (const [, report] of Object.entries(reports)) {
      const text = buildTelegramReport(report)
      await fetch(`https://api.telegram.org/bot${tgBot}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'Markdown' }),
      }).catch((e) => console.error('[eod] TG send error:', e))
    }
  }

  return NextResponse.json({ status: 'ok', date: today(), reports })
}
