function waitForMediaReady(media) {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup()
      resolve()
    }

    const onError = () => {
      cleanup()
      reject(new Error('Unable to load media source for rendering.'))
    }

    const cleanup = () => {
      media.removeEventListener('loadedmetadata', onReady)
      media.removeEventListener('canplay', onReady)
      media.removeEventListener('error', onError)
    }

    media.addEventListener('loadedmetadata', onReady)
    media.addEventListener('canplay', onReady)
    media.addEventListener('error', onError)
  })
}

function getBubblePlacement(position, width, height) {
  const size = Math.min(width, height) * 0.22
  const margin = 36

  if (position === 'top-left') {
    return { x: margin, y: margin, size }
  }

  if (position === 'top-right') {
    return { x: width - size - margin, y: margin, size }
  }

  if (position === 'bottom-right') {
    return { x: width - size - margin, y: height - size - margin - 150, size }
  }

  return { x: margin, y: height - size - margin - 150, size }
}

async function loadImage(url) {
  if (!url) {
    return null
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error('Screenshot fetch failed.')
    }

    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)

    return await new Promise((resolve) => {
      const image = new Image()
      image.onload = () => {
        URL.revokeObjectURL(objectUrl)
        resolve(image)
      }
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl)
        resolve(null)
      }
      image.src = objectUrl
    })
  } catch {
    return new Promise((resolve) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => resolve(null)
      image.src = url
    })
  }
}

function normalizeWebsiteUrl(url) {
  const value = String(url || '').trim()
  if (!value) {
    return ''
  }

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  return `https://${value}`
}

function buildCustomScreenshotSource(url) {
  const template = String(import.meta.env.VITE_SCREENSHOT_API_TEMPLATE || '').trim()
  if (!template) {
    return ''
  }

  return template.replace('{url}', encodeURIComponent(url))
}

async function resolveBackgroundImage(primaryUrl, fallbackUrl) {
  const cleanedPrimary = normalizeWebsiteUrl(primaryUrl)
  const cleanedFallback = normalizeWebsiteUrl(fallbackUrl)

  const sources = []
  if (cleanedPrimary) {
    const customPrimary = buildCustomScreenshotSource(cleanedPrimary)
    if (customPrimary) {
      sources.push(customPrimary)
    }
    sources.push(`https://image.thum.io/get/width/1920/noanimate/${cleanedPrimary}`)
    sources.push(`https://image.thum.io/get/width/1920/noanimate/${encodeURIComponent(cleanedPrimary)}`)
    sources.push(`https://mini.s-shot.ru/1920x1080/JPEG/1920/Z100/?${encodeURIComponent(cleanedPrimary)}`)
    sources.push(`https://s.wordpress.com/mshots/v1/${encodeURIComponent(cleanedPrimary)}?w=1920`)
  }

  if (cleanedFallback) {
    const customFallback = buildCustomScreenshotSource(cleanedFallback)
    if (customFallback) {
      sources.push(customFallback)
    }
    sources.push(`https://image.thum.io/get/width/1920/noanimate/${cleanedFallback}`)
    sources.push(`https://image.thum.io/get/width/1920/noanimate/${encodeURIComponent(cleanedFallback)}`)
    sources.push(`https://mini.s-shot.ru/1920x1080/JPEG/1920/Z100/?${encodeURIComponent(cleanedFallback)}`)
    sources.push(`https://s.wordpress.com/mshots/v1/${encodeURIComponent(cleanedFallback)}?w=1920`)
  }

  for (const source of sources) {
    const image = await loadImage(source)
    if (image) {
      return image
    }
  }

  return null
}

function drawBackground(ctx, canvas, backgroundImage, simulateScrolling, progress) {
  const { width, height } = canvas

  if (!backgroundImage) {
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#0a1a38')
    gradient.addColorStop(0.5, '#10294d')
    gradient.addColorStop(1, '#1e2f57')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    return
  }

  const imageRatio = backgroundImage.width / backgroundImage.height
  const canvasRatio = width / height

  let drawWidth = width
  let drawHeight = height
  if (imageRatio > canvasRatio) {
    drawHeight = height
    drawWidth = drawHeight * imageRatio
  } else {
    drawWidth = width
    drawHeight = drawWidth / imageRatio
  }

  let offsetX = (width - drawWidth) / 2
  let offsetY = (height - drawHeight) / 2

  if (simulateScrolling) {
    const maxShift = Math.max(0, drawHeight - height)
    offsetY = -maxShift * progress
  }

  ctx.drawImage(backgroundImage, offsetX, offsetY, drawWidth, drawHeight)
  ctx.fillStyle = 'rgba(7, 11, 22, 0.2)'
  ctx.fillRect(0, 0, width, height)
}

async function createAudioTrackFromBlob(audioBlob) {
  const Context = window.AudioContext || window.webkitAudioContext
  const context = new Context()

  const data = await audioBlob.arrayBuffer()
  const decoded = await context.decodeAudioData(data.slice(0))

  const source = context.createBufferSource()
  source.buffer = decoded

  const gain = context.createGain()
  gain.gain.value = 1

  const destination = context.createMediaStreamDestination()
  source.connect(gain)
  gain.connect(destination)

  return {
    track: destination.stream.getAudioTracks()[0],
    start: () => source.start(0),
    cleanup: async () => {
      source.disconnect()
      gain.disconnect()
      if (context.state !== 'closed') {
        await context.close()
      }
    },
  }
}

function getRecorderMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

export async function renderDynamicVideo(options) {
  const {
    sourceBlob,
    dynamicBackground,
    backgroundUrl,
    fallbackUrl,
    bubblePosition,
    simulateScrolling,
    personalizedAudioBlob,
    onProgress,
  } = options

  if (!sourceBlob) {
    throw new Error('No source video provided for rendering.')
  }

  const sourceUrl = URL.createObjectURL(sourceBlob)
  const video = document.createElement('video')
  video.src = sourceUrl
  video.crossOrigin = 'anonymous'
  video.playsInline = true
  video.preload = 'auto'

  try {
    await waitForMediaReady(video)

    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')

    const backgroundImage = dynamicBackground
      ? await resolveBackgroundImage(backgroundUrl, fallbackUrl)
      : null

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8
    const stream = canvas.captureStream(30)

    let externalAudioTrack = null
    let audioStarter = null
    let audioCleanup = async () => {}
    let sourceStream = null

    if (personalizedAudioBlob) {
      const generatedAudio = await createAudioTrackFromBlob(personalizedAudioBlob)
      externalAudioTrack = generatedAudio.track
      audioStarter = generatedAudio.start
      audioCleanup = generatedAudio.cleanup
      video.muted = true
    } else {
      sourceStream = video.captureStream()
      externalAudioTrack = sourceStream.getAudioTracks()[0] || null
      video.muted = false
      video.volume = 1
    }

    const tracks = [stream.getVideoTracks()[0]]
    if (externalAudioTrack) {
      tracks.push(externalAudioTrack)
    }

    const combined = new MediaStream(tracks)
    const mimeType = getRecorderMimeType()
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined)

    const chunks = []
    const outputBlobPromise = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      recorder.onerror = () => reject(new Error('Failed while recording dynamic video output.'))
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
        resolve(blob)
      }
    })

    const drawFrame = () => {
      const progress = Math.min(1, video.currentTime / duration)

      if (dynamicBackground) {
        drawBackground(ctx, canvas, backgroundImage, simulateScrolling, progress)

        const placement = getBubblePlacement(bubblePosition, canvas.width, canvas.height)
        ctx.save()
        ctx.beginPath()
        ctx.arc(
          placement.x + placement.size / 2,
          placement.y + placement.size / 2,
          placement.size / 2,
          0,
          Math.PI * 2,
        )
        ctx.closePath()
        ctx.clip()
        ctx.drawImage(video, placement.x, placement.y, placement.size, placement.size)
        ctx.restore()
      } else {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      }

      onProgress?.(progress)
    }

    recorder.start(250)
    if (audioStarter) {
      audioStarter()
    }

    await video.play()

    await new Promise((resolve) => {
      let raf = null

      const step = () => {
        drawFrame()

        if (video.ended || video.currentTime >= duration) {
          resolve()
          return
        }

        raf = requestAnimationFrame(step)
      }

      raf = requestAnimationFrame(step)

      video.addEventListener(
        'ended',
        () => {
          if (raf) {
            cancelAnimationFrame(raf)
          }
          resolve()
        },
        { once: true },
      )
    })

    drawFrame()

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }

    const outputBlob = await outputBlobPromise
    await audioCleanup()

    return outputBlob
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}
