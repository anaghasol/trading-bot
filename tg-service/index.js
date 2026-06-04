/**
 * Telegram channel poller — runs as a persistent process on Railway.
 * Reads SF Essential Trades every 60s and sends to Vercel webhook for processing.
 */

const { TelegramClient } = require('telegram')
const { StringSession }  = require('telegram/sessions')
const { createClient }   = require('@supabase/supabase-js')

const API_ID     = parseInt(process.env.TELEGRAM_API_ID)
const API_HASH   = process.env.TELEGRAM_API_HASH
const CHANNEL_ID = -1002381909837  // SF Essential Trades
const INGEST_URL = process.env.VERCEL_APP_URL + '/api/telegram/ingest'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function getVal(key) {
  const { data } = await sb.from('tb_settings').select('value').eq('key', key).single()
  return data?.value ?? null
}
async function setVal(key, value) {
  await sb.from('tb_settings').upsert({ key, value: String(value) })
}

async function poll() {
  try {
    const sessionStr = await getVal('telegram_session')
    if (!sessionStr) { console.error('No session in Supabase'); return }

    // gramjs requires a full logger interface — plain {log:()=>{}} crashes on .info/.warn/.error
    const SILENT = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{},
                     log:()=>{}, levels:[], setLevel:()=>{}, format:()=>'', canSend:()=>false }
    const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
      connectionRetries: 3,
      updateWorkers: 0,
      baseLogger: SILENT,
    })
    await client.connect()
    await setVal('tg_last_poll', new Date().toISOString())  // heartbeat for dashboard widget
    await setVal('telegram_session', client.session.save())

    const lastId  = parseInt(await getVal('tg_last_msg_id') ?? '0')
    const messages = await client.getMessages(CHANNEL_ID, { limit: 10 })
    await client.disconnect()

    const newMsgs = messages.filter(m => m.id > lastId && (m.text ?? '').length > 5).reverse()
    if (newMsgs.length === 0) { console.log(`[${new Date().toISOString()}] No new messages`); return }

    const maxId = Math.max(...newMsgs.map(m => m.id))
    await setVal('tg_last_msg_id', maxId)

    for (const msg of newMsgs) {
      const text = msg.text ?? ''
      console.log(`[${new Date().toISOString()}] #${msg.id}: ${text.slice(0, 80)}`)
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'sf_essential_trades', msg_id: msg.id }),
      })
      const data = await res.json().catch(() => ({}))
      console.log(`  → ${data.type ?? '?'} ${data.signal?.symbol ?? ''} ${data.order?.status ?? ''}`)
      await new Promise(r => setTimeout(r, 300))
    }
    await setVal('tg_status', 'ok')
  } catch (e) {
    console.error('Poll error:', e.message)
    await setVal('tg_status', `error:${e.message?.slice(0, 120) ?? 'unknown'}`)
  }
}

// Run immediately then every 60 seconds
poll()
setInterval(poll, 60_000)
console.log('Telegram poller started — reading SF Essential Trades every 60s')
