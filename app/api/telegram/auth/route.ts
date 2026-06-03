/**
 * One-time Telegram auth flow:
 *   Step 1: GET /api/telegram/auth?secret=XXX&phone=%2B1...
 *           → sends OTP to your phone
 *   Step 2: GET /api/telegram/auth?secret=XXX&phone=%2B1...&code=12345
 *           → completes login, stores session in Supabase
 */

import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { saveSession } from '@/lib/telegram-client'
import { createServiceClient } from '@/lib/supabase-server'

const API_ID   = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret')
  const phone  = searchParams.get('phone')
  const code   = searchParams.get('code')
  const password = searchParams.get('password') // 2FA if needed

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!phone) {
    return NextResponse.json({ error: 'phone param required, e.g. ?phone=%2B12345678901' }, { status: 400 })
  }

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3 })
  await client.connect()

  if (!code) {
    // Step 1 — send OTP
    await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone)
    return NextResponse.json({ ok: true, next: 'Add &code=XXXXX to the URL with the code Telegram just texted you' })
  }

  // Step 2 — sign in
  try {
    await client.signInUser(
      { apiId: API_ID, apiHash: API_HASH },
      {
        phoneNumber: phone,
        phoneCode: async () => code,
        password: async () => password ?? '',
        onError: async (err) => { throw err },
      }
    )
    const session = client.session.save() as unknown as string
    await saveSession(session)
    await client.disconnect()
    return NextResponse.json({ ok: true, message: 'Logged in! Session saved to Supabase. Polling is now active.' })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
