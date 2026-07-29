/**
 * Groq vision OCR — free-tier image trade-signal extraction.
 * Dual-key fallback: tries key 1 → key 2 per model.
 * Models: llama-4-scout → llama-4-maverick → llama-3.2-90b-vision-preview
 * Fires TG alert if all keys × all models exhaust.
 */
const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
]

function getGroqKeys(): string[] {
  const keys: string[] = []
  if (process.env.GROQ_API_KEY)   keys.push(process.env.GROQ_API_KEY)
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2)
  return keys
}

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
      text: `⚠️ *Groq Vision Exhausted*\n\nAll keys × all vision models failed for image OCR.\nSignal images will be skipped until quota resets (< 1 hour).`,
      parse_mode: 'Markdown',
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

export async function groqVisionExtract(dataUrl: string, prompt: string): Promise<string | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) return null

  for (const model of GROQ_VISION_MODELS) {
    for (const key of keys) {
      try {
        const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
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
          signal: AbortSignal.timeout(15_000),
        })
        if (gr.status === 429 || gr.status === 503) continue  // exhausted — try next key
        if (!gr.ok) continue
        const gd = await gr.json() as { choices?: { message?: { content?: string } }[] }
        const out = gd.choices?.[0]?.message?.content?.trim() ?? 'NONE'
        if (out !== 'NONE' && out.includes('TICKER')) {
          console.log(`[IMG_OCR][groq:${model.split('/').pop()}] ${out}`)
          return out
        }
        return null  // model responded cleanly with NONE — no need to retry other models
      } catch { /* timeout / network — try next key */ }
    }
  }

  void alertVisionExhausted()
  return null
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
