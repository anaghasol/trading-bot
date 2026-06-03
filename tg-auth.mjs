import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createClient } from '@supabase/supabase-js'
import * as readline from 'readline'

const API_ID   = 34439500
const API_HASH = '973e147ccc3ccb895fa22c60151552ed'
const PHONE    = '+12516800461'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
  connectionRetries: 5,
})

await client.start({
  phoneNumber: async () => PHONE,
  phoneCode:   async () => await ask('Enter the Telegram code sent to your phone: '),
  password:    async () => await ask('Enter 2FA password (or press Enter to skip): '),
  onError:     (err) => console.error(err),
})

const session = client.session.save()
console.log('\n✅ Session saved:', session)

// Save to Supabase
const sb = createClient(
  'https://fskgekjysnstegbnqdzl.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
await sb.from('tb_settings').upsert({ key: 'telegram_session', value: session })
console.log('✅ Session stored in Supabase — polling is now active!')

await client.disconnect()
rl.close()
process.exit(0)
