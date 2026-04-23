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
  if (!url) return null

  // Fetch the image through JS so we get a blob: URL — this avoids canvas
  // tainting that would break captureStream() on cross-origin images.
  try {
    const response = await fetch(url, { mode: 'cors' })
    if (!response.ok) throw new Error(`Image fetch: ${response.status}`)

    const blob = await response.blob()
    if (!blob.size) throw new Error('Empty image blob')

    const objectUrl = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img) }
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null) }
      img.src = objectUrl
    })
  } catch {
    // No-cors fallback: load direct. Canvas may be tainted but captureStream usually still works.
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
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

function buildScreenshotSources(websiteUrl) {
  const encoded = encodeURIComponent(websiteUrl)
  // URLBox (ubx_sk_* keys) needs HMAC-signed tokens — skip them to avoid
  // the "Image not authorized" watermark image that still returns HTTP 200.
  // Use only truly free, no-auth services.
  return [
    // thum.io fullpage — best quality, free, no auth
    `https://image.thum.io/get/width/1280/fullpage/noanimate/${websiteUrl}`,
    `https://image.thum.io/get/width/1280/fullpage/noanimate/${encoded}`,
    // thum.io viewport fallback
    `https://image.thum.io/get/width/1280/${websiteUrl}`,
    // WordPress mshots — free, no auth
    `https://s.wordpress.com/mshots/v1/${encoded}?w=1280&h=960`,
    // pagepeeker — free tier, no auth
    `https://free.pagepeeker.com/v2/thumbs.php?size=x&url=${encoded}`,
  ]
}

async function resolveBackgroundImage(primaryUrl, fallbackUrl) {
  const cleanedPrimary = normalizeWebsiteUrl(primaryUrl)
  const cleanedFallback = normalizeWebsiteUrl(fallbackUrl)

  const sources = []

  if (cleanedPrimary) {
    for (const src of buildScreenshotSources(cleanedPrimary)) {
      sources.push(src)
    }
  }

  if (cleanedFallback) {
    for (const src of buildScreenshotSources(cleanedFallback)) {
      sources.push(src)
    }
  }

  for (const source of sources) {
    const image = await loadImage(source)
    if (image && image.width > 100) {
      return image
    }
  }

  return null
}

function smoothstep(t) {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * (3 - 2 * clamped)
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

  // Scale image to fill canvas width exactly (preserves full page height for scrolling)
  const scaleToWidth = width / backgroundImage.width
  const drawWidth = width
  const drawHeight = backgroundImage.height * scaleToWidth

  let offsetY = 0

  if (simulateScrolling && drawHeight > height) {
    // Scroll smoothly from top to near-bottom of the full page screenshot.
    // smoothstep easing gives a natural deceleration feel.
    const maxScroll = drawHeight - height
    // Scroll through 85% of the page so the bottom edge isn't abruptly cut off.
    offsetY = -(maxScroll * 0.85 * smoothstep(progress))
  } else if (!simulateScrolling) {
    // Center vertically when not scrolling
    offsetY = Math.min(0, (height - drawHeight) / 2)
  }

  ctx.drawImage(backgroundImage, 0, offsetY, drawWidth, drawHeight)
  ctx.fillStyle = 'rgba(7, 11, 22, 0.15)'
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
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ]
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
    const stream = canvas.captureStream(60)

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
      let done = false

      const finish = () => {
        if (done) return
        done = true
        if (raf) {
          cancelAnimationFrame(raf)
        }
        resolve()
      }

      const rafStep = () => {
        drawFrame()

        if (video.ended || video.currentTime >= duration) {
          finish()
          return
        }

        raf = requestAnimationFrame(rafStep)
      }

      if ('requestVideoFrameCallback' in video) {
        const frameStep = () => {
          drawFrame()

          if (video.ended || video.currentTime >= duration) {
            finish()
            return
          }

          video.requestVideoFrameCallback(frameStep)
        }
        video.requestVideoFrameCallback(frameStep)
      } else {
        raf = requestAnimationFrame(rafStep)
      }

      video.addEventListener('ended', finish, { once: true })
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
