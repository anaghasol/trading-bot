/**
 * Performance tracking — win rate, expectancy, drawdown, compounding progress.
 * Read by dashboard, settings, and AI advisor to tune decisions.
 */
import { createServiceClient } from './supabase-server'

export interface PerformanceStats {
  total_trades:      number
  wins:              number
  losses:            number
  win_rate:          number           // %
  avg_win_pct:       number           // avg % gain on winners
  avg_loss_pct:      number           // avg % loss on losers
  expectancy:        number           // (win_rate * avg_win) - (loss_rate * avg_loss) per trade
  profit_factor:     number           // total win $ / total loss $ (>1 = profitable)
  total_pnl:         number           // $ realized
  current_balance:   number
  max_drawdown_pct:  number           // worst peak→trough in %
  daily_avg_pnl:     number           // average daily P&L
  best_day:          number
  worst_day:         number
  goal_progress_pct: number           // % of way to $25K
  days_to_goal:      number           // at current daily avg
  sharpe_approx:     number           // simple Sharpe approximation
  streak_wins:       number           // current winning streak
  streak_losses:     number
}

export async function getPerformanceStats(days = 30): Promise<PerformanceStats> {
  const db   = createServiceClient()
  const from = new Date(Date.now() - days * 86_400_000).toISOString()

  const [tradesResult, accountResult, dailySummaryResult] = await Promise.all([
    db.from('tb_trades').select('pnl, pnl_pct, strategy, created_at, closed_at')
      .eq('status', 'CLOSED').gte('closed_at', from).order('closed_at'),
    db.from('tb_account').select('balance, total_pnl').order('id', { ascending: false }).limit(1).single(),
    db.from('tb_daily_summary').select('daily_pnl, date').order('date', { ascending: false }).limit(30),
  ])

  const trades = tradesResult.data ?? []
  const balance = accountResult.data?.balance ?? 2000

  if (trades.length === 0) {
    return {
      total_trades: 0, wins: 0, losses: 0, win_rate: 0,
      avg_win_pct: 0, avg_loss_pct: 0, expectancy: 0, profit_factor: 0,
      total_pnl: 0, current_balance: balance,
      max_drawdown_pct: 0, daily_avg_pnl: 0,
      best_day: 0, worst_day: 0,
      goal_progress_pct: (balance / 25000) * 100,
      days_to_goal: balance < 25000 ? Math.ceil((25000 - balance) / 150) : 0,
      sharpe_approx: 0, streak_wins: 0, streak_losses: 0,
    }
  }

  const winners = trades.filter((t) => t.pnl > 0)
  const losers  = trades.filter((t) => t.pnl <= 0)

  const win_rate     = (winners.length / trades.length) * 100
  const avg_win_pct  = winners.length > 0 ? winners.reduce((s, t) => s + t.pnl_pct, 0) / winners.length : 0
  const avg_loss_pct = losers.length  > 0 ? Math.abs(losers.reduce((s, t) => s + t.pnl_pct, 0) / losers.length) : 0
  const total_win_$  = winners.reduce((s, t) => s + t.pnl, 0)
  const total_loss_$ = Math.abs(losers.reduce((s, t) => s + t.pnl, 0))

  const expectancy    = (win_rate / 100 * avg_win_pct) - ((1 - win_rate / 100) * avg_loss_pct)
  const profit_factor = total_loss_$ > 0 ? total_win_$ / total_loss_$ : total_win_$ > 0 ? 999 : 0
  const total_pnl     = trades.reduce((s, t) => s + t.pnl, 0)

  // Current streak
  let streak_wins = 0, streak_losses = 0
  for (const t of [...trades].reverse()) {
    if (t.pnl > 0) { if (streak_losses > 0) break; streak_wins++ }
    else           { if (streak_wins > 0) break; streak_losses++ }
  }

  // Daily stats
  const dailyPnls = (dailySummaryResult.data ?? []).map((d) => d.daily_pnl).filter((p) => p !== null) as number[]
  const daily_avg_pnl = dailyPnls.length > 0 ? dailyPnls.reduce((s, p) => s + p, 0) / dailyPnls.length : 0
  const best_day      = dailyPnls.length > 0 ? Math.max(...dailyPnls) : 0
  const worst_day     = dailyPnls.length > 0 ? Math.min(...dailyPnls) : 0

  // Max drawdown (from daily P&L cumulative)
  let peak = 0, maxDD = 0, running = 0
  for (const p of dailyPnls.reverse()) {
    running += p
    if (running > peak) peak = running
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0
    if (dd > maxDD) maxDD = dd
  }

  // Sharpe approximation (mean / std of daily returns)
  const mean = daily_avg_pnl
  const variance = dailyPnls.length > 1
    ? dailyPnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (dailyPnls.length - 1)
    : 1
  const std = Math.sqrt(variance)
  const sharpe_approx = std > 0 ? (mean / std) * Math.sqrt(252) : 0  // annualized

  const goal_progress_pct = (balance / 25000) * 100
  const days_to_goal = daily_avg_pnl > 0 && balance < 25000
    ? Math.ceil((25000 - balance) / daily_avg_pnl)
    : 0

  return {
    total_trades: trades.length,
    wins: winners.length,
    losses: losers.length,
    win_rate: Math.round(win_rate * 10) / 10,
    avg_win_pct:  Math.round(avg_win_pct * 100) / 100,
    avg_loss_pct: Math.round(avg_loss_pct * 100) / 100,
    expectancy:    Math.round(expectancy * 100) / 100,
    profit_factor: Math.round(profit_factor * 100) / 100,
    total_pnl:    Math.round(total_pnl * 100) / 100,
    current_balance: balance,
    max_drawdown_pct: Math.round(maxDD * 10) / 10,
    daily_avg_pnl:  Math.round(daily_avg_pnl * 100) / 100,
    best_day:  Math.round(best_day * 100) / 100,
    worst_day: Math.round(worst_day * 100) / 100,
    goal_progress_pct: Math.round(goal_progress_pct * 10) / 10,
    days_to_goal,
    sharpe_approx: Math.round(sharpe_approx * 100) / 100,
    streak_wins, streak_losses,
  }
}
