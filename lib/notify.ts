/**
 * Notifications — SMS via Twilio for high-conviction trade alerts.
 * Fires when both AIs agree ≥ 80% on a real-money Schwab trade,
 * or when a stop loss hits, or at end of day with P&L summary.
 *
 * Silently no-ops if Twilio env vars are missing (paper mode).
 */

const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN
const FROM_PHONE   = process.env.TWILIO_PHONE_NUMBER
const TO_PHONE     = process.env.ALERT_PHONE

async function sendSMS(body: string): Promise<void> {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_PHONE || !TO_PHONE) return

  try {
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
    const creds = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')
    const params = new URLSearchParams({ To: TO_PHONE, From: FROM_PHONE, Body: body })

    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  } catch (e) {
    console.error('[notify] SMS failed:', e)
  }
}

// ── Alert types ───────────────────────────────────────────────────────────────

/** High-conviction trade placed — both AIs 80%+ */
export async function alertTradeEntered(opts: {
  broker: 'schwab' | 'alpaca_paper'
  symbol: string
  qty: number
  price: number
  claude_conf: number
  openai_conf: number
  ema_score: number
  reason: string
  stop: number
  target: number
}) {
  if (opts.broker !== 'schwab') return  // SMS only for real money
  const merged = Math.round((opts.claude_conf + opts.openai_conf) / 2)
  if (merged < 78) return               // Only alert high-conviction

  const msg = [
    `🟢 MyTrade BUY ${opts.qty} ${opts.symbol} @ $${opts.price.toFixed(2)}`,
    `EMA ${opts.ema_score}/10 · Claude ${opts.claude_conf}% · GPT ${opts.openai_conf}% · Merged ${merged}%`,
    `Stop $${opts.stop.toFixed(2)} · Target $${opts.target.toFixed(2)}`,
    opts.reason.slice(0, 80),
  ].join('\n')

  await sendSMS(msg)
}

/** Stop loss or trailing stop hit */
export async function alertStopHit(opts: {
  broker: 'schwab' | 'alpaca_paper'
  symbol: string
  qty: number
  pnl: number
  pnl_pct: number
  exit_type: string
}) {
  if (opts.broker !== 'schwab') return

  const emoji = opts.pnl >= 0 ? '💰' : '🛑'
  const msg = [
    `${emoji} MyTrade ${opts.exit_type} ${opts.symbol}`,
    `P&L: ${opts.pnl >= 0 ? '+' : ''}$${opts.pnl.toFixed(2)} (${opts.pnl_pct.toFixed(1)}%)`,
    `${opts.qty} shares closed`,
  ].join('\n')

  await sendSMS(msg)
}

/** End-of-day summary */
export async function alertEODSummary(opts: {
  daily_pnl: number
  balance: number
  wins: number
  losses: number
  trades: number
}) {
  const emoji = opts.daily_pnl >= 0 ? '✅' : '❌'
  const goal_pct = ((opts.balance / 25000) * 100).toFixed(1)

  const msg = [
    `${emoji} MyTrade EOD: ${opts.daily_pnl >= 0 ? '+' : ''}$${opts.daily_pnl.toFixed(2)}`,
    `${opts.wins}W / ${opts.losses}L · Balance $${opts.balance.toFixed(2)}`,
    `$25K goal: ${goal_pct}% (${Math.ceil((25000 - opts.balance) / 150)}d @ $150/d)`,
  ].join('\n')

  await sendSMS(msg)
}

/** Pre-market setup alert (morning scan results) */
export async function alertPreMarket(opts: {
  setups_found: number
  top_symbol: string
  top_score: number
  regime: string
  vix: number
}) {
  if (opts.setups_found === 0) return  // no alert if nothing found

  const msg = [
    `📊 MyTrade Pre-Market Scan`,
    `${opts.setups_found} EMA setups · Regime: ${opts.regime} · VIX ${opts.vix.toFixed(0)}`,
    `Top setup: ${opts.top_symbol} (${opts.top_score}/10) — watching for entry`,
  ].join('\n')

  await sendSMS(msg)
}
