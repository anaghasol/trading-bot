/**
 * Notifications — Telegram push to "Akhil & myapp" group.
 * All alerts replaced with TG (no SMS). Live (Schwab) gets full coverage;
 * paper (Alpaca) is mostly silent to keep the channel clean.
 *
 * BOT_TOKEN → TELEGRAM_BOT_TOKEN
 * GROUP_ID  → TELEGRAM_ALLOWED_CHAT_ID  (the "Akhil & myapp" private group)
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const GROUP_ID  = process.env.TELEGRAM_ALLOWED_CHAT_ID

async function sendTG(body: string): Promise<void> {
  if (!BOT_TOKEN || !GROUP_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, text: body, parse_mode: 'Markdown' }),
    })
  } catch (e) {
    console.error('[notify] TG failed:', e)
  }
}

// ── Live trade alerts ─────────────────────────────────────────────────────────

/** BUY placed on live Schwab account */
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
  if (opts.broker !== 'schwab') return
  const merged = Math.round((opts.claude_conf + opts.openai_conf) / 2)
  if (merged < 78) return

  await sendTG([
    `🟢 *LIVE BUY — ${opts.symbol}*`,
    `${opts.qty} shares @ $${opts.price.toFixed(2)} · EMA ${opts.ema_score}/10 · ${merged}% confidence`,
    `Stop $${opts.stop.toFixed(2)} · Target $${opts.target.toFixed(2)}`,
    opts.reason.slice(0, 100),
  ].join('\n'))
}

/** Stop or trailing stop triggered on live account */
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
  await sendTG([
    `${emoji} *LIVE SELL — ${opts.symbol}* (${opts.exit_type})`,
    `P&L: ${opts.pnl >= 0 ? '+' : ''}$${opts.pnl.toFixed(2)} (${opts.pnl_pct.toFixed(1)}%)`,
    `${opts.qty} shares closed`,
  ].join('\n'))
}

/** End-of-day summary — live Schwab account */
export async function alertEODSummary(opts: {
  daily_pnl: number
  balance: number
  wins: number
  losses: number
  trades: number
}) {
  const emoji = opts.daily_pnl >= 0 ? '✅' : '❌'
  const goal_pct = ((opts.balance / 25000) * 100).toFixed(1)
  const days_left = Math.ceil((25000 - opts.balance) / 150)

  await sendTG([
    `${emoji} *MyTrade EOD — Live Account*`,
    `Day P&L: ${opts.daily_pnl >= 0 ? '+' : ''}$${opts.daily_pnl.toFixed(2)} · ${opts.wins}W / ${opts.losses}L · ${opts.trades} trades`,
    `Balance: $${opts.balance.toFixed(2)}`,
    `$25K goal: ${goal_pct}% · ~${days_left}d @ $150/day`,
  ].join('\n'))
}

/** End-of-day Paper vs Live comparison */
export async function alertEODComparison(opts: {
  paper_pnl: number
  paper_balance: number
  live_pnl: number
  live_balance: number
  paper_wins: number
  paper_losses: number
  live_wins: number
  live_losses: number
}) {
  const pe = opts.paper_pnl >= 0 ? '📗' : '📕'
  const le = opts.live_pnl >= 0 ? '✅' : '❌'
  const goal_pct = ((opts.live_balance / 25000) * 100).toFixed(1)

  await sendTG([
    `📊 *MyTrade EOD Report*`,
    `${le} *Live:*  ${opts.live_pnl >= 0 ? '+' : ''}$${opts.live_pnl.toFixed(0)} | ${opts.live_wins}W/${opts.live_losses}L | $${opts.live_balance.toFixed(0)}`,
    `${pe} Paper: ${opts.paper_pnl >= 0 ? '+' : ''}$${opts.paper_pnl.toFixed(0)} | ${opts.paper_wins}W/${opts.paper_losses}L | $${opts.paper_balance.toFixed(0)}`,
    `$25K goal: ${goal_pct}%`,
  ].join('\n'))
}

/** Morning brief — 9:35 AM ET */
export async function alertMorningBrief(opts: {
  account_value: number
  open_pnl: number
  positions: Array<{ symbol: string; pnl_pct: number; hold_days: number }>
  recycled: string[]
  regime?: string
}) {
  const { account_value, open_pnl, positions, recycled, regime } = opts
  const winners = positions.filter((p) => p.pnl_pct >= 5)
  const losers  = positions.filter((p) => p.pnl_pct <= -3)

  const posLine = positions
    .sort((a, b) => b.pnl_pct - a.pnl_pct)
    .slice(0, 7)
    .map((p) => `${p.symbol} ${p.pnl_pct >= 0 ? '+' : ''}${p.pnl_pct.toFixed(1)}%`)
    .join(' | ')

  const lines = [
    `🌅 *MyTrade Morning Brief*`,
    `$${account_value.toLocaleString('en-US', { maximumFractionDigits: 0 })} · Open P&L: ${open_pnl >= 0 ? '+' : ''}$${open_pnl.toFixed(0)}`,
    `${positions.length} open · ${winners.length} winners · ${losers.length} losers${regime ? ` · ${regime}` : ''}`,
    posLine,
    recycled.length ? `Recycled: ${recycled.join(', ')}` : '',
    `Bot running.`,
  ].filter(Boolean)

  await sendTG(lines.join('\n'))
}

/** Pre-market scan results — fired when scan finds setups */
export async function alertPreMarket(opts: {
  setups_found: number
  top_symbol: string
  top_score: number
  regime: string
  vix: number
}) {
  if (opts.setups_found === 0) return

  await sendTG([
    `📊 *Pre-Market Scan*`,
    `${opts.setups_found} setups · Regime: ${opts.regime} · VIX ${opts.vix.toFixed(0)}`,
    `Top: ${opts.top_symbol} (${opts.top_score}/10) — watching for entry`,
  ].join('\n'))
}

/** Schwab token expiring */
export async function alertSchwabTokenExpiry(hours: number): Promise<void> {
  const urgency = hours <= 4 ? '🚨 URGENT' : '⚠️'
  await sendTG(
    `${urgency} *Schwab token expires in ${hours}h*\nGo to Settings → Re-authorize Schwab before trading stops.\nhttps://trading-bot-hazel-one.vercel.app/settings`
  )
}

/** Telegram poller went silent */
export async function alertTelegramDown(minutesSilent: number): Promise<void> {
  await sendTG(
    `⚠️ *Telegram disconnected*\nSF Trades signals paused — ${minutesSilent}min since last poll`
  )
}

/** Telegram reconnected */
export async function alertTelegramReconnected(): Promise<void> {
  await sendTG(`✅ *Telegram reconnected* — SF Trades signals live again`)
}

/** Health alert — from self-healing cron */
export async function sendHealthAlert(issues: string[], healed: string[]): Promise<void> {
  const lines = [
    `⚠️ *MyTrade Health Alert*`,
    healed.length ? `✅ Auto-fixed: ${healed.slice(0, 3).join(', ')}` : null,
    `🔴 ${issues.length} issue${issues.length > 1 ? 's' : ''}:`,
    ...issues.slice(0, 4).map((i) => `• ${i.slice(0, 80)}`),
    issues.length > 4 ? `…+${issues.length - 4} more` : null,
  ].filter(Boolean)
  await sendTG(lines.join('\n'))
}
