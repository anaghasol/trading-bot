/**
 * Groq text completion — dual-key + multi-model fallback chain.
 *
 * Fallback order: for each model, try key 1 → key 2.
 * If both keys 429/503 on a model, move to the next model.
 * This ensures the intelligence cron + TG signal parser never go silent
 * even when one key hits its RPM/daily limit.
 */
const GROQ_TEXT_CHAIN = [
  { model: 'llama-3.3-70b-versatile', label: 'Groq/Llama3.3-70B' },
  { model: 'llama3-70b-8192',          label: 'Groq/Llama3-70B'   },
  { model: 'gemma2-9b-it',             label: 'Groq/Gemma2-9B'    },
  { model: 'llama-3.1-8b-instant',     label: 'Groq/Llama3.1-8B'  },
]

function getGroqKeys(): string[] {
  const keys: string[] = []
  if (process.env.GROQ_API_KEY)   keys.push(process.env.GROQ_API_KEY)
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2)
  return keys
}

/** Sends a single-turn prompt through the Groq dual-key + model fallback chain.
 *  Returns trimmed text or null if all keys × all models fail. */
export async function groqTextComplete(prompt: string, maxTokens = 600): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) return null

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
  return null
}

/** Same as groqTextComplete but forces the fastest model (8B) — for latency-sensitive paths. */
export async function groqFast(prompt: string, maxTokens = 400): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) return null

  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content?.trim()
      if (text) return { text, model: 'Groq/Llama3.1-8B-fast' }
    } catch { /* try next key */ }
  }
  // Fallback to full chain
  return groqTextComplete(prompt, maxTokens)
}
