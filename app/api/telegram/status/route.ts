import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET() {
  const db = createServiceClient()

  const [sessionRow, lastPollRow, lastMsgRow, statusRow, signalRows] = await Promise.all([
    db.from('tb_settings').select('value').eq('key', 'telegram_session').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_poll').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_status').single(),
    db.from('tb_alerts')
      .select('id, type, message, symbol, created_at')
      .or('message.ilike.%SF Essential%,message.ilike.%SF Trades%,type.in.(BUY,SELL,INFO)')
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  const hasSession  = !!(sessionRow.data?.value)
  const lastPoll    = lastPollRow.data?.value ?? null
  const lastMsgId   = parseInt(lastMsgRow.data?.value ?? '0')
  const tgStatus    = statusRow.data?.value ?? null   // 'ok' | 'error:...' | null

  const minutesSilent = lastPoll
    ? Math.round((Date.now() - new Date(lastPoll).getTime()) / 60000)
    : null

  // Connected = poller checked in within last 3 min AND last status was 'ok'
  const connected = hasSession && !!lastPoll && (minutesSilent ?? 999) < 3 && tgStatus === 'ok'

  return NextResponse.json({
    connected,
    has_session:     hasSession,
    last_poll:       lastPoll,
    minutes_silent:  minutesSilent,
    tg_status:       tgStatus,
    last_msg_id:     lastMsgId,
    signals:         signalRows.data ?? [],
  })
}
