/**
 * Classifies Telegram messages — acts like a human trader.
 *
 *   type: 'trade'   → explicit BUY/SELL → execute immediately
 *   type: 'exit'    → channel says a stock hit SL/target → close our position if held
 *   type: 'learn'   → insight/analysis → save to learning log for future AI context
 *   type: 'ignore'  → noise, promos, greetings → skip
 *
 * Uses Groq (free) for all text classification — llama-3.3-70b-versatile.
 * Claude is NOT used here; it's only used for image OCR in the poll route.
 */

const GROQ_KEY = process.env.GROQ_API_KEY ?? ''

async function groqClassify(prompt: string): Promise<string> {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set')
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`)
  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content?.trim() ?? ''
}

const TRADE_KEYWORDS = /\b(buy|sell|long|short|entry|sl|stop.?loss|target|t1|t2|t3|breakout|support|resistance|earnings|hold|exit|watchlist|alert|position|setup|hit|stopped|closed)\b/i
const HAS_TICKER    = /\b[A-Z]{2,5}\b/
const HAS_PRICE     = /\$[\d,]+(\.\d+)?|\d+\.?\d*\s*%/

// Multi-leg / complex options — bot cannot manage these, skip entirely
const OPTIONS_PATTERN = /\b(call spread|put spread|bull put|bear call|iron condor|straddle|strangle|butterfly|debit spread|credit spread|vertical spread|covered call|cash.secured put|IV rank|implied vol|theta|delta|gamma|vega|0DTE)\b/i

// OCC options symbol: TICKER + YYMMDD + C/P + 8-digit strike (e.g. AMD260724P00485000)
const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/

export function isOptionsSignal(text: string): boolean {
  return OPTIONS_PATTERN.test(text)
}

export function isOCCSymbol(symbol: string): boolean {
  return OCC_SYMBOL.test(symbol)
}

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

// ── Thread-aware batch parser ─────────────────────────────────────────────────
// Sends all new messages to Claude at once so context flows between them:
// e.g. "watching OKLO near $45" (msg 1) + "entering now" (msg 3) = BUY OKLO @45

function normalizeSignal(p: Record<string, unknown>, raw: string): ParsedSignal {
  if (p.type === 'trade') {
    if (!p.symbol || !p.action || ((p.confidence as number) ?? 0) < 70) {
      return {
        type: 'learn', summary: `Possible trade on ${p.symbol ?? 'unknown'}`,
        symbols: p.symbol ? [String(p.symbol).toUpperCase()] : [],
        sentiment: 'neutral', sector: null, watch_zone: null, actionable: false, raw,
      }
    }
    return {
      type: 'trade',
      symbol: String(p.symbol).toUpperCase(),
      action: p.action as 'BUY' | 'SELL',
      order_type: (p.order_type as 'MARKET' | 'LIMIT') ?? 'MARKET',
      entry_price: (p.entry_price as number) ?? null,
      stop_loss: (p.stop_loss as number) ?? null,
      target: (p.target as number) ?? null,
      confidence: p.confidence as number,
      raw,
    }
  }
  if (p.type === 'exit') {
    if (!p.symbol) return { type: 'ignore' }
    return {
      type: 'exit',
      symbol: String(p.symbol).toUpperCase(),
      reason: (p.reason as 'SL_HIT' | 'TARGET_HIT' | 'ADVISOR_EXIT') ?? 'ADVISOR_EXIT',
      summary: String(p.summary ?? ''),
      raw,
    }
  }
  if (p.type === 'learn') {
    return {
      type: 'learn',
      summary: String(p.summary ?? raw.slice(0, 120)),
      symbols: Array.isArray(p.symbols) ? (p.symbols as string[]).map((s) => String(s).toUpperCase()) : [],
      sentiment: (p.sentiment as 'bullish' | 'bearish' | 'neutral') ?? 'neutral',
      sector: (p.sector as string) ?? null,
      watch_zone: (p.watch_zone as string) ?? null,
      actionable: (p.actionable as boolean) ?? false,
      raw,
    }
  }
  return { type: 'ignore' }
}

export async function parseSignalThread(
  messages: Array<{ id: number; text: string }>,
  channelName = 'Trading Channel',
  signalStyle = ''
): Promise<Array<{ id: number; signal: ParsedSignal }>> {
  if (messages.length === 0) return []
  try {
    const numbered = messages.map((m, i) => `[${i + 1}] ${m.text}`).join('\n\n')
    const channelContext = signalStyle ? `\nCHANNEL STYLE:\n${signalStyle}\n` : ''
    const raw = await groqClassify(`You are reading a THREAD of messages from "${channelName}". Read ALL messages first, then classify each one with the benefit of thread context. Earlier messages inform later ones.${channelContext}

${numbered}

Thread-context rules:
- If msg [1] says "watching OKLO near $45" and msg [3] says "entering now" or "buy here" → [3] is type:trade for OKLO at $45
- If a macro bearish tone builds across messages, later neutral messages inherit that sentiment
- If the channel mentions a stock positively across multiple messages, mark actionable:true

Per-message classification rules:
- type:trade = explicit entry with ticker + price (e.g. "Buy SPIR at 20.5 SL 18.5") OR explicit "buying X at Y with Z as stop" → type:trade
- type:trade also if message says "Trade Id : XXXXX" with ticker + price + SL
- type:exit = explicit instruction to close NOW, or "TP hit", "book profits", "stop hit"
- type:learn = insight, watch zone, position update, macro commentary, "first TP secured" updates
- type:ignore = noise, greetings, links, admin, member Q&A without a clear signal

Return ONLY a JSON array with exactly ${messages.length} objects (one per message, in order):
[{"msg_index":1,"type":"learn","summary":"...","symbols":["X"],"sentiment":"bullish","sector":null,"watch_zone":"$45-48","actionable":true}, ...]

For trade: {"msg_index":N,"type":"trade","symbol":"X","action":"BUY","entry_price":20.5,"stop_loss":18.5,"target":null,"confidence":95}
For exit: {"msg_index":N,"type":"exit","symbol":"X","reason":"ADVISOR_EXIT","summary":"..."}
For ignore: {"msg_index":N,"type":"ignore"}`)
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return messages.map((m) => ({ id: m.id, signal: { type: 'ignore' as const } }))
    const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>
    return messages.map((m, i) => {
      const p = parsed.find((x) => (x.msg_index as number) === i + 1) ?? { type: 'ignore' }
      return { id: m.id, signal: normalizeSignal(p, m.text) }
    })
  } catch (e) {
    console.error('[telegram-signal] thread parse error:', e)
    return messages.map((m) => ({ id: m.id, signal: { type: 'ignore' as const } }))
  }
}

export async function parseSignal(text: string, channelName = 'Trading Channel', signalStyle = ''): Promise<ParsedSignal> {
  try {
    const channelContext = signalStyle
      ? `\nCHANNEL STYLE: ${signalStyle}\n`
      : ''
    const raw = await groqClassify(`You are a trading signal classifier for a bot that trades stocks AND single-leg options.
Channel: "${channelName}"${channelContext}

Message: "${text}"

STEP 1 — CRYPTO? (BTC, ETH, SOL, POL, MATIC, XRP, ADA, BNB, etc.)
→ TRADE signal! LONG=BUY, SHORT=SELL. Symbol = crypto ticker (e.g. "POL" from "POLUSDT LONG").
→ The system maps crypto→equity proxies. Just classify it.
→ Use the stop loss from message. Set entry_price=null. No stop loss = type:learn.

STEP 2 — SINGLE-LEG OPTIONS (explicit call or put with a stock ticker, strike price, and expiry)?
→ e.g. "Buy NVDA 140 Call Aug 15", "Buy AMD 105P July 24", "Enter TSLA 200C"
→ Return type:trade with action=BUY. Set symbol to the format "TICKER STRIKE TYPE EXPIRY"
  e.g. symbol="NVDA 140 CALL 2026-08-15" or "AMD 105 PUT 2026-07-24"
→ The system will look up the actual contract. Use stop_loss from message or null.
→ SKIP if: multi-leg spread (condor, straddle, bull put, bear call, debit/credit spread) → type:learn
→ SKIP if: options exit / "closing my call" / "took profit on puts" → type:learn

STEP 3 — STOCK trade?
→ Explicit: stock ticker + BUY/SELL + price/market + stop loss → type:trade
→ e.g. "Buy SPIR at 20 SL 18.5", "Enter COIN market SL 245"
→ No stop loss = type:learn (not confident enough to execute)
→ Index mentions (SPX, NDX, RUT, VIX) alone = type:learn, trade ETF proxy only if explicit BUY

STEP 4 — EXIT?
→ Explicit close/exit of a stock position we hold → type:exit
→ NOT for options P&L updates or spread closings

STEP 5 — LEARN/IGNORE
→ type:learn = macro commentary, watchlists, sector views, conditional setups, options P&L
→ type:ignore = greetings, referrals, admin, very short noise

Reply ONLY with a JSON object:

For stock trade: {"type":"trade","symbol":"TICKER","action":"BUY","entry_price":200,"stop_loss":190,"target":null,"confidence":90}
For options trade: {"type":"trade","symbol":"NVDA 140 CALL 2026-08-15","action":"BUY","entry_price":null,"stop_loss":null,"target":null,"confidence":85}
For exit: {"type":"exit","symbol":"TICKER","reason":"ADVISOR_EXIT","summary":"one factual sentence"}
For learn: {"type":"learn","summary":"one factual sentence — no names","symbols":["TICKER"],"sentiment":"bullish","sector":null,"watch_zone":null,"actionable":true}
For ignore: {"type":"ignore"}

Rules:
- confidence < 75 → demote trade to learn
- Default to learn when unsure
- No person names in summary`)

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
