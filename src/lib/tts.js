// Free TTS via Hugging Face Inference API — no API key required (rate-limited public access).
// Models are tried in priority order; first successful response wins.
const HF_MODELS = [
  'facebook/mms-tts-eng',
  'espnet/kan-bayashi_ljspeech_vits',
  'kakao-enterprise/vits-ljs',
]

async function tryHuggingFaceTTS(text, model) {
  const endpoint = `https://api-inference.huggingface.co/models/${model}`
  const body = JSON.stringify({ inputs: text, options: { wait_for_model: true } })
  const headers = { 'Content-Type': 'application/json' }

  const response = await fetch(endpoint, { method: 'POST', headers, body })

  if (response.status === 503) {
    // Model is cold — wait then retry once with an extended timeout
    await new Promise((resolve) => setTimeout(resolve, 10000))
    const retry = await fetch(endpoint, { method: 'POST', headers, body })
    if (!retry.ok) {
      throw new Error(`HuggingFace TTS model ${model} returned ${retry.status}.`)
    }
    const retryBlob = await retry.blob()
    if (!retryBlob.size) throw new Error('Empty audio from retry.')
    return new Blob([await retryBlob.arrayBuffer()], { type: 'audio/wav' })
  }

  if (!response.ok) {
    throw new Error(`HuggingFace TTS model ${model} returned ${response.status}.`)
  }

  const blob = await response.blob()
  if (!blob.size) throw new Error('Empty audio response.')

  return new Blob([await blob.arrayBuffer()], { type: 'audio/wav' })
}

export async function synthesizeSpeechFromText(text) {
  const content = String(text || '').trim()

  if (!content) {
    throw new Error('Cannot generate speech for empty text.')
  }

  let lastError = null

  for (const model of HF_MODELS) {
    try {
      return await tryHuggingFaceTTS(content, model)
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(
    lastError?.message || 'All free TTS providers failed. Check your network connection.',
  )
}
