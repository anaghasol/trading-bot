/**
 * GET /api/telegram/relay-test?secret=X&chat_id=-5570033333
 * Sends one test message to the target chat to verify the bot is a member.
 * Also auto-discovers the group chat ID via getUpdates.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  // Use provided chat_id or fall back to TELEGRAM_RELAY_CHAT_ID env var
  const chatId = searchParams.get('chat_id') ?? process.env.TELEGRAM_RELAY_CHAT_ID

  // Step 1: discover recent chats via getUpdates
  const updRes  = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50&allowed_updates=["message","my_chat_member"]`)
  const updData = await updRes.json() as { ok: boolean; result: { message?: { chat: { id: number; title?: string; type: string } }; my_chat_member?: { chat: { id: number; title?: string; type: string } } }[] }

  const chatMap: Record<string, { id: number; title: string; type: string }> = {}
  for (const upd of updData.result ?? []) {
    const chat = upd.message?.chat ?? upd.my_chat_member?.chat
    if (chat) chatMap[chat.id] = { id: chat.id, title: chat.title ?? 'private', type: chat.type }
  }
  const knownGroups = Object.values(chatMap).filter(c => c.type !== 'private')

  // Step 2: send test message
  if (!chatId) {
    return NextResponse.json({
      error: 'No chat_id provided. Pass ?chat_id=-XXXX or set TELEGRAM_RELAY_CHAT_ID env var.',
      known_groups: knownGroups,
      tip: 'Add the bot to your SF Trades Relay group first, send any message there, then retry.',
    })
  }

  const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ *MyTrade Relay — Connection Test*\n\nThis group is now connected.\nLive US Equities signals will appear here automatically every time a new message is posted in the source channel.\n\n_Powered by MyTrade bot_`,
      parse_mode: 'Markdown',
    }),
  })
  const sendData = await sendRes.json() as { ok: boolean; description?: string; result?: { message_id: number } }

  // Step 3: if it worked, also try the correct supergroup ID form
  let superGroupAttempt = null
  if (!sendData.ok && !String(chatId).startsWith('-100')) {
    const sgId = `-100${String(chatId).replace('-', '')}`
    const sg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: sgId, text: `✅ *MyTrade Relay — Connection Test*\n\nConnected! US Equities signals will flow here automatically.`, parse_mode: 'Markdown' }),
    })
    const sgData = await sg.json() as { ok: boolean; description?: string; result?: { message_id: number } }
    superGroupAttempt = { tried_id: sgId, ...sgData }
  }

  return NextResponse.json({
    tried_chat_id: chatId,
    send_result:   sendData,
    supergroup_attempt: superGroupAttempt,
    known_groups:  knownGroups,
    next_step: sendData.ok
      ? `Success! Set TELEGRAM_RELAY_CHAT_ID=${chatId} in Vercel env vars.`
      : superGroupAttempt
        ? `Check supergroup_attempt result above for the correct ID.`
        : 'Bot is not in the group yet. Add the bot as admin first, then retry.',
  })
}
