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
  sector: string | null   // e.g. 'nuclear', 'tech', 'biotech'
  actionable: boolean     // should the AI scanner consider this context?
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
        content: `You are an expert trading assistant reading messages from a paid stock signals channel (SF Essential Trades by Pavan Sailesh). You must classify each message and act like a professional human trader would.

Message: "${text}"

Reply with ONLY a JSON object — one of these four shapes:

1. EXPLICIT TRADE INSTRUCTION (buy/sell a specific stock now):
{"type":"trade","symbol":"TICKER","action":"BUY","order_type":"MARKET","entry_price":null,"stop_loss":18.5,"target":null,"confidence":95}

2. EXIT SIGNAL (channel says a held stock hit stop-loss, hit target, or advisor says exit/close):
{"type":"exit","symbol":"TICKER","reason":"SL_HIT","summary":"INTU hit stop-loss at $180, trade closed for a loss"}
reason must be one of: SL_HIT | TARGET_HIT | ADVISOR_EXIT

3. MARKET INSIGHT (analysis, sector news, holding commentary, earnings, risk summary — worth saving for AI context):
{"type":"learn","summary":"one-line insight","symbols":["TICKER"],"sentiment":"bullish","sector":"nuclear","actionable":true}
- sentiment: bullish / bearish / neutral
- sector: the industry if identifiable, else null
- actionable: true if this should influence future trade decisions

4. NOISE (promos, admin, greetings, webinars, referral links):
{"type":"ignore"}

Classification rules:
- "buy X at Y" / "SL at Z" / clear entry instruction → type:trade
- EXPLICIT direct command to close/sell NOW (e.g. "exit SPIR now", "sell all SPIR", "close your position in X immediately") → type:exit
  Do NOT use exit for: "X hit stop loss", "X stopped out", "X dropped" — those are general commentary, not commands to us
- General market commentary, "X hit SL" updates, sector news, analyst opinions, hold/watch guidance → type:learn with appropriate sentiment
- confidence < 70 on a trade → demote to learn
- When in doubt between exit and learn, choose learn`,
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
          sentiment: 'neutral', sector: null, actionable: false,
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
