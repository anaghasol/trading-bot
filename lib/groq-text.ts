/**
 * Groq text completion — free-tier sequential fallback chain.
 * Drops to the next model on 429/503 so a single rate-limited model
 * doesn't block the call. No paid fallback — Groq only.
 */
const GROQ_TEXT_CHAIN = [
  { model: 'llama-3.3-70b-versatile', label: 'Groq/Llama3.3-70B' },
  { model: 'llama3-70b-8192',          label: 'Groq/Llama3-70B'   },
  { model: 'gemma2-9b-it',             label: 'Groq/Gemma2-9B'    },
  { model: 'llama-3.1-8b-instant',     label: 'Groq/Llama3.1-8B'  },
]

/** Sends a single-turn prompt through the Groq fallback chain. Returns trimmed text or null if all models fail. */
export async function groqTextComplete(prompt: string, maxTokens = 600): Promise<{ text: string; model: string } | null> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return null

  for (const { model, label } of GROQ_TEXT_CHAIN) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) continue   // 429/503 → try next model
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content?.trim()
      if (text) return { text, model: label }
    } catch { /* try next model */ }
  }
  return null
}
