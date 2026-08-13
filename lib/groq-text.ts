/**
 * Groq text completion — dual-key + full free-model fallback chain.
 *
 * Fallback order: for each model, try key 1 → key 2.
 * If both keys 429/503 on a model, move to the next model.
 * When ALL models × ALL keys are exhausted → TG alert fires (rate-limited 30 min).
 */

// All free Groq text models, ordered best → fastest
const GROQ_TEXT_CHAIN = [
  { model: 'llama-3.3-70b-versatile',           label: 'Groq/Llama3.3-70B'    },
  { model: 'openai/gpt-oss-120b',               label: 'Groq/GPT-OSS-120B'    },
  { model: 'openai/gpt-oss-20b',                label: 'Groq/GPT-OSS-20B'     },
  { model: 'allam-2-7b',                        label: 'Groq/Allam-2-7B'      },
]

function getGroqKeys(): string[] {
  const keys: string[] = []
  if (process.env.GROQ_API_KEY)   keys.push(process.env.GROQ_API_KEY)
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2)
  return keys
}

// Rate-limit exhaustion alert to once per 30 min (module-level; resets on cold start)
let lastExhaustAlertMs = 0

async function alertGroqExhausted(context: string) {
  const now = Date.now()
  if (now - lastExhaustAlertMs < 30 * 60_000) return
  lastExhaustAlertMs = now
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!token || !chatId) return
  const keyCount = getGroqKeys().length
  const msg = `⚠️ *Groq API Exhausted*\n\nAll ${keyCount} key(s) × ${GROQ_TEXT_CHAIN.length} models failed.\nContext: \`${context}\`\n\nAI signal classification is paused until quota resets (usually < 1 hour).\n\nAdd a 3rd key: \`GROQ_API_KEY_3\` in Vercel env vars, or wait for reset.`
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

/** Sends a single-turn prompt through the Groq dual-key + model fallback chain.
 *  Returns trimmed text or null if all keys × all models fail (fires TG alert on null). */
export async function groqTextComplete(
  prompt: string,
  maxTokens = 600,
  context = 'groq-text',
): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) {
    void alertGroqExhausted('no-keys-configured')
    return null
  }

  for (const { model, label } of GROQ_TEXT_CHAIN) {
    for (const key of keys) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 429 || res.status === 503) continue  // exhausted — try next key
        if (!res.ok) continue
        const data = await res.json() as { choices?: { message?: { content?: string } }[] }
        const text = data.choices?.[0]?.message?.content?.trim()
        if (text) return { text, model: label }
      } catch { /* timeout / network — try next key */ }
    }
  }

  void alertGroqExhausted(context)
  return null
}

/** Forces the fastest model (8B instant) — for latency-sensitive paths.
 *  Falls back to the full chain if 8B is also rate-limited. */
export async function groqFast(
  prompt: string,
  maxTokens = 400,
  context = 'groq-fast',
): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) return null

  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content?.trim()
      if (text) return { text, model: 'Groq/GPT-OSS-20B-fast' }
    } catch { /* try next key */ }
  }

  // All fast keys exhausted — fall back to full chain (will alert if that also fails)
  return groqTextComplete(prompt, maxTokens, context)
}
