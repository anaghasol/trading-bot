const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const { createClient } = require('@supabase/supabase-js')

const API_ID   = 34439500
const API_HASH = '973e147ccc3ccb895fa22c60151552ed'
const PHONE    = '+12516800461'
const CODE     = process.argv[2] // pass code as: node tg-auth.cjs 12345

const sb = createClient(
  'https://fskgekjysnstegbnqdzl.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

;(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 })
  await client.connect()

  if (!CODE) {
    // Step 1: send OTP
    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, PHONE)
    await sb.from('tb_settings').upsert({ key: 'tg_phone_hash', value: result.phoneCodeHash })
    await sb.from('tb_settings').upsert({ key: 'tg_partial_session', value: client.session.save() })
    await client.disconnect()
    console.log('✅ Code sent to your Telegram! Run again with: node tg-auth.cjs YOUR_CODE')
    process.exit(0)
  }

  // Step 2: sign in with code
  const { data: hashRow } = await sb.from('tb_settings').select('value').eq('key', 'tg_phone_hash').single()
  const { data: sessRow } = await sb.from('tb_settings').select('value').eq('key', 'tg_partial_session').single()

  const client2 = new TelegramClient(new StringSession(sessRow?.value ?? ''), API_ID, API_HASH, { connectionRetries: 5 })
  await client2.connect()

  const { Api } = require('telegram/tl')
  await client2.invoke(new Api.auth.SignIn({
    phoneNumber: PHONE,
    phoneCodeHash: hashRow?.value ?? '',
    phoneCode: CODE,
  }))

  const session = client2.session.save()
  await sb.from('tb_settings').upsert({ key: 'telegram_session', value: session })
  await sb.from('tb_settings').delete().in('key', ['tg_phone_hash', 'tg_partial_session'])
  await client2.disconnect()
  console.log('✅ Logged in! Session saved. Polling is now active.')
  process.exit(0)
})().catch(e => { console.error('Error:', e.message); process.exit(1) })
