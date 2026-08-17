/**
 * AI text completion — multi-provider fallback chain. Never exhausts.
 *
 * Tier 1 — Groq (fastest, free): gpt-oss-120b → gpt-oss-20b → allam-2-7b
 *   llama-3.3-70b-versatile was Groq's best free model until they retired it 2026-08-17.
 *           Try GROQ_API_KEY then GROQ_API_KEY_2 per model.
 * Tier 2 — OpenRouter free (OPENROUTER_API_KEY): Llama3.3 → Gemini-2.0 → Qwen2.5 → Mistral
 * Tier 3 — Gemini direct (GEMINI_API_KEY): gemini-2.0-flash-exp → gemini-1.5-flash (truly free)
 *
 * When ALL tiers fail → TG alert fires (rate-limited 30 min).
 */

// ── Tier 1: Groq ──────────────────────────────────────────────────────────────

const GROQ_CHAIN = [
  { model: 'openai/gpt-oss-120b',     label: 'Groq/GPT-OSS-120B'   },
  { model: 'openai/gpt-oss-20b',      label: 'Groq/GPT-OSS-20B'    },
  { model: 'allam-2-7b',              label: 'Groq/Allam-2-7B'      },
]

function getGroqKeys(): string[] {
  const keys: string[] = []
  if (process.env.GROQ_API_KEY)   keys.push(process.env.GROQ_API_KEY)
  if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2)
  return keys
}

async function tryGroq(prompt: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  if (keys.length === 0) return null
  for (const { model, label } of GROQ_CHAIN) {
    for (const key of keys) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 429 || res.status === 503) continue
        if (!res.ok) continue
        const data = await res.json() as { choices?: { message?: { content?: string } }[] }
        const text = data.choices?.[0]?.message?.content?.trim()
        if (text) return { text, model: label }
      } catch { /* timeout / network */ }
    }
  }
  return null
}

// ── Tier 2: OpenRouter free models ───────────────────────────────────────────

// Verified live 2026-08-17. The previous chain was ENTIRELY dead — all five ids
// ('meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.0-flash-exp:free',
// 'qwen/qwen-2.5-72b-instruct:free', 'mistralai/mistral-7b-instruct:free',
// 'deepseek/deepseek-chat:free') 404 with either "unavailable for free" or
// "no endpoints found", so tier 2 had silently stopped existing.
// gemma-4-26b leads: it is the only free model that stays clean at max_tokens:3
// as well as at generation budgets. The rest emit a reasoning preamble under
// tight budgets, which is fine here only because callers pass real budgets.
const OR_FREE_CHAIN = [
  { model: 'google/gemma-4-26b-a4b-it:free',          label: 'OR/Gemma-4-26B'      },
  { model: 'openrouter/free',                          label: 'OR/Auto-Free'        },
  { model: 'nvidia/nemotron-3-super-120b-a12b:free',   label: 'OR/Nemotron-Super'   },
  { model: 'nvidia/nemotron-3-ultra-550b-a55b:free',   label: 'OR/Nemotron-Ultra'   },
]

async function tryOpenRouter(prompt: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  for (const { model, label } of OR_FREE_CHAIN) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mytrade.app' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content?.trim()
      if (text) return { text, model: label }
    } catch { /* timeout / network */ }
  }
  return null
}

// ── Tier 3: Google Gemini (free direct API) ───────────────────────────────────

// Confirmed working + fast free Gemini models (tested Aug 2026 — 3.7/3.6 timeout on reasoning)
const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
]

async function tryGemini(prompt: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY
  if (!key) return null
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens },
          }),
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      if (text) return { text, model: `Gemini/${model}` }
    } catch { /* timeout / network */ }
  }
  return null
}

// ── Exhaust alert ─────────────────────────────────────────────────────────────

let lastExhaustAlertMs = 0

async function alertAllExhausted(context: string) {
  const now = Date.now()
  if (now - lastExhaustAlertMs < 30 * 60_000) return
  lastExhaustAlertMs = now
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!token || !chatId) return
  const tiers = [
    getGroqKeys().length > 0 ? `Groq (${getGroqKeys().length} keys × ${GROQ_CHAIN.length} models)` : null,
    process.env.OPENROUTER_API_KEY ? `OpenRouter (${OR_FREE_CHAIN.length} free models)` : null,
    (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY) ? `Gemini (${GEMINI_MODELS.length} models)` : null,
  ].filter(Boolean).join(' → ')
  const msg = `🚨 *All AI Providers Exhausted*\n\nTried: ${tiers || 'none configured'}\nContext: \`${context}\`\n\nAI classification paused. Add GEMINI_API_KEY or OPENROUTER_API_KEY if not set. Quota usually resets in < 1 hour.`
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Multi-provider text completion: Groq → OpenRouter → Gemini.
 *  Returns null only if every configured provider fails (fires TG alert). */
export async function groqTextComplete(
  prompt: string,
  maxTokens = 600,
  context = 'groq-text',
): Promise<{ text: string; model: string } | null> {
  const result =
    await tryGroq(prompt, maxTokens) ??
    await tryOpenRouter(prompt, maxTokens) ??
    await tryGemini(prompt, maxTokens)

  if (!result) void alertAllExhausted(context)
  return result
}

/** Fast path: tries the smallest/fastest model first, falls back to full chain. */
export async function groqFast(
  prompt: string,
  maxTokens = 400,
  context = 'groq-fast',
): Promise<{ text: string; model: string } | null> {
  const keys = getGroqKeys()
  // Try the fastest Groq model first
  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 429 || res.status === 503) continue
      if (!res.ok) continue
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content?.trim()
      if (text) return { text, model: 'Groq/GPT-OSS-20B-fast' }
    } catch { /* try next */ }
  }
  // Fell through — use full multi-provider chain
  return groqTextComplete(prompt, maxTokens, context)
}
