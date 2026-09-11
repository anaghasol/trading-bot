/**
 * GET /api/telegram/pavan-archive?secret=...
 *
 * Archives every message from Pavan's SF Essential Trades channel into
 * tb_pavan_signals for performance analysis. Idempotent — upserts on msg_id,
 * so it can be re-run safely and will only add what's new.
 *
 * ?days=N   how far back to pull (default 30; use 180 for a full backfill)
 * ?stats=1  skip the pull, just report what's already archived
 *
 * Runs nightly via cron to keep the archive current.
 */

export const runtime     = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { getStoredSession } from '@/lib/telegram-client'
import { createServiceClient } from '@/lib/supabase-server'
import { parsePavan } from '@/lib/pavan-parse'

const API_ID   = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''
const SF_CHANNEL_ID = (() => {
  const raw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  const n = parseInt(raw)
  return isNaN(n) ? raw : n
})()

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()

  if (searchParams.get('stats') === '1') {
    const { data } = await db.from('tb_pavan_signals').select('kind, symbol, posted_at')
    const byKind: Record<string, number> = {}
    for (const r of data ?? []) byKind[r.kind ?? 'null'] = (byKind[r.kind ?? 'null'] ?? 0) + 1
    const dates = (data ?? []).map(r => r.posted_at).sort()
    return NextResponse.json({
      ok: true, archived: data?.length ?? 0, by_kind: byKind,
      oldest: dates[0] ?? null, newest: dates[dates.length - 1] ?? null,
    })
  }

  const days = Math.min(365, Math.max(1, parseInt(searchParams.get('days') ?? '30')))
  const since = Math.floor(Date.now() / 1000) - days * 86_400

  const sessionStr = await getStoredSession()
  if (!sessionStr) return NextResponse.json({ ok: false, reason: 'no session' })

  const { data: mapRow } = await db.from('tb_settings').select('value').eq('key', 'tg_mirror_topic_map').single()
  let topicMap: Record<string, number> = {}
  try { topicMap = JSON.parse(mapRow?.value ?? '{}') } catch { /* empty */ }
  const { data: namesRow } = await db.from('tb_settings').select('value').eq('key', 'pavan_topics_json').single()
  let topicNames: Record<string, string> = {}
  try { topicNames = JSON.parse(namesRow?.value ?? '{}') } catch { /* empty */ }

  const topicIds = Object.keys(topicMap).length ? Object.keys(topicMap).map(Number) : [3, 3767, 2, 11541]

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
  try { await client.connect() } catch (e) {
    return NextResponse.json({ ok: false, reason: `tg connect failed: ${String(e).slice(0, 80)}` })
  }

  // msg_id is globally unique in the channel, so a message pulled under two
  // topics still lands as one row — dedupe here to keep the upsert batch clean.
  const seen = new Map<number, Record<string, unknown>>()

  try {
    for (const topicId of topicIds) {
      let offsetId = 0
      for (let page = 0; page < 15; page++) {
        let batch
        try { batch = await client.getMessages(SF_CHANNEL_ID, { limit: 100, replyTo: topicId, offsetId }) }
        catch { break }
        if (!batch.length) break

        for (const m of batch) {
          const text = m.text ?? ''
          if (m.date < since || text.length < 5 || seen.has(m.id)) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = (m as any).sender
          const sender: string = s?.firstName
            ? `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`
            : s?.username ?? 'Member'
          const p = parsePavan(text)
          seen.set(m.id, {
            msg_id: m.id, topic_id: topicId,
            topic_name: topicNames[String(topicId)] ?? `topic ${topicId}`,
            posted_at: new Date(m.date * 1000).toISOString(),
            sender, text, ...p,
          })
        }
        offsetId = batch[batch.length - 1].id
        if (batch[batch.length - 1].date < since) break
      }
    }
  } finally {
    await client.disconnect().catch(() => {})
  }

  const rows = Array.from(seen.values())
  let saved = 0
  const errors: string[] = []
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from('tb_pavan_signals').upsert(rows.slice(i, i + 200), { onConflict: 'msg_id' })
    if (error) errors.push(error.message.slice(0, 100))
    else saved += Math.min(200, rows.length - i)
  }

  const byKind: Record<string, number> = {}
  for (const r of rows) byKind[String(r.kind)] = (byKind[String(r.kind)] ?? 0) + 1

  await db.from('tb_settings').upsert({ key: 'pavan_archive_last', value: new Date().toISOString() })

  return NextResponse.json({ ok: errors.length === 0, days, pulled: rows.length, saved, by_kind: byKind, errors })
}
