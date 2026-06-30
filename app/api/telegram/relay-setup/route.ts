/**
 * GET /api/telegram/relay-setup
 * Shows recent bot updates so you can find the new relay group's chat ID.
 * Add the bot to your new group, send a message, then call this endpoint.
 * Copy the negative chat_id and set it as TELEGRAM_RELAY_CHAT_ID in Vercel.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const secret = new URL(req.url).searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  const res  = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&allowed_updates=["message"]`)
  const data = await res.json() as { ok: boolean; result: { message?: { chat: { id: number; title?: string; type: string } } }[] }

  const chatMap: Record<number, { id: number; title: string; type: string }> = {}
  for (const upd of data.result ?? []) {
    const chat = upd.message?.chat
    if (chat) chatMap[chat.id] = { id: chat.id, title: chat.title ?? 'private', type: chat.type }
  }

  const allChats  = Object.values(chatMap)
  const currentRelay = process.env.TELEGRAM_RELAY_CHAT_ID ?? '(not set)'

  return NextResponse.json({
    current_relay_chat_id: currentRelay,
    instruction: 'Add your bot to the new group, send a message, then reload this page. Copy the negative chat_id and set it as TELEGRAM_RELAY_CHAT_ID in Vercel env vars.',
    groups_seen: allChats.filter(c => c.type !== 'private'),
    all_chats:   allChats,
  })
}
