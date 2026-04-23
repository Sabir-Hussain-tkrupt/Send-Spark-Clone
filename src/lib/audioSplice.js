import { synthesizeSpeechFromText } from './tts'
import { keywordExistsFuzzy } from './template'

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

function audioBufferToWavBlob(buffer) {
  const numCh = buffer.numberOfChannels
  const sr = buffer.sampleRate
  const len = buffer.length
  const bps = 16
  const blockAlign = numCh * (bps / 8)
  const dataSize = len * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const view = new DataView(ab)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)               // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, sr * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bps, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([ab], { type: 'audio/wav' })
}

/** Linear-interpolation resampler: converts Float32Array from srcSR → dstSR */
function resample(data, srcSR, dstSR) {
  if (srcSR === dstSR) return data
  const ratio = srcSR / dstSR
  const outLen = Math.round(data.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(lo + 1, data.length - 1)
    out[i] = data[lo] + (data[hi] - data[lo]) * (src - lo)
  }
  return out
}

/**
 * Finds the word chunk that best matches the keyword and returns its timestamps.
 * Returns null if not found.
 */
function findKeywordChunk(wordChunks, keyword) {
  for (const chunk of wordChunks) {
    if (keywordExistsFuzzy(chunk.word, keyword)) {
      return chunk
    }
  }
  return null
}

/**
 * Splices TTS audio of `nameText` into `sourceBlob` at the position of the
 * keyword word found in `wordChunks`.
 *
 * Returns a WAV Blob if successful, or null if the keyword wasn't found.
 */
export async function spliceNameIntoAudio(sourceBlob, wordChunks, keyword, nameText) {
  const keywordChunk = findKeywordChunk(wordChunks, keyword)
  if (!keywordChunk) return null

  const AudioContext = window.AudioContext || window.webkitAudioContext
  const ctx = new AudioContext()

  try {
    // Decode original video audio
    const origBuffer = await sourceBlob.arrayBuffer()
    const origAudio = await ctx.decodeAudioData(origBuffer.slice(0))

    // Generate TTS for just the name (short, fast)
    const nameTTSBlob = await synthesizeSpeechFromText(nameText)
    const nameBuffer = await nameTTSBlob.arrayBuffer()
    const nameAudio = await ctx.decodeAudioData(nameBuffer.slice(0))

    const sr = origAudio.sampleRate
    const numCh = origAudio.numberOfChannels
    const startSample = Math.floor(keywordChunk.start * sr)
    const endSample = Math.floor(keywordChunk.end * sr)

    // Resample name audio to match original sample rate
    const nameResampled = resample(nameAudio.getChannelData(0), nameAudio.sampleRate, sr)
    const nameSamples = nameResampled.length

    const totalLen = startSample + nameSamples + Math.max(0, origAudio.length - endSample)
    const outBuffer = ctx.createBuffer(numCh, totalLen, sr)

    for (let ch = 0; ch < numCh; ch++) {
      const origData = origAudio.getChannelData(ch)
      const out = outBuffer.getChannelData(ch)

      // Pre-keyword: original audio unchanged
      out.set(origData.slice(0, startSample), 0)

      // Name TTS (resampled from channel 0 of TTS, or per-channel if stereo)
      const nameChData = nameAudio.numberOfChannels > ch
        ? resample(nameAudio.getChannelData(ch), nameAudio.sampleRate, sr)
        : nameResampled
      out.set(nameChData.slice(0, nameSamples), startSample)

      // Post-keyword: original audio resumed
      const postSlice = origData.slice(endSample, origAudio.length)
      out.set(postSlice, startSample + nameSamples)
    }

    return audioBufferToWavBlob(outBuffer)
  } finally {
    if (ctx.state !== 'closed') await ctx.close()
  }
}
