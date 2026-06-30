/**
 * Telegram Forum Topics routing for SF Trades Relay group.
 *
 * Topics are cached in tb_settings by thread ID.
 * sendToTopic() includes the original Pavan timestamp so members know
 * when the signal was actually posted (not just when we relayed it).
 * sendToTopicIfNew() deduplicates by message ID — safe to call multiple times.
 */

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''

export type TopicCategory = 'trades' | 'exits' | 'market_info'

const TOPIC_HARDCODED: Record<TopicCategory, number> = {
  trades:      6,   // Buy/Sell Alerts
  exits:       7,   // Exit & Profit Taking
  market_info: 5,   // Market Info & Discussion
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

/** Get the thread ID for a topic (from hardcoded map or Supabase cache). */
export async function getTopicId(
  category: TopicCategory,
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>
): Promise<number | null> {
  if (!BOT_TOKEN || !RELAY_CHAT) return null

  // Try Supabase cache first
  const settingKey = `tg_relay_topic_${category}`
  const { data } = await db.from('tb_settings').select('value').eq('key', settingKey).single()
  if (data?.value && data.value !== 'unsupported' && !isNaN(parseInt(data.value))) {
    return parseInt(data.value, 10)
  }

  // Fall back to hardcoded IDs (topics created 2026-06-30)
  return TOPIC_HARDCODED[category] ?? null
}

/**
 * Send a message to the correct topic with original sender + timestamp in the header.
 * @param text       Raw message text
 * @param category   Which topic to route to
 * @param db         Supabase client
 * @param originalTs Unix timestamp (seconds) of the original post
 * @param senderName Display name of who sent it (e.g. "Pavan", "Mint", "Captain NK")
 */
export async function sendToTopic(
  text: string,
  category: TopicCategory,
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>,
  originalTs?: number,
  senderName?: string
): Promise<boolean> {
  if (!BOT_TOKEN || !RELAY_CHAT || !text.trim()) return false

  // Category badge — small label, not a big header
  const badge = category === 'trades'      ? '🟢 Buy/Sell Alert'
              : category === 'exits'       ? '🔴 Exit/Profit'
              :                              'ℹ️ Market Info'

  // Who said it + when — mirrors how Pavan's group displays sender
  const who = senderName ? `👤 *${senderName}*` : '📢 SF Essential Trades'
  let tsLine = ''
  if (originalTs) {
    const d = new Date(originalTs * 1000)
    const etStr = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
    tsLine = ` · ${etStr} ET`
  }

  // Format: sender + time on one line, badge on same line, then message
  const fullText = `${who}${tsLine}  ${badge}\n\n${text}`

  const threadId = await getTopicId(category, db)

  const body: Record<string, unknown> = {
    chat_id:    RELAY_CHAT,
    text:       fullText,
    parse_mode: 'Markdown',
  }
  if (threadId) body.message_thread_id = threadId

  try {
    await tgCall('sendMessage', body)
    return true
  } catch {
    return false
  }
}

/**
 * Deduplicated relay — checks if this TG message ID was already sent.
 * Stores relayed IDs as a comma-separated list in tb_settings.
 * Call this from poll-sf for real-time messages to prevent double-relay on retries.
 */
export async function sendToTopicIfNew(
  msgId: number,
  text: string,
  category: TopicCategory,
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>,
  originalTs?: number,
  senderName?: string
): Promise<'sent' | 'duplicate' | 'error'> {
  const DEDUP_KEY = 'tg_relay_sent_ids'
  const { data } = await db.from('tb_settings').select('value').eq('key', DEDUP_KEY).single()
  const sentIds = new Set((data?.value ?? '').split(',').filter(Boolean).map(Number))

  if (sentIds.has(msgId)) return 'duplicate'

  const ok = await sendToTopic(text, category, db, originalTs, senderName)
  if (!ok) return 'error'

  // Keep last 500 IDs to avoid unbounded growth
  sentIds.add(msgId)
  const trimmed = Array.from(sentIds).slice(-500).join(',')
  await db.from('tb_settings').upsert({ key: DEDUP_KEY, value: trimmed })

  return 'sent'
}

/** Pin the most recent BUY/SELL message in relay group. */
export async function pinMessage(messageId: number): Promise<void> {
  if (!BOT_TOKEN || !RELAY_CHAT) return
  await tgCall('pinChatMessage', {
    chat_id:              RELAY_CHAT,
    message_id:           messageId,
    disable_notification: true,
  }).catch(() => {})
}
