/**
 * Classifier for Pavan's SF Essential Trades messages.
 *
 * Deliberately conservative: it only fills structured fields when he uses his
 * own explicit format ("Trade ID:10122 - Buying AA at 52.4 With SL of 49 ...").
 * Everything else is stored verbatim as commentary so it can be re-classified
 * later without re-pulling Telegram history.
 */

export type PavanKind = 'entry' | 'exit' | 'hold' | 'commentary'

export interface PavanParsed {
  kind:          PavanKind
  trade_id:      string | null
  symbol:        string | null
  entry_price:   number | null
  stop_loss:     number | null
  target_price:  number | null
  purchase_type: string | null
  risk_pct:      number | null
}

const ENTRY_WORDS = /\b(buying|buy|adding|add(?:ed)?|entered|entering|accumulat)/i
const EXIT_WORDS  = /\b(sold|sell(?:ing)?|exit(?:ed|ing)?|booked|book\s+profit|clos(?:e|ed|ing)|trim(?:med|ming)?|target\s+hit|hit\s+the\s+target|stopped\s+out|stop\s+hit|took\s+profit|square[d]?\s+off)/i
const HOLD_WORDS  = /\b(hold(?:ing)?|keep|stay\s+put|continue\s+to\s+hold)\b/i

// "Trade ID:10122 - Buying AA at 52.4 With SL of 49"
const STRUCTURED = /buying\s+([A-Z]{1,6})\s+(?:at|@)\s*\$?([\d.]+)\s*with\s+sl\s+of\s*\$?([\d.]+)/i

export function parsePavan(text: string): PavanParsed {
  const t = text ?? ''

  const tradeId      = t.match(/trade\s*id\s*[:#]?\s*(\d+)/i)?.[1] ?? null
  const purchaseType = t.match(/purchase\s+type\s+as\s*[:\s]\s*([A-Za-z]+)/i)?.[1] ?? null
  const riskPct      = t.match(/max\s+risk\s+of\s*(-?[\d.]+)\s*%/i)?.[1]
  const struct       = t.match(STRUCTURED)

  // Target: "target is above 80$", "9$ is T1 and T2 is 24$", "target are 24$ and 58$"
  const targetRaw =
    t.match(/targets?\s+(?:is|are)\s+(?:above\s+)?\$?([\d.]+)/i)?.[1] ??
    t.match(/\bT1\s+(?:is\s+)?\$?([\d.]+)/i)?.[1] ??
    null

  const hasEntry = ENTRY_WORDS.test(t)
  const hasExit  = EXIT_WORDS.test(t)

  // An explicit "Buying X at P with SL of S" is an entry even if the notes also
  // discuss selling later — the structured form is the actionable part.
  const kind: PavanKind =
    struct              ? 'entry'
    : hasExit           ? 'exit'
    : hasEntry          ? 'entry'
    : HOLD_WORDS.test(t)? 'hold'
    :                     'commentary'

  return {
    kind,
    trade_id:      tradeId,
    symbol:        struct ? struct[1].toUpperCase() : null,
    entry_price:   struct ? Number(struct[2]) : null,
    stop_loss:     struct ? Number(struct[3]) : null,
    target_price:  targetRaw ? Number(targetRaw) : null,
    purchase_type: purchaseType,
    risk_pct:      riskPct ? Number(riskPct) : null,
  }
}

/** His stated horizon → the bot's hold_mode. "Investment" means years, not days. */
export function holdModeFor(purchaseType: string | null): 'swing' | 'trend' {
  return /invest/i.test(purchaseType ?? '') ? 'trend' : 'swing'
}
