/**
 * RELAY AUDIT — continuous source→relay reconciliation. Self-healing.
 *
 * poll-sf is a forward-only mirror: it walks a watermark and never looks back.
 * Anything it drops (rate limit, send failure, wrong topic, stuck watermark,
 * a wiped topic map) is invisible and permanent. That is exactly how 4 days of
 * Pavan's messages silently vanished into duplicate topics in Aug 2026.
 *
 * This cron closes that hole. It compares what is actually IN each relay topic
 * against what is actually IN the source topic over a rolling window, and
 * re-sends whatever is missing — regardless of why it went missing.
 *
 * Identity key: every relayed message carries "· <stamp> ET" in its header,
 * so a gap in the MIDDLE is detected, not just a trailing cutoff.
 *
 * Health keys: relay_audit_last, relay_audit_status
 */

export const runtime     = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession } from '@/lib/telegram-client'
import { createServiceClient } from '@/lib/supabase-server'

const API_ID     = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH   = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN ?? ''
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''
const ALERT_CHAT = process.env.TELEGRAM_ALLOWED_CHAT_ID ?? ''

const SF_CHANNEL_ID: string | number = (() => {
  const raw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  const n = parseInt(raw)
  return isNaN(n) ? raw : n
})()

/** Rolling window to reconcile. Wide enough to cover a long weekend outage. */
const LOOKBACK_HOURS = 72
/** Cap per run so one bad day cannot blow the 300s budget or trip TG flood limits. */
const MAX_HEAL_PER_RUN = 12

/** Must match buildHeader() in lib/telegram-topics.ts exactly. */
function stamp(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

async function tgPost(method: string, body: unknown, isForm = false): Promise<true | string> {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        isForm
          ? { method: 'POST', body: body as FormData }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json() as { ok: boolean; description?: string; parameters?: { retry_after?: number } }
      if (d.ok) return true
      const wait = d.parameters?.retry_after
      if (wait && wait < 60) { await new Promise(r => setTimeout(r, (wait + 1) * 1000)); continue }
      return d.description ?? 'unknown error'
    } catch (e) { return String(e).slice(0, 80) }
  }
  return 'retry limit hit'
}

async function alert(text: string) {
  if (!BOT_TOKEN || !ALERT_CHAT) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ALERT_CHAT, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {})
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = searchParams.get('dry') === '1'
  const db = createServiceClient()

  if (!BOT_TOKEN || !RELAY_CHAT || !SF_CHANNEL_ID) {
    return NextResponse.json({ ok: false, reason: 'relay not configured' })
  }

  const sessionStr = await getStoredSession()
  if (!sessionStr) {
    await alert('🔴 *Relay Audit* — no Telegram session. Visit /tg-connect.')
    return NextResponse.json({ ok: false, reason: 'no session' })
  }

  const { data: mapRow } = await db.from('tb_settings').select('value').eq('key', 'tg_mirror_topic_map').single()
  let topicMap: Record<string, number> = {}
  try { topicMap = JSON.parse(mapRow?.value ?? '{}') } catch { /* stays empty */ }

  if (Object.keys(topicMap).length === 0) {
    await alert('🔴 *Relay Audit* — `tg_mirror_topic_map` is EMPTY.\n\nThis is the failure that forked the relay into duplicate topics in Aug 2026. poll-sf will now fall back to the canonical map, but investigate what cleared this row.')
    return NextResponse.json({ ok: false, reason: 'topic map empty' })
  }

  let client: TelegramClient | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
      await client.connect()
      break
    } catch {
      client = null
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  if (!client) {
    await db.from('tb_settings').upsert({ key: 'relay_audit_status', value: 'tg_connect_failed' })
    return NextResponse.json({ ok: false, reason: 'tg connect failed' })
  }

  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600
  const report: Array<{ src: number; relay: number; missing: number; healed: number; failed: number }> = []
  let totalMissing = 0, totalHealed = 0, totalFailed = 0
  const failures: string[] = []

  try {
    for (const [srcStr, relayThread] of Object.entries(topicMap)) {
      const srcTopic = parseInt(srcStr)

      let srcMsgs: Awaited<ReturnType<typeof client.getMessages>>
      let relMsgs: Awaited<ReturnType<typeof client.getMessages>>
      try {
        srcMsgs = await client.getMessages(SF_CHANNEL_ID, { limit: 200, replyTo: srcTopic })
        relMsgs = await client.getMessages(parseInt(RELAY_CHAT), { limit: 300, replyTo: relayThread })
      } catch {
        continue  // topic may be closed/deleted — other topics still reconcile
      }

      // What has actually landed in the relay, keyed by the source timestamp
      // embedded in each relayed header.
      const present = new Set<string>()
      for (const m of relMsgs) {
        const t = m.text ?? ''
        const hit = t.match(/·\s*(.+?)\s*ET/)
        if (hit) present.add(hit[1].trim())
      }

      const missing = srcMsgs
        .filter(m => m.date >= since && ((m.text?.length ?? 0) > 3 || m.media != null))
        .filter(m => !present.has(stamp(m.date)))
        .sort((a, b) => a.id - b.id)

      let healed = 0, failed = 0
      if (!dryRun) {
        for (const m of missing.slice(0, MAX_HEAL_PER_RUN)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = (m as any).sender
          const name: string = s?.firstName
            ? `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`
            : s?.username ?? 'Member'
          const header = `👤 ${name} · ${stamp(m.date)} ET`

          let sent: true | string = 'not attempted'
          if (m.media) {
            try {
              const media = m.media as unknown as Record<string, unknown>
              const isPhoto = media.className === 'MessageMediaPhoto'
              const docMime = String((media.document as Record<string, unknown>)?.mimeType ?? '')
              if (isPhoto || (media.className === 'MessageMediaDocument' && docMime.startsWith('image/'))) {
                const buf = await client.downloadMedia(m, {}) as Buffer | undefined
                if (buf && buf.length >= 500 && buf.length < 5_000_000) {
                  const mime = isPhoto ? 'image/jpeg' : docMime
                  const form = new FormData()
                  form.append('chat_id', RELAY_CHAT)
                  form.append('message_thread_id', String(relayThread))
                  form.append('caption', `${header}\n\n${m.text ?? '📸'}`.slice(0, 1024))
                  form.append(isPhoto ? 'photo' : 'document',
                    new Blob([new Uint8Array(buf)], { type: mime }), isPhoto ? 'photo.jpg' : 'file')
                  sent = await tgPost(isPhoto ? 'sendPhoto' : 'sendDocument', form, true)
                }
              }
            } catch { /* fall through to text */ }
          }
          // Plain text (no parse_mode — source text has unbalanced * and _ that break Markdown)
          if (sent !== true) {
            sent = await tgPost('sendMessage', {
              chat_id: RELAY_CHAT,
              message_thread_id: relayThread,
              text: `${header}\n\n${m.text || '📸'}`,
            })
          }

          if (sent === true) healed++
          else { failed++; if (failures.length < 5) failures.push(`#${m.id}: ${sent}`) }
          await new Promise(r => setTimeout(r, 1500))  // stay under TG group flood limit
        }
      }

      totalMissing += missing.length
      totalHealed  += healed
      totalFailed  += failed
      report.push({ src: srcTopic, relay: relayThread, missing: missing.length, healed, failed })
    }
  } finally {
    await client.disconnect().catch(() => {})
  }

  const status = totalFailed > 0 ? `healed ${totalHealed}, FAILED ${totalFailed}`
               : totalHealed > 0 ? `healed ${totalHealed}`
               : 'in sync'

  await db.from('tb_settings').upsert({ key: 'relay_audit_last',   value: new Date().toISOString() })
  await db.from('tb_settings').upsert({ key: 'relay_audit_status', value: status })

  // Only speak up when something was actually wrong — silence means healthy.
  if (!dryRun && (totalHealed > 0 || totalFailed > 0)) {
    const lines = report.filter(r => r.missing > 0)
      .map(r => `• src#${r.src} → rel#${r.relay}: ${r.healed} restored${r.failed ? `, ${r.failed} failed` : ''}`)
    await alert(
      `${totalFailed > 0 ? '🔴' : '🩹'} *Relay Self-Heal*\n\n` +
      `Found ${totalMissing} message(s) missing from the relay and restored ${totalHealed}.\n\n` +
      lines.join('\n') +
      (failures.length ? `\n\nErrors:\n${failures.join('\n')}` : '') +
      (totalMissing > MAX_HEAL_PER_RUN * Object.keys(topicMap).length
        ? `\n\n_Capped at ${MAX_HEAL_PER_RUN}/topic per run — next run continues._` : '')
    )
  }

  return NextResponse.json({ ok: true, dry_run: dryRun, lookback_hours: LOOKBACK_HOURS, status, total_missing: totalMissing, total_healed: totalHealed, total_failed: totalFailed, report })
}
