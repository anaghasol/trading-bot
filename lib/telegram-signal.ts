/**
 * Classifies Telegram messages from SF Essential Trades — acts like a human trader.
 *
 *   type: 'trade'   → explicit BUY/SELL → execute immediately
 *   type: 'exit'    → channel says a stock hit SL/target → close our position if held
 *   type: 'learn'   → insight/analysis → save to learning log for future AI context
 *   type: 'ignore'  → noise, promos, greetings → skip
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const TRADE_KEYWORDS = /\b(buy|sell|long|short|entry|sl|stop.?loss|target|t1|t2|t3|breakout|support|resistance|earnings|hold|exit|watchlist|alert|position|setup|hit|stopped|closed)\b/i
const HAS_TICKER    = /\b[A-Z]{2,5}\b/
const HAS_PRICE     = /\$[\d,]+(\.\d+)?|\d+\.?\d*\s*%/

export function isWorthClassifying(text: string): boolean {
  if (text.length < 15) return false
  if (TRADE_KEYWORDS.test(text)) return true
  if (HAS_TICKER.test(text) && HAS_PRICE.test(text)) return true
  if (text.length > 80) return true
  return false
}

export type SignalType = 'trade' | 'exit' | 'learn' | 'ignore'

export interface TradeSignal {
  type: 'trade'
  symbol: string
  action: 'BUY' | 'SELL'
  order_type: 'MARKET' | 'LIMIT'
  entry_price: number | null
  stop_loss: number | null
  target: number | null
  confidence: number
  raw: string
}

export interface ExitSignal {
  type: 'exit'
  symbol: string
  reason: 'SL_HIT' | 'TARGET_HIT' | 'ADVISOR_EXIT'
  summary: string
  raw: string
}

export interface LearnSignal {
  type: 'learn'
  summary: string
  symbols: string[]
  sentiment: 'bullish' | 'bearish' | 'neutral'
  sector: string | null     // e.g. 'nuclear', 'tech', 'biotech'
  watch_zone: string | null // price range to watch for future entry, e.g. '$45-48'
  actionable: boolean       // should the AI scanner consider this context?
  raw: string
}

export interface IgnoreSignal { type: 'ignore' }

export type ParsedSignal = TradeSignal | ExitSignal | LearnSignal | IgnoreSignal

export async function parseSignal(text: string): Promise<ParsedSignal> {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are reading messages from "SF Essential Trades" — a paid channel by Pavan Sailesh, a professional trader. Read like a human trader would and classify the intent precisely.

Pavan communicates in these patterns:
1. DIRECT ENTRY — gives ticker + price + stop loss → we must execute
   e.g. "Buy SPIR at 20.5 With SL of 18.5", "06/04: Buy TEM at 52 SL 46"
2. DIRECT EXIT — explicitly tells subscribers to close/exit a position NOW
   e.g. "Exit SPIR", "Sell SPIR now", "Close your SPIR position", "Book profits on X"
3. POSITION UPDATE — tells what happened to a past recommendation (not a command to us)
   e.g. "INTU hit stop loss", "LPTH hit our target of $17", "SIDU was stopped out"
4. WATCH / SETUP ALERT — flags a stock to watch for future entry, not actionable yet
   e.g. "OKLO could pull back to $45, watch for re-entry", "TEM looks good near $48"
5. MARKET / SECTOR INSIGHT — general knowledge, macro views, sector commentary
   e.g. "QQQ needs to correct", "nuclear sector heating up", portfolio risk summaries
6. NOISE — webinars, referral links, greetings, admin → ignore

Message: "${text}"

Reply with ONLY a JSON object:

DIRECT ENTRY → {"type":"trade","symbol":"TICKER","action":"BUY","entry_price":20.5,"stop_loss":18.5,"target":null,"confidence":95}

DIRECT EXIT → {"type":"exit","symbol":"TICKER","reason":"ADVISOR_EXIT","summary":"one-line reason"}

POSITION UPDATE / WATCH / MARKET INSIGHT → {"type":"learn","summary":"one clear sentence","symbols":["TICKER"],"sentiment":"bullish","sector":"nuclear","watch_zone":"$45-48","actionable":true}
  sentiment: bullish / bearish / neutral
  sector: industry name if clear, else null
  watch_zone: price range mentioned for watching/re-entry, else null
  actionable: true if it should influence future AI stock picks

NOISE → {"type":"ignore"}

Critical rules:
- type:trade ONLY for explicit entry with ticker + price/instruction. Never guess.
- type:exit ONLY when Pavan explicitly says to close — NOT when he reports "X hit SL" (that is his subscribers' trade, not a command to us)
- "X hit stop loss / target" = type:learn, bearish or bullish accordingly
- "Watch X near $Y" = type:learn, watch_zone set
- "buy on dips", "accumulation opportunity", "stocks at discount, re-entry" (no specific ticker) = type:learn, sentiment:bullish, symbols:[], actionable:true — this tells the bot to run the AI scanner immediately
- confidence < 70 → demote trade to learn
- Default to learn over exit when unsure`,
      }],
    })

    const raw = (msg.content[0] as { type: string; text: string }).text.trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { type: 'ignore' }

    const parsed = JSON.parse(jsonMatch[0])

    if (parsed.type === 'trade') {
      if (!parsed.symbol || !parsed.action || (parsed.confidence ?? 0) < 70) {
        return {
          type: 'learn',
          summary: `Possible ${parsed.action ?? 'trade'} on ${parsed.symbol ?? 'unknown'} — low confidence`,
          symbols: parsed.symbol ? [parsed.symbol] : [],
          sentiment: 'neutral', sector: null, watch_zone: null, actionable: false,
          raw: text,
        }
      }
      return {
        type: 'trade',
        symbol: String(parsed.symbol).toUpperCase(),
        action: parsed.action,
        order_type: parsed.order_type ?? 'MARKET',
        entry_price: parsed.entry_price ?? null,
        stop_loss: parsed.stop_loss ?? null,
        target: parsed.target ?? null,
        confidence: parsed.confidence,
        raw: text,
      }
    }

    if (parsed.type === 'exit') {
      if (!parsed.symbol) return { type: 'ignore' }
      return {
        type: 'exit',
        symbol: String(parsed.symbol).toUpperCase(),
        reason: parsed.reason ?? 'ADVISOR_EXIT',
        summary: parsed.summary ?? `Exit signal for ${parsed.symbol}`,
        raw: text,
      }
    }

    if (parsed.type === 'learn') {
      return {
        type: 'learn',
        summary: parsed.summary ?? text.slice(0, 120),
        symbols: Array.isArray(parsed.symbols) ? parsed.symbols.map((s: string) => String(s).toUpperCase()) : [],
        sentiment: parsed.sentiment ?? 'neutral',
        sector: parsed.sector ?? null,
        watch_zone: parsed.watch_zone ?? null,
        actionable: parsed.actionable ?? false,
        raw: text,
      }
    }

    return { type: 'ignore' }
  } catch (e) {
    console.error('[telegram-signal] parse error:', e)
    return { type: 'ignore' }
  }
}
