/**
 * SNDK Early-Detection Screener
 *
 * Goal: find stocks at Stage 1 (fundamental inflection BEFORE price runs)
 * not Stage 3 (SNDK today — already 4,000%+ and "most overbought in history").
 *
 * The SNDK signature before the roar:
 *   1. Gross margin expanding fast sequentially (commodity pricing power unlock)
 *   2. Operating leverage inflection (losses → positive margins fast)
 *   3. EPS estimate revisions accelerating upward (analysts scrambling to catch up)
 *   4. Narrative attached to a megatrend (AI infra, nuclear, advanced packaging…)
 *   5. Stage 1 price action: 0-40% above RISING 200DMA from a long base
 *   6. Monthly RSI direction: crossing UP through 55-65, not already >85
 */

const YF_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary'

// ── Screening Universe ─────────────────────────────────────────────────────────
// Sectors where the NEXT fundamental inflection is most likely.
// Deliberately NOT mega-cap momentum (those are already Stage 2-3).
// Focus: adjacent laggards + next datacenter bottleneck.
export const DISCOVERY_UNIVERSE: Record<string, string[]> = {
  'AI_POWER_GRID': ['GEV', 'ETN', 'VST', 'CEG', 'EVRG', 'NRG', 'NEE', 'AEE', 'PCG'],
  'AI_COOLING':    ['VRT', 'AICC', 'APH', 'GFS'],
  'AI_NETWORKING': ['ANET', 'CIEN', 'LITE', 'VIAV', 'INFN', 'CALX'],
  'ADV_PACKAGING': ['ON', 'COHR', 'ONTO', 'IPGP', 'KLIC', 'ACMR', 'AEHR'],
  'NUCLEAR':       ['OKLO', 'SMR', 'CEG', 'BWXT', 'NNE', 'LEU', 'UUUU'],
  'MEMORY_ADJ':    ['WDC', 'MU', 'NXPI', 'MCHP', 'SWKS', 'QRVO', 'WOLF'],
  'DEFENSE_TECH':  ['RCAT', 'JOBY', 'ACHR', 'BFLY', 'ASTS', 'LUNR', 'RDW'],
  'BIOTECH_INFLEX':['RXRX', 'BEAM', 'SRPT', 'CRSP', 'EDIT', 'NTLA', 'FATE'],
  'FINTECH_ADJ':   ['LC', 'UPST', 'OPEN', 'FLYW', 'PAYC', 'WEX'],
  'INDUSTRIAL_AI': ['IONQ', 'QUBT', 'RGTI', 'DFNS', 'BBAI', 'SOUN'],
}

export const ALL_DISCOVERY_SYMBOLS = Object.values(DISCOVERY_UNIVERSE).flat()
  .filter((s, i, a) => a.indexOf(s) === i)

// ── Data Fetching ──────────────────────────────────────────────────────────────

interface YFFinancialData {
  grossMargins?: { raw?: number }
  operatingMargins?: { raw?: number }
  revenueGrowth?: { raw?: number }
  targetMeanPrice?: { raw?: number }
  currentPrice?: { raw?: number }
  returnOnEquity?: { raw?: number }
}

interface YFQuarterlyIncome {
  totalRevenue?: { raw?: number }
  grossProfit?: { raw?: number }
  operatingIncome?: { raw?: number }
  endDate?: { fmt?: string }
}

interface YFEarningsTrend {
  trend?: Array<{
    period?: string
    earningsEstimate?: {
      avg?: { raw?: number }
      numberOfAnalysts?: { raw?: number }
    }
    epsTrend?: {
      current?: { raw?: number }
      '7daysAgo'?: { raw?: number }
      '30daysAgo'?: { raw?: number }
      '60daysAgo'?: { raw?: number }
    }
    revenueEstimate?: { avg?: { raw?: number } }
  }>
}

interface YFChartData {
  close: number[]
  volume: number[]
  timestamps: number[]
}

async function fetchFundamentals(symbol: string): Promise<{
  financial: YFFinancialData | null
  incomeQ: YFQuarterlyIncome[]
  earningsTrend: YFEarningsTrend | null
}> {
  const modules = 'financialData,incomeStatementHistoryQuarterly,earningsTrend'
  const url = `${YF_SUMMARY}/${symbol}?modules=${modules}&crumb=&lang=en-US`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return { financial: null, incomeQ: [], earningsTrend: null }
    const data = await res.json() as {
      quoteSummary?: {
        result?: Array<{
          financialData?: YFFinancialData
          incomeStatementHistoryQuarterly?: { incomeStatementHistory?: YFQuarterlyIncome[] }
          earningsTrend?: YFEarningsTrend
        }>
      }
    }
    const result = data.quoteSummary?.result?.[0]
    if (!result) return { financial: null, incomeQ: [], earningsTrend: null }
    return {
      financial:     result.financialData ?? null,
      incomeQ:       result.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [],
      earningsTrend: result.earningsTrend ?? null,
    }
  } catch {
    return { financial: null, incomeQ: [], earningsTrend: null }
  }
}

async function fetchPriceHistory(symbol: string): Promise<YFChartData | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store',
    })
    if (!res.ok) return null
    const data = await res.json() as {
      chart?: { result?: Array<{
        timestamps?: number[]
        indicators?: { quote?: Array<{ close?: number[]; volume?: number[] }> }
      }> }
    }
    const r = data.chart?.result?.[0]
    if (!r) return null
    const q = r.indicators?.quote?.[0]
    return {
      close:      (q?.close ?? []).map((v) => v ?? 0),
      volume:     (q?.volume ?? []).map((v) => v ?? 0),
      timestamps: r.timestamps ?? [],
    }
  } catch { return null }
}

// ── Stage Classifier ────────────────────────────────────────────────────────────

export type Stage = 0 | 1 | 2 | 3

/** Classify which stage of the cycle a stock is in based on 200DMA deviation.
 * Stage 1 (0-40% above RISING 200DMA) = SNDK before the roar → target.
 * Stage 3 (>150% above) = SNDK today → avoid new positions. */
function classifyStage(closes: number[]): { stage: Stage; deviationPct: number; ma200: number } {
  if (closes.length < 200) return { stage: 0, deviationPct: 0, ma200: 0 }

  const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200
  const prev200 = closes.slice(-220, -20).reduce((a, b) => a + b, 0) / 200
  const ma200Rising = ma200 > prev200 * 1.001  // 200DMA trending up

  const currentPrice = closes[closes.length - 1]
  const deviationPct = ma200 > 0 ? ((currentPrice - ma200) / ma200) * 100 : 0

  let stage: Stage
  if (!ma200Rising || deviationPct < -10) {
    stage = 0  // below or flat 200DMA — base building
  } else if (deviationPct >= 0 && deviationPct <= 40) {
    stage = 1  // ← THE SNDK ZONE: just reclaimed rising 200DMA
  } else if (deviationPct > 40 && deviationPct <= 150) {
    stage = 2  // running — can still enter but momentum is recognized
  } else {
    stage = 3  // blowoff — SNDK today — penalize
  }

  return { stage, deviationPct, ma200 }
}

// ── RSI ─────────────────────────────────────────────────────────────────────────

function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  const slice = closes.slice(-(period + 20))  // extra for convergence
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = slice[i] - slice[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  let ag = gains / period, al = losses / period
  for (let i = period + 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1]
    ag = (ag * (period - 1) + Math.max(0, diff))  / period
    al = (al * (period - 1) + Math.max(0, -diff)) / period
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al)
}

/** Monthly RSI using ~21 trading day periods */
function monthlyRSI(closes: number[]): { current: number; fourWeeksAgo: number } {
  if (closes.length < 300) return { current: 50, fourWeeksAgo: 50 }
  const current     = computeRSI(closes, 14)
  const fourWeeksAgo = computeRSI(closes.slice(0, -21), 14)
  return { current, fourWeeksAgo }
}

// ── Volume Expansion ─────────────────────────────────────────────────────────

function volumeExpansionScore(volumes: number[]): number {
  if (volumes.length < 55) return 0
  const recent5   = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5
  const avg50     = volumes.slice(-55, -5).reduce((a, b) => a + b, 0) / 50
  const expansion = avg50 > 0 ? recent5 / avg50 : 1
  if (expansion >= 2.0) return 10
  if (expansion >= 1.5) return 7
  if (expansion >= 1.2) return 4
  return 0
}

// ── Fundamental Scoring ───────────────────────────────────────────────────────

function revenueAccelerationScore(incomeQ: YFQuarterlyIncome[]): number {
  if (incomeQ.length < 4) return 0
  const revs = incomeQ.slice(0, 4).map((q) => q.totalRevenue?.raw ?? 0).reverse()
  if (revs.some((r) => r <= 0)) return 0
  const g1 = (revs[1] - revs[0]) / revs[0]  // Q-2 to Q-1 growth
  const g2 = (revs[2] - revs[1]) / revs[1]  // Q-1 to Q0 growth
  const g3 = (revs[3] - revs[2]) / revs[2]  // Q0 to Q1 growth (most recent)
  // Second derivative positive = acceleration
  if (g3 > g2 && g2 > g1) return 10   // full acceleration
  if (g3 > g2)             return 6    // most recent quarter accelerating
  if (g3 > 0.10)           return 3    // at least growing fast
  return 0
}

function grossMarginExpansionScore(incomeQ: YFQuarterlyIncome[], currentGM: number): number {
  if (incomeQ.length < 2) return 0
  const q0 = incomeQ[0]
  const q1 = incomeQ[1]
  const gm0 = q0.totalRevenue?.raw ? (q0.grossProfit?.raw ?? 0) / q0.totalRevenue.raw : 0
  const gm1 = q1.totalRevenue?.raw ? (q1.grossProfit?.raw ?? 0) / q1.totalRevenue.raw : 0
  const seqExpansion = gm0 - gm1  // positive = expanding

  if (seqExpansion >= 0.05)         return 10   // +500bps sequential — SNDK-level pricing power
  if (seqExpansion >= 0.02)         return 7    // +200bps — clear expansion
  if (seqExpansion >= 0.005)        return 3    // +50bps — directionally right
  if (currentGM >= 0.50)            return 5    // already high margin (>50%) = structural moat
  return 0
}

function operatingLeverageScore(incomeQ: YFQuarterlyIncome[]): number {
  if (incomeQ.length < 3) return 0
  const ops = incomeQ.slice(0, 3).map((q) =>
    q.totalRevenue?.raw ? (q.operatingIncome?.raw ?? 0) / q.totalRevenue.raw : null
  )
  if (ops.some((v) => v === null)) return 0
  const [om0, om1, om2] = ops as number[]  // Q0=most recent, Q2=oldest
  // Inflection: was losing, now profitable
  if (om2 < -0.05 && om1 < 0 && om0 > 0.05) return 10  // full loss-to-profit inflection
  if (om2 < 0 && om0 > 0)                     return 7   // turned positive
  if (om0 > om1 && om1 > om2 && om0 > 0.10)  return 5   // consistent expansion into profit
  if (om0 > om1 && om0 > 0.20)               return 3   // already high, still expanding
  return 0
}

function epsRevisionScore(earningsTrend: YFEarningsTrend | null): number {
  if (!earningsTrend?.trend) return 0
  // Use next-year estimates (period '0y')
  const nextYear = earningsTrend.trend.find((t) => t.period === '0y' || t.period === '+1y')
  if (!nextYear?.epsTrend) return 0
  const current    = nextYear.epsTrend.current?.raw    ?? 0
  const thirtyAgo  = nextYear.epsTrend['30daysAgo']?.raw ?? current
  const sixtyAgo   = nextYear.epsTrend['60daysAgo']?.raw ?? current
  if (thirtyAgo === 0) return 0
  const rev30 = (current - thirtyAgo)  / Math.abs(thirtyAgo)
  const rev60 = (current - sixtyAgo)   / Math.abs(sixtyAgo)
  // Analysts scrambling upward = 550%+ revisions were the SNDK tell
  if (rev30 >= 0.30)                  return 10   // +30% revision in 30 days = major catch-up
  if (rev30 >= 0.10)                  return 7    // +10% = meaningful
  if (rev30 > 0 && rev60 > 0)        return 4    // consistent upward drift
  if (rev30 > 0)                      return 2    // any positive revision
  return 0
}

// ── The Full Score ─────────────────────────────────────────────────────────────

export interface SNDKCandidate {
  symbol:            string
  sector:            string
  sndkScore:         number   // 0-100
  stage:             Stage
  deviationPct:      number   // % above/below 200DMA
  rsiCurrent:        number
  rsiDirection:      'rising_early' | 'momentum' | 'extreme' | 'flat'
  fundamentalScore:  number   // 0-40
  stageScore:        number   // 0-30
  rsiScore:          number   // 0-20
  volumeScore:       number   // 0-10
  grossMarginPct:    number
  operatingMarginPct: number
  revenueGrowthPct:  number
  epsRevision30d:    number
  highlights:        string[] // human-readable reasons this is interesting
  priceTarget:       number   // analyst consensus
  currentPrice:      number
  screened_at:       string
}

export async function scoreSNDKCandidate(
  symbol: string,
  sector: string
): Promise<SNDKCandidate | null> {
  const [price, fundamentals] = await Promise.all([
    fetchPriceHistory(symbol),
    fetchFundamentals(symbol),
  ])

  if (!price || price.close.length < 60) return null
  const { financial, incomeQ, earningsTrend } = fundamentals

  // Stage classification
  const { stage, deviationPct, ma200 } = classifyStage(price.close)

  // RSI
  const { current: rsiNow, fourWeeksAgo: rsiPrev } = monthlyRSI(price.close)
  let rsiDirection: SNDKCandidate['rsiDirection']
  let rsiScore: number
  if (rsiNow > 85) {
    rsiDirection = 'extreme'
    rsiScore = -10
  } else if (rsiNow >= 65 && rsiNow <= 85) {
    rsiDirection = 'momentum'
    rsiScore = 10
  } else if (rsiNow >= 50 && rsiNow <= 65 && rsiNow > rsiPrev) {
    rsiDirection = 'rising_early'  // crossing up through 55-65 = SNDK signal zone
    rsiScore = 20
  } else {
    rsiDirection = 'flat'
    rsiScore = 0
  }

  // Stage score — Stage 1 = the money zone
  let stageScore: number
  if (stage === 1)      stageScore = 30
  else if (stage === 2) stageScore = 15
  else if (stage === 0) stageScore = 10
  else                  stageScore = -10  // Stage 3 = SNDK today = penalize

  // Fundamental scores
  const currentGM   = financial?.grossMargins?.raw    ?? 0
  const currentOM   = financial?.operatingMargins?.raw ?? 0
  const revGrowth   = financial?.revenueGrowth?.raw   ?? 0

  const fRevAccel   = revenueAccelerationScore(incomeQ)
  const fGMExpand   = grossMarginExpansionScore(incomeQ, currentGM)
  const fOpLeverage = operatingLeverageScore(incomeQ)
  const fEPSRev     = epsRevisionScore(earningsTrend)
  const fundamentalScore = fRevAccel + fGMExpand + fOpLeverage + fEPSRev

  // Volume
  const volScore = volumeExpansionScore(price.volume)

  // Total SNDK score
  const sndkScore = Math.max(0, Math.min(100,
    fundamentalScore + stageScore + rsiScore + volScore
  ))

  // Analyst price target
  const priceTarget  = financial?.targetMeanPrice?.raw  ?? 0
  const currentPrice = financial?.currentPrice?.raw ?? (price.close.at(-1) ?? 0)

  // EPS revision for display
  const nextYearTrend = earningsTrend?.trend?.find((t) => t.period === '0y' || t.period === '+1y')
  const epsCurrent    = nextYearTrend?.epsTrend?.current?.raw    ?? 0
  const eps30ago      = nextYearTrend?.epsTrend?.['30daysAgo']?.raw ?? epsCurrent
  const epsRevision30 = eps30ago !== 0 ? ((epsCurrent - eps30ago) / Math.abs(eps30ago)) * 100 : 0

  // Human-readable highlights
  const highlights: string[] = []
  if (stage === 1) highlights.push(`Stage 1: ${deviationPct.toFixed(0)}% above rising 200DMA — early breakout zone`)
  if (fGMExpand >= 7) highlights.push(`Gross margin expanding sequentially (${(currentGM * 100).toFixed(0)}% GM)`)
  if (fOpLeverage >= 7) highlights.push(`Operating leverage inflection (OM ${(currentOM * 100).toFixed(0)}%)`)
  if (fEPSRev >= 7) highlights.push(`EPS estimates revised +${epsRevision30.toFixed(0)}% in 30d — analysts catching up`)
  if (fRevAccel >= 7) highlights.push(`Revenue accelerating (YoY +${(revGrowth * 100).toFixed(0)}%)`)
  if (rsiDirection === 'rising_early') highlights.push(`RSI ${rsiNow.toFixed(0)} crossing up through 55-65 — early momentum signal`)
  if (volScore >= 7) highlights.push('Volume surge on recent breakout candles')
  if (priceTarget > currentPrice * 1.3) highlights.push(`Analyst target $${priceTarget.toFixed(0)} = +${(((priceTarget - currentPrice) / currentPrice) * 100).toFixed(0)}% upside`)

  if (sndkScore < 10) return null  // below minimum — not worth surfacing

  return {
    symbol, sector, sndkScore, stage, deviationPct,
    rsiCurrent: rsiNow, rsiDirection,
    fundamentalScore, stageScore, rsiScore, volumeScore: volScore,
    grossMarginPct:     Math.round(currentGM * 1000) / 10,
    operatingMarginPct: Math.round(currentOM * 1000) / 10,
    revenueGrowthPct:   Math.round(revGrowth * 1000) / 10,
    epsRevision30d:     Math.round(epsRevision30 * 10) / 10,
    highlights,
    priceTarget, currentPrice,
    screened_at: new Date().toISOString(),
  }
}

/** Run the full SNDK screener on the discovery universe.
 *  Processes in parallel batches to avoid rate-limiting. */
export async function runSNDKScreener(): Promise<SNDKCandidate[]> {
  const results: SNDKCandidate[] = []

  // Process in batches of 10 to avoid Yahoo Finance rate limits
  const entries = Object.entries(DISCOVERY_UNIVERSE)
  for (const [sector, symbols] of entries) {
    const batch = symbols.slice(0, 10)  // 10 per sector
    const scored = await Promise.all(
      batch.map((sym) => scoreSNDKCandidate(sym, sector).catch(() => null))
    )
    for (const c of scored) {
      if (c && c.sndkScore >= 15) results.push(c)
    }
    // Brief pause between sector batches to be polite to Yahoo Finance
    await new Promise((r) => setTimeout(r, 500))
  }

  // Sort by SNDK score descending
  return results.sort((a, b) => b.sndkScore - a.sndkScore)
}
