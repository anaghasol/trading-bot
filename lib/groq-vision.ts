/**
 * Vision OCR for image trade-signal extraction — multi-provider, never exhausts.
 *
 * Tier 1 — OpenRouter (OPENROUTER_API_KEY): openrouter/auto → qwen/qwen3.7-flash
 *           Groq dropped all vision models in Aug 2026.
 * Tier 2 — Gemini direct (GEMINI_API_KEY): gemini-3.1-flash-lite → -preview → 3-flash-preview
 *
 * Fires TG alert if all providers exhaust (rate-limited 30 min).
 */

// ── Tier 1: OpenRouter vision ─────────────────────────────────────────────────

const OR_VISION_MODELS = [
  'openrouter/auto',
  'qwen/qwen3.7-flash',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-4-scout:free',
]

async function tryORVision(dataUrl: string, prompt: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  for (const model of OR_VISION_MODELS) {
    try {
      const gr = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://mytrade.app',
        },
        body: JSON.stringify({
          model,
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (gr.status === 429 || gr.status === 503) continue
      if (!gr.ok) continue
      const gd = await gr.json() as { choices?: { message?: { content?: string } }[] }
      const out = gd.choices?.[0]?.message?.content?.trim() ?? 'NONE'
      if (out !== 'NONE' && out.includes('TICKER')) {
        console.log(`[IMG_OCR][OR:${model.split('/').pop()}] ${out}`)
        return out
      }
      return null  // clean NONE response — no ticker found
    } catch { /* timeout / network — try next model */ }
  }
  return null
}

// ── Tier 2: Gemini vision (free direct API) ───────────────────────────────────

async function tryGeminiVision(dataUrl: string, prompt: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY
  if (!key) return null

  // Extract base64 and mime from data URL
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const [, mimeType, base64Data] = match

  // flash-lite first: it spends 0 tokens on internal thinking and answers in ~1-3s.
  // gemini-3-flash-preview DOES think, is the most 503-prone, and goes last.
  // Only 3.x ids work — gemini-1.5/2.0/2.5 now return "no longer available to new users".
  for (const model of ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview']) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType, data: base64Data } },
                { text: prompt },
              ],
            }],
            // Thinking tokens count against maxOutputTokens and thinkingBudget:0 is
            // rejected with INVALID_ARGUMENT, so the budget can only be out-sized.
            // At 150 a thinking model spends the whole allowance on thoughts and
            // returns an EMPTY string with finishReason MAX_TOKENS.
            generationConfig: { temperature: 0, maxOutputTokens: 2000 },
          }),
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      // Join every part — a thinking model can emit thoughts before the answer,
      // so parts[0] alone is not reliably the response.
      const out = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '').join('').trim() || 'NONE'
      if (out !== 'NONE' && out.includes('TICKER')) {
        console.log(`[IMG_OCR][Gemini:${model}] ${out}`)
        return out
      }
      return null
    } catch { /* try next */ }
  }
  return null
}

// ── Exhaust alert ─────────────────────────────────────────────────────────────

let lastVisionExhaustMs = 0
async function alertVisionExhausted() {
  const now = Date.now()
  if (now - lastVisionExhaustMs < 30 * 60_000) return
  lastVisionExhaustMs = now
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!token || !chatId) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `⚠️ *Vision OCR Exhausted*\n\nOpenRouter + Gemini both failed for image trade signals.\nSignal images will be skipped until keys/quota recover.\n\nCheck OPENROUTER_API_KEY and GEMINI_API_KEY in Vercel.`,
      parse_mode: 'Markdown',
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function groqVisionExtract(dataUrl: string, prompt: string): Promise<string | null> {
  const result = await tryORVision(dataUrl, prompt) ?? await tryGeminiVision(dataUrl, prompt)
  if (result === undefined) {
    void alertVisionExhausted()
    return null
  }
  return result
}

/** Downloads Telegram media via GramJS and returns a base64 data URL, or null if not an image / too large. */
export async function tgMediaToDataUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { downloadMedia: (msg: any, opts: Record<string, never>) => Promise<unknown> },
  msg: unknown,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const media = (msg as any)?.media as Record<string, unknown> | undefined
  if (!media) return null
  const isPhoto    = media.className === 'MessageMediaPhoto'
  const docMime    = String((media.document as Record<string, unknown>)?.mimeType ?? '')
  const isImageDoc = media.className === 'MessageMediaDocument' && docMime.startsWith('image/')
  if (!isPhoto && !isImageDoc) return null

  const buffer = await client.downloadMedia(msg, {}) as Buffer | undefined
  if (!buffer || buffer.length < 500 || buffer.length > 5_000_000) return null

  const mimeType = isPhoto ? 'image/jpeg' : (docMime || 'image/jpeg')
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}
