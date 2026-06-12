/**
 * /api/monitor — aggregates system health + pipeline state for the Live Monitor page.
 *
 * Returns everything the animated dashboard needs:
 *   - Last scan snapshot per broker (from tb_settings last_scan_*)
 *   - Recent cron run log (last 10 from tb_cron_log)
 *   - Open trades summary
 *   - Recent alerts (last 8 from tb_alerts)
 *   - TG poller watermarks (last poll time)
 *   - Health checks: Schwab, Alpaca, Anthropic reachability
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function GET() {
  const db = createServiceClient()

  const [settingsRes, cronRes, tradesRes, alertsRes] = await Promise.allSettled([
    // Settings: last scan snapshots + TG watermarks
    db.from('tb_settings')
      .select('key, value')
      .in('key', [
        'last_scan_schwab',
        'last_scan_alpaca_paper',
        'tg_last_msg_id',
        'tg_last_msg_id_us_equities',
        'tg_macro_stance',
      ]),

    // Cron log: last 12 runs across all jobs
    db.from('tb_cron_log')
      .select('job, status, trades_made, message, created_at')
      .order('created_at', { ascending: false })
      .limit(12),

    // Open trades
    db.from('tb_trades')
      .select('symbol, action, quantity, entry_price, confidence, strategy, created_at, broker')
      .eq('status', 'OPEN')
      .order('created_at', { ascending: false })
      .limit(20),

    // Recent alerts
    db.from('tb_alerts')
      .select('type, message, symbol, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const settings: Record<string, string> = {}
  if (settingsRes.status === 'fulfilled') {
    for (const row of settingsRes.value.data ?? []) {
      settings[row.key] = row.value
    }
  }

  // Parse last scan snapshots
  const parseScan = (key: string) => {
    try { return settings[key] ? JSON.parse(settings[key]) : null } catch { return null }
  }
  const scanSchwab  = parseScan('last_scan_schwab')
  const scanAlpaca  = parseScan('last_scan_alpaca_paper')

  // TG poller last-seen timestamps (watermarks are message IDs, not timestamps —
  // proxy: check the most recent tb_alerts row with source containing 'tg')
  const tgMacro = (() => {
    try {
      const raw = settings['tg_macro_stance']
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  })()

  // Health probes (fire-and-forget, 4s timeout each)
  const probe = async (url: string): Promise<'ok' | 'slow' | 'down'> => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MyTrade-Monitor/1.0' } })
      clearTimeout(t)
      return r.ok || r.status === 401 || r.status === 403 ? 'ok' : 'slow'
    } catch {
      return 'down'
    }
  }

  const [schwabHealth, alpacaHealth, claudeHealth] = await Promise.all([
    probe('https://api.schwabapi.com/marketdata/v1/markets'),
    probe('https://paper-api.alpaca.markets/v2/clock'),
    probe('https://api.anthropic.com'),
  ])

  const cronLogs = cronRes.status === 'fulfilled' ? cronRes.value.data ?? [] : []
  const openTrades = tradesRes.status === 'fulfilled' ? tradesRes.value.data ?? [] : []
  const recentAlerts = alertsRes.status === 'fulfilled' ? alertsRes.value.data ?? [] : []

  // Last run time per cron job
  const lastRun: Record<string, string> = {}
  for (const row of cronLogs) {
    if (!lastRun[row.job]) lastRun[row.job] = row.created_at
  }

  return NextResponse.json({
    ts: new Date().toISOString(),
    health: {
      schwab:  schwabHealth,
      alpaca:  alpacaHealth,
      claude:  claudeHealth,
      tg_poller: tgMacro ? 'ok' : 'unknown',
    },
    scans: {
      schwab: scanSchwab,
      alpaca: scanAlpaca,
    },
    cron: {
      last_run: lastRun,
      recent:   cronLogs.slice(0, 6),
    },
    trades: {
      open_count: openTrades.length,
      open:       openTrades.slice(0, 8),
    },
    alerts:    recentAlerts,
    tg: {
      macro_stance: tgMacro?.stance ?? 'unknown',
      macro_set_at: tgMacro?.set_at ?? null,
    },
  })
}
