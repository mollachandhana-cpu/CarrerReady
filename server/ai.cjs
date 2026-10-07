'use strict'
/* One place for every AI call. Works with Google Gemini (free tier available) or OpenAI.
   Gemini is used when GEMINI_API_KEY is set, otherwise OpenAI when OPENAI_API_KEY is set.
   Provider error messages are logged on the server only: they can echo part of your key, so users never see them. */
const provider = () => (process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : null)
const enabled = () => provider() !== null

async function askText(prompt) {
  try { return await askTextInner(prompt) } catch (err) {
    if (!err.status && err.code !== 'NO_AI') console.error('[ai] request failed before a response:', err.name, err.message, err.cause?.code || err.cause?.message || '')
    throw err
  }
}

async function askTextInner(prompt) {
  const which = provider()
  if (!which) throw Object.assign(new Error('AI is not configured.'), { code: 'NO_AI' })
  const signal = AbortSignal.timeout(30000)
  let r, data
  if (which === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
    })
    data = await r.json().catch(() => ({}))
    if (!r.ok) { console.error('[ai] Gemini error', r.status, data.error?.message || ''); throw Object.assign(new Error('AI provider error'), { status: r.status }) }
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
  }
  r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5.6-luna', input: prompt }),
  })
  data = await r.json().catch(() => ({}))
  if (!r.ok) { console.error('[ai] OpenAI error', r.status, data.error?.message || ''); throw Object.assign(new Error('AI provider error'), { status: r.status }) }
  return data.output_text || (data.output || []).flatMap((x) => x.content || []).map((x) => x.text || '').join('')
}

// Models sometimes wrap JSON in ```json fences; strip them before parsing.
const parseJson = (text) => JSON.parse(String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim())

// Friendly message for the user, based on the provider's HTTP status.
function userMessage(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'The AI provider timed out. Please try again.'
  if (err.status === 429) return 'The AI service is busy or its free quota is used up. Please try again later.'
  if (err.status === 404) return 'The AI model name was not found. The site owner needs to set GEMINI_MODEL to a model that exists.'
  if (err.status === 401 || err.status === 403 || err.status === 400) return 'The AI service is not set up correctly. The site owner needs to check the API key and model name.'
  if (err.status >= 500) return 'The AI provider is having problems. Please try again in a minute.'
  return 'Could not reach the AI provider.'
}

module.exports = { enabled, provider, askText, parseJson, userMessage }
