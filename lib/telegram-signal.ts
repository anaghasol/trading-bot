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
        content: `You are a trading signal parser. Extract trade instructions from this Telegram message.

Message: "${text}"

Reply with ONLY a JSON object (no markdown, no explanation). Use this shape:
{"symbol":"TICKER","action":"BUY","order_type":"LIMIT","entry_price":67.75,"stop_loss":64,"target":null,"confidence":95}

Rules:
- action: "BUY" or "SELL" only
- order_type: "LIMIT" if a price is mentioned, otherwise "MARKET"
- confidence: 90+ if clearly a trade signal, 70-89 if somewhat clear, below 70 if not a trade signal
- SL / stop loss / stop = stop_loss field
- TP / target / take profit = target field
- If not a trade signal at all, reply with: {"confidence":0}`,
      }],
    })

    const raw = (msg.content[0] as { type: string; text: string }).text.trim()

    // Extract JSON even if Claude wraps it in markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed?.symbol || !parsed?.action || !parsed.confidence || parsed.confidence < 70) return null

    return {
      symbol: String(parsed.symbol).toUpperCase(),
      action: parsed.action,
      order_type: parsed.order_type ?? 'MARKET',
      entry_price: parsed.entry_price ?? null,
      stop_loss: parsed.stop_loss ?? null,
      target: parsed.target ?? null,
      confidence: parsed.confidence,
      raw: text,
    }
  } catch (e) {
    console.error('[telegram-signal] parse error:', e)
    return null
  }
}
