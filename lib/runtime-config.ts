/**
 * Runtime config — key strategy params stored in Supabase tb_settings.
 * EOD auto-tuner writes adjustments here; next cron run picks them up
 * without any code deployment.
 *
 * Falls back to profile defaults if Supabase has no override.
 */

import { createServiceClient } from '@/lib/supabase-server'
import { profileFor } from '@/lib/strategy-profiles'

export interface RuntimeConfig {
  min_confidence: number    // AI gate (0-1). Lower = more trades.
  stop_pct: number          // Equity initial stop (0-1). E.g. 0.02 = 2%
  trail_pct: number         // Trailing stop pct (0-1)
  opt_stop_pct: number      // Options stop (negative %). E.g. -10
  max_positions: number     // Max concurrent positions
  risk_pct: number          // % equity risked per trade
  flat_recycle_days: number // Days before flat position recycled
  // Metadata
  last_updated: string
  updated_by: string        // 'eod_autotuner' | 'manual'
  reason: string
}

const SETTINGS_KEY: Record<string, string> = {
  alpaca_paper: 'paper_runtime_config',
  schwab:       'schwab_runtime_config',
}

export async function getRuntimeConfig(broker: 'alpaca_paper' | 'schwab'): Promise<RuntimeConfig> {
  const profile = profileFor(broker)
  const defaults: RuntimeConfig = {
    min_confidence:    profile.min_confidence,
    stop_pct:          profile.initial_stop_pct,
    trail_pct:         profile.trail_pct,
    opt_stop_pct:      broker === 'alpaca_paper' ? -10 : -25,
    max_positions:     profile.max_positions,
    risk_pct:          profile.risk_pct,
    flat_recycle_days: 2,
    last_updated:      '',
    updated_by:        'default',
    reason:            'profile default',
  }

  try {
    const db  = createServiceClient()
    const key = SETTINGS_KEY[broker]
    const { data } = await db.from('tb_settings').select('value').eq('key', key).single()
    if (!data?.value) return defaults
    const saved = JSON.parse(data.value) as Partial<RuntimeConfig>
    // Clamp stored values to current profile floors so a code change to the profile
    // takes effect immediately — without needing to wipe the DB config.
    const floored = { ...saved }
    // min_confidence uses integer scale (36 = 36%); floor to current profile minimum
    if (floored.min_confidence !== undefined)
      floored.min_confidence = Math.max(profile.min_confidence, floored.min_confidence)
    // stop_pct uses fraction scale (0.025 = 2.5%); floor prevents auto-tuner from going below profile
    if (floored.stop_pct !== undefined)
      floored.stop_pct = Math.max(profile.initial_stop_pct, floored.stop_pct)
    // max_positions: clamp DOWN to profile cap (new 20 cap must override old 40 in DB)
    if (floored.max_positions !== undefined)
      floored.max_positions = Math.min(profile.max_positions, floored.max_positions)
    return { ...defaults, ...floored }
  } catch {
    return defaults
  }
}

export async function setRuntimeConfig(
  broker: 'alpaca_paper' | 'schwab',
  patch: Partial<Omit<RuntimeConfig, 'last_updated' | 'updated_by' | 'reason'>>,
  reason: string,
  updatedBy = 'eod_autotuner'
): Promise<RuntimeConfig> {
  const current = await getRuntimeConfig(broker)
  const next: RuntimeConfig = {
    ...current,
    ...patch,
    last_updated: new Date().toISOString(),
    updated_by:   updatedBy,
    reason,
  }
  const db  = createServiceClient()
  const key = SETTINGS_KEY[broker]
  await db.from('tb_settings').upsert({ key, value: JSON.stringify(next) })
  return next
}
