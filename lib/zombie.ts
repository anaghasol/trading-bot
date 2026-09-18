/**
 * lib/zombie.ts — persistent zombie-position registry.
 *
 * BUG IT FIXES (2026-09-18): the SAN "zombie" loop on live Schwab.
 * A lingering broker-persisted position was auto-journaled as RECOVERED by
 * /api/cron/health, the monitor sold it at a loss, the broker position
 * persisted, and health re-journaled it again — ~6 loss-sells on 2026-09-18
 * (-2.5% to -3.4% each), and the same cycle repeating since 2026-09-03.
 *
 * The old 90-minute guard only skipped re-journaling when the close was
 * <90 min ago; the loop simply waited it out (close 15:02 → re-journal 17:00).
 *
 * Now: once a symbol is closed as RECOVERED 2+ times in 7 days while still
 * persisting at the broker, it is promoted to the zombie set (tb_settings key
 * `zombie_positions`). Zombied symbols are NEVER auto-journaled and NEVER
 * re-entered by signal execution until manually reviewed.
 *
 * Manual review escape hatch: GET /api/cron/health?clear_zombie=SYMBOL
 * (with cron auth) removes the block. The set also self-heals: entries whose
 * broker position has actually disappeared are cleared automatically.
 */

import { createServiceClient } from '@/lib/supabase-server'

type Db = ReturnType<typeof createServiceClient>

export const ZOMBIE_KEY = 'zombie_positions'

export interface ZombieEntry {
  first_seen: string
  closes: number
  last_close_at: string
  reason: string
  last_alert_at?: string
}

export type ZombieSet = Record<string, ZombieEntry>

export function zombieId(broker: string, symbol: string): string {
  return `${broker}:${symbol.toUpperCase()}`
}

export async function getZombieSet(db: Db): Promise<ZombieSet> {
  try {
    const { data } = await db.from('tb_settings').select('value').eq('key', ZOMBIE_KEY).single()
    const v = (data as { value?: string } | null)?.value
    return v ? (JSON.parse(v) as ZombieSet) : {}
  } catch {
    return {}
  }
}

export async function saveZombieSet(db: Db, set: ZombieSet): Promise<void> {
  await db.from('tb_settings').upsert({ key: ZOMBIE_KEY, value: JSON.stringify(set) }).then(() => {}, () => {})
}

export async function isZombie(db: Db, broker: string, symbol: string): Promise<boolean> {
  const set = await getZombieSet(db)
  return zombieId(broker, symbol) in set
}
