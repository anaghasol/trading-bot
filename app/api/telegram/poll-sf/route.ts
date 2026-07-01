/**
 * POLLER 2 — SF Trades (Pavan exclusive paid channel) — PURE MIRROR
 *
 * Copies every message from Pavan's SF Essential Trades channel → SF Trades Relay group.
 * Topic routing: each of Pavan's forum topics maps to a matching topic in the relay group.
 * Images are forwarded with Groq vision OCR appended to caption (free, no paid models).
 *
 * No signal parsing. No trade execution. All intelligence + trading is in the 3-channel poller.
 *
 * Health keys: tg_sf_cron_ping, tg_sf_last_poll, tg_sf_status, tg_sf_relay_last_msg
 * Watermark:   tg_last_msg_id_sf_trades
 */

export const runtime    = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession, saveSession } from '@/lib/telegram-client'
import { mirrorIfNew, getOrCreateMirrorThread } from '@/lib/telegram-topics'
import { createServiceClient } from '@/lib/supabase-server'

const API_ID     = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH   = process.env.TELEGRAM_API_HASH ?? ''
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const GROUP_ID   = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '0')
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''

const SF_CHANNEL_ID: string | number = (() => {
  const raw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  const n = parseInt(raw)
  return isNaN(n) ? raw : n
})()

export async function GET(req: Request) {
  const db = createServiceClient()

  await db.from('tb_settings').upsert({ key: 'tg_sf_cron_ping', value: new Date().toISOString() }).then(() => {}, () => {})

  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!SF_CHANNEL_ID) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'not_configured' })
    return NextResponse.json({ ok: false, reason: 'TELEGRAM_SF_TRADES_CHANNEL_ID not set' })
  }

  const sessionStr = await getStoredSession()
  if (!sessionStr) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'no_session' })
    return NextResponse.json({ error: 'Not authenticated. Visit /tg-connect first.' })
  }

  let client: TelegramClient | null = null
  let connectErr: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
      await client.connect()
      connectErr = null
      break
    } catch (e) {
      connectErr = String(e).slice(0, 120)
      client = null
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }

  if (!client || connectErr) {
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: `error: ${connectErr}` })
    const { data: lastAlertRow } = await db.from('tb_settings').select('value').eq('key', 'tg_sf_disconnect_alerted_at').single()
    const lastAlert = lastAlertRow?.value ? new Date(lastAlertRow.value).getTime() : 0
    if (BOT_TOKEN && Date.now() - lastAlert > 30 * 60_000) {
      await db.from('tb_settings').upsert({ key: 'tg_sf_disconnect_alerted_at', value: new Date().toISOString() })
      const alertText = `🔴 *SF Trades Poller — Connection Lost*\n\nRelay from Pavan's channel is paused.\nFailed to connect after 3 attempts.\n\nError: ${connectErr}\n\nVisit /tg-connect to restore.`
      for (const chatId of [GROUP_ID, RELAY_CHAT].filter(Boolean)) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alertText, parse_mode: 'Markdown' }),
        }).catch(() => {})
      }
    }
    return NextResponse.json({ ok: false, error: 'TG connect failed after 3 retries', detail: connectErr })
  }

  try { await saveSession(client.session.save() as unknown as string) } catch { /* non-fatal */ }

  await db.from('tb_settings').upsert({ key: 'tg_sf_last_poll', value: new Date().toISOString() })
  await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: 'ok' })

  const WATERMARK_KEY = 'tg_last_msg_id_sf_trades'
  const { data: lastData } = await db.from('tb_settings').select('value').eq('key', WATERMARK_KEY).single()
  const lastId = parseInt(lastData?.value ?? '0')

  let messages: Awaited<ReturnType<typeof client.getMessages>>
  try {
    messages = await client.getMessages(SF_CHANNEL_ID, { limit: 10 })
  } catch (e) {
    await client.disconnect().catch(() => {})
    await db.from('tb_settings').upsert({ key: 'tg_sf_status', value: `error: getMessages failed: ${String(e).slice(0, 80)}` })
    return NextResponse.json({ ok: false, error: 'getMessages failed', detail: String(e) })
  }

  const newMsgs = messages
    .filter(m => m.id > lastId && (m.text?.length > 3 || m.media != null))
    .sort((a, b) => b.id - a.id)
    .slice(0, 5)

  if (newMsgs.length === 0) {
    await client.disconnect().catch(() => {})
    return NextResponse.json({ ok: true, channel: 'SF Trades', new: 0, checked: messages.length })
  }

  // Discover Pavan's forum topics on first run, cache in Supabase
  let pavanTopics: Record<number, string> = {}
  try {
    const { data: topicCache } = await db.from('tb_settings').select('value').eq('key', 'pavan_topics_json').single()
    if (topicCache?.value) {
      pavanTopics = JSON.parse(topicCache.value)
    } else {
      const { Api } = await import('telegram')
      const entity = await client.getInputEntity(SF_CHANNEL_ID)
      const result = await client.invoke(new Api.channels.GetForumTopics({
        channel: entity as unknown as import('telegram').Api.InputChannel,
        limit: 100, offsetId: 0, offsetDate: 0, offsetTopic: 0, q: '',
      })) as { topics: Array<{ id: number; title: string }> }
      result.topics.forEach(t => { pavanTopics[t.id] = t.title })
      await db.from('tb_settings').upsert({ key: 'pavan_topics_json', value: JSON.stringify(pavanTopics) })
    }
  } catch { /* non-fatal — defaults to thread 89 */ }

  const results: { id: number; type: string }[] = []
  let maxDeliveredId = lastId  // only advance watermark for confirmed deliveries

  for (const msg of newMsgs) {
    const text = msg.text ?? ''

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sender = (msg as any).sender
    const senderName: string = sender?.firstName
      ? `${sender.firstName}${sender.lastName ? ` ${sender.lastName}` : ''}`
      : sender?.username ?? 'Member'

    // Nested replies: replyToTopId → topic root; topic openers: forumTopic=true + replyToMsgId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replyTo = (msg as any).replyTo
    const srcTopicId: number | null =
      replyTo?.replyToTopId
      ?? (replyTo?.forumTopic ? replyTo?.replyToMsgId : null)
      ?? null
    const srcTopicName = (srcTopicId && pavanTopics[srcTopicId]) ? pavanTopics[srcTopicId] : 'SF Essential Trades'

    const relayThreadId = srcTopicId
      ? await getOrCreateMirrorThread(srcTopicId, srcTopicName, db)
      : 89  // default: "SF Essential Trades( Buy /Sell Alerts)"

    // Download image and forward as-is — no OCR, pure mirror
    let imageBuffer: Buffer | undefined
    let imageMime: string | undefined
    if (msg.media) {
      try {
        const media = msg.media as unknown as Record<string, unknown>
        const isPhoto    = media.className === 'MessageMediaPhoto'
        const docMime    = String((media.document as Record<string, unknown>)?.mimeType ?? '')
        const isImageDoc = media.className === 'MessageMediaDocument' && docMime.startsWith('image/')
        if (isPhoto || isImageDoc) {
          const buffer = await client.downloadMedia(msg, {}) as Buffer | undefined
          if (buffer && buffer.length >= 500 && buffer.length < 5_000_000) {
            imageBuffer = buffer
            imageMime   = isPhoto ? 'image/jpeg' : docMime
          }
        }
      } catch { /* non-fatal — continue with text-only */ }
    }

    const relayResult = await mirrorIfNew(
      msg.id, relayThreadId,
      text || '📸',
      db, senderName, msg.date, imageBuffer, imageMime,
    )

    if (relayResult === 'sent') {
      maxDeliveredId = Math.max(maxDeliveredId, msg.id)
      await db.from('tb_settings').upsert({ key: 'tg_sf_relay_last_msg', value: new Date().toISOString() }).then(() => {}, () => {})
    } else if (relayResult === 'duplicate') {
      maxDeliveredId = Math.max(maxDeliveredId, msg.id)  // already sent, safe to advance
    }
    // 'error' → do NOT advance watermark — will retry next run

    results.push({
      id:   msg.id,
      type: relayResult === 'duplicate' ? 'duplicate_skip' : relayResult === 'error' ? `error:${srcTopicName.slice(0, 15)}` : `mirrored:${srcTopicName.slice(0, 20)}`,
    })
  }

  // Write watermark only up to the last successfully delivered message
  if (maxDeliveredId > lastId) {
    await db.from('tb_settings').upsert({ key: WATERMARK_KEY, value: String(maxDeliveredId) })
  }

  await client.disconnect().catch(() => {})
  return NextResponse.json({ ok: true, channel: 'SF Trades', processed: newMsgs.length, results })
}
