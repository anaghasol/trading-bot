/**
 * lib/cron-auth.ts — single shared cron auth check.
 *
 * Replaces the copy-pasted `authorized()` that appeared in every cron route:
 *   const s = process.env.CRON_SECRET
 *   return !s || req.headers.get('authorization') === `Bearer ${s}`
 * That pattern FAILED OPEN: if CRON_SECRET was ever unset/empty, every
 * trading endpoint (scan, monitor, close, health, telegram pollers…) was
 * callable by anyone on the internet with no auth at all.
 *
 * This version FAILS CLOSED: unset secret → deny. Accepts the secret as
 * `?secret=` query param (Vercel cron paths, manual checks) or as
 * `Authorization: Bearer <secret>` (Vercel's scheduler auto-injects this
 * header on cron invocations when CRON_SECRET is set; GitHub Actions
 * passes it explicitly).
 *
 * Verified safe to roll out (2026-09-18): CRON_SECRET is set in the Vercel
 * production env, Vercel auto-injects the Bearer header for its own crons,
 * and GitHub Actions sends it explicitly — so no legitimate caller breaks.
 */
export function cronAuthorized(req: Request): boolean {
  const s = process.env.CRON_SECRET
  if (!s) return false
  let provided: string | null = null
  try {
    provided = new URL(req.url).searchParams.get('secret')
  } catch {
    /* ignore malformed URL */
  }
  if (!provided) {
    provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  }
  return provided === s
}
