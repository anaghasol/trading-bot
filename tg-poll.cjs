/**
 * Silently reads SF Essential Trades channel.
 * No forwarding, no posting. Just: read → Claude classify → execute on Alpaca Paper → SMS.
 * Run every minute via Mac launchd.
 */

const { TelegramClient } = require('telegram')
const { StringSession }  = require('telegram/sessions')
const { createClient }   = require('@supabase/supabase-js')

const API_ID     = 34439500
const API_HASH   = '973e147ccc3ccb895fa22c60151552ed'
const CHANNEL_ID = -1002381909837   // SF Essential Trades
const WEBHOOK    = 'https://trading-bot-hazel-one.vercel.app/api/telegram/ingest'

const sb = createClient(
  'https://fskgekjysnstegbnqdzl.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function getVal(key) {
  const { data } = await sb.from('tb_settings').select('value').eq('key', key).single()
  return data?.value ?? null
}
async function setVal(key, value) {
  await sb.from('tb_settings').upsert({ key, value: String(value) })
}

;(async () => {
  const sessionStr = await getVal('telegram_session')
  if (!sessionStr) { console.error('No session. Run tg-auth.cjs first.'); process.exit(1) }

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3 })
  await client.connect()
  await setVal('telegram_session', client.session.save()) // refresh session

  const lastId = parseInt(await getVal('tg_last_msg_id') ?? '0')
  const messages = await client.getMessages(CHANNEL_ID, { limit: 10 })
  await client.disconnect()

  const newMsgs = messages
    .filter(m => m.id > lastId && (m.text ?? '').length > 5)
    .reverse()

  if (newMsgs.length === 0) {
    console.log(`[${new Date().toISOString()}] No new messages`)
    process.exit(0)
  }

  const maxId = Math.max(...newMsgs.map(m => m.id))
  await setVal('tg_last_msg_id', maxId)

  for (const msg of newMsgs) {
    const text = msg.text ?? ''
    console.log(`[${new Date().toISOString()}] #${msg.id}: ${text.slice(0, 80)}`)

    // Send to ingest endpoint — Claude classifies + executes silently
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: 'sf_essential_trades', msg_id: msg.id }),
    })
    const data = await res.json().catch(() => ({}))
    console.log(`  → ${data.type ?? 'unknown'} ${data.signal?.symbol ?? ''} ${data.order?.status ?? ''}`)
    await new Promise(r => setTimeout(r, 300))
  }

  console.log(`[${new Date().toISOString()}] Done — processed ${newMsgs.length} message(s)`)
  process.exit(0)
})().catch(e => { console.error('Error:', e.message); process.exit(1) })
