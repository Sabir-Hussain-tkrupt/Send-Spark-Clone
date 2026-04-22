const DEFAULT_VOICES = ['Joanna', 'Brian', 'Amy']

export async function synthesizeSpeechFromText(text, preferredVoice = 'Joanna') {
  const content = String(text || '').trim()

  if (!content) {
    throw new Error('Cannot generate speech for empty text.')
  }

  const voices = [preferredVoice, ...DEFAULT_VOICES.filter((voice) => voice !== preferredVoice)]

  let lastError = null
  for (const voice of voices) {
    try {
      const endpoint = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(
        voice,
      )}&text=${encodeURIComponent(content)}`

      const response = await fetch(endpoint)
      if (!response.ok) {
        throw new Error(`TTS request failed with status ${response.status}.`)
      }

      const data = await response.arrayBuffer()
      if (!data.byteLength) {
        throw new Error('TTS returned an empty audio file.')
      }

      return new Blob([data], { type: 'audio/mpeg' })
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(lastError?.message || 'Unable to generate speech with external TTS providers.')
}
