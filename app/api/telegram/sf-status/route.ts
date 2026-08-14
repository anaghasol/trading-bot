/**
 * GET /api/telegram/sf-status
 *
 * Diagnoses why poll-sf might be silent. Checks:
 *  1. Env vars configured
 *  2. TG session exists
 *  3. Can connect to Telegram
 *  4. Can read messages from SF channel (returns latest 3 IDs)
 *  5. Current watermark vs latest message ID
 *  6. Can bot send to relay group
 *  7. Topic map cached in Supabase
 *
 * Add ?reset_watermark=1 to reset tg_last_msg_id_sf_trades → 0
 * so poll-sf will pick up the most recent messages next run.
 *
 * Add ?reset_topics=1 to clear pavan_topics_json and tg_mirror_topic_map
 * so topics are re-discovered on next run.
 */
import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession } from '@/lib/telegram-client'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime    = 'nodejs'
export const maxDuration = 60

const API_ID    = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH  = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const SF_CHANNEL_ID: string | number = (() => {
  const raw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  const n = parseInt(raw)
  return isNaN(n) ? raw : n
})()
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()
  const report: Record<string, unknown> = {}

  // ── 1. Env config ──────────────────────────────────────────────────────────
  report.env = {
    sf_channel_id:    SF_CHANNEL_ID || 'NOT SET',
    relay_chat_id:    RELAY_CHAT    || 'NOT SET',
    bot_token_set:    !!BOT_TOKEN,
    api_id_set:       !!API_ID,
  }

  // ── 2. Watermark + topic cache ──────────────────────────────────────────────
  const [wmRow, topicsRow, topicMapRow, relayRow, dedupeRow] = await Promise.all([
    db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id_sf_trades').single(),
    db.from('tb_settings').select('value').eq('key', 'pavan_topics_json').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_mirror_topic_map').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_sf_relay_last_msg').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_relay_sent_ids').single(),
  ])

  const watermark    = parseInt(wmRow.data?.value ?? '0')
  const dedupeIds    = (dedupeRow.data?.value ?? '').split(',').filter(Boolean).map(Number)
  const topicMap     = topicMapRow.data?.value ? JSON.parse(topicMapRow.data.value) : {}
  const pavanTopics  = topicsRow.data?.value   ? JSON.parse(topicsRow.data.value)   : {}

  report.watermark = {
    tg_last_msg_id_sf_trades: watermark,
    relay_last_msg:           relayRow.data?.value ?? 'never',
    dedup_ids_cached:         dedupeIds.length,
    dedup_latest_ids:         dedupeIds.slice(-5),
  }
  report.topic_cache = {
    pavan_topics_count:  Object.keys(pavanTopics).length,
    mirror_topic_map:    topicMap,
  }

  // ── 3. Reset options ────────────────────────────────────────────────────────
  if (searchParams.get('reset_watermark') === '1') {
    await db.from('tb_settings').upsert({ key: 'tg_last_msg_id_sf_trades', value: '0' })
    report.reset_watermark = 'DONE — watermark reset to 0, poll-sf will re-scan next run'
  }
  if (searchParams.get('reset_topics') === '1') {
    await db.from('tb_settings').delete().eq('key', 'pavan_topics_json')
    await db.from('tb_settings').delete().eq('key', 'tg_mirror_topic_map')
    report.reset_topics = 'DONE — topic cache cleared, will re-discover on next run'
  }

  // ── 4. TG session check ─────────────────────────────────────────────────────
  const sessionStr = await getStoredSession()
  report.session = { exists: !!sessionStr, length: sessionStr?.length ?? 0 }
  if (!sessionStr) {
    return NextResponse.json({ ...report, verdict: 'NO SESSION — visit /tg-connect' })
  }

  // ── 5. TG connect + channel probe ──────────────────────────────────────────
  let client: TelegramClient | null = null
  try {
    client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
    await client.connect()
    report.tg_connect = 'OK'
  } catch (e) {
    report.tg_connect = `FAILED: ${String(e).slice(0, 120)}`
    return NextResponse.json({ ...report, verdict: 'TG CONNECT FAILED — session may be expired, visit /tg-connect' })
  }

  try {
    const msgs = await client.getMessages(SF_CHANNEL_ID, { limit: 5 })
    const latest = msgs.map(m => ({ id: m.id, text: (m.text ?? '').slice(0, 60), has_media: !!m.media }))
    report.sf_channel = {
      status:         'OK — can read messages',
      latest_ids:     latest.map(m => m.id),
      latest_texts:   latest.map(m => m.text),
      watermark_vs_latest: watermark,
      newest_id:      latest[0]?.id ?? 0,
      gap:            (latest[0]?.id ?? 0) - watermark,
      verdict:        (latest[0]?.id ?? 0) <= watermark
        ? 'WATERMARK STUCK — newest msg is older than or equal to watermark, nothing appears new'
        : `${(latest[0]?.id ?? 0) - watermark} new messages should be picked up next run`,
    }
  } catch (e) {
    report.sf_channel = `FAILED: ${String(e).slice(0, 150)}`
    report.sf_channel_verdict = 'Bot may have lost access to SF channel — check if account is still in the channel'
  }

  // ── 6. Relay group bot probe ────────────────────────────────────────────────
  if (BOT_TOKEN && RELAY_CHAT) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: RELAY_CHAT }),
        signal: AbortSignal.timeout(5_000),
      })
      const data = await res.json() as { ok: boolean; result?: { title?: string; type?: string }; description?: string }
      report.relay_group = data.ok
        ? { status: 'OK', title: data.result?.title, type: data.result?.type }
        : { status: `FAILED: ${data.description}` }
    } catch (e) {
      report.relay_group = `ERROR: ${String(e).slice(0, 80)}`
    }
  } else {
    report.relay_group = 'NOT CONFIGURED — BOT_TOKEN or RELAY_CHAT_ID missing'
  }

  await client.disconnect().catch(() => {})

  // ── 7. Overall verdict ──────────────────────────────────────────────────────
  const sfOk     = typeof report.sf_channel === 'object' && (report.sf_channel as Record<string,unknown>).status === 'OK — can read messages'
  const relayOk  = typeof report.relay_group === 'object' && (report.relay_group as Record<string,unknown>).status === 'OK'
  const gap      = sfOk ? (report.sf_channel as Record<string,unknown>).gap as number : -1
  const stuck    = sfOk && gap <= 0

  report.verdict = stuck
    ? 'WATERMARK STUCK — add ?reset_watermark=1 to fix'
    : !sfOk
    ? 'SF CHANNEL ACCESS FAILED — bot may have been removed from channel'
    : !relayOk
    ? 'RELAY GROUP UNREACHABLE — bot may have been removed from relay group'
    : `ALL OK — ${gap} new message(s) pending, will be relayed next poll-sf run`

  return NextResponse.json(report)
}
