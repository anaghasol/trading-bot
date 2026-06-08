import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()

  const [sessionRow, lastPollRow, lastMsgRow, statusRow, cronPingRow, signalRows] = await Promise.all([
    db.from('tb_settings').select('value').eq('key', 'telegram_session').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_poll').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_status').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_cron_ping').single(),
    db.from('tb_alerts')
      .select('id, type, message, symbol, created_at')
      .or('message.ilike.%SF Essential%,message.ilike.%SF Trades%,type.in.(BUY,SELL,INFO)')
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  const hasSession   = !!(sessionRow.data?.value)
  const lastPoll     = lastPollRow.data?.value ?? null
  const lastMsgId    = parseInt(lastMsgRow.data?.value ?? '0')
  const tgStatus     = statusRow.data?.value ?? null   // 'ok' | 'error:...' | 'no_session' | null
  const lastCronPing = cronPingRow.data?.value ?? null // updated every cron tick, regardless of TG state

  const minutesSilent = lastPoll
    ? Math.round((Date.now() - new Date(lastPoll).getTime()) / 60000)
    : null

  const minutesSinceCronPing = lastCronPing
    ? Math.round((Date.now() - new Date(lastCronPing).getTime()) / 60000)
    : null

  // Connected = poller checked in within last 3 min AND last status was 'ok'
  const connected = hasSession && !!lastPoll && (minutesSilent ?? 999) < 3 && tgStatus === 'ok'
  // Cron alive = cron endpoint was called within last 3 min (regardless of TG state)
  const cron_alive = (minutesSinceCronPing ?? 999) < 3

  return NextResponse.json({
    connected,
    cron_alive,
    has_session:             hasSession,
    last_poll:               lastPoll,
    last_cron_ping:          lastCronPing,
    minutes_silent:          minutesSilent,
    minutes_since_cron_ping: minutesSinceCronPing,
    tg_status:               tgStatus,
    last_msg_id:             lastMsgId,
    signals:                 signalRows.data ?? [],
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}
