/**
 * CRON: /api/cron/tg-watchdog — 24/7 TG relay monitor
 * Runs every 5 minutes around the clock.
 *
 * Sends an SMS via Twilio (independent of Telegram) if either poller has been
 * silent for 5+ minutes. Prevents silent failures outside market hours.
 * Uses 30-min dedupe per poller so you're not spammed every 5 minutes.
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendHealthAlert } from '@/lib/notify'

export const runtime = 'nodejs'
export const maxDuration = 15

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

const POLLERS = [
  { label: '3-channel TG poller (US Equities / SF Essential / Jimmy)', pingKey: 'tg_cron_ping',    alertKey: 'tg_watchdog_alerted_at' },
  { label: 'SF Trades exclusive poller (Pavan)',                        pingKey: 'tg_sf_cron_ping', alertKey: 'tg_sf_watchdog_alerted_at' },
] as const

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db   = createServiceClient()
  const now  = Date.now()
  const down: string[] = []

  for (const p of POLLERS) {
    const [pingRow, alertRow] = await Promise.all([
      db.from('tb_settings').select('value').eq('key', p.pingKey).single(),
      db.from('tb_settings').select('value').eq('key', p.alertKey).single(),
    ])

    const lastPing  = pingRow.data?.value  ? new Date(pingRow.data.value).getTime()  : 0
    const lastAlert = alertRow.data?.value ? new Date(alertRow.data.value).getTime() : 0
    const silentMin = lastPing > 0 ? Math.round((now - lastPing) / 60_000) : null

    const isDown = lastPing === 0 || (silentMin ?? 999) > 5
    const canAlert = now - lastAlert > 30 * 60_000   // alert at most once per 30 min

    if (isDown && canAlert) {
      await db.from('tb_settings').upsert({ key: p.alertKey, value: new Date().toISOString() })
      down.push(`${p.label} — silent ${silentMin == null ? 'always' : `${silentMin}m`}`)
    }
  }

  if (down.length > 0) {
    // SMS via Twilio — independent of TG, works even when TG itself is down
    await sendHealthAlert(
      down.map(d => `🔴 TG relay down: ${d}. Visit /tg-connect to restore.`),
      [],
    ).catch(() => {})

    // Also post to SF Trades Relay group so members see relay is paused
    const bot      = process.env.TELEGRAM_BOT_TOKEN
    const relayCht = process.env.TELEGRAM_RELAY_CHAT_ID
    if (bot && relayCht) {
      const lines = down.map(d => `• ${d}`)
      await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: relayCht,
          text: `⚠️ *MyTrade relay paused*\n\n${lines.join('\n')}\n\nMessages from source channels will not appear here until reconnected. Visit /tg-connect to restore.`,
          parse_mode: 'Markdown',
        }),
      }).catch(() => {})
    }
  }

  return NextResponse.json({ ok: true, checked: POLLERS.length, down })
}
