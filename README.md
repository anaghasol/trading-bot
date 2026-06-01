# MyTrade — AI-Powered Schwab Trading on Vercel

Automated daily trading engine using **Claude AI + Schwab API**. Runs fully serverless on Vercel with Supabase for auth and storage. No local server needed.

## Architecture

```
Vercel Cron → API Route → Schwab API → Execute Trade
                  ↕
        Supabase (tokens, trades, P&L, alerts, auth)
                  ↕
        Claude AI (stock picks with 75%+ confidence)
                  ↕
        Yahoo Finance (market data, VIX, RSI, volume)
```

## Risk Rules

| Rule | Value |
|------|-------|
| Stop loss per trade | −5.0% |
| Trailing stop (starts at +3%) | 3.5% trail |
| Trailing stop (at +5%) | 2.5% trail |
| Trailing stop (at +10%) | 1.5% trail (very tight) |
| Max concurrent positions | 3 |
| Daily loss all-stop | −5.0% of balance |
| Position size | 15% of balance per trade |
| EOD forced close | 3:45 PM ET |

## Setup Guide

### 1. Run Supabase Migrations
Go to [Supabase SQL Editor](https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql):
1. Run `supabase_schema.sql` (base tables)
2. Run `supabase_schema_v2.sql` (tokens, alerts, snapshots)

Then copy your **Anon Key** and **Service Role Key** from Settings → API.

### 2. Update Schwab Redirect URI
In [developer.schwab.com](https://developer.schwab.com), add:
```
https://your-app.vercel.app/api/schwab/callback
```

### 3. Deploy to Vercel
```bash
git add -A
git commit -m "feat: Vercel trading app"
git push origin main
```
Then in Vercel: Import repo → Add env vars → Deploy.

### 4. Environment Variables
Add these in Vercel Project Settings → Environment Variables:

```bash
NEXT_PUBLIC_SUPABASE_URL          # https://fskgekjysnstegbnqdzl.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     # from Supabase → Settings → API
SUPABASE_SERVICE_ROLE_KEY         # from Supabase → Settings → API
SCHWAB_CLIENT_ID                  # from developer.schwab.com
SCHWAB_CLIENT_SECRET              # from developer.schwab.com
SCHWAB_REDIRECT_URI               # https://your-app.vercel.app/api/schwab/callback
SCHWAB_ACCOUNT_ID                 # your Schwab account number (78910832)
ANTHROPIC_API_KEY                 # from console.anthropic.com
CRON_SECRET                       # any random 32-char string
```

### 5. First Time Login
1. Visit `https://your-app.vercel.app/login`
2. Sign up with your email
3. Go to `/settings` → click **Test Connection**
4. If tokens expired, click **Re-authorize Schwab**

## Cron Jobs (requires Vercel Pro)

| Job | UTC Schedule | ET Time | What it does |
|-----|-------------|---------|-------------|
| `/api/cron/scan` | `*/15 13-20 * * 1-5` | Every 15 min | Claude picks stocks, places BUY orders |
| `/api/cron/monitor` | `*/5 13-21 * * 1-5` | Every 5 min | Checks stops, closes losing positions |
| `/api/cron/close` | `45 19 * * 1-5` | 3:45 PM EDT | Forces all positions closed |

## Local Development

```bash
npm install
# Create .env.local with all env vars above
npm run dev    # http://localhost:3000
```

## Security
- Schwab OAuth tokens stored encrypted in Supabase — never in code/files
- All pages protected by Supabase Auth
- Cron jobs protected by `CRON_SECRET` bearer token
- ⚠️ Rotate your Anthropic API key — old key was exposed in `advisor.py`

## Watchlist (AI scans these)
NVDA, AMD, MSFT, AAPL, PLTR, TSLA, AMZN, SHOP, NFLX, COIN, SOFI, META, GOOGL
