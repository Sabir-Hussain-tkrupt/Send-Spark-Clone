/**
 * TTS via Sound of Text (soundoftext.com) — free, browser-safe, uses Google voices.
 * Falls back to HuggingFace MMS if SOT is unavailable.
 */

const SOT_API = 'https://api.soundoftext.com/sounds'
const SOT_MAX_CHARS = 480

async function trySoundOfText(text) {
  const safeText = text.slice(0, SOT_MAX_CHARS)

  const createRes = await fetch(SOT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'Google', data: { text: safeText, voice: 'en-US' } }),
  })

  if (!createRes.ok) throw new Error(`Sound of Text create failed (${createRes.status}).`)

  const { id, success } = await createRes.json()
  if (!success || !id) throw new Error('Sound of Text returned no task ID.')

  // Poll up to ~18 s for completion
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 1500))

    const statusRes = await fetch(`${SOT_API}/${id}`)
    if (!statusRes.ok) continue

    const { status, location } = await statusRes.json()

    if (status === 'Done' && location) {
      const audioRes = await fetch(location)
      if (!audioRes.ok) throw new Error('Sound of Text audio download failed.')

      const buffer = await audioRes.arrayBuffer()
      if (!buffer.byteLength) throw new Error('Sound of Text returned empty audio.')

      return new Blob([buffer], { type: 'audio/mpeg' })
    }

    if (status === 'Error') throw new Error('Sound of Text generation error.')
  }

  throw new Error('Sound of Text timed out waiting for audio.')
}

async function tryHuggingFaceTTS(text) {
  const model = 'facebook/mms-tts-eng'
  const endpoint = `https://api-inference.huggingface.co/models/${model}`
  const body = JSON.stringify({ inputs: text.slice(0, 500), options: { wait_for_model: true } })

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!res.ok) throw new Error(`HuggingFace TTS returned ${res.status}.`)

  const blob = await res.blob()
  if (!blob.size) throw new Error('HuggingFace TTS returned empty audio.')

  return new Blob([await blob.arrayBuffer()], { type: 'audio/wav' })
}

export async function synthesizeSpeechFromText(text) {
  const content = String(text || '').trim()
  if (!content) throw new Error('Cannot synthesize empty text.')

  // Try Sound of Text first (browser-safe, free, no CORS issues)
  try {
    return await trySoundOfText(content)
  } catch (sotError) {
    console.warn('[TTS] Sound of Text failed:', sotError.message)
  }

  // Fallback: HuggingFace MMS TTS
  try {
    return await tryHuggingFaceTTS(content)
  } catch (hfError) {
    console.warn('[TTS] HuggingFace TTS failed:', hfError.message)
  }

  throw new Error('All TTS providers failed. The video will use original audio instead.')
}
