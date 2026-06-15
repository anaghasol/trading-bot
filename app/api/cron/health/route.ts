/**
 * CRON: /api/cron/health — Self-healing system monitor
 * Runs every 30 min during market hours.
 *
 * What it does:
 *  1. Detects broker positions with no tb_trades journal → auto-inserts entries
 *     so the monitor can immediately start managing stops/exits.
 *  2. Checks scan + monitor cron frequency — alerts if either goes silent.
 *  3. Detects repeated error patterns in tb_cron_log (daily_loss stuck, etc.)
 *  4. Verifies Schwab auth status.
 *  5. Sends SMS for anything it can't auto-fix.
 *
 * Schedule: "0,30 13-20 * * 1-5"  (every 30 min, 9 AM – 4 PM ET)
 */
import { NextResponse } from 'next/server'
import * as AlpacaBroker from '@/lib/alpaca'
import * as SchwabBroker from '@/lib/schwab'
import { getSchwabAuthStatus } from '@/lib/schwab'
import { sendHealthAlert } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function etHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db      = createServiceClient()
  const issues:  string[] = []
  const healed:  string[] = []
  const today   = new Date().toISOString().split('T')[0]
  const now     = new Date()

  // ── 1. UNJOURNALED POSITIONS ───────────────────────────────────────────────
  // For each broker, find live positions with no open tb_trades entry.
  // Auto-insert a minimal journal row so the monitor can manage stops/exits.
  for (const broker of ['schwab', 'alpaca_paper'] as const) {
    const isSchwab = broker === 'schwab'
    try {
      const positions = isSchwab
        ? await SchwabBroker.getPositions().catch(() => [] as Awaited<ReturnType<typeof SchwabBroker.getPositions>>)
        : await AlpacaBroker.getPositions().catch(() => [] as Awaited<ReturnType<typeof AlpacaBroker.getPositions>>)

      if (positions.length === 0) continue

      const { data: openTrades } = await db
        .from('tb_trades')
        .select('symbol')
        .eq('status', 'OPEN')
        .or(isSchwab ? 'broker.eq.schwab,broker.is.null' : 'broker.eq.alpaca_paper')

      const journaledSymbols = new Set((openTrades ?? []).map((t) => t.symbol as string))

      for (const pos of positions) {
        if (journaledSymbols.has(pos.symbol)) continue

        // Position exists at broker but has no journal — auto-create one
        const entryPrice = pos.avg_cost > 0 ? pos.avg_cost : pos.current_price
        const stopPrice  = entryPrice * (isSchwab ? 0.975 : 0.965)

        const { error } = await db.from('tb_trades').insert({
          symbol:      pos.symbol,
          broker,
          status:      'OPEN',
          entry_price: entryPrice,
          quantity:    Math.abs(pos.quantity),
          strategy:    'RECOVERED',
          confidence:  70,
          reason:      `stop=$${stopPrice.toFixed(2)} | auto-journaled by health check (position existed at broker without tb_trades entry)`,
          peak_pnl:    Math.max(0, pos.pnl_pct),
          created_at:  new Date(now.getTime() - 86_400_000).toISOString(), // assume entered yesterday
        })

        if (!error) {
          healed.push(`[${broker}] AUTO-JOURNALED ${pos.symbol} @ $${entryPrice.toFixed(2)} (was untracked)`)
          await db.from('tb_alerts').insert({
            type: 'INFO', symbol: pos.symbol, broker,
            message: `[health] Auto-journaled ${pos.symbol} (${broker}) @ $${entryPrice.toFixed(2)} — position existed without journal entry`,
          })
        } else {
          issues.push(`[${broker}] Failed to auto-journal ${pos.symbol}: ${error.message}`)
        }
      }
    } catch (e) {
      issues.push(`[${broker}] Position check failed: ${String(e)}`)
    }
  }

  // ── 2. CRON FREQUENCY CHECK ────────────────────────────────────────────────
  // Scan should fire every 10 min, monitor every 5 min.
  // Alert if either has been silent > 25 min or > 12 min respectively.
  try {
    const cutoff30 = new Date(now.getTime() - 30 * 60_000).toISOString()
    const { data: recentLogs } = await db
      .from('tb_cron_log')
      .select('job, created_at')
      .gte('created_at', cutoff30)
      .order('created_at', { ascending: false })

    const lastScan    = recentLogs?.find((r) => r.job === 'scan')?.created_at
    const lastMonitor = recentLogs?.find((r) => r.job === 'monitor')?.created_at

    const scanAgeMin    = lastScan    ? Math.round((now.getTime() - new Date(lastScan).getTime())    / 60_000) : 999
    const monitorAgeMin = lastMonitor ? Math.round((now.getTime() - new Date(lastMonitor).getTime()) / 60_000) : 999

    const h = etHour()
    const isMarketHours = h >= 9 && h < 16

    if (isMarketHours && scanAgeMin > 25) {
      issues.push(`SCAN CRON SILENT: last fired ${scanAgeMin}m ago (expected every 10m)`)
    }
    if (isMarketHours && monitorAgeMin > 12) {
      issues.push(`MONITOR CRON SILENT: last fired ${monitorAgeMin}m ago (expected every 5m)`)
    }
  } catch (e) {
    issues.push(`Cron frequency check failed: ${String(e)}`)
  }

  // ── 3. ERROR PATTERN DETECTION ─────────────────────────────────────────────
  // Check last 30 min of cron logs for repeated failure patterns.
  try {
    const cutoff30 = new Date(now.getTime() - 30 * 60_000).toISOString()
    const { data: recentLogs } = await db
      .from('tb_cron_log')
      .select('job, message, status')
      .gte('created_at', cutoff30)

    const scanLogs = (recentLogs ?? []).filter((r) => r.job === 'scan')
    const schwabBlocked = scanLogs.filter((r) => String(r.message).includes('Daily loss limit hit')).length
    if (schwabBlocked >= 3) {
      issues.push(`Schwab scan blocked by daily-loss-limit for ${schwabBlocked} consecutive runs — check realized P/L today`)
    }

    const noJournalLogs = (recentLogs ?? []).filter((r) => String(r.message).includes('no journal'))
    if (noJournalLogs.length >= 3) {
      const match = String(noJournalLogs[0]?.message ?? '').match(/(\w+): no journal/)
      if (match) issues.push(`'no journal' persisting after health run for ${match[1]} — check tb_trades insert`)
    }

    const errorRuns = (recentLogs ?? []).filter((r) => r.status === 'error')
    if (errorRuns.length >= 2) {
      issues.push(`${errorRuns.length} cron errors in last 30 min: ${errorRuns.map((r) => r.job).join(', ')}`)
    }
  } catch (e) {
    issues.push(`Error pattern check failed: ${String(e)}`)
  }

  // ── 4. SCHWAB AUTH CHECK ───────────────────────────────────────────────────
  try {
    const auth = await getSchwabAuthStatus()
    if (!auth.ok) {
      issues.push(`Schwab token EXPIRED — all live trades blocked`)
    } else if ((auth.hours_left ?? 999) < 24) {
      issues.push(`Schwab token expires in ${auth.hours_left}h — re-authorize before tomorrow`)
    }
  } catch { /* non-fatal */ }

  // ── 5. LOG + SMS ───────────────────────────────────────────────────────────
  const summary = [
    healed.length ? `Healed: ${healed.join('; ')}` : null,
    issues.length ? `Issues: ${issues.join('; ')}` : null,
  ].filter(Boolean).join(' | ') || 'All systems healthy'

  await db.from('tb_cron_log').insert({
    job: 'health', status: issues.length ? 'warn' : 'success',
    trades_made: healed.length,
    message: summary,
  })

  if (issues.length > 0) {
    await sendHealthAlert(issues, healed).catch(() => {})
  }

  return NextResponse.json({
    status: issues.length ? 'issues_found' : 'healthy',
    healed, issues, summary,
  })
}
