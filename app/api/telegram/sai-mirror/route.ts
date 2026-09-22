/**
 * SAI MIRROR — read-only Telegram signal archive → Supabase tb_settings.
 *
 * Runs on Vercel (every minute via vercel.json cron). Vercel is used because the
 * Hatch VM cannot open raw MTProto TCP (platform policy blocks it); Vercel
 * egress reaches Telegram DCs fine (same as the poll / poll-sf routes).
 *
 * READ-ONLY ON TELEGRAM: this route only calls getDialogs / getMessages /
 * channels.GetForumTopics. It NEVER calls sendMessage, forwardMessages,
 * reactions, or any Telegram write API. A write call in this file is a bug.
 *
 * ALL state lives in Supabase `tb_settings` under keys prefixed `sai_mirror_`.
 * The bot's own `telegram_session` / `tg_*` keys are NEVER read or written
 * here — a collision would corrupt the bot's live trading state. The mirror
 * uses its own Telegram session (sai_mirror_telegram_session), created once
 * via the one-time phone-code auth. Do NOT "simplify" this to reuse the
 * bot's session: two clients sharing one auth key risks the live signal.
 *
 * Ported 1:1 from ~/workspace/tg-mirror/poll.js (2026-09-22). Behaviour:
 *  - 3-attempt connect, backoff 2s*(attempt+1), { connectionRetries: 2, useWSS: true }
 *  - session refreshed in Supabase after every successful connect
 *  - per-source message-ID watermarks; watermark advances ONLY to the max
 *    msg_id successfully archived (fail-closed: failed writes keep the old
 *    watermark so the message retries next run)
 *  - oldest-first processing; idempotent message upserts (re-runs harmless)
 *  - archive + watermark in ONE bulk upsert per channel
 *  - stuck-watermark detection flags (watchdog alerts on them)
 *  - any channel that fails to resolve or poll forces status=error (never
 *    silently 'ok')
 *
 * Sources:
 *  - sf_pavan:    Pavan's exclusive channel (TELEGRAM_SF_TRADES_CHANNEL_ID env,
 *                 else auto-discovered via getDialogs; the PUBLIC SF Essential
 *                 Trades channel -1002381909837 is explicitly excluded)
 *  - us_equities: @OptionT1
 *  - jimmy:       @JimmyLeshTrades
 *  - stockflyer:  resolved by dialog title (case-insensitive)
 */

export const runtime = 'nodejs'
export const maxDuration = 300

import { NextResponse } from 'next/server'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createServiceClient } from '@/lib/supabase-server'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

const MSG_LIMIT = 15
const MIN_TEXT_LEN = 3
// Public SF Essential Trades channel — explicitly NOT a mirror source.
const PUBLIC_SF_CHANNEL_ID = '-1002381909837'

const K = {
  session: 'sai_mirror_telegram_session',
  cronPing: 'sai_mirror_cron_ping',
  lastPoll: 'sai_mirror_last_poll',
  status: 'sai_mirror_status',
  topics: 'sai_mirror_topics_json',
  wm: (slug: string) => `sai_mirror_last_msg_id_${slug}`,
  lastMsgAt: (slug: string) => `sai_mirror_last_msg_at_${slug}`,
  msg: (slug: string, id: number) => `sai_mirror_msg_${slug}_${id}`,
  stuck: (slug: string) => `sai_mirror_stuck_${slug}`,
}
const EXPECTED_SLUGS = ['sf_pavan', 'us_equities', 'jimmy', 'stockflyer']
const nowIso = () => new Date().toISOString()

type Db = ReturnType<typeof createServiceClient>

async function kvMget(db: Db, keys: string[]): Promise<Record<string, string>> {
  const { data } = await db.from('tb_settings').select('key,value').in('key', keys)
  const out: Record<string, string> = {}
  for (const row of (data ?? []) as Array<{ key: string; value: string }>) out[row.key] = row.value
  return out
}

async function kvMset(db: Db, obj: Record<string, string>) {
  const rows = Object.entries(obj).map(([key, value]) => ({ key, value }))
  if (!rows.length) return
  const { error } = await db.from('tb_settings').upsert(rows)
  if (error) throw new Error(`kvMset failed: ${error.message}`)
}

async function kvDel(db: Db, key: string) {
  await db.from('tb_settings').delete().eq('key', key)
}

function isAuthError(t: string) {
  return /AUTH_KEY|SESSION_REVOKED|SESSION_PASSWORD_NEEDED|deactivat|unauthori[sz]ed|USER_DEACTIVATED/i.test(t || '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function senderName(msg: any): string {
  try {
    const s = msg.sender
    if (s?.firstName) return `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`
    if (s?.username) return '@' + s.username
    if (s?.title) return s.title
  } catch { /* fall through */ }
  return 'Member'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function topicIdOf(msg: any): number | null {
  try {
    const r = msg.replyTo
    return r?.replyToTopId ?? (r?.forumTopic ? r?.replyToMsgId : null) ?? null
  } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postedAtOf(msg: any): string {
  try {
    const d = msg.date instanceof Date ? msg.date : new Date((msg.date || 0) * 1000)
    return d.toISOString()
  } catch { return nowIso() }
}

async function connectWithRetry(sessionStr: string) {
  let client: TelegramClient | null = null
  let connectErr: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 2, useWSS: true })
      await client.connect()
      connectErr = null
      break
    } catch (e) {
      connectErr = String(e instanceof Error ? e.message : e).slice(0, 160)
      client = null
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  return { client, connectErr }
}

/**
 * sf_pavan resolution: TELEGRAM_SF_TRADES_CHANNEL_ID env wins (deterministic);
 * otherwise discover the broadcast channel matching /sf/i + /trades|pavan/i,
 * excluding the SF Trades Relay group and the public -1002381909837 channel.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveSfPavan(client: TelegramClient, dialogs: any[]): Promise<any | null> {
  const overrideRaw = process.env.TELEGRAM_SF_TRADES_CHANNEL_ID ?? ''
  if (overrideRaw) {
    const n = parseInt(overrideRaw)
    return client.getInputEntity(isNaN(n) ? overrideRaw : n)
  }
  const cands: Array<{ title: string; fullId: string; entity: unknown }> = []
  for (const d of dialogs) {
    const title: string = d.title || ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = d.entity
    if (!e || e.className !== 'Channel' || !e.broadcast) continue
    const fullId = '-100' + String(e.id)
    if (fullId === PUBLIC_SF_CHANNEL_ID) continue
    if (/relay/i.test(title)) continue
    if (/sf/i.test(title) && /(trades|pavan)/i.test(title)) cands.push({ title, fullId, entity: e })
  }
  if (!cands.length) return null
  cands.sort((a, b) => (/pavan/i.test(b.title) ? 1 : 0) - (/pavan/i.test(a.title) ? 1 : 0))
  return cands[0].entity
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveEntities(client: TelegramClient): Promise<Map<string, any>> {
  const dialogs = await client.getDialogs()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolved = new Map<string, any>()
  const sfPavan = await resolveSfPavan(client, dialogs)
  if (sfPavan) resolved.set('sf_pavan', sfPavan)
  const byTitle = (needle: string) => dialogs.find(d => (d.title || '').toLowerCase().includes(needle.toLowerCase()))
  try {
    resolved.set('us_equities', await client.getInputEntity('@OptionT1'))
  } catch {
    const opt = byTitle('optiont1')
    if (opt) resolved.set('us_equities', opt.entity)
  }
  try {
    resolved.set('jimmy', await client.getInputEntity('@JimmyLeshTrades'))
  } catch {
    const j = byTitle('jimmy')
    if (j) resolved.set('jimmy', j.entity)
  }
  const sf = byTitle('stockflyer')
  if (sf) resolved.set('stockflyer', sf.entity)
  return resolved
}

async function getTopicMap(
  db: Db, client: TelegramClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolved: Map<string, any>, cachedRaw: string | undefined,
): Promise<Record<string, Record<string, string>>> {
  try {
    const cached = JSON.parse(cachedRaw || '{}')
    if (cached && Object.keys(cached).length) return cached
  } catch { /* rebuild */ }
  const map: Record<string, Record<string, string>> = {}
  for (const [slug, entity] of Array.from(resolved)) {
    try {
      const result = await client.invoke(new Api.channels.GetForumTopics({
        channel: entity as unknown as Api.InputChannel,
        limit: 100, offsetId: 0, offsetDate: 0, offsetTopic: 0, q: '',
      })) as unknown as { topics: Array<{ id: number; title: string }> }
      const tm: Record<string, string> = {}
      for (const t of result.topics || []) tm[String(t.id)] = t.title
      if (Object.keys(tm).length) map[slug] = tm
    } catch { /* not a forum group — fine */ }
  }
  return map
}

async function pollChannel(
  db: Db, client: TelegramClient, slug: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity: any, wm: number,
  topicMap: Record<string, Record<string, string>>, hadStuckFlag: boolean,
): Promise<{ ok: boolean; wm: number; archived: number }> {
  let messages
  try {
    messages = await client.getMessages(entity, { limit: MSG_LIMIT })
  } catch {
    return { ok: false, wm, archived: 0 }
  }
  const newMsgs = messages
    .filter(m => m.id > wm && (((m as unknown as { text?: string }).text ?? '').length > MIN_TEXT_LEN || m.media != null))
    .sort((a, b) => a.id - b.id) // oldest-first
  const latestInChannel = messages.reduce((max, m) => Math.max(max, m.id), 0)
  if (!newMsgs.length) {
    if (latestInChannel > 0 && latestInChannel <= wm) {
      await kvMset(db, { [K.stuck(slug)]: JSON.stringify({ at: nowIso(), latest_in_channel: latestInChannel, watermark: wm, note: 'channel has no messages beyond watermark — mirror may be frozen' }) })
    } else if (hadStuckFlag) {
      await kvDel(db, K.stuck(slug)).catch(() => {})
    }
    return { ok: true, wm, archived: 0 }
  }
  // Archive + watermark in ONE bulk upsert (fail-closed: a failed batch keeps
  // the old watermark and the messages retry next run; upserts are idempotent).
  const batch: Record<string, string> = {}
  let maxId = wm
  let maxPostedAt: string | null = null
  let count = 0
  for (const m of newMsgs) {
    if (!Number.isFinite(m.id)) continue
    const tid = topicIdOf(m)
    const postedAt = postedAtOf(m)
    batch[K.msg(slug, m.id)] = JSON.stringify({
      channel: slug,
      msg_id: m.id,
      sender: senderName(m).slice(0, 200),
      text: ((m as unknown as { text?: string }).text ?? '').slice(0, 20000),
      posted_at: postedAt,
      topic_id: tid,
      topic_name: (tid != null && topicMap[slug] && topicMap[slug][String(tid)]) || null,
      has_media: m.media != null,
      archived_at: nowIso(),
    })
    count++
    if (m.id > maxId) { maxId = m.id; maxPostedAt = postedAt }
  }
  if (maxId === wm) return { ok: true, wm, archived: 0 }
  batch[K.wm(slug)] = String(maxId)
  if (maxPostedAt) batch[K.lastMsgAt(slug)] = maxPostedAt
  try {
    await kvMset(db, batch)
  } catch {
    return { ok: false, wm, archived: 0 } // watermark NOT advanced — retries next run
  }
  if (hadStuckFlag) await kvDel(db, K.stuck(slug)).catch(() => {})
  return { ok: true, wm: maxId, archived: count }
}

export async function GET(req: Request) {
  const db = createServiceClient()

  // Ping at run start — mirrors the bot's tg_sf_cron_ping convention.
  await kvMset(db, { [K.cronPing]: nowIso() }).catch(() => {})

  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!API_ID || !API_HASH) {
    await kvMset(db, { [K.status]: 'error: TELEGRAM_API_ID / TELEGRAM_API_HASH not configured' }).catch(() => {})
    return NextResponse.json({ ok: false, error: 'Telegram API credentials not configured' }, { status: 500 })
  }

  const state = await kvMget(db, [K.session, K.topics, ...EXPECTED_SLUGS.map(K.wm), ...EXPECTED_SLUGS.map(K.stuck)])
    .catch(() => ({} as Record<string, string>))
  const sessionStr = (state[K.session] || '').trim()
  if (!sessionStr) {
    await kvMset(db, { [K.status]: 'no_session' }).catch(() => {})
    return NextResponse.json({ ok: false, error: 'no_session — run the one-time phone-code auth first' }, { status: 500 })
  }

  const { client, connectErr } = await connectWithRetry(sessionStr)
  if (!client || connectErr) {
    const status = isAuthError(connectErr ?? '')
      ? `error: auth expired (${connectErr}) — re-run the one-time auth`
      : `error: ${connectErr}`
    await kvMset(db, { [K.status]: status }).catch(() => {})
    return NextResponse.json({ ok: false, error: 'TG connect failed after 3 retries', detail: connectErr })
  }

  const finalWrites: Record<string, string> = {}
  try {
    finalWrites[K.session] = client.session.save() as unknown as string // session refresh
    finalWrites[K.lastPoll] = nowIso()

    const resolved = await resolveEntities(client)
    const topicMap = await getTopicMap(db, client, resolved, state[K.topics])
    if (Object.keys(topicMap).length) finalWrites[K.topics] = JSON.stringify(topicMap)

    const failedSlugs = EXPECTED_SLUGS.filter(s => !resolved.has(s))
    const perChannel: Record<string, { archived: number; watermark: number }> = {}
    for (const [slug, entity] of Array.from(resolved)) {
      const wmRaw = state[K.wm(slug)] ?? '0'
      const wm = parseInt(wmRaw, 10)
      try {
        const res = await pollChannel(db, client, slug, entity, Number.isFinite(wm) ? wm : 0, topicMap, !!state[K.stuck(slug)])
        perChannel[slug] = { archived: res.archived, watermark: res.wm }
        if (!res.ok) failedSlugs.push(slug)
      } catch {
        failedSlugs.push(slug)
      }
    }
    const failed = Array.from(new Set(failedSlugs))
    finalWrites[K.status] = failed.length
      ? `error: channel poll failed (${failed.join(', ')}) — retrying next run`
      : 'ok'
    await kvMset(db, finalWrites)
    return NextResponse.json({ ok: failed.length === 0, channels: perChannel, failed })
  } finally {
    await client.disconnect().catch(() => {}) // short-lived connection per run
  }
}
