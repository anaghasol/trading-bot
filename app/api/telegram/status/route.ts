import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET() {
  const db = createServiceClient()

  const [sessionRow, lastPollRow, lastMsgRow, signalRows] = await Promise.all([
    db.from('tb_settings').select('value').eq('key', 'telegram_session').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_poll').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single(),
    db.from('tb_alerts')
      .select('id, type, message, symbol, created_at')
      .or('message.ilike.%SF Essential%,message.ilike.%SF Trades%,type.in.(BUY,SELL,INFO)')
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  const hasSession = !!(sessionRow.data?.value)
  const lastPoll   = lastPollRow.data?.value ?? null
  const lastMsgId  = parseInt(lastMsgRow.data?.value ?? '0')

  // Connected = has session + Railway poller checked in within last 3 minutes
  let connected = false
  if (hasSession && lastPoll) {
    const ageSec = (Date.now() - new Date(lastPoll).getTime()) / 1000
    connected = ageSec < 180
  }

  return NextResponse.json({
    connected,
    has_session: hasSession,
    last_poll: lastPoll,
    last_msg_id: lastMsgId,
    signals: signalRows.data ?? [],
  })
}
