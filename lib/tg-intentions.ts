/**
 * TG Intentions Queue — translates Pavan's channel messages into staged engine directives.
 *
 * Instead of acting immediately OR storing and forgetting, every TG signal creates
 * an "intention" with conditions. The engine checks intentions every scan/monitor tick
 * and executes when price and technical setup confirm what Pavan suggested.
 *
 * Intent types:
 *   buy_zone    — Pavan mentioned a stock bullishly; buy when price enters the zone
 *   hold_position — Pavan says don't exit; monitor cron respects this before closing
 *   watch_only  — Pavan mentioned it but no actionable setup yet; boost AI scan score
 *   avoid       — Pavan bearish; skip in scanner even if chart looks good
 *
 * All intentions stored as JSON in tb_settings (key: tg_intentions).
 * No schema change needed.
 */

import { createServiceClient } from './supabase-server'

export type IntentType = 'buy_zone' | 'hold_position' | 'watch_only' | 'avoid'
export type Urgency    = 'high' | 'medium' | 'low'

export interface TgIntention {
  symbol:       string
  type:         IntentType
  urgency:      Urgency         // high = act immediately if conditions met; low = wait for strong setup
  price_zone:   { low: number; high: number } | null
  context:      string           // one-line reason from Pavan
  set_at:       string           // ISO timestamp
  expires_hours: number
  acted_at:     string | null    // set when the engine acts on it
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function readAll(): Promise<TgIntention[]> {
  const db = createServiceClient()
  const { data } = await db.from('tb_settings').select('value').eq('key', 'tg_intentions').single()
  if (!data?.value) return []
  try {
    const all: TgIntention[] = JSON.parse(data.value)
    const now = Date.now()
    return all.filter((i) => (now - new Date(i.set_at).getTime()) / 3600000 < i.expires_hours)
  } catch { return [] }
}

async function writeAll(intentions: TgIntention[]) {
  const db = createServiceClient()
  await db.from('tb_settings').upsert({ key: 'tg_intentions', value: JSON.stringify(intentions) })
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function addIntention(intent: Omit<TgIntention, 'set_at' | 'acted_at'>) {
  const all = await readAll()
  // Replace any existing un-acted intention for the same symbol + type
  const filtered = all.filter((i) => !(i.symbol === intent.symbol && i.type === intent.type && !i.acted_at))
  filtered.push({ ...intent, set_at: new Date().toISOString(), acted_at: null })
  await writeAll(filtered)
}

export async function getActiveIntentions(): Promise<TgIntention[]> {
  const all = await readAll()
  return all.filter((i) => !i.acted_at)
}

export async function markActed(symbol: string, type: IntentType) {
  const all = await readAll()
  const updated = all.map((i) =>
    i.symbol === symbol && i.type === type && !i.acted_at
      ? { ...i, acted_at: new Date().toISOString() }
      : i
  )
  await writeAll(updated)
}

/**
 * Returns a human-readable string included in every AI prompt so Claude knows
 * what Pavan's current intentions are before rating setups.
 */
export async function buildIntentionContext(): Promise<string> {
  const active = await getActiveIntentions()
  if (active.length === 0) return ''

  const lines = active.map((i) => {
    const ageH = Math.round((Date.now() - new Date(i.set_at).getTime()) / 3600000)
    switch (i.type) {
      case 'buy_zone':
        return i.price_zone
          ? `• BUY ${i.symbol} when price $${i.price_zone.low}–$${i.price_zone.high} [urgency:${i.urgency}, ${ageH}h ago] — ${i.context}`
          : `• BULLISH on ${i.symbol} — no specific price [${ageH}h ago] — ${i.context}`
      case 'hold_position':
        return `• HOLD ${i.symbol} — Pavan says do not exit [${ageH}h ago] — ${i.context}`
      case 'avoid':
        return `• AVOID ${i.symbol} — Pavan bearish [${ageH}h ago] — ${i.context}`
      case 'watch_only':
        return `• WATCHING ${i.symbol} — no entry yet [${ageH}h ago] — ${i.context}`
    }
  })

  return `PAVAN'S ACTIVE INTENTIONS (respect these over your own analysis):\n${lines.join('\n')}`
}

/**
 * Parse a watch_zone string like "$45-48", "$45.50", "near $45" into {low, high}.
 * Returns null if unparseable.
 */
export function parseZonePrices(zone: string): { low: number; high: number } | null {
  // "$45-48" or "45-48"
  const range = zone.match(/\$?([\d.]+)\s*[-–]\s*\$?([\d.]+)/)
  if (range) return { low: parseFloat(range[1]), high: parseFloat(range[2]) }
  // single price "$45" — create ±4% buffer (entry zone)
  const single = zone.match(/\$?([\d.]+)/)
  if (single) {
    const p = parseFloat(single[1])
    return { low: Math.round(p * 0.96 * 100) / 100, high: Math.round(p * 1.04 * 100) / 100 }
  }
  return null
}
