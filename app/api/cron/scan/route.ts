/**
 * CRON: /api/cron/scan — the continuous-trading entry loop.
 * Runs BOTH Schwab (real, protected) and Alpaca (paper, aggressive lab) concurrently.
 *
 * UPGRADE (this build): the scanner is now profile + sleeve + rotation aware.
 *   1. profileFor(broker)   → per-broker risk personality (protected vs lab)
 *   2. getCategoryMomentum()→ rank themes; skip COLD, boost HOT (daily rotation)
 *   3. getSleeveAllocation()→ each entry is sized against its time-horizon sleeve
 *
 * Each AI pick is routed:  setup → sleeve → (budget × risk × category-bias) → qty.
 * All Supabase contracts (tb_trades / tb_alerts / tb_cron_log, broker-column
 * fallback) are unchanged — this is additive sizing/selection logic only.
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { getRecommendations } from '@/lib/ai-advisor'
import { analyzePdtStatus } from '@/lib/pdt'
import { batchEarningsCheck, formatEarningsWarning } from '@/lib/earnings'
import { isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
import { alertTradeEntered, alertPreMarket } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'
import { profileFor } from '@/lib/strategy-profiles'
import { getCategoryMomentum, biasForSymbol, categoryLabel, type RotationResult } from '@/lib/category-rotation'
import { getSleeveAllocation, sleeveForSetup, sleeveSizing } from '@/lib/sleeves'
import { getActiveIntentions, markActed } from '@/lib/tg-intentions'
import { batchResearch, applyResearchBoost } from '@/lib/research-score'
import { getRuntimeConfig } from '@/lib/runtime-config'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

async function getEngineStatus(db: ReturnType<typeof createServiceClient>) {
  const { data } = await db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca'])
  return {
    schwab:       data?.find((r) => r.key === 'engine_schwab')?.value ?? 'running',
    alpaca_paper: data?.find((r) => r.key === 'engine_alpaca')?.value ?? 'running',
  }
}

// ── Shared scan logic ─────────────────────────────────────────────────────────

async function runScan(
  broker: 'schwab' | 'alpaca_paper',
  db: ReturnType<typeof createServiceClient>,
  rotation: RotationResult,
): Promise<{ trades_made: number; message: string }> {

  // Distributed lock: skip if another instance of this broker's scan is already running.
  // Lock expires after 100s (maxDuration is 60s, so 100s is safe overlap buffer).
  // Stale fallback: if lock is > 5 min old, previous scan likely crashed — force-clear and log.
  const lockKey = `scan_lock_${broker}`
  try {
    const { data: lock } = await db.from('tb_settings').select('value').eq('key', lockKey).single()
    if (lock?.value) {
      const ageMs = Date.now() - new Date(lock.value).getTime()
      if (ageMs < 100_000) {
        return { trades_made: 0, message: `[${broker}] Skipped — scan already running (${Math.floor(ageMs / 1000)}s ago)` }
      }
      if (ageMs > 300_000) {
        // > 5 min stale — scan crashed without releasing. Alert so it shows in Live Monitor.
        console.warn(`[${broker}] Stale scan lock (${Math.floor(ageMs / 60000)}m) — force-clearing`)
        void db.from('tb_alerts').insert({ type: 'WARN', message: `[${broker}] Stale scan lock cleared (${Math.floor(ageMs / 60000)}m old — previous scan may have crashed)` })
      }
    }
    await db.from('tb_settings').upsert({ key: lockKey, value: new Date().toISOString() })
  } catch { /* non-fatal — if lock check fails, proceed anyway */ }

  const isSchwab = broker === 'schwab'
  const api      = isSchwab ? SchwabBroker : AlpacaBroker
  const profile  = profileFor(broker)

  // Cancel stale open BUY orders from previous scan runs (Alpaca paper only).
  // Market orders that haven't filled after 10+ minutes are consuming buying power
  // and blocking new entries. Safe to cancel — scan will re-issue fresh orders
  // if the setup is still valid. GTC trailing stops are sell-side and unaffected.
  if (!isSchwab) {
    try {
      // getOpenOrders() returns pending/working orders (not filled). Cancel all DAY buy orders
      // older than 4 min — market buys that haven't filled are stale and consuming buying power.
      // GTC trailing stop sells are unaffected (instruction === 'SELL').
      const openOrders = await AlpacaBroker.getOpenOrders()
      const staleBuys = openOrders.filter((o) =>
        o.instruction === 'BUY' &&
        (Date.now() - new Date(o.entered_time).getTime()) > 4 * 60 * 1000
      )
      if (staleBuys.length > 0) {
        console.log(`[alpaca] Cancelling ${staleBuys.length} stale buy orders: ${staleBuys.map(o => o.symbol).join(', ')}`)
        await Promise.all(staleBuys.map((o) => AlpacaBroker.cancelOrder(o.order_id)))
        await new Promise((r) => setTimeout(r, 800))  // let Alpaca release the buying power
      }
    } catch { /* non-fatal — proceed with scan */ }

    // Hard gate: check Alpaca's actual buying_power (includes pending order reservations).
    // Our position-based exposure calc misses working orders that are reserving cash.
    // If BP < $2000, no trade can be sized safely — skip entire scan and report clearly.
    try {
      const bp = await AlpacaBroker.getBuyingPower()
      if (bp < 2000) {
        const msg = `[alpaca_paper] Skipped — buying power $${bp.toFixed(0)} < $2000 (account fully deployed or orders pending)`
        console.log(msg)
        void db.from('tb_alerts').insert({ type: 'INFO', message: msg, broker: 'alpaca_paper' })
        return { trades_made: 0, message: msg }
      }
    } catch { /* non-fatal */ }
  }
  // Runtime config overrides profile — EOD auto-tuner writes here so adjustments
  // take effect next scan cycle without a code deploy
  const runtimeCfg = await getRuntimeConfig(broker)

  // Strategy boost: Growth page can temporarily boost one strategy for 48h.
  // Reads tb_settings 'strategy_boost' → { name, mult, expires_at }
  let stratBoost: { name: string; mult: number } | null = null
  try {
    const { data: boostRow } = await db.from('tb_settings').select('value').eq('key', 'strategy_boost').single()
    if (boostRow?.value) {
      const b = JSON.parse(boostRow.value) as { name: string; mult: number; expires_at: string }
      if (b.name && new Date(b.expires_at) > new Date()) {
        stratBoost = { name: b.name.toUpperCase(), mult: b.mult ?? 1.2 }
        console.log(`[${broker}] Strategy boost active: ${stratBoost.name} ×${stratBoost.mult}`)
      }
    }
  } catch { /* non-fatal */ }

  const [positions, balance, orders] = await Promise.all([
    api.getPositions(),
    api.getAccountBalance(),
    api.getOrders(7),
  ])

  const equity = balance ?? (isSchwab ? 2000 : 100000)
  const pdt    = analyzePdtStatus(orders, equity)

  // Re-entry boost: if a symbol was stopped out in the last 90 minutes on this broker,
  // and it's no longer held, give it +5 confidence boost so the AI re-enters it
  // if the setup is still valid. This implements the "smart re-entry" behavior.
  const recentStopSymbols = new Set<string>()
  try {
    const stopCutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    const { data: stopRows } = await db
      .from('tb_alerts')
      .select('symbol')
      .eq('type', 'STOP_LOSS')
      .gte('created_at', stopCutoff)
      .not('symbol', 'is', null)
      .or(isSchwab ? 'broker.eq.schwab,broker.is.null' : 'broker.eq.alpaca_paper')
    const heldSet = new Set(positions.map((p) => p.symbol))
    for (const r of stopRows ?? []) {
      const sym = r.symbol as string
      if (sym && !heldSet.has(sym)) recentStopSymbols.add(sym)  // not held = eligible for re-entry
    }
    if (recentStopSymbols.size > 0) {
      console.log(`[${broker}] Re-entry candidates (stopped <90m ago, not held): ${Array.from(recentStopSymbols).join(', ')}`)
    }
  } catch { /* non-fatal */ }

  // Compute today's realized P/L fresh from tb_trades — never trust stale tb_account.daily_pnl.
  const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00Z'
  const { data: todayClosedRows } = await db
    .from('tb_trades')
    .select('pnl')
    .eq('status', 'CLOSED')
    .gte('closed_at', todayStart)
    .or(isSchwab ? 'broker.eq.schwab,broker.is.null' : 'broker.eq.alpaca_paper')
  const dailyPnl = (todayClosedRows ?? []).reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)

  // Daily-loss breaker: enforced on real money (Schwab); paper lab runs looser.
  if (isSchwab && isDailyLossExceeded(dailyPnl, equity)) {
    return { trades_made: 0, message: `[${broker}] Daily loss limit hit (realized today: $${dailyPnl.toFixed(2)})` }
  }

  // Macro bearish gate: if channel advisor said "hold off on new purchases" within last 18h, pause entries
  try {
    const { data: macroRow } = await db.from('tb_settings').select('value').eq('key', 'tg_macro_stance').single()
    if (macroRow?.value) {
      const macro = JSON.parse(macroRow.value) as { stance: string; set_at: string }
      const hoursAgo = (Date.now() - new Date(macro.set_at).getTime()) / 3600000
      if (macro.stance === 'bearish' && hoursAgo < 18) {
        return { trades_made: 0, message: `[${broker}] Macro bearish pause — advisor said hold off ${hoursAgo.toFixed(0)}h ago` }
      }
    }
  } catch { /* non-fatal — if this fails, scan continues */ }

  // Economic event pause (FOMC, CPI, NFP): TG channel warned of big moves around specific time.
  // Only applies to live Schwab — paper lab keeps running to collect data through events.
  if (isSchwab) {
    try {
      const { data: pauseRow } = await db.from('tb_settings').select('value').eq('key', 'event_pause_until').single()
      if (pauseRow?.value) {
        const pause = JSON.parse(pauseRow.value) as { until: string; reason: string }
        if (new Date(pause.until) > new Date()) {
          const minLeft = Math.round((new Date(pause.until).getTime() - Date.now()) / 60_000)
          return { trades_made: 0, message: `[schwab] EVENT PAUSE — ${minLeft}m left | ${pause.reason.slice(0, 60)}` }
        }
      }
    } catch { /* non-fatal */ }
  }

  // (position cap enforced after regime check using dynamicMaxPos below)

  // Total exposure cap: don't open new positions if already > 75% equity deployed.
  // Uses Yahoo price for each position (not Alpaca IEX) to avoid inflated cap readings
  // from stale IEX data — then tracks per-trade running exposure so multiple picks
  // in one scan run don't collectively bypass the cap.
  // Paper: 80% max deployed — keeps 20% dry powder for high-score setups.
  // Live (Schwab): 70% max — real money stays conservative.
  const MAX_EXPOSURE = isSchwab ? 0.70 : 0.95  // paper: deploy up to 95% — use ALL capital
  const totalMarketValue = positions.reduce((s, p) => s + Math.abs(p.market_value ?? p.current_price * p.quantity), 0)

  // Options exposure cap: don't let options consume more than 20% (paper) / 10% (live) of equity.
  // AMD-style put losses can be catastrophic when options become 24%+ of account. Hard gate.
  const MAX_OPT_EXPOSURE = isSchwab ? 0.10 : 0.20
  const optMarketValue = positions.filter((p) => p.asset_type === 'OPTION').reduce((s, p) => s + Math.abs(p.market_value ?? 0), 0)
  if (optMarketValue / equity > MAX_OPT_EXPOSURE) {
    console.log(`[${broker}] Options exposure ${(optMarketValue/equity*100).toFixed(0)}% > ${MAX_OPT_EXPOSURE*100}% cap — blocking new option entries`)
  }

  if (totalMarketValue / equity > MAX_EXPOSURE) {
    // Rotate up to 3 losers to bring exposure under cap, then CONTINUE the scan
    // to immediately fill the freed slots. Previous behavior (rotate 1, return early)
    // meant freed capital sat idle for 10 full minutes until the next scan cycle.
    const rotateThreshold = isSchwab ? -1.5 : -0.8
    let runningMV = totalMarketValue
    const rotated: string[] = []

    const loserCandidates = [...positions]
      .filter((p) => p.pnl_pct < rotateThreshold && p.asset_type !== 'OPTION')
      .sort((a, b) => a.pnl_pct - b.pnl_pct)

    for (const loser of loserCandidates) {
      if (runningMV / equity <= MAX_EXPOSURE) break  // exposure now under cap
      if (rotated.length >= 3) break                  // cap rotations per cycle
      const result = isSchwab
        ? await SchwabBroker.placeOrder(loser.symbol, Math.abs(loser.quantity), 'SELL', 'MARKET')
        : await AlpacaBroker.closePosition(loser.symbol)
      if (result.status === 'PLACED') {
        runningMV -= Math.abs(loser.market_value ?? loser.current_price * loser.quantity)
        rotated.push(`${loser.symbol}(${loser.pnl_pct.toFixed(1)}%)`)
        await db.from('tb_alerts').insert({ type: 'SELL', symbol: loser.symbol, broker,
          message: `[ROTATE] Sold ${loser.symbol} (${loser.pnl_pct.toFixed(1)}%) → freeing capacity for high-score entry` })
        console.log(`[${broker}] Rotated out ${loser.symbol} (${loser.pnl_pct.toFixed(1)}%) — exposure now ${(runningMV/equity*100).toFixed(0)}%`)
      }
    }

    // If still over cap after rotations, block for this cycle
    if (runningMV / equity > MAX_EXPOSURE) {
      return { trades_made: 0, message: `[${broker}] Exposure cap: ${(runningMV/equity*100).toFixed(0)}% > ${MAX_EXPOSURE*100}% — rotated [${rotated.join(', ') || 'none'}], still blocked` }
    }
    // Exposure freed — fall through and enter new positions immediately
    console.log(`[${broker}] Rotated [${rotated.join(', ')}] — exposure now ${(runningMV/equity*100).toFixed(0)}%, continuing scan`)
  }
  // Running exposure: updated after each successful trade in this scan run so the
  // second and third picks in the same run can't sneak past the cap.
  let runningExposure = totalMarketValue

  const heldSymbols = positions.map((p) => p.symbol)
  const alloc       = await getSleeveAllocation(db)

  const { recommendations, regime, scanned, candidates, new_discoveries } =
    await getRecommendations(equity, heldSymbols, pdt.day_trades_remaining, broker)

  // Log how many raw recommendations came back (before EMA bypass / signal boosts)
  console.log(`[${broker}] getRecommendations → ${recommendations.length} recs from Claude (${candidates} candidates, ${scanned} scanned)`)

  // Alert on genuinely new discoveries (not in static watchlist) — once per symbol per day
  // Now fires for BOTH live and paper since discovery is enabled for both
  if (new_discoveries.length > 0) {
    const today = new Date().toISOString().slice(0, 10)
    for (const d of new_discoveries.slice(0, 3)) {  // cap at 3 alerts per tick
      const alertKey = `discovery_alert_${d.symbol}_${today}`
      const { data: existing } = await db.from('tb_settings').select('value').eq('key', alertKey).single()
      if (!existing) {
        await db.from('tb_settings').upsert({ key: alertKey, value: new Date().toISOString() })
        await db.from('tb_alerts').insert({ type: 'INFO', symbol: d.symbol, message: `🔍 Discovery: ${d.symbol} — ${d.signal}` })
        const BOT = process.env.TELEGRAM_BOT_TOKEN
        const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
        if (BOT && GID) {
          fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: GID, text: `🔍 *New Discovery: ${d.symbol}*\n${d.signal}\nNot in watchlist — scanning now`, parse_mode: 'Markdown' }),
          }).catch(() => {})
        }
      }
    }
  }

  // ── 3-tier dynamic market gate ────────────────────────────────────────────
  // Good (VIX<22, SPY above 200SMA) → base gate, full positions
  // Tough (VIX 22-28)               → gate +5pts, same positions
  // Bad  (VIX>28 or below 200SMA)   → gate +12pts (floor 65%), cap positions at 6
  const vix = regime.vix
  const aboveSma = regime.spy_above_200sma

  let marketTier: 'GOOD' | 'TOUGH' | 'BAD'
  let dynamicMinConf: number
  let dynamicMaxPos: number

  // Base gate + max positions from runtime config (EOD tuner adjusts these daily)
  const baseConf = runtimeCfg.min_confidence
  const baseMax  = runtimeCfg.max_positions

  if (!aboveSma || vix > 28) {
    marketTier    = 'BAD'
    dynamicMinConf = isSchwab ? Math.max(baseConf + 12, 65) : baseConf + 6
    dynamicMaxPos  = isSchwab ? Math.min(baseMax, 6) : Math.min(baseMax, 16)
  } else if (vix > 22) {
    marketTier    = 'TOUGH'
    dynamicMinConf = isSchwab ? baseConf + 5 : baseConf + 2
    dynamicMaxPos  = baseMax
  } else {
    marketTier    = 'GOOD'
    dynamicMinConf = baseConf
    dynamicMaxPos  = baseMax
  }

  // Optional position cap from dashboard settings (set schwab_max_pos=2 for cautious first-week start).
  // Applies on top of the regime cap — never overrides downward protection, only adds a tighter ceiling.
  if (isSchwab) {
    try {
      const { data: capRow } = await db.from('tb_settings').select('value').eq('key', 'schwab_max_pos').single()
      if (capRow?.value) {
        const cap = parseInt(capRow.value, 10)
        if (cap > 0) dynamicMaxPos = Math.min(dynamicMaxPos, cap)
      }
    } catch { /* non-fatal */ }
  }

  if (positions.length >= dynamicMaxPos) {
    return { trades_made: 0, message: `[${broker}] Full ${marketTier}: ${positions.length}/${dynamicMaxPos} | VIX${vix.toFixed(0)}` }
  }

  // Idle-cash gate: if <30% of equity is deployed, lower confidence gate by 3pts so we
  // fill slots instead of sitting in cash. Paper deploys aggressively; Schwab stays guarded.
  const deployedPct = totalMarketValue / equity
  if (deployedPct < 0.30 && positions.length < Math.floor(dynamicMaxPos / 2)) {
    const idleDrop = isSchwab ? 2 : 3
    dynamicMinConf = Math.max(dynamicMinConf - idleDrop, isSchwab ? 55 : 18)
    console.log(`[${broker}] Idle-cash mode: ${(deployedPct * 100).toFixed(0)}% deployed — gate lowered to ${dynamicMinConf}%`)
  }

  // Load active intentions from TG channel signals — these shape every execution decision this tick
  const intentions = await getActiveIntentions().catch(() => [])
  const intentionMap = new Map(intentions.map((i) => [i.symbol, i]))
  const avoidSymbols = new Set(intentions.filter((i) => i.type === 'avoid').map((i) => i.symbol))

  // Telegram signal boost: symbols mentioned in recent Telegram trade signals
  // (last 4 hours) get +8 confidence points — channel confirms our own scan.
  const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
  const { data: tgRows } = await db
    .from('tb_alerts')
    .select('symbol')
    .in('type', ['BUY', 'SELL'])
    .gte('created_at', since)
    .not('symbol', 'is', null)
  const tgSymbols = new Set((tgRows ?? []).map((r) => r.symbol as string))

  // Supercycle queue boost: symbols queued by weekly supercycle screener get +10 confidence.
  // SUPERCYCLE_QUEUE entries written by /api/cron/supercycle every Sunday — valid for 7 days.
  const supercycleCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const { data: scRows } = await db
    .from('tb_alerts')
    .select('symbol')
    .eq('type', 'SUPERCYCLE_QUEUE')
    .gte('created_at', supercycleCutoff)
    .not('symbol', 'is', null)
  const supercycleSymbols = new Set((scRows ?? []).map((r) => r.symbol as string))

  // Hot List boost: symbols in today's hot list (last 90 min) get +6 confidence.
  // These are intraday momentum movers ranked by change% × volume surge.
  const hotlistCutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString()
  const { data: hotRows } = await db
    .from('tb_alerts')
    .select('symbol')
    .eq('type', 'HOT_LIST')
    .gte('created_at', hotlistCutoff)
    .not('symbol', 'is', null)
  const hotlistSymbols = new Set((hotRows ?? []).map((r) => r.symbol as string))

  // Rotation overlay: rank by confidence × category bias.
  // Paper mode: COLD categories get bias=0.5 (not filtered out) so we still collect data.
  // Live (Schwab): COLD categories are filtered out completely.
  // Telegram-confirmed symbols get +8 confidence bonus before ranking.
  // Supercycle-queued symbols get +10 confidence bonus (monthly momentum confirmed).
  // Research layer applied BEFORE the confidence gate so high-RS stocks can unlock themselves.
  const rankedPre = recommendations
    .filter((r) => !heldSymbols.includes(r.symbol))
    .filter((r) => !avoidSymbols.has(r.symbol))   // channel said avoid — never enter
    .map((r) => {
      const rawBias = biasForSymbol(r.symbol, rotation)
      const bias = !isSchwab && rawBias === 0 ? 0.4 : rawBias

      const intent = intentionMap.get(r.symbol)
      // Post-Claude safety-net boosts — reduced since Claude now sees signals directly in the prompt.
      // These exist so a borderline setup (e.g. 72% Claude but strong TG+SC combo) still passes gate.
      // buy_zone / watch_only intents are still full-strength (price-zone logic not in Claude prompt).
      let intentBoost = 0
      if (intent?.type === 'buy_zone' && intent.price_zone) {
        intentBoost = intent.urgency === 'high' ? 15 : 10  // price-zone entry unchanged
      } else if (intent?.type === 'watch_only') {
        intentBoost = 5
      } else if (tgSymbols.has(r.symbol)) {
        intentBoost = 10  // TG channel confirmed: strong post-Claude safety-net boost
      }
      const supercycleBoost = supercycleSymbols.has(r.symbol) ? 12 : 0  // strong: weekly RS+200MA confirmed
      const hotlistBoost    = hotlistSymbols.has(r.symbol)    ? 12 : 0  // strong: today's hot mover by volume
      const reentryBoost    = recentStopSymbols.has(r.symbol) ? 5 : 0   // re-entry bump

      const totalBoost = intentBoost + supercycleBoost + hotlistBoost + reentryBoost
      const finalConf  = Math.min(100, r.confidence + totalBoost)
      if (totalBoost > 0 || tgSymbols.has(r.symbol) || supercycleSymbols.has(r.symbol)) {
        const sigLabels = [
          tgSymbols.has(r.symbol) ? 'TG✓' : '',
          supercycleSymbols.has(r.symbol) ? 'SC✓' : '',
          hotlistSymbols.has(r.symbol) ? 'HL✓' : '',
          recentStopSymbols.has(r.symbol) ? 'RE✓' : '',
          intent ? `INTENT(${intent.type})` : '',
        ].filter(Boolean).join(' ')
        console.log(`[SIGNALS] ${r.symbol}: ${sigLabels || 'none'} | claude=${r.confidence}% boost=+${totalBoost} → final=${finalConf}%`)
      }

      return {
        rec: { ...r, confidence: finalConf },
        bias,
        tg_confirmed:  tgSymbols.has(r.symbol) || !!intent,
        supercycle:    supercycleSymbols.has(r.symbol),
        intent,
      }
    })
    .filter((x) => isSchwab ? x.bias > 0 : true)

  // Research & Conviction Engine: batch-fetch RS vs SPY, volume pace, 52-week proximity.
  // Applies confidence boosts BEFORE the dynamicMinConf gate — allows strong setups to
  // self-qualify even when AI alone was borderline (e.g. 67% → 77% for score ≥ 7.5 on paper).
  const research = await batchResearch(rankedPre.map((x) => x.rec.symbol)).catch(() => new Map<string, import('@/lib/research-score').ResearchScore>())
  for (const item of rankedPre) {
    const rs = research.get(item.rec.symbol)
    const prevConf = item.rec.confidence
    item.rec.confidence = applyResearchBoost(prevConf, rs, !isSchwab)
    if (rs && rs.score >= 5) {
      const boosted = item.rec.confidence > prevConf ? ` → conf ${prevConf}→${item.rec.confidence}%` : ''
      console.log(`[RESEARCH][${broker}] ${item.rec.symbol} score=${rs.score} (RS+${rs.pts.rs} Vol+${rs.pts.vol} 52w+${rs.pts.high52} Range+${rs.pts.range}) label=${rs.label}${boosted}`)
    }
  }

  // Dip Runner boost (paper only): strong RS stocks pulling back = best entries.
  // Any stock with research RS score ≥ 5 (outperforming SPY) + AI hesitant (conf<65)
  // = AI is seeing short-term risk on a market leader. Boost it — buy the dip.
  // Supercycle confirmed = even stronger signal (SNDK-pattern weekly screener found it).
  if (!isSchwab) {
    let dipRunnerCount = 0
    for (const item of rankedPre) {
      const rs = research.get(item.rec.symbol)
      const rsScore = rs?.score ?? 0
      // Widened: RS ≥ 4 (was 5), aiHesitant < 70 (was 65), ema ≥ 2 (was 3), cap 8 (was 4)
      const isRunner      = item.supercycle || rsScore >= 4  // outperforming SPY
      const aiHesitant    = item.rec.confidence < 70         // AI uncertain = likely dipping
      const hasStructure  = (item.rec.ema_score ?? 0) >= 2   // minimal mechanical structure
      const boost         = item.supercycle ? 28 : 22        // slightly bigger boost too
      if (isRunner && aiHesitant && hasStructure && dipRunnerCount < 8) {
        const oldConf = item.rec.confidence
        item.rec.confidence = Math.min(85, item.rec.confidence + boost)
        item.rec.hold_mode  = 'trend'
        dipRunnerCount++
        console.log(`[DIP_RUNNER][paper] ${item.rec.symbol}: SC=${item.supercycle} RS=${rsScore.toFixed(1)} ema=${item.rec.ema_score} +${boost} → conf ${oldConf}→${item.rec.confidence}% TREND`)
      }
    }
  }

  // Paper mode: EMA score IS the quality gate. Claude ranks/sizes, doesn't veto.
  // ema≥3 = any mechanical structure = enter paper. Pro systems act, not deliberate.
  // Bypassed setups get confidence floored at 50 so sizing math works correctly.
  // Live: strict AI gate applies — Claude's confidence must clear dynamicMinConf.
  const ranked = rankedPre
    .filter((x) => {
      if (x.rec.confidence >= dynamicMinConf) return true
      if (!isSchwab && (x.rec.ema_score ?? 0) >= 3) {
        x.rec.confidence = Math.max(x.rec.confidence, 50)  // floor for sizing
        return true
      }
      return false
    })
    .sort((a, b) => (b.rec.confidence * b.bias) - (a.rec.confidence * a.bias))

  let tradesMade = 0
  const enteredSymbols = new Set<string>()   // track entries to build fast-scan queue
  const openSlots = dynamicMaxPos - positions.length
  const reviewLimit = isSchwab ? openSlots : Math.max(openSlots, 80)  // paper: review up to 80 ranked

  const skipReasons: string[] = []  // collected per scan tick, sent as one TG if no trades made

  // Batch-fetch earnings dates for all ranked candidates in one Yahoo Finance call.
  // Cheaper than per-stock calls inside the loop. Symbols with no data → treated as safe.
  const earningsMap = await batchEarningsCheck(ranked.slice(0, reviewLimit).map((x) => x.rec.symbol)).catch(() => new Map())

  for (const { rec, bias, tg_confirmed, intent } of ranked.slice(0, reviewLimit)) {
    const quote = isSchwab
      ? await SchwabBroker.getQuote(rec.symbol)
      : await AlpacaBroker.getQuote(rec.symbol)
    if (!quote || quote.price <= 0) {
      skipReasons.push(`${rec.symbol}: no quote`)
      continue
    }

    // Earnings guard: skip stocks with earnings within 2 days (before or after).
    // Binary events = unpredictable gap risk. Let the dust settle, re-enter after.
    const earningsInfo = earningsMap.get(rec.symbol)
    if (earningsInfo?.hasSoon) {
      const warn = formatEarningsWarning(earningsInfo)
      console.log(`[${broker}] Skip ${rec.symbol} — ${warn}`)
      skipReasons.push(`${rec.symbol}: ${warn}`)
      continue
    }

    // Alpaca IEX price sanity check: IEX bars can be stale for thin/new stocks.
    // Cross-check against Yahoo Finance — if >30% apart, the IEX price is lying, skip the trade.
    // (This caught SPCX being priced at $27 via stale IEX bar when market was at $163.)
    if (!isSchwab) {
      try {
        const yhRes = await fetch(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${rec.symbol}&fields=regularMarketPrice,regularMarketChangePercent`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        )
        if (yhRes.ok) {
          const yhData = await yhRes.json()
          const yhResult = yhData?.quoteResponse?.result?.[0] ?? {}
          const yhPrice: number = yhResult.regularMarketPrice ?? 0
          const yhChangePct: number = yhResult.regularMarketChangePercent ?? 0
          if (yhPrice > 0 && Math.abs(quote.price - yhPrice) / yhPrice > 0.30) {
            const msg = `[alpaca] Stale IEX price ${rec.symbol}: IEX=$${quote.price.toFixed(2)} vs Yahoo=$${yhPrice.toFixed(2)} (${(Math.abs(quote.price - yhPrice)/yhPrice*100).toFixed(0)}% diff) — skipping trade`
            console.warn(msg)
            void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, message: msg })
            skipReasons.push(`${rec.symbol}: stale IEX $${quote.price.toFixed(0)} vs Yahoo $${yhPrice.toFixed(0)}`)
            continue
          }
          if (yhPrice > 0) quote.price = yhPrice
          // Log dip entry for monitoring — dip runners are best entered on red days
          if (rec.hold_mode === 'trend' && yhChangePct < -2) {
            console.log(`[DIP_ENTRY][paper] ${rec.symbol}: buying dip ${yhChangePct.toFixed(1)}% today @ $${yhPrice.toFixed(2)} — TREND hold`)
          }
        }
      } catch { /* if Yahoo check fails, proceed with broker quote */ }
    }

    // Schwab live spread gate — real-money orders only.
    // Wide spread = illiquid at this moment; market order will fill badly.
    // Live cap: 0.5% max. If bid/ask unavailable from the API, fall back to
    // a Yahoo Finance check to get indicative spread (also catches stale Schwab quotes).
    if (isSchwab) {
      // Cast to access bid/ask fields that Schwab's getQuote returns but Alpaca's doesn't.
      const sq = quote as { bid?: number; ask?: number }
      let spreadPct: number | null = null
      if (sq.bid && sq.ask && sq.ask > sq.bid) {
        const mid = (sq.bid + sq.ask) / 2
        spreadPct = mid > 0 ? ((sq.ask - sq.bid) / mid) * 100 : null
      }
      if (spreadPct === null) {
        // Schwab didn't return bid/ask — fetch from Yahoo as fallback
        try {
          const yhRes = await fetch(
            `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${rec.symbol}&fields=bid,ask`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          )
          if (yhRes.ok) {
            const yhData = await yhRes.json()
            const r = yhData?.quoteResponse?.result?.[0] ?? {}
            const bid: number = r.bid ?? 0, ask: number = r.ask ?? 0
            if (bid > 0 && ask > bid) {
              const mid = (bid + ask) / 2
              spreadPct = ((ask - bid) / mid) * 100
            }
          }
        } catch { /* non-fatal — proceed without spread check if Yahoo down */ }
      }
      // Opening 30 min (9:30–10:00 ET) naturally has wider spreads as the book forms.
      // Allow up to 0.7% then, tighten to 0.5% once the market is settled.
      const etH = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
      const MAX_SPREAD_PCT = parseInt(etH, 10) < 10 ? 0.7 : 0.5
      if (spreadPct !== null && spreadPct > MAX_SPREAD_PCT) {
        const msg = `[schwab] Wide spread ${rec.symbol}: ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}% max — skipping entry`
        console.warn(msg)
        void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, message: msg })
        skipReasons.push(`${rec.symbol}: spread ${spreadPct.toFixed(1)}%>${MAX_SPREAD_PCT}%`)
        continue
      }
      if (spreadPct !== null) {
        console.log(`[SPREAD][schwab] ${rec.symbol}: ${spreadPct.toFixed(2)}% — OK`)
      }
    }

    // buy_zone intent: only execute if live price is actually inside the channel's zone.
    // If price is outside zone → skip this tick, wait for the right entry point.
    if (intent?.type === 'buy_zone' && intent.price_zone) {
      const { low, high } = intent.price_zone
      if (quote.price < low || quote.price > high) {
        skipReasons.push(`${rec.symbol}: price $${quote.price.toFixed(2)} outside zone $${low}–$${high}`)
        continue
      }
    }

    // LIVE SCHWAB QUALITY GATE — real money only enters on high-conviction setups.
    // EMA20_BOUNCE needs TG OR very strong EMA (≥9) — historically low win rate without signal.
    // BREAKOUT: allowed if AI conf ≥75% AND EMA score ≥8 (strong mechanical signal = skip TG req).
    if (isSchwab) {
      if (rec.setup === 'EMA20_BOUNCE' && !tg_confirmed && (rec.ema_score ?? 0) < 9) {
        const msg = `[schwab] BLOCKED ${rec.symbol} — EMA20_BOUNCE without TG needs ema≥9 (has ${rec.ema_score}/10)`
        console.log(msg)
        void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, broker, message: msg })
        skipReasons.push(`${rec.symbol}: EMA20_BOUNCE needs TG or ema≥9`)
        continue
      }
      if (rec.setup === 'BREAKOUT' && !tg_confirmed && ((rec.ema_score ?? 0) < 8 || rec.confidence < 75)) {
        const msg = `[schwab] BLOCKED ${rec.symbol} — BREAKOUT without TG needs ema≥8 AND conf≥75% (has ${rec.ema_score}/10, ${rec.confidence}%)`
        console.log(msg)
        void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, broker, message: msg })
        skipReasons.push(`${rec.symbol}: BREAKOUT needs TG or (ema≥8+conf≥75%)`)
        continue
      }
      // All other strategies: need TG confirmation OR decent mechanical score
      // Lowered from 5 → 4: a score of 4/10 still shows some setup quality, don't waste the slot
      if (!tg_confirmed && (rec.ema_score ?? 0) < 4) {
        const msg = `[schwab] SKIPPED ${rec.symbol} — no TG confirm and low EMA score ${rec.ema_score}/10`
        console.log(msg)
        void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, broker, message: msg })
        skipReasons.push(`${rec.symbol}: ema=${rec.ema_score}/10 no TG`)
        continue
      }
    }

    // Route the pick to its sleeve and size against that horizon's budget.
    // High-conviction setups (EMA score ≥ 8 + AI confidence ≥ 85%) get 1.4×, others 1.0×.
    // convictionMult is applied on top of categoryBias, combined cap is 1.8×.
    // stratBoost: user-activated from Growth page — extra mult if setup prefix matches.
    const sleeve = sleeveForSetup(rec.setup)
    const convictionMult = (rec.ema_score >= 8 && rec.confidence >= 85) ? 1.4
      : (rec.ema_score >= 6 && rec.confidence >= 78) ? 1.1 : 1.0
    const setupPrefix = rec.setup?.split('_')[0]?.toUpperCase() ?? ''
    const boostMult = stratBoost && setupPrefix === stratBoost.name ? stratBoost.mult : 1.0
    // Trend positions get 1.5× base sizing — they're designed to hold and compound.
    // Cap combined mult at 2.0× to avoid oversizing a single entry on small account.
    const trendMult = rec.hold_mode === 'trend' ? 1.5 : 1.0
    const combinedMult = Math.min(convictionMult * boostMult * trendMult, 2.0)
    const sizing = sleeveSizing(sleeve, profile, equity, quote.price, alloc, bias, combinedMult)
    if (sizing.qty < 1) {
      skipReasons.push(`${rec.symbol}: qty=0 (${sizing.note})`)
      console.log(`[${broker}] SKIP ${rec.symbol} — sizing returned qty=0: ${sizing.note}`)
      continue
    }

    // Per-trade exposure gate: check BEFORE each trade, not just at scan start.
    // Prevents multiple picks in one scan run from collectively exceeding the cap.
    const tradeCost = sizing.qty * quote.price
    if ((runningExposure + tradeCost) / equity > MAX_EXPOSURE) {
      const pct = ((runningExposure + tradeCost) / equity * 100).toFixed(0)
      console.log(`[${broker}] Skip ${rec.symbol} — would push exposure to ${pct}% (cap ${MAX_EXPOSURE * 100}%)`)
      skipReasons.push(`${rec.symbol}: exposure ${pct}%>${MAX_EXPOSURE * 100}%`)
      continue
    }

    const { buy, stop_order_id } = isSchwab
      ? await SchwabBroker.placeBuyWithProtection(rec.symbol, sizing.qty, sizing.trail_pct)
      : await AlpacaBroker.placeBuyWithProtection(rec.symbol, sizing.qty, sizing.trail_pct)

    if (buy.status !== 'PLACED') {
      const reason = buy.error ?? buy.status
      const msg = `[${broker}] Order FAILED ${rec.symbol} ${sizing.qty}sh @ $${quote.price.toFixed(2)} — ${reason}`
      console.error(msg)
      void db.from('tb_alerts').insert({ type: 'WARN', symbol: rec.symbol, broker, message: msg })
      skipReasons.push(`${rec.symbol}: ${reason}`)
    }

    if (buy.status === 'PLACED') {
      runningExposure += tradeCost  // keep cap accurate within this scan run
      enteredSymbols.add(rec.symbol)
      tradesMade++

      const initialStop = quote.price * (1 - sizing.stop_pct)
      const target      = quote.price * (1 + sizing.stop_pct * 2)
      const cat      = categoryLabel(rec.symbol)
      // Mark the intention as acted so we don't buy twice on the same signal
      if (intent) await markActed(rec.symbol, intent.type).catch(() => {})

      const intentNote = intent?.type === 'buy_zone' ? ' 🎯TG-zone' : intent?.type === 'watch_only' ? ' 👁TG-watch' : ''
      const tgNote   = tg_confirmed ? ` 📡TG${intentNote}` : ''
      const holdModeNote = rec.hold_mode === 'trend' ? ' 📈TREND' : rec.hold_mode === 'day' ? ' ⚡DAY' : ''
      const riskNote = ` | sleeve=${sleeve} cat=${cat} ema=${rec.ema_score}/10 claude=${rec.claude_conf}% oai=${rec.openai_conf}% stop=$${initialStop.toFixed(2)} target=$${target.toFixed(2)} stop_id=${stop_order_id ?? 'n/a'} hold_mode=${rec.hold_mode}${tgNote}${holdModeNote}`

      const tradeRow: Record<string, unknown> = {
        symbol: rec.symbol, action: 'BUY', quantity: sizing.qty,
        entry_price: quote.price, status: 'OPEN',
        strategy: rec.setup, reason: rec.reason + riskNote,
        confidence: rec.confidence, regime: regime.regime,
        created_at: new Date().toISOString(),
      }

      // Try with broker column (schema v4), fall back without
      const { error } = await db.from('tb_trades').insert({ ...tradeRow, broker })
      if (error?.code === 'PGRST204') await db.from('tb_trades').insert(tradeRow)

      const alertRow = {
        type: 'BUY',
        message: `[${broker.toUpperCase()}] BUY ${sizing.qty} ${rec.symbol} @ $${quote.price.toFixed(2)} · ${sleeve}/${cat} · ${rec.reason} (${rec.confidence}%)`,
        symbol: rec.symbol,
      }
      const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
      if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

      // SMS alert for real-money Schwab trades with 80%+ dual confidence
      await alertTradeEntered({
        broker: broker as 'schwab' | 'alpaca_paper',
        symbol: rec.symbol, qty: sizing.qty, price: quote.price,
        claude_conf: rec.claude_conf, openai_conf: rec.openai_conf,
        ema_score: rec.ema_score, reason: rec.reason,
        stop: initialStop, target,
      })
    }
  }

  // Cache unentered AI picks for the 1-min fast-entry scan (no Claude cost).
  // Fast scan reads this queue, checks live quotes, enters mechanically within 60s.
  if (!isSchwab) {
    const fastQueue = ranked
      .filter((item) => !enteredSymbols.has(item.rec.symbol) && (item.rec.ema_score ?? 0) >= 3)
      .slice(0, 20)
      .map((item) => ({
        symbol:     item.rec.symbol,
        confidence: item.rec.confidence,
        ema_score:  item.rec.ema_score ?? 0,
        hold_mode:  item.rec.hold_mode ?? 'swing',
        setup:      item.rec.setup ?? 'EMA_PULLBACK',
        cached_at:  Date.now(),
      }))
    void db.from('tb_settings').upsert({ key: 'fast_entry_queue', value: JSON.stringify(fastQueue) })
  }

  // Diagnostic: if AI scored setups but all came back below confidence gate, say so
  // (After bypass logic this should not happen for paper — ema≥6 bypasses automatically)
  if (tradesMade === 0 && ranked.length === 0 && candidates > 0) {
    const BOT = process.env.TELEGRAM_BOT_TOKEN
    const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
    const brokerLabel = isSchwab ? '🔴 Schwab' : '🔵 Paper'
    const topEma = rankedPre.slice(0, 3).map(x => `${x.rec.symbol}(ema=${x.rec.ema_score} conf=${x.rec.confidence}%)`).join(', ')
    if (BOT && GID) {
      const text = `🤖 *${brokerLabel} — 0 ranked after bypass*\n${candidates} setup${candidates > 1 ? 's' : ''} found, all below gate AND ema<3\nRegime: ${regime.regime} · VIX ${regime.vix.toFixed(0)}\nTop candidates: ${topEma}`
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GID, text, parse_mode: 'Markdown' }),
      }).catch(() => {})
    }
  }

  // Diagnostic alert: if setups were ranked but nothing traded, explain WHY in TG
  if (tradesMade === 0 && ranked.length > 0) {
    const top = ranked[0].rec
    const BOT = process.env.TELEGRAM_BOT_TOKEN
    const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
    const brokerLabel = isSchwab ? '🔴 Schwab' : '🔵 Paper'
    if (BOT && GID) {
      const reasonLines = skipReasons.length > 0
        ? skipReasons.slice(0, 5).join('\n')
        : 'All ranked setups passed gates — order placement may have failed'
      const text = `⏸ *${brokerLabel} — ${ranked.length} setup${ranked.length > 1 ? 's' : ''} found, 0 traded*\nTop: ${top.symbol} conf=${top.confidence}% ema=${top.ema_score}/10\nRegime: ${regime.regime} · VIX ${regime.vix.toFixed(0)}\n\n*Why blocked:*\n${reasonLines}`
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GID, text, parse_mode: 'Markdown' }),
      }).catch(() => {})
    }
  }

  const hot = rotation.hottest ? ` Hot:${rotation.hottest}` : ''

  // Save scan snapshot to tb_settings so the Live Monitor page can display it
  const scanSnapshot = {
    ts:           new Date().toISOString(),
    broker,
    regime:       regime.label,
    vix:          Math.round(vix * 10) / 10,
    market:       marketTier,
    spy_above_sma: aboveSma,   // used by health bar popover to explain regime reason
    scanned,
    candidates,
    ranked:     ranked.length,
    trades:     tradesMade,
    picks:      ranked.slice(0, 5).map((r) => ({
      symbol:     r.rec.symbol,
      confidence: r.rec.confidence,
      setup:      r.rec.setup,
      score:      r.rec.ema_score,
      rs_score:   research.get(r.rec.symbol)?.score,
      rs_label:   research.get(r.rec.symbol)?.label,
      rs_vs_spy:  research.get(r.rec.symbol)?.rs_vs_spy,
    })),
    discoveries: (new_discoveries ?? []).slice(0, 4).map((d) => ({ symbol: d.symbol, signal: d.signal })),
  }
  void db.from('tb_settings').upsert({ key: `last_scan_${broker}`, value: JSON.stringify(scanSnapshot) })
  void db.from('tb_settings').upsert({ key: lockKey, value: '' })  // release lock

  return {
    trades_made: tradesMade,
    message: `[${broker}] Market:${marketTier} VIX${vix.toFixed(0)} Gate:${dynamicMinConf}% MaxPos:${dynamicMaxPos}${hot} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Ranked:${ranked.length} Trades:${tradesMade}`,
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const engines = await getEngineStatus(db)

  // Rank themes once per tick and share across both brokers.
  const rotation = await getCategoryMomentum()

  const results: Record<string, unknown> = {}
  const tasks: Promise<void>[] = []

  if (engines.schwab === 'running') {
    tasks.push(
      runScan('schwab', db, rotation).then((r) => {
        results.schwab = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.schwab = { error: e.message } })
    )
  } else {
    results.schwab = { skipped: 'engine_stopped' }
  }

  if (engines.alpaca_paper === 'running') {
    tasks.push(
      runScan('alpaca_paper', db, rotation).then((r) => {
        results.alpaca_paper = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.alpaca_paper = { error: e.message } })
    )
  } else {
    results.alpaca_paper = { skipped: 'engine_stopped' }
    // Alert so it's visible — paper engine being stopped silently kills all lab trading
    const BOT = process.env.TELEGRAM_BOT_TOKEN
    const GID = process.env.TELEGRAM_ALLOWED_CHAT_ID
    if (BOT && GID) {
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GID, text: '⚠️ *Alpaca Paper engine is STOPPED*\nGo to Settings → toggle Paper engine ON to resume lab trading.', parse_mode: 'Markdown' }),
      }).catch(() => {})
    }
  }

  await Promise.allSettled(tasks)

  return NextResponse.json({
    status: 'ok',
    engines,
    rotation: rotation.categories.map((c) => ({ key: c.key, rank: c.rank, temp: c.temp, score: c.score, bias: c.bias })),
    results,
  })
}
