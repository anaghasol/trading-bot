import { NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createServiceClient } from '@/lib/supabase-server'

const API_ID   = parseInt(process.env.TELEGRAM_API_ID ?? '0')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

function makeClient(session = '') {
  return new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 3,
    useWSS: true,          // WebSocket — works in Vercel serverless (TCP does not)
  })
}

async function dbGet(key: string) {
  const db = createServiceClient()
  const { data } = await db.from('tb_settings').select('value').eq('key', key).single()
  return data?.value ?? null
}

async function dbSet(key: string, value: string) {
  const db = createServiceClient()
  await db.from('tb_settings').upsert({ key, value })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const phone    = searchParams.get('phone')
  const code     = searchParams.get('code')
  const password = searchParams.get('password') ?? ''

  if (!phone) return NextResponse.json({ error: 'phone param required' }, { status: 400 })

  try {
    if (!code) {
      // ── Step 1: send OTP ──────────────────────────────────────────────────
      const client = makeClient()
      await client.connect()
      const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone)
      // Save partial session + hash so step 2 can reuse them
      await dbSet('tg_phone_hash', result.phoneCodeHash)
      await dbSet('tg_partial_session', client.session.save() as unknown as string)
      await client.disconnect()

      return NextResponse.json({
        ok: true,
        msg: `Code sent to ${phone}. Now visit the URL again adding &code=XXXXX with the Telegram code.`,
      })
    }

    // ── Step 2: verify code ─────────────────────────────────────────────────
    const partialSession = await dbGet('tg_partial_session') ?? ''
    const phoneCodeHash  = await dbGet('tg_phone_hash') ?? ''

    const client = makeClient(partialSession)
    await client.connect()

    await client.invoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (await import('telegram/tl')).Api.auth.SignIn({
        phoneNumber:   phone,
        phoneCodeHash,
        phoneCode:     code,
      }) as any
    )

    const session = client.session.save() as unknown as string
    await dbSet('telegram_session', session)
    // Clean up temp keys
    const db = createServiceClient()
    await db.from('tb_settings').delete().in('key', ['tg_phone_hash', 'tg_partial_session'])
    await client.disconnect()

    return NextResponse.json({ ok: true, msg: 'Logged in! Polling will now read SF Essential Trades automatically.' })
  } catch (e: unknown) {
    const err = e as Error
    // 2FA required
    if (err.message?.includes('SESSION_PASSWORD_NEEDED')) {
      return NextResponse.json({ error: '2FA required — add &password=YOUR_2FA_PASSWORD to the URL' })
    }
    return NextResponse.json({ error: err.message ?? String(e) }, { status: 500 })
  }
}
