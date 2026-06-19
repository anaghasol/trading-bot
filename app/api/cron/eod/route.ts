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
import * as AlpacaBroker from '@/lib/alpaca'
import * as SchwabBroker from '@/lib/schwab'

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

  // Profit factor: total gross wins / total gross losses — better signal than win rate alone.
  // PF > 1.5 = healthy, 1.0-1.5 = marginal, < 1.0 = net loser regardless of win rate.
  const grossWins   = wins.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const grossLosses = Math.abs(losses.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0))
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 1)

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

  // Profit factor too low — net loser even with a decent win rate
  if (trades.length >= 5 && profitFactor < 1.0) {
    issues.push({
      code: 'LOW_PROFIT_FACTOR',
      severity: 'critical',
      message: `Profit factor ${profitFactor.toFixed(2)} < 1.0 — gross losses exceed gross wins. Raise gate and tighten stops.`,
      fix: 'Raise min_confidence + tighten stop_pct',
    })
  }

  // Good performance — can be more aggressive
  if (profitFactor >= 1.5 && totalPnl > 0 && trades.length >= 5) {
    issues.push({
      code: 'STRONG_DAY',
      severity: 'warn',
      message: `Strong day: PF=${profitFactor.toFixed(2)}, ${(winRate * 100).toFixed(0)}% WR, +$${totalPnl.toFixed(0)} P&L.`,
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

    if (issue.code === 'LOW_PROFIT_FACTOR') {
      // Double correction: raise gate AND tighten stop — PF<1 means losses dominate
      const newConf = Math.max(minConf, Math.min(maxConf, config.min_confidence + 0.05))
      const newStop = Math.max(0.01, Math.min(0.05, config.stop_pct - 0.005))
      if (newConf !== config.min_confidence) {
        patch.min_confidence = newConf
        changes.push(`min_confidence ${(config.min_confidence * 100).toFixed(0)}% → ${(newConf * 100).toFixed(0)}% (PF=${profitFactor.toFixed(2)})`)
      }
      if (newStop !== config.stop_pct) {
        patch.stop_pct = newStop
        changes.push(`stop_pct ${(config.stop_pct * 100).toFixed(1)}% → ${(newStop * 100).toFixed(1)}% (PF=${profitFactor.toFixed(2)})`)
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

  // ── Mid-week decay scan (Wednesdays) — early warning for critically weak theses ──
  // Friday does the full rebalance. Wednesday catches anything that collapsed fast
  // (score < 30) so there's time to act before the weekend.
  const dayOfWeek = new Date().getDay()
  if (dayOfWeek === 3) {  // Wednesday
    for (const broker of ['alpaca_paper', 'schwab'] as const) {
      try {
        const { data: ltTrades } = await db
          .from('tb_trades').select('symbol').eq('status', 'OPEN')
          .eq('strategy', 'DISCOVERY_LT').or(`broker.eq.${broker},broker.is.null`)
        const ltSymbols = (ltTrades ?? []).map((t: { symbol: string }) => t.symbol)
        if (ltSymbols.length === 0) continue

        const { data: decayed } = await db
          .from('tb_discoveries').select('symbol, sndk_score')
          .in('symbol', ltSymbols).lt('sndk_score', 30)

        if ((decayed ?? []).length > 0) {
          const list = (decayed ?? []).map((r: { symbol: string; sndk_score: number }) => `${r.symbol}(${r.sndk_score})`).join(', ')
          await db.from('tb_alerts').insert({
            type: 'WARN', broker,
            message: `[MID-WEEK DECAY] Critical score collapse (<30): ${list} — thesis may be broken, review before Friday`,
          })
          if (tgBot && tgChat) {
            await fetch(`https://api.telegram.org/bot${tgBot}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: tgChat,
                text: `⚠️ *Mid-Week Decay Alert* [${broker}]\nCritical score collapse (score<30): ${list}\nThesis may be broken — review before Friday rebalance`,
                parse_mode: 'Markdown',
              }),
            }).catch(() => {})
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── Weekly LT sleeve rebalancing (Fridays only) ──────────────────────────
  // If LT sleeve > 28% of account equity, trim 1-2 weakest positions (lowest
  // current SNDK score from tb_discoveries) to free capital for new discoveries.
  if (dayOfWeek === 5) {  // Friday
    const rebalanceResults: string[] = []
    for (const broker of ['alpaca_paper', 'schwab'] as const) {
      try {
        const api       = broker === 'alpaca_paper' ? AlpacaBroker : SchwabBroker
        const positions = await api.getPositions()
        const equity    = await api.getAccountBalance() ?? (broker === 'alpaca_paper' ? 100000 : 2000)

        // Find open LT positions from tb_trades
        const { data: ltTrades } = await db
          .from('tb_trades')
          .select('symbol')
          .eq('status', 'OPEN')
          .eq('strategy', 'DISCOVERY_LT')
          .or(`broker.eq.${broker},broker.is.null`)
        const ltSymbols = new Set((ltTrades ?? []).map((t: { symbol: string }) => t.symbol))

        const ltPositions = positions.filter((p) => ltSymbols.has(p.symbol))
        const ltExposure  = ltPositions.reduce((s, p) => s + Math.abs(p.market_value ?? p.current_price * p.quantity), 0)
        const ltPct       = ltExposure / equity

        // Score decay check — flag trend positions with SNDK score < 35 regardless of sleeve size.
        // Degraded thesis (RS weakened, narrative stale) should trigger a review alert even if
        // we don't trim (only trim when sleeve > 28%).
        const { data: allScores } = await db
          .from('tb_discoveries')
          .select('symbol, sndk_score, highlights')
          .in('symbol', ltPositions.map((p) => p.symbol))
        const decayed = (allScores ?? []).filter((r: { symbol: string; sndk_score: number }) => (r.sndk_score ?? 50) < 35)
        if (decayed.length > 0) {
          const decayMsg = decayed.map((r: { symbol: string; sndk_score: number }) => `${r.symbol} score=${r.sndk_score}`).join(', ')
          console.warn(`[eod][${broker}] Trend score decay detected: ${decayMsg}`)
          await db.from('tb_alerts').insert({
            type: 'WARN', broker,
            message: `[SNDK DECAY] Trend positions with weakened thesis (score<35): ${decayMsg} — review for trim`,
          })
          rebalanceResults.push(`[${broker}] ⚠ Score decay: ${decayMsg}`)
        }

        if (ltPct <= 0.28 || ltPositions.length === 0) {
          rebalanceResults.push(`[${broker}] LT ${(ltPct*100).toFixed(0)}% — no rebalance needed`)
          continue
        }

        // Look up current SNDK scores from tb_discoveries
        const { data: scores } = await db
          .from('tb_discoveries')
          .select('symbol, sndk_score')
          .in('symbol', ltPositions.map((p) => p.symbol))
        const scoreMap = new Map((scores ?? []).map((r: { symbol: string; sndk_score: number }) => [r.symbol, r.sndk_score]))

        // Sort by score ascending — weakest first
        const sorted = [...ltPositions].sort((a, b) =>
          (scoreMap.get(a.symbol) ?? 0) - (scoreMap.get(b.symbol) ?? 0)
        )

        // Trim weakest positions until exposure drops below 28%.
        // First pass: prefer score < 35 (degraded thesis). If all score ≥ 35 but
        // sleeve is still overweight, trim the single weakest anyway — exposure cap
        // takes priority over letting every individual position run.
        let runningExposure = ltExposure
        let trimmed = 0
        for (const pos of sorted) {
          if (runningExposure / equity <= 0.28) break  // exposure now under cap
          if (trimmed >= 2) break                       // never trim more than 2 per week
          const score = scoreMap.get(pos.symbol) ?? 50
          const posValue = Math.abs(pos.market_value ?? pos.current_price * pos.quantity)
          const result = broker === 'alpaca_paper'
            ? await AlpacaBroker.closePosition(pos.symbol).catch(() => null)
            : await SchwabBroker.placeOrder(pos.symbol, Math.abs(pos.quantity), 'SELL', 'MARKET').catch(() => null)
          if (result?.status === 'PLACED') {
            runningExposure -= posValue
            await db.from('tb_alerts').insert({
              type: 'SELL', symbol: pos.symbol, broker,
              message: `[REBALANCE] Trimmed LT ${pos.symbol} (score=${score}) — sleeve ${(ltPct*100).toFixed(0)}%→${(runningExposure/equity*100).toFixed(0)}%`,
            })
            rebalanceResults.push(`[${broker}] Trimmed ${pos.symbol} score=${score} → sleeve now ${(runningExposure/equity*100).toFixed(0)}%`)
            trimmed++
          }
        }
        if (trimmed === 0) rebalanceResults.push(`[${broker}] LT ${(ltPct*100).toFixed(0)}% — no trim (${ltPositions.length} pos)`)
      } catch (e) {
        console.error('[eod] rebalance error:', e)
      }
    }

    if (tgBot && tgChat && rebalanceResults.some((r) => r.includes('Trimmed'))) {
      await fetch(`https://api.telegram.org/bot${tgBot}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChat,
          text: `🔄 *LT Sleeve Friday Rebalance*\n${rebalanceResults.join('\n')}`,
          parse_mode: 'Markdown',
        }),
      }).catch(() => {})
    }
  }

  return NextResponse.json({ status: 'ok', date: today(), reports })
}
