/**
 * Telegram Forum Topics routing for SF Trades Relay group.
 *
 * Topics are created on first use and their IDs stored in tb_settings.
 * If the group does not have Forum mode enabled, all sends fall back to
 * the main chat (no topic) so the relay still works.
 *
 * To enable topics in SF Trades Relay:
 *   1. Open the group → ⋮ menu → Edit → enable "Topics"
 *   2. Give the bot "Manage Topics" admin permission
 *
 * Topic definitions — edit names/icons here to rename them in Telegram.
 */

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!
const RELAY_CHAT = process.env.TELEGRAM_RELAY_CHAT_ID ?? ''

export type TopicCategory = 'trades' | 'exits' | 'market_info'

const TOPIC_DEFS: Record<TopicCategory, { name: string; icon_color: number }> = {
  trades:      { name: '🟢 Buy/Sell Trades',  icon_color: 0x6FB9F0 },
  exits:       { name: '🔴 Exit Signals',      icon_color: 0xFF0000 },
  market_info: { name: 'ℹ️ Market Info',       icon_color: 0xFFD67E },
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

/** Get or create a topic thread ID for the given category. */
export async function getTopicId(
  category: TopicCategory,
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>
): Promise<number | null> {
  if (!BOT_TOKEN || !RELAY_CHAT) return null

  const settingKey = `tg_relay_topic_${category}`

  // Check cache in Supabase
  const { data } = await db.from('tb_settings').select('value').eq('key', settingKey).single()
  if (data?.value && data.value !== 'unsupported') {
    return parseInt(data.value, 10)
  }
  if (data?.value === 'unsupported') return null

  // Try to create the topic
  try {
    const def = TOPIC_DEFS[category]
    const result = await tgCall('createForumTopic', {
      chat_id:    RELAY_CHAT,
      name:       def.name,
      icon_color: def.icon_color,
    }) as { message_thread_id: number }
    const threadId = result.message_thread_id
    await db.from('tb_settings').upsert({ key: settingKey, value: String(threadId) })
    return threadId
  } catch {
    // Forum not enabled — mark as unsupported so we don't retry every message
    await db.from('tb_settings').upsert({ key: settingKey, value: 'unsupported' })
    return null
  }
}

/** Send a message to the appropriate topic (or main chat if topics not enabled). */
export async function sendToTopic(
  text: string,
  category: TopicCategory,
  db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>
): Promise<boolean> {
  if (!BOT_TOKEN || !RELAY_CHAT || !text.trim()) return false

  const badge = category === 'trades'      ? '🟢 BUY/SELL — IMPORTANT'
              : category === 'exits'       ? '🔴 EXIT SIGNAL'
              :                              'ℹ️ INFO'

  const threadId = await getTopicId(category, db)

  const body: Record<string, unknown> = {
    chat_id:    RELAY_CHAT,
    text:       `⭐ [SF Essential Trades] — ${badge}\n\n${text}`,
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

/** Pin the most recent BUY/SELL message in main chat so it's always visible. */
export async function pinMessage(messageId: number): Promise<void> {
  if (!BOT_TOKEN || !RELAY_CHAT) return
  await tgCall('pinChatMessage', {
    chat_id:              RELAY_CHAT,
    message_id:           messageId,
    disable_notification: true,
  }).catch(() => {})
}
