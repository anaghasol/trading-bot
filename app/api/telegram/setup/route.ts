import { NextResponse } from 'next/server'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const APP_URL = process.env.VERCEL_APP_URL ?? process.env.VERCEL_URL

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!APP_URL) {
    return NextResponse.json({ error: 'VERCEL_APP_URL not set in env' }, { status: 500 })
  }

  const webhookUrl = `${APP_URL}/api/telegram/webhook`

  // Register webhook with Telegram
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'channel_post'],
        drop_pending_updates: true,
      }),
    }
  )

  const data = await res.json()

  // Also get webhook info
  const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`)
  const info = await infoRes.json()

  return NextResponse.json({ registered: webhookUrl, telegram_response: data, webhook_info: info })
}
