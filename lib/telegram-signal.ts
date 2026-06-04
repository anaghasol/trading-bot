/**
 * Classifies any Telegram message into one of three outcomes:
 *
 *   type: 'trade'  → clear BUY/SELL instruction → execute on Alpaca Paper
 *   type: 'learn'  → market insight / analysis with no trade action → save to learning log
 *   type: 'ignore' → promo, spam, referral links, greetings, noise → skip silently
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

// Cheap pre-filter — skip Claude entirely for obvious noise.
// A message passes if it has ANY trading signal: ticker, price, keyword, or real length.
const TRADE_KEYWORDS = /\b(buy|sell|long|short|entry|sl|stop.?loss|target|t1|t2|t3|breakout|support|resistance|earnings|hold|exit|watchlist|alert|position|setup)\b/i
const HAS_TICKER    = /\b[A-Z]{2,5}\b/        // 2–5 uppercase letters (ticker pattern)
const HAS_PRICE     = /\$[\d,]+(\.\d+)?|\d+\.?\d*\s*%/  // $123 or 12.5%

export function isWorthClassifying(text: string): boolean {
  if (text.length < 15) return false          // too short to matter
  if (TRADE_KEYWORDS.test(text)) return true
  if (HAS_TICKER.test(text) && HAS_PRICE.test(text)) return true
  if (text.length > 80) return true           // long message — likely analysis
  return false
}

export type SignalType = 'trade' | 'learn' | 'ignore'

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

export interface LearnSignal {
  type: 'learn'
  summary: string   // one-line summary of the insight
  symbols: string[] // mentioned tickers
  raw: string
}

export interface IgnoreSignal {
  type: 'ignore'
}

export type ParsedSignal = TradeSignal | LearnSignal | IgnoreSignal

export async function parseSignal(text: string): Promise<ParsedSignal> {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are an assistant for a stock trading bot. Classify this Telegram message from a paid trading signals channel.

Message: "${text}"

Reply with ONLY a JSON object. Choose one of these three shapes:

1. If it is a clear trade instruction (buy/sell a specific stock):
{"type":"trade","symbol":"TICKER","action":"BUY","order_type":"LIMIT","entry_price":67.75,"stop_loss":64,"target":null,"confidence":95}

2. If it contains useful market analysis, sector insight, earnings info, stock commentary, or educational content worth saving (but NOT a direct trade command):
{"type":"learn","summary":"one-line insight here","symbols":["OKLO","NVDA"]}

3. If it is promotional content, referral links, admin messages, greetings, spam, or completely irrelevant:
{"type":"ignore"}

Classification rules:
- "buy X at Y" / "sell X" / "SL at Z" → type:trade
- "X looks strong", "watch X", "earnings on X", market commentary → type:learn
- Referral links, "join our group", congratulations, webinar ads → type:ignore
- For trade: confidence 90+ = very clear, 70-89 = somewhat clear, below 70 = treat as learn instead
- order_type: LIMIT if price mentioned, MARKET if not`,
      }],
    })

    const raw = (msg.content[0] as { type: string; text: string }).text.trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { type: 'ignore' }

    const parsed = JSON.parse(jsonMatch[0])

    if (parsed.type === 'trade') {
      if (!parsed.symbol || !parsed.action || (parsed.confidence ?? 0) < 70) {
        // Low confidence trade → demote to learn
        return {
          type: 'learn',
          summary: `Possible ${parsed.action ?? 'trade'} signal on ${parsed.symbol ?? 'unknown'} — low confidence`,
          symbols: parsed.symbol ? [parsed.symbol] : [],
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

    if (parsed.type === 'learn') {
      return {
        type: 'learn',
        summary: parsed.summary ?? text.slice(0, 100),
        symbols: Array.isArray(parsed.symbols) ? parsed.symbols.map((s: string) => String(s).toUpperCase()) : [],
        raw: text,
      }
    }

    return { type: 'ignore' }
  } catch (e) {
    console.error('[telegram-signal] parse error:', e)
    return { type: 'ignore' }
  }
}
