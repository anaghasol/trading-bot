import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()

  const [
    sessionRow, lastPollRow, lastMsgRow, statusRow, cronPingRow, relayRow,
    // SF Trades exclusive poller
    sfStatusRow, sfCronPingRow, sfLastPollRow, sfRelayRow,
    signalRows,
  ] = await Promise.all([
    db.from('tb_settings').select('value').eq('key', 'telegram_session').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_poll').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_last_msg_id').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_status').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_cron_ping').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_relay_last_msg').single(),
    // SF poller health keys
    db.from('tb_settings').select('value').eq('key', 'tg_sf_status').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_sf_cron_ping').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_sf_last_poll').single(),
    db.from('tb_settings').select('value').eq('key', 'tg_sf_relay_last_msg').single(),
    db.from('tb_alerts')
      .select('id, type, message, symbol, created_at')
      .or('message.ilike.%SF%,message.ilike.%SF Trades%,type.in.(BUY,SELL,INFO)')
      .order('created_at', { ascending: false })
      .limit(25),
  ])

  const hasSession    = !!(sessionRow.data?.value)
  const lastPoll      = lastPollRow.data?.value ?? null
  const lastMsgId     = parseInt(lastMsgRow.data?.value ?? '0')
  const tgStatus      = statusRow.data?.value ?? null
  const lastCronPing  = cronPingRow.data?.value ?? null
  const relayLastMsg  = relayRow.data?.value ?? null

  const minutesSilent           = lastPoll      ? Math.round((Date.now() - new Date(lastPoll).getTime())      / 60000) : null
  const minutesSinceCronPing    = lastCronPing  ? Math.round((Date.now() - new Date(lastCronPing).getTime())  / 60000) : null
  const relayMinutesAgo         = relayLastMsg  ? Math.round((Date.now() - new Date(relayLastMsg).getTime())  / 60000) : null

  const connected  = hasSession && !!lastPoll && (minutesSilent ?? 999) < 3 && tgStatus === 'ok'
  const cron_alive = (minutesSinceCronPing ?? 999) < 3

  // SF Trades poller
  const sfStatus        = sfStatusRow.data?.value ?? null
  const sfCronPing      = sfCronPingRow.data?.value ?? null
  const sfLastPoll      = sfLastPollRow.data?.value ?? null
  const sfRelayLastMsg  = sfRelayRow.data?.value ?? null

  const sfMinutesSilent         = sfLastPoll  ? Math.round((Date.now() - new Date(sfLastPoll).getTime())  / 60000) : null
  const sfMinutesSinceCronPing  = sfCronPing  ? Math.round((Date.now() - new Date(sfCronPing).getTime())  / 60000) : null
  const sfRelayMinutesAgo       = sfRelayLastMsg ? Math.round((Date.now() - new Date(sfRelayLastMsg).getTime()) / 60000) : null

  const sf_connected  = hasSession && !!sfLastPoll && (sfMinutesSilent ?? 999) < 3 && sfStatus === 'ok'
  const sf_cron_alive = (sfMinutesSinceCronPing ?? 999) < 3
  const sf_configured = sfStatus !== 'not_configured' && sfStatus !== null

  return NextResponse.json({
    // 3-channel poller
    connected,
    cron_alive,
    has_session:              hasSession,
    last_poll:                lastPoll,
    last_cron_ping:           lastCronPing,
    minutes_silent:           minutesSilent,
    minutes_since_cron_ping:  minutesSinceCronPing,
    tg_status:                tgStatus,
    last_msg_id:              lastMsgId,
    relay_last_msg:           relayLastMsg,
    relay_minutes_ago:        relayMinutesAgo,
    // SF Trades exclusive poller
    sf_connected,
    sf_cron_alive,
    sf_configured,
    sf_status:                sfStatus,
    sf_last_poll:             sfLastPoll,
    sf_relay_last_msg:        sfRelayLastMsg,
    sf_relay_minutes_ago:     sfRelayMinutesAgo,
    sf_minutes_silent:        sfMinutesSilent,
    signals:                  signalRows.data ?? [],
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}
