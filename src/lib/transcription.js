let transcriberPromise = null

function getAudioContext() {
  const Context = window.AudioContext || window.webkitAudioContext
  if (!Context) {
    throw new Error('Web Audio API is not available in this browser.')
  }

  return new Context()
}

async function decodeVideoAudio(blob) {
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

    return { samples: mono, sampleRate: decoded.sampleRate }
  } finally {
    if (context.state !== 'closed') {
      await context.close()
    }
  }
}

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { env, pipeline } = await import('@xenova/transformers')
      env.allowLocalModels = false
      env.allowRemoteModels = true
      env.useBrowserCache = true

      return pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en')
    })()
  }

  return transcriberPromise
}

export async function transcribeVideoBlob(blob) {
  if (!blob) {
    throw new Error('No video blob was provided for transcription.')
  }

  const { samples, sampleRate } = await decodeVideoAudio(blob)
  const transcriber = await getTranscriber()

  const result = await transcriber(samples, {
    sampling_rate: sampleRate,
    chunk_length_s: 20,
    stride_length_s: 4,
    task: 'transcribe',
    language: 'english',
  })

  return String(result?.text || '').trim()
}
