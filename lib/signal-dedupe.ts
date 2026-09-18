/**
 * lib/signal-dedupe.ts — cross-path signal execution dedupe.
 *
 * BUG IT FIXES (2026-09-18): the same Telegram signal was executed 2-4x.
 * Two independent ingest paths read the same channels with independent
 * watermarks and no shared "already executed" record:
 *   1. Mac launchd tg-poll.cjs (every 60s) → POST /api/telegram/ingest
 *   2. Vercel cron /api/telegram/poll (every 60s)
 * Overlapping runs / races meant both paths (or two overlapping runs of one
 * path) placed orders for the same message. E.g. 2026-09-17 RKLB: 2x46 sh
 * on Alpaca Paper + 2x7 on Schwab Live; 2026-09-02 RKLB fired 4x.
 *
 * HOW IT WORKS: every order placement is preceded by claimSignalExecution().
 * The claim is a plain INSERT into tb_settings with a deterministic key:
 *   sigexec:tg:<source>:<msg_id>:<SYMBOL>:<ACTION>:<broker>
 * tb_settings.key is the primary key, so the INSERT is atomic — concurrent
 * claims for the same signal+broker: exactly one wins (201), the rest get
 * a 23505 unique violation and must skip. No DDL, no new table, no locks.
 *
 * RULES:
 *  - Claim BEFORE placing the order. Only the winner proceeds.
 *  - Losers return false → caller must skip (and log type '..._duplicate').
 *  - On unexpected DB errors we FAIL CLOSED (block + loud alert). For real
 *    money, a missed signal beats a double-filled one.
 *  - Keys live 7 days; stale keys are cleaned opportunistically.
 *
 * Callers: app/api/telegram/ingest/route.ts, app/api/telegram/poll/route.ts
 */

import { createServiceClient } from '@/lib/supabase-server'

type Db = ReturnType<typeof createServiceClient>

export type DedupeBroker = 'alpaca_paper' | 'schwab'

export interface SignalClaim {
  source: string            // channel/source id, e.g. 'sf_pavan', 'us_equities'
  msgId: number | string   // Telegram message id — the signal's identity
  symbol: string            // FINAL executed symbol (after ETF/OCC resolution)
  action: string            // BUY | SELL
  broker: DedupeBroker
}

const PREFIX = 'sigexec'
const CLAIM_TTL_MS = 7 * 24 * 3600_000

export function dedupeKey(c: SignalClaim): string {
  return `${PREFIX}:tg:${c.source}:${c.msgId}:${c.symbol.toUpperCase()}:${String(c.action).toUpperCase()}:${c.broker}`
}

/**
 * Attempt to claim the exclusive right to execute this signal on this broker.
 * @returns true  — we won the claim, proceed to place the order.
 * @returns false — another path already claimed/executed it (or DB error) → SKIP.
 */
export async function claimSignalExecution(
  db: Db,
  claim: SignalClaim,
  channel: string,
): Promise<boolean> {
  // Without a message id we cannot identity the signal — a shared key would
  // wrongly suppress unrelated signals. Fall back to the old behavior (no
  // dedupe) rather than risk blocking legitimate trades.
  if (claim.msgId === null || claim.msgId === undefined || claim.msgId === '') {
    console.warn(`[DEDUP] no msg_id for ${claim.symbol} — skipping dedupe (fail-open)`)
    return true
  }

  const key = dedupeKey(claim)
  const now = new Date().toISOString()
  const value = JSON.stringify({
    channel,
    source: claim.source,
    msg_id: claim.msgId,
    symbol: claim.symbol.toUpperCase(),
    action: String(claim.action).toUpperCase(),
    broker: claim.broker,
    status: 'CLAIMED',
    claimed_at: now,
  })

  // Plain INSERT, NOT upsert: the PK on tb_settings.key makes this the
  // atomic compare-and-set. Exactly one concurrent claim wins.
  const { error } = await db.from('tb_settings').insert({ key, value })

  if (!error) {
    if (Math.random() < 0.05) void cleanupOldClaims(db).catch(() => {})
    return true
  }

  if ((error as { code?: string }).code === '23505') {
    // Another ingest path (or an overlapping run) already executed this
    // signal on this broker. Skip quietly but visibly.
    console.log(`[DEDUP] duplicate suppressed: ${key}`)
    await db.from('tb_alerts').insert({
      type: 'INFO',
      symbol: claim.symbol.toUpperCase(),
      broker: claim.broker,
      message: `[DEDUP] ${channel}: ${String(claim.action).toUpperCase()} ${claim.symbol.toUpperCase()} (${claim.broker}) skipped — already executed for ${claim.source} msg#${claim.msgId}`,
    }).then(() => {}, () => {})
    return false
  }

  // Unexpected DB error — fail CLOSED: block the trade and alert loudly.
  // A missed signal is recoverable; a double-filled live order is not.
  console.error(`[DEDUP] claim insert failed for ${key}: ${error.message}`)
  await db.from('tb_alerts').insert({
    type: 'WARN',
    symbol: claim.symbol.toUpperCase(),
    message: `[DEDUP] claim FAILED for ${key}: ${error.message} — trade blocked (fail-closed)`,
  }).then(() => {}, () => {})
  return false
}

/** Mark a won claim as settled (observability — powers the "executed exactly once" verification). */
export async function markSignalExecution(
  db: Db,
  claim: SignalClaim,
  status: 'PLACED' | 'FAILED',
  orderId?: string | null,
): Promise<void> {
  const key = dedupeKey(claim)
  try {
    const { data } = await db.from('tb_settings').select('value').eq('key', key).single()
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse((data as { value?: string } | null)?.value ?? '{}') } catch { /* keep empty */ }
    meta.status = status
    if (orderId) meta.order_id = orderId
    meta.settled_at = new Date().toISOString()
    await db.from('tb_settings').update({ value: JSON.stringify(meta) }).eq('key', key)
  } catch { /* non-fatal — observability only */ }
}

async function cleanupOldClaims(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
  const { data } = await db.from('tb_settings').select('key, value').like('key', `${PREFIX}:%`).limit(500)
  for (const r of data ?? []) {
    let claimedAt = ''
    try { claimedAt = String((JSON.parse(r.value) as { claimed_at?: string }).claimed_at ?? '') } catch { claimedAt = '' }
    if (!claimedAt || claimedAt < cutoff) {
      await db.from('tb_settings').delete().eq('key', r.key).then(() => {}, () => {})
    }
  }
}
