/**
 * Telegram MTProto client (gramjs) — reads channels as a real user.
 * Session string is stored in Supabase so it persists across Vercel invocations.
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createServiceClient } from './supabase-server'

const API_ID   = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

async function getStoredSession(): Promise<string> {
  const db = createServiceClient()
  const { data } = await db.from('tb_settings').select('value').eq('key', 'telegram_session').single()
  return data?.value ?? ''
}

async function saveSession(session: string) {
  const db = createServiceClient()
  await db.from('tb_settings').upsert({ key: 'telegram_session', value: session })
}

export async function getClient(): Promise<TelegramClient> {
  const sessionStr = await getStoredSession()
  const session = new StringSession(sessionStr)
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    useWSS: true,
  })
  await client.connect()
  if (sessionStr === '') {
    await saveSession(client.session.save() as unknown as string)
  }
  return client
}

export async function saveClientSession(client: TelegramClient) {
  await saveSession(client.session.save() as unknown as string)
}

export { getStoredSession, saveSession }
