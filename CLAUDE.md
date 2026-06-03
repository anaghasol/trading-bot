# MyTrade — Claude Code Project Guide

## What This Is
Personal AI-powered trading bot for Akhil. Runs fully serverless on Vercel. No local processes — everything is Vercel cron jobs + Next.js API routes. Goal: daily profit on Schwab real account, tested first on Alpaca paper account.

## Dev Server
```
npm run dev   →  http://localhost:54321
```
**Always port 54321. Never 3000. Port range must be < 65536.**

## Stack
- **Framework**: Next.js 14 App Router, TypeScript — never Python
- **Hosting**: Vercel (Pro plan required for cron jobs)
- **Auth + DB**: Supabase — `fskgekjysnstegbnqdzl.supabase.co` (shared with sitara-catering project)
- **Real broker**: Schwab (live $, ~$2K account, account ID 78910832)
- **Paper broker**: Alpaca paper trading ($100K fake balance)
- **AI picks**: Claude claude-sonnet-4-6 via Anthropic API (`lib/ai-advisor.ts`)
- **SMS alerts**: Twilio → phone +12516800461 (`lib/notify.ts`)
- **Market data**: Schwab quotes API + Alpaca data API
- **Design**: MyTrade dark navy UI (`#0b0f17` bg, `#13c98e` green, IBM Plex Sans/Mono)

## Broker Architecture
The app supports two brokers in one codebase. Switching is done via a tab on the dashboard UI — NOT the `BROKER` env var (that's legacy).

| Broker | Mode | Balance | Strategy |
|--------|------|---------|----------|
| `schwab` | Live real $ | ~$2K | Protected — PDT-safe swings, 78%+ AI confidence, 1.5% risk/trade, −5% daily stop |
| `alpaca_paper` | Paper fake $ | $100K | Aggressive Lab — day trades OK, 75%+ AI confidence, 3% risk/trade, −8% daily stop |

**Key abstraction**: `lib/broker.ts` — unified interface routing to `lib/schwab.ts` or `lib/alpaca.ts`. Cron jobs use this. The dashboard's Quick Trade panel calls `/api/trade` which accepts a `broker` param and bypasses the env var.

## Key Files
```
lib/
  schwab.ts           — Schwab API client (OAuth, auto-refresh tokens from Supabase)
  alpaca.ts           — Alpaca paper/live API client
  broker.ts           — Unified broker abstraction (cron jobs import from here)
  ai-advisor.ts       — Claude AI stock picks pipeline
  risk.ts             — Stop loss, trailing stops, daily loss limit logic
  market-data.ts      — Yahoo Finance / market data helpers
  strategy-profiles.ts — Risk profiles per broker (PROFILES object)
  notify.ts           — Twilio SMS alerts
  pdt.ts              — PDT (Pattern Day Trader) protection logic
  supabase-server.ts  — Server-side Supabase client
  supabase-client.ts  — Browser-side Supabase client

app/
  dashboard/page.tsx  — Main trading desk UI (positions, quick trade, orders, AI signals)
  trades/page.tsx     — Trade history
  growth/page.tsx     — P&L growth charts
  sleeves/page.tsx    — Portfolio sleeve allocation
  learning/page.tsx   — AI learning / strategy analysis
  settings/page.tsx   — Config settings

app/api/
  trade/route.ts          — Manual trade execution (accepts broker param, routes to Schwab or Alpaca)
  schwab/trade/route.ts   — Legacy Schwab-only trade endpoint
  schwab/positions/        — Live positions
  schwab/balance/          — Account balance / summary
  schwab/quotes/           — Live quotes (used for watchlist)
  schwab/activity/         — Order history
  schwab/history/          — PDT day-trade history
  alpaca/positions/        — Alpaca positions
  alpaca/account/          — Alpaca account summary
  alpaca/orders/           — Alpaca order history
  dashboard/route.ts       — Aggregated dashboard data from Supabase
  engine/route.ts          — AI engine trigger (manual scan)
  cron/scan/route.ts       — Entry signals (runs every 15 min via Vercel cron)
  cron/monitor/route.ts    — Position monitor (every 5 min)
  cron/close/route.ts      — EOD close all positions (3:45 PM ET)
  rotation/route.ts        — Category rotation / sector momentum
```

## Supabase Schema (key tables)
- `tb_trades` — all trades (open + closed)
- `tb_alerts` — SMS/system alerts log
- `tb_pnl_snapshots` — daily P&L history
- `schwab_tokens` — Schwab OAuth tokens (auto-refreshed)

## Environment Variables (all in `.env`)
All secrets are in `.env` — never hardcode. Key vars:
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Service role (server only)
- `SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET` — Schwab OAuth app
- `ALPACA_KEY_ID` + `ALPACA_SECRET_KEY` — Alpaca API
- `ANTHROPIC_API_KEY` — Claude AI
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` — SMS
- `CRON_SECRET` — Vercel cron auth header

## Strategy Profiles (lib/strategy-profiles.ts)
```
schwab (PROTECTED):
  risk_pct: 1.5%, max_positions: 3, min_confidence: 78%, no day trades
  initial_stop: 2.5%, trail: 5%, daily_loss_stop: 5%, max_hold: 5 days

alpaca_paper (AGGRESSIVE LAB):
  risk_pct: 3%, max_positions: 6, min_confidence: 75%, day trades OK
  initial_stop: 3%, trail: 6%, daily_loss_stop: 8%, max_hold: 3 days
```

## Dashboard UI Notes
- Broker switcher at top right: **Live · Schwab** (red dot) vs **Paper · Alpaca** (blue dot)
- Each tab fetches ONLY from its own broker — no cross-contamination
- Quick Trade card: symbol input + BUY/SELL + Market/Limit + shares or dollars → posts to `/api/trade`
- Positions table has per-row "Close" button (fires SELL)
- Activity tabs: Working / Filled / Canceled
- AI Signal Queue shows open trades with confidence bars
- Category Trends card shows sector rotation heat

## Git / Deployment Rules
- After `git push origin main` → **stop**. Do not poll Vercel deployment status. Just say "pushed, deploying."
- Vercel auto-deploys on push to `main`
- Never use `--no-verify` or skip hooks

## Goal
$25,000 account value (PDT threshold). Current balance ~$2K on Schwab. Grow it. Paper account ($100K Alpaca) is the lab to test strategies before risking real money.
