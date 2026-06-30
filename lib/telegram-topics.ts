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
 * Get relay thread ID for a given Pavan topic (name + ID).
 * Creates the relay topic if it doesn't exist yet.
 * Returns null if relay chat not configured or creation fails.
 */
export async function getOrCreateMirrorThread(
  pavanTopicId: number,
  pavanTopicName: string,
  db: DB
): Promise<number | null> {
  if (!BOT_TOKEN || !RELAY_CHAT) return null

  const map = await loadTopicMap(db)
  if (map[pavanTopicId]) return map[pavanTopicId]

  // Create a matching topic in our relay group
  const newThreadId = await createRelayTopic(pavanTopicName)
  if (!newThreadId) return null

  map[pavanTopicId] = newThreadId
  await saveTopicMap(map, db)
  return newThreadId
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

  try { await tgCall('sendMessage', body); return true }
  catch { return false }
}

/** Dedup check then mirror. Returns 'sent' | 'duplicate' | 'error'. */
export async function mirrorIfNew(
  msgId: number,
  threadId: number | null,
  text: string,
  db: DB,
  senderName?: string,
  originalTs?: number
): Promise<'sent' | 'duplicate' | 'error'> {
  const DEDUP_KEY = 'tg_relay_sent_ids'
  const { data } = await db.from('tb_settings').select('value').eq('key', DEDUP_KEY).single()
  const sentIds = new Set((data?.value ?? '').split(',').filter(Boolean).map(Number))

  if (sentIds.has(msgId)) return 'duplicate'

  const ok = await sendToThread(threadId, text, senderName, originalTs)
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
