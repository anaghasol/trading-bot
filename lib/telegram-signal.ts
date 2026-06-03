/**
 * Parses a raw Telegram message into a structured trade signal using Claude AI.
 * Handles natural language like:
 *   "OKLO buy at 67.75, SL 64"
 *   "NVDA — sell half at 950, trail 3%"
 *   "Exit TSLA now"
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

export interface TradeSignal {
  symbol: string
  action: 'BUY' | 'SELL'
  order_type: 'MARKET' | 'LIMIT'
  entry_price: number | null    // null = market order
  stop_loss: number | null
  target: number | null
  confidence: number            // 0-100, how clear the signal was
  raw: string
}

export async function parseSignal(text: string): Promise<TradeSignal | null> {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a trading signal parser. Extract trade instructions from this Telegram message and return ONLY valid JSON, no explanation.

Message: "${text}"

Return this exact JSON shape (null for missing fields):
{
  "symbol": "TICKER",
  "action": "BUY" or "SELL",
  "order_type": "MARKET" or "LIMIT",
  "entry_price": number or null,
  "stop_loss": number or null,
  "target": number or null,
  "confidence": 0-100
}

Rules:
- confidence 90+ = crystal clear signal ("buy OKLO at 67.75")
- confidence 70-89 = clear with some ambiguity
- confidence < 70 = unclear / not a trade signal — return null
- If message is just commentary / news with no clear buy/sell instruction, return null
- "SL" or "stop loss" or "stop" = stop_loss
- "target" or "TP" or "take profit" = target
- If price mentioned without "limit", still set order_type LIMIT with that price
- If no price mentioned, MARKET order

Return null (not JSON) if this is not a trade signal.`,
      }],
    })

    const raw = (msg.content[0] as { type: string; text: string }).text.trim()
    if (raw === 'null' || raw === '') return null

    const parsed = JSON.parse(raw)
    if (!parsed?.symbol || !parsed?.action || parsed.confidence < 70) return null

    return { ...parsed, raw: text }
  } catch {
    return null
  }
}
