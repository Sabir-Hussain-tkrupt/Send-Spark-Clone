const transcriberCache = new Map()

function getAudioContext() {
  const Context = window.AudioContext || window.webkitAudioContext
  if (!Context) throw new Error('Web Audio API is not available in this browser.')
  return new Context()
}

export async function decodeVideoAudio(blob) {
  const context = getAudioContext()
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0))

    const channels = decoded.numberOfChannels
    const length = decoded.length
    const mono = new Float32Array(length)

    if (channels === 1) {
      mono.set(decoded.getChannelData(0))
    } else {
      for (let channel = 0; channel < channels; channel += 1) {
        const source = decoded.getChannelData(channel)
        for (let i = 0; i < length; i += 1) {
          mono[i] += source[i] / channels
        }
      }
    }

    return { samples: mono, sampleRate: decoded.sampleRate, decoded }
  } finally {
    if (context.state !== 'closed') await context.close()
  }
}

async function getTranscriber(modelName) {
  const key = modelName || 'Xenova/whisper-base.en'
  if (!transcriberCache.has(key)) {
    const promise = (async () => {
      const { env, pipeline } = await import('@xenova/transformers')
      env.allowLocalModels = false
      env.allowRemoteModels = true
      env.useBrowserCache = true
      return pipeline('automatic-speech-recognition', key)
    })()
    transcriberCache.set(key, promise)
  }
  return transcriberCache.get(key)
}

/**
 * Returns { text, wordChunks } where wordChunks is an array of
 * { word: string, start: number, end: number } with timestamps in seconds.
 */
export async function transcribeVideoBlob(blob) {
  if (!blob) throw new Error('No video blob provided for transcription.')

  const { samples, sampleRate } = await decodeVideoAudio(blob)

  const modelCandidates = ['Xenova/whisper-base.en', 'Xenova/whisper-tiny.en']

  for (const modelName of modelCandidates) {
    try {
      const transcriber = await getTranscriber(modelName)

      const result = await transcriber(samples, {
        sampling_rate: sampleRate,
        chunk_length_s: 20,
        stride_length_s: 4,
        task: 'transcribe',
        language: 'english',
        return_timestamps: 'word',
      })

      const text = String(result?.text || '').trim()
      if (!text) continue

      // Flatten word-level chunks from either result.chunks or result.words
      const rawChunks = result?.chunks || []
      const wordChunks = rawChunks
        .filter((c) => c.timestamp && c.timestamp.length === 2)
        .map((c) => ({
          word: String(c.text || '').trim(),
          start: Number(c.timestamp[0]) || 0,
          end: Number(c.timestamp[1]) || 0,
        }))
        .filter((c) => c.word)

      return { text, wordChunks }
    } catch {
      // Try next model
    }
  }

  return { text: '', wordChunks: [] }
}
