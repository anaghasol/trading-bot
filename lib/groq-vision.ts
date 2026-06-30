/**
 * Groq vision OCR — free-tier image trade-signal extraction.
 * Tries llama-4-scout first, falls back to llama-4-maverick on 429/503/error.
 * No paid vision fallback — Groq only.
 */
const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
]

export async function groqVisionExtract(dataUrl: string, prompt: string): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return null
  for (const model of GROQ_VISION_MODELS) {
    try {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
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
      })
      if (!gr.ok) continue   // 429/503 → try next model
      const gd = await gr.json() as { choices?: { message?: { content?: string } }[] }
      const out = gd.choices?.[0]?.message?.content?.trim() ?? 'NONE'
      if (out !== 'NONE' && out.includes('TICKER')) {
        console.log(`[IMG_OCR][groq:${model.split('/')[1]}] ${out}`)
        return out
      }
      return null   // model responded cleanly with NONE — no need to retry
    } catch { /* try next model */ }
  }
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
