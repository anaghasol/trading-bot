/**
 * Telegram Forum Topics — dynamic mirror of Pavan's group structure.
 *
 * Each topic in Pavan's group (SF Essential Trades, Discussion, etc.)
 * gets a matching topic in SF Trades Relay with the same name.
 * Mapping is cached in tb_settings as JSON so topics aren't recreated every run.
 *
 * sendMirroredMessage() is the main entry point:
 *   - Looks up Pavan's topic ID → relay topic ID
 *   - Creates the relay topic if it doesn't exist yet
 *   - Sends message with sender name + original timestamp header
 *   - Deduplicates by message ID
 */

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''

// Keep these for the 3-channel poller / backfill that uses category-based routing
export type TopicCategory = 'trades' | 'exits' | 'market_info'
const TOPIC_HARDCODED: Record<TopicCategory, number> = {
  trades:      6,
  exits:       7,
  market_info: 5,
}

async function tgCall(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as { ok: boolean; result?: unknown; description?: string }
  if (!data.ok) throw new Error(`TG ${method}: ${data.description}`)
  return data.result
}

type DB = ReturnType<typeof import('@/lib/supabase-server').createServiceClient>

// ── Topic map cache ─────────────────────────────────────────────────────────

/** Load {pavanTopicId → relayTopicId} map from Supabase. */
async function loadTopicMap(db: DB): Promise<Record<number, number>> {
  const { data } = await db.from('tb_settings').select('value').eq('key', 'tg_mirror_topic_map').single()
  if (!data?.value) return {}
  try { return JSON.parse(data.value) } catch { return {} }
}

async function saveTopicMap(map: Record<number, number>, db: DB): Promise<void> {
  await db.from('tb_settings').upsert({ key: 'tg_mirror_topic_map', value: JSON.stringify(map) })
}

/** Create a new forum topic in the relay group and return its thread ID. */
async function createRelayTopic(name: string): Promise<number | null> {
  try {
    const result = await tgCall('createForumTopic', {
      chat_id: RELAY_CHAT,
      name: name.slice(0, 128),  // TG limit
    }) as { message_thread_id: number }
    return result.message_thread_id
  } catch {
    return null
  }
}

/**
 * Canonical Pavan topic → relay thread. The two groups are fixed, so this is the
 * source of truth: if tg_mirror_topic_map is ever wiped, the relay resumes into
 * the original threads instead of creating a duplicate set (which silently
 * stranded 4 days of messages in Aug 2026).
 */
const KNOWN_TOPIC_MAP: Record<number, number> = {
  3:     89,  // SF Essential Trades( Buy /Sell Alerts)
  2:     90,  // SF Essential Discussion forum
  3767:  91,  // Updates on Holdings
  11541: 92,  // Education
  2080:  93,  // Weekly Webinar Videos
  1:     94,  // New Joiners
  10600: 95,  // Feedback & Suggestions
  9852:  96,  // Referral links
}

/** Strip punctuation/parentheticals so "SF Essential Trades( Buy /Sell)" matches "SF Essential Trades". */
function normTitle(s: string): string {
  return s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '')
}

/** Existing relay topics, injected by the caller (Bot API cannot list forum topics). */
export type RelayTopic = { id: number; title: string }

/**
 * Get relay thread ID for a given Pavan topic (name + ID).
 * Resolution order: cached map → canonical map → name match against existing
 * relay topics → create. Creating is the last resort so a lost cache never
 * forks the relay into duplicate topics.
 */
export async function getOrCreateMirrorThread(
  pavanTopicId: number,
  pavanTopicName: string,
  db: DB,
  relayTopics: RelayTopic[] = [],
): Promise<number | null> {
  if (!BOT_TOKEN || !RELAY_CHAT) return null

  const map = await loadTopicMap(db)
  if (map[pavanTopicId]) return map[pavanTopicId]

  let threadId = KNOWN_TOPIC_MAP[pavanTopicId] ?? null

  if (!threadId && relayTopics.length) {
    const want = normTitle(pavanTopicName)
    const hits = relayTopics.filter(t => {
      const got = normTitle(t.title)
      return got === want || got.startsWith(want) || want.startsWith(got)
    })
    // Lowest id wins — the earliest-created topic is the canonical one.
    if (hits.length) threadId = Math.min(...hits.map(t => t.id))
  }

  const resolved = threadId ?? await createRelayTopic(pavanTopicName)
  if (!resolved) return null

  map[pavanTopicId] = resolved
  await saveTopicMap(map, db)
  return resolved
}

// ── Format helper ────────────────────────────────────────────────────────────

function buildHeader(senderName?: string, originalTs?: number): string {
  const who = senderName ? `👤 *${senderName}*` : '📢 SF Essential Trades'
  let tsLine = ''
  if (originalTs) {
    const d = new Date(originalTs * 1000)
    tsLine = ` · ${d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })} ET`
  }
  return `${who}${tsLine}`
}

// ── Main send functions ───────────────────────────────────────────────────────

/**
 * Mirror a message to the relay group at a specific thread ID.
 * Adds sender + timestamp header. No dedup check here — caller handles it.
 */
export async function sendToThread(
  threadId: number | null,
  text: string,
  senderName?: string,
  originalTs?: number
): Promise<boolean> {
  if (!BOT_TOKEN || !RELAY_CHAT || !text.trim()) return false

  const header = buildHeader(senderName, originalTs)
  const body: Record<string, unknown> = {
    chat_id:    RELAY_CHAT,
    text:       `${header}\n\n${text}`,
    parse_mode: 'Markdown',
  }
  if (threadId) body.message_thread_id = threadId

  try {
    await tgCall('sendMessage', body)
    return true
  } catch (e) {
    // tgCall throws on Telegram API errors — log so we can see failures in Vercel logs
    console.error(`[relay] sendToThread FAILED thread=${threadId ?? 'default'}: ${String(e).slice(0, 150)}`)
    return false
  }
}

/**
 * Send an image (Buffer) to a relay topic thread via Bot API multipart upload.
 * Caption gets the sender + timestamp header prepended (truncated to 1024 chars).
 */
export async function sendImageToThread(
  threadId: number | null,
  imageBuffer: Buffer,
  mimeType: string,
  caption: string,
  senderName?: string,
  originalTs?: number
): Promise<boolean> {
  if (!BOT_TOKEN || !RELAY_CHAT) return false

  const header = buildHeader(senderName, originalTs)
  const fullCaption = `${header}\n\n${caption}`.slice(0, 1024)
  const isPhoto = mimeType.startsWith('image/')

  const form = new FormData()
  form.append('chat_id', RELAY_CHAT)
  if (threadId) form.append('message_thread_id', String(threadId))
  form.append('caption', fullCaption)
  form.append('parse_mode', 'Markdown')

  const blob = new Blob([new Uint8Array(imageBuffer)], { type: mimeType })
  const filename = isPhoto ? 'photo.jpg' : 'file'
  const method   = isPhoto ? 'sendPhoto'    : 'sendDocument'
  const field    = isPhoto ? 'photo'        : 'document'
  form.append(field, blob, filename)

  try {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', body: form })
    const data = await res.json() as { ok: boolean; description?: string }
    if (!data.ok) {
      console.error(`[relay] sendImageToThread FAILED thread=${threadId}: ${data.description}`)
      return false
    }
    return true
  } catch (e) {
    console.error(`[relay] sendImageToThread EXCEPTION thread=${threadId}: ${String(e).slice(0, 120)}`)
    return false
  }
}

/** Dedup check then mirror. Returns 'sent' | 'duplicate' | 'error'. */
export async function mirrorIfNew(
  msgId: number,
  threadId: number | null,
  text: string,
  db: DB,
  senderName?: string,
  originalTs?: number,
  imageBuffer?: Buffer,
  imageMime?: string,
): Promise<'sent' | 'duplicate' | 'error'> {
  const DEDUP_KEY = 'tg_relay_sent_ids'
  const { data } = await db.from('tb_settings').select('value').eq('key', DEDUP_KEY).single()
  const sentIds = new Set((data?.value ?? '').split(',').filter(Boolean).map(Number))

  if (sentIds.has(msgId)) return 'duplicate'

  let ok: boolean
  if (imageBuffer && imageMime) {
    // Send image — caption is the full message text (pure mirror, no OCR appended)
    ok = await sendImageToThread(threadId, imageBuffer, imageMime, text || '📸', senderName, originalTs)
  } else {
    ok = await sendToThread(threadId, text, senderName, originalTs)
  }
  if (!ok) return 'error'

  sentIds.add(msgId)
  const trimmed = Array.from(sentIds).slice(-500).join(',')
  await db.from('tb_settings').upsert({ key: DEDUP_KEY, value: trimmed })
  return 'sent'
}

// ── Category-based API (used by 3-channel poller + backfill) ─────────────────

export async function getTopicId(category: TopicCategory, db: DB): Promise<number | null> {
  if (!BOT_TOKEN || !RELAY_CHAT) return null
  const settingKey = `tg_relay_topic_${category}`
  const { data } = await db.from('tb_settings').select('value').eq('key', settingKey).single()
  if (data?.value && !isNaN(parseInt(data.value))) return parseInt(data.value, 10)
  return TOPIC_HARDCODED[category] ?? null
}

export async function sendToTopic(
  text: string,
  category: TopicCategory,
  db: DB,
  originalTs?: number,
  senderName?: string
): Promise<boolean> {
  const threadId = await getTopicId(category, db)
  return sendToThread(threadId, text, senderName, originalTs)
}

export async function sendToTopicIfNew(
  msgId: number,
  text: string,
  category: TopicCategory,
  db: DB,
  originalTs?: number,
  senderName?: string
): Promise<'sent' | 'duplicate' | 'error'> {
  const threadId = await getTopicId(category, db)
  return mirrorIfNew(msgId, threadId, text, db, senderName, originalTs)
}

export async function pinMessage(messageId: number): Promise<void> {
  if (!BOT_TOKEN || !RELAY_CHAT) return
  await tgCall('pinChatMessage', {
    chat_id: RELAY_CHAT, message_id: messageId, disable_notification: true,
  }).catch(() => {})
}
