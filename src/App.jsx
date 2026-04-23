import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatDuration,
  getBlobDuration,
  getCameraStream,
  getScreenAndMicStream,
  getSupportedMimeType,
  isMediaRecordingSupported,
  stopAudioContext,
  stopStream,
} from './lib/media'
import {
  addVideoRecord,
  deleteVideoRecord,
  listVideoRecords,
  revokeVideoUrls,
} from './lib/videoStore'
import {
  applyTemplate,
  createEmptyContact,
  normalizeContact,
  replaceKeywordWithFirstName,
} from './lib/template'
import { transcribeVideoBlob } from './lib/transcription'
import { synthesizeSpeechFromText } from './lib/tts'
import { renderDynamicVideo } from './lib/dynamicVideo'

const VIEWS = {
  HOME: 'home',
  LIBRARY: 'library',
  DYNAMIC: 'dynamic',
}

const STEPS = ['Video', 'Background', 'Landing Page', 'Contacts', 'Output']
const FIXED_PERSONALIZATION_KEYWORD = 'someone'

function buildVideoName(source) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${source}-${stamp}.webm`
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function ToggleSwitch({ checked, onToggle, disabled = false }) {
  return (
    <button
      type="button"
      className={checked ? 'toggle-switch on' : 'toggle-switch'}
      onClick={() => {
        if (!disabled) {
          onToggle(!checked)
        }
      }}
      aria-pressed={checked}
      disabled={disabled}
    >
      <span className="toggle-knob" />
      <span className="toggle-text">{checked ? 'ON' : 'OFF'}</span>
    </button>
  )
}

function revokeGeneratedVideoUrls(records) {
  records.forEach((record) => {
    if (record.previewUrl) {
      URL.revokeObjectURL(record.previewUrl)
    }
  })
}

function App() {
  const [view, setView] = useState(VIEWS.HOME)
  const [videos, setVideos] = useState([])
  const [status, setStatus] = useState('Loading videos...')
  const [error, setError] = useState('')
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [uploadContext, setUploadContext] = useState('general')
  const [recordContext, setRecordContext] = useState('general')
  const [recordChoiceOpen, setRecordChoiceOpen] = useState(false)
  const [recordMode, setRecordMode] = useState(null)
  const [deleteCandidate, setDeleteCandidate] = useState(null)

  const [dynamicSelectedId, setDynamicSelectedId] = useState(null)
  const [dynamicStep, setDynamicStep] = useState(1)
  const [dynamicConfigOpen, setDynamicConfigOpen] = useState(false)

  const [namePersonalization, setNamePersonalization] = useState(true)
  const [detectedTranscript, setDetectedTranscript] = useState('')

  const [dynamicBackgroundEnabled, setDynamicBackgroundEnabled] = useState(true)
  const [fallbackUrl, setFallbackUrl] = useState('')
  const [bubblePosition, setBubblePosition] = useState('bottom-left')
  const [simulateScrolling, setSimulateScrolling] = useState(true)

  const [headerTemplate, setHeaderTemplate] = useState('')
  const [messageTemplate, setMessageTemplate] = useState('')
  const [ctaText, setCtaText] = useState('')
  const [ctaUrl, setCtaUrl] = useState('')
  const [mergePopup, setMergePopup] = useState(null) // 'header' | 'message' | null

  const headerRef = useRef(null)
  const messageRef = useRef(null)
  const headerSelRef = useRef({ start: 0, end: 0 })
  const messageSelRef = useRef({ start: 0, end: 0 })

  const [contacts, setContacts] = useState([createEmptyContact()])
  const [generatedVideos, setGeneratedVideos] = useState([])
  const [selectedGeneratedId, setSelectedGeneratedId] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationProgress, setGenerationProgress] = useState('')
  const [generationPercent, setGenerationPercent] = useState(0)
  const [retryingIds, setRetryingIds] = useState(new Set())

  const uploadRef = useRef(null)

  const dynamicSelectedVideo = useMemo(
    () => videos.find((video) => video.id === dynamicSelectedId) || null,
    [dynamicSelectedId, videos],
  )

  const selectedGeneratedVideo = useMemo(
    () => generatedVideos.find((item) => item.id === selectedGeneratedId) || generatedVideos[0] || null,
    [generatedVideos, selectedGeneratedId],
  )

  useEffect(() => {
    let mounted = true

    const loadVideos = async () => {
      try {
        setStatus('Loading videos...')
        const loaded = await listVideoRecords()

        if (!mounted) {
          revokeVideoUrls(loaded)
          return
        }

        setVideos((previous) => {
          revokeVideoUrls(previous)
          return loaded
        })
        setStatus(loaded.length ? '' : 'No videos yet. Record or upload your first one.')
      } catch (loadError) {
        if (!mounted) return
        setError(loadError.message || 'Unable to load videos from local storage.')
      }
    }

    loadVideos()

    return () => {
      mounted = false
      setVideos((previous) => {
        revokeVideoUrls(previous)
        return []
      })
      setGeneratedVideos((previous) => {
        revokeGeneratedVideoUrls(previous)
        return []
      })
    }
  }, [])

  useEffect(() => {
    if (dynamicSelectedId && !videos.some((item) => item.id === dynamicSelectedId)) {
      setDynamicSelectedId(null)
      setDynamicStep(1)
    }
  }, [dynamicSelectedId, videos])

  const refreshVideos = async () => {
    const refreshed = await listVideoRecords()
    setVideos((previous) => {
      revokeVideoUrls(previous)
      return refreshed
    })
    setStatus(refreshed.length ? '' : 'No videos yet. Record or upload your first one.')
    return refreshed
  }

  const persistVideo = async (record) => {
    const payload = {
      ...record,
      createdAt: new Date().toISOString(),
    }

    await addVideoRecord(payload)
    const refreshed = await refreshVideos()

    const saved = refreshed.find((item) => item.name === payload.name && item.createdAt === payload.createdAt)
    return saved || refreshed[0] || null
  }

  const resetDynamicOutputs = () => {
    setGeneratedVideos((previous) => {
      revokeGeneratedVideoUrls(previous)
      return []
    })
    setSelectedGeneratedId(null)
    setGenerationProgress('')
    setGenerationPercent(0)
  }

  const handleUploadedFiles = async (event) => {
    const files = event.target.files
    if (!files || !files.length) {
      setError('No file selected. Please choose an MP4 or WebM video.')
      return
    }

    const file = files[0]
    const validType = /video\/(mp4|webm|quicktime|x-matroska)/i.test(file.type)
    const extensionValid = /\.(mp4|webm|mov|mkv)$/i.test(file.name)

    if (!validType && !extensionValid) {
      setError('Unsupported format. Please upload MP4 or WebM (common video formats also supported).')
      event.target.value = ''
      return
    }

    setError('')
    setStatus('Processing uploaded video...')

    try {
      const duration = await getBlobDuration(file)
      const saved = await persistVideo({
        blob: file,
        name: file.name,
        duration,
        source: 'upload',
        mimeType: file.type || 'video/webm',
        size: file.size,
      })

      if (uploadContext === 'dynamic' && saved) {
        setView(VIEWS.DYNAMIC)
        setDynamicSelectedId(saved.id)
        setDynamicStep(1)
        setDetectedTranscript('')
      }

      setStatus('Video uploaded and saved to library.')
    } catch (uploadError) {
      setError(uploadError.message || 'Failed to process uploaded video.')
    } finally {
      event.target.value = ''
    }
  }

  const openUploadPicker = (context = 'general') => {
    setUploadContext(context)
    uploadRef.current?.click()
  }

  const openRecordChoices = (context = 'general') => {
    if (!isMediaRecordingSupported()) {
      setError('This browser does not support media recording APIs required for this feature.')
      return
    }

    setRecordContext(context)
    setRecordChoiceOpen(true)
    setNewMenuOpen(false)
  }

  const launchRecorder = (mode) => {
    setRecordMode(mode)
    setRecordChoiceOpen(false)
  }

  const handleNewAction = (action) => {
    setNewMenuOpen(false)
    setError('')

    if (action === 'upload') {
      openUploadPicker('general')
      return
    }

    if (action === 'record') {
      openRecordChoices('general')
      return
    }

    setView(VIEWS.DYNAMIC)
  }

  const handleSaveRecording = async (record) => {
    setStatus('Saving recorded video...')
    const saved = await persistVideo(record)

    if (recordContext === 'dynamic' && saved) {
      setView(VIEWS.DYNAMIC)
      setDynamicSelectedId(saved.id)
      setDynamicStep(1)
      setDetectedTranscript('')
    }

    setStatus('Recording saved to library.')
  }

  const handleDeleteVideo = async () => {
    if (!deleteCandidate) {
      return
    }

    try {
      setStatus('Deleting video...')
      await deleteVideoRecord(deleteCandidate.id)
      const refreshed = await refreshVideos()

      if (!refreshed.some((item) => item.id === deleteCandidate.id) && dynamicSelectedId === deleteCandidate.id) {
        setDynamicSelectedId(null)
      }

      setDeleteCandidate(null)
      setStatus('Video deleted successfully.')
    } catch (deleteError) {
      setError(deleteError.message || 'Failed to delete this video.')
    }
  }

  const openDynamicConfig = () => {
    if (!dynamicSelectedVideo) {
      setError('Select a video first to create a dynamic video.')
      return
    }

    setError('')
    setDynamicConfigOpen(true)
  }

  const validateKeywordAndContinue = () => {
    if (!dynamicSelectedVideo) {
      setError('Select a video first to continue.')
      return
    }

    setDetectedTranscript('')
    setDynamicConfigOpen(false)
    setDynamicStep(2)
  }

  const updateContact = (id, key, value) => {
    setContacts((previous) =>
      previous.map((contact) => (contact.id === id ? { ...contact, [key]: value } : contact)),
    )
  }

  const removeContact = (id) => {
    setContacts((previous) => {
      if (previous.length <= 1) {
        return previous
      }
      return previous.filter((item) => item.id !== id)
    })
  }

  const MERGE_TAGS = [
    { label: 'First Name', token: 'firstName', fallback: 'there' },
    { label: 'Last Name', token: 'lastName', fallback: '' },
    { label: 'Company Name', token: 'companyName', fallback: 'your company' },
    { label: 'Email', token: 'email', fallback: 'your email' },
    { label: 'Custom Field', token: 'customField', fallback: '' },
  ]

  const insertMergeTag = (field, tag) => {
    const tagText = tag.fallback ? `{{${tag.token} | ${tag.fallback}}}` : `{{${tag.token}}}`
    const selRef = field === 'header' ? headerSelRef : messageSelRef
    const ref = field === 'header' ? headerRef : messageRef
    const current = field === 'header' ? headerTemplate : messageTemplate
    const setter = field === 'header' ? setHeaderTemplate : setMessageTemplate

    const { start, end } = selRef.current
    const next = current.slice(0, start) + tagText + current.slice(end)
    setter(next)

    const newPos = start + tagText.length
    selRef.current = { start: newPos, end: newPos }

    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.focus()
        ref.current.setSelectionRange(newPos, newPos)
      }
    })

    setMergePopup(null)
  }

  const buildRenderPayload = (contact) => {
    const normalizedContact = normalizeContact(contact)

    return {
      header: applyTemplate(headerTemplate, normalizedContact),
      message: applyTemplate(messageTemplate, normalizedContact),
      cta: applyTemplate(ctaText, normalizedContact),
      ctaHref: applyTemplate(ctaUrl, normalizedContact),
      contact: normalizedContact,
      background: normalizedContact.backgroundUrl,
    }
  }

  const generatePersonalizedAudio = async (contact, transcript) => {
    if (!namePersonalization || !transcript) {
      return null
    }

    const script = replaceKeywordWithFirstName(transcript, FIXED_PERSONALIZATION_KEYWORD, contact.firstName)
    return synthesizeSpeechFromText(script)
  }

  const generateVideos = async () => {
    if (!dynamicSelectedVideo) {
      setError('Select a source video first.')
      setDynamicStep(1)
      return
    }

    const normalizedContacts = contacts
      .map((contact) => normalizeContact(contact))
      .filter((contact) => contact.firstName || contact.email || contact.companyName || contact.customField)

    if (!normalizedContacts.length) {
      setError('Enter at least one contact before generation.')
      setDynamicStep(4)
      return
    }

    setIsGenerating(true)
    setError('')
    setStatus('Generating personalized videos...')
    setGenerationPercent(0)
    resetDynamicOutputs()

    // Transcribe video once upfront for name personalization TTS
    let activeTranscript = detectedTranscript
    if (namePersonalization && !activeTranscript) {
      setGenerationProgress('Transcribing video for name personalization...')
      try {
        activeTranscript = await transcribeVideoBlob(dynamicSelectedVideo.blob)
        if (activeTranscript) {
          setDetectedTranscript(activeTranscript)
        }
      } catch {
        // Continue without TTS if transcription fails
      }
    }

    const results = []
    const total = normalizedContacts.length

    for (let index = 0; index < normalizedContacts.length; index += 1) {
      const contact = normalizedContacts[index]
      const label = contact.firstName || contact.email || `contact-${index + 1}`
      setGenerationProgress(`Generating ${index + 1}/${normalizedContacts.length}: ${label}`)

      try {
        const payload = buildRenderPayload(contact)

        // TTS failure is non-blocking — video uses original audio if TTS fails
        let personalizedAudioBlob = null
        if (activeTranscript && namePersonalization) {
          try {
            personalizedAudioBlob = await generatePersonalizedAudio(contact, activeTranscript)
          } catch (ttsError) {
            console.warn('[TTS] Skipping personalized audio:', ttsError.message)
          }
        }

        const blob = await renderDynamicVideo({
          sourceBlob: dynamicSelectedVideo.blob,
          dynamicBackground: dynamicBackgroundEnabled,
          backgroundUrl: payload.background,
          fallbackUrl,
          bubblePosition,
          simulateScrolling,
          personalizedAudioBlob,
          onProgress: (frameProgress) => {
            const normalized = Math.max(0, Math.min(1, Number(frameProgress || 0)))
            const pct = Math.round(((index + normalized) / total) * 100)
            setGenerationPercent(pct)
          },
        })

        let duration = 0
        try {
          duration = await getBlobDuration(blob)
        } catch {
          duration = Number(dynamicSelectedVideo.duration || 0)
        }

        try {
          await addVideoRecord({
            blob,
            name: `dynamic-${payload.contact.firstName || 'contact'}-${Date.now()}.webm`,
            duration,
            source: 'dynamic',
            mimeType: blob.type || 'video/webm',
            size: blob.size,
            createdAt: new Date().toISOString(),
          })
        } catch {
          // Do not fail generation if library persistence fails for one item.
        }

        const previewUrl = URL.createObjectURL(blob)
        const output = {
          id: crypto.randomUUID(),
          contact: payload.contact,
          header: payload.header,
          message: payload.message,
          cta: payload.cta,
          ctaHref: payload.ctaHref,
          previewUrl,
          blob,
          status: 'success',
          fileName: `dynamic-${payload.contact.firstName || 'contact'}-${index + 1}.webm`,
        }

        results.push(output)
        setGeneratedVideos([...results])
        setGenerationPercent(Math.round(((index + 1) / total) * 100))
      } catch (generationError) {
        results.push({
          id: crypto.randomUUID(),
          contact,
          status: 'error',
          error: generationError.message || 'Failed to generate personalized output.',
        })
        setGeneratedVideos([...results])
      }
    }

    await refreshVideos()

    setIsGenerating(false)
    setGenerationProgress('Generation complete.')
    setGenerationPercent(100)
    setStatus('Personalized videos generated. Review and download below.')
    setDynamicStep(5)

    const firstSuccess = results.find((item) => item.status === 'success')
    setSelectedGeneratedId(firstSuccess?.id || null)
  }

  const retryGenerateVideo = async (failedItem) => {
    if (!dynamicSelectedVideo) return

    setRetryingIds((prev) => new Set([...prev, failedItem.id]))

    try {
      const contact = failedItem.contact
      const payload = buildRenderPayload(contact)

      let transcript = detectedTranscript
      if (namePersonalization && !transcript) {
        try {
          transcript = await transcribeVideoBlob(dynamicSelectedVideo.blob)
          if (transcript) setDetectedTranscript(transcript)
        } catch { /* skip TTS if transcription fails */ }
      }

      let personalizedAudioBlob = null
      if (transcript && namePersonalization) {
        try {
          personalizedAudioBlob = await generatePersonalizedAudio(contact, transcript)
        } catch (ttsError) {
          console.warn('[TTS] Retry — skipping personalized audio:', ttsError.message)
        }
      }

      const blob = await renderDynamicVideo({
        sourceBlob: dynamicSelectedVideo.blob,
        dynamicBackground: dynamicBackgroundEnabled,
        backgroundUrl: payload.background,
        fallbackUrl,
        bubblePosition,
        simulateScrolling,
        personalizedAudioBlob,
      })

      let duration = 0
      try { duration = await getBlobDuration(blob) } catch { duration = Number(dynamicSelectedVideo.duration || 0) }

      try {
        await addVideoRecord({
          blob,
          name: `dynamic-${contact.firstName || 'contact'}-${Date.now()}.webm`,
          duration,
          source: 'dynamic',
          mimeType: blob.type || 'video/webm',
          size: blob.size,
          createdAt: new Date().toISOString(),
        })
      } catch { /* non-fatal */ }

      const previewUrl = URL.createObjectURL(blob)
      setGeneratedVideos((prev) =>
        prev.map((item) =>
          item.id === failedItem.id
            ? {
                id: failedItem.id,
                contact,
                header: payload.header,
                message: payload.message,
                cta: payload.cta,
                ctaHref: payload.ctaHref,
                previewUrl,
                blob,
                status: 'success',
                fileName: `dynamic-${contact.firstName || 'contact'}-retry.webm`,
              }
            : item,
        ),
      )
      await refreshVideos()
    } catch (retryError) {
      setGeneratedVideos((prev) =>
        prev.map((item) =>
          item.id === failedItem.id
            ? { ...item, error: retryError.message || 'Retry failed.', status: 'error' }
            : item,
        ),
      )
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev)
        next.delete(failedItem.id)
        return next
      })
    }
  }

  const downloadGeneratedVideo = (record) => {
    if (!record?.blob || !record.previewUrl) {
      return
    }

    const anchor = document.createElement('a')
    anchor.href = record.previewUrl
    anchor.download = record.fileName || `dynamic-${record.id}.webm`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  }

  const renderLibrary = (selectable = false) => (
    <section className="panel library-panel">
      <div className="panel-header">
        <h2>Video Library</h2>
        <p>{videos.length} saved videos</p>
      </div>

      {videos.length === 0 ? (
        <div className="empty-state">No saved videos yet. Record or upload to populate the library.</div>
      ) : (
        <div className="video-grid">
          {videos.map((video) => (
            <article key={video.id} className="video-card">
              <video controls preload="metadata" src={video.previewUrl} className="video-player" />
              <div className="video-meta">
                <h3 title={video.name}>{video.name}</h3>
                <p>
                  {formatDuration(video.duration)} • {new Date(video.createdAt).toLocaleString()}
                </p>
                <p>
                  {video.source} • {formatBytes(video.size)}
                </p>
              </div>

              {selectable ? (
                <button
                  className={dynamicSelectedId === video.id ? 'button solid' : 'button ghost'}
                  onClick={() => {
                    setDynamicSelectedId(video.id)
                    setDynamicStep(1)
                    setError('')
                    setDetectedTranscript('')
                    resetDynamicOutputs()
                  }}
                >
                  {dynamicSelectedId === video.id ? 'Selected' : 'Use This Video'}
                </button>
              ) : (
                <button className="button danger" onClick={() => setDeleteCandidate(video)}>
                  Delete Video
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )

  const renderHome = () => (
    <section className="welcome-shell">
      <div className="welcome-headline">
        <span className="avatar-chip"></span>
        <h1>Welcome</h1>
      </div>

      <section className="panel welcome-hero">
        <div className="welcome-copy">
          <span className="feature-tag">AI Dynamic Videos</span>
          <h2>Make AI-Personalized Videos</h2>
          <p>
            Record or upload once, then generate personalized videos for every contact with dynamic backgrounds,
            custom messaging, and bulk exports.
          </p>

          <div className="hero-actions">
            <button className="button solid" onClick={() => openRecordChoices('general')}>
              Get Started
            </button>
            <button className="button ghost" onClick={() => openUploadPicker('general')}>
              Upload Video
            </button>
            <button className="button ghost" onClick={() => setView(VIEWS.DYNAMIC)}>
              Dynamic Studio
            </button>
          </div>

          <p className="hero-note">Use keyword someone for name-personalized audio replacement.</p>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="visual-card visual-card-top">hey someone</div>
          <div className="visual-card visual-card-right">{'{{firstName}}'}</div>
          <div className="visual-circle" />
          <div className="visual-card visual-card-bottom">dynamic background</div>
        </div>
      </section>
    </section>
  )

  const renderDynamic = () => {
    const sampleContact = normalizeContact(contacts[0] || createEmptyContact())
    const previewHeader = applyTemplate(headerTemplate, sampleContact)
    const previewMessage = applyTemplate(messageTemplate, sampleContact)
    const previewCta = applyTemplate(ctaText, sampleContact)

    return (
      <section className="panel dynamic-panel">
        <div className="panel-header panel-header-block">
          <div>
            <h2>Dynamic Video Studio</h2>
            <p>Build and generate contact-personalized dynamic videos end-to-end.</p>
          </div>
        </div>

        <div className="dynamic-actions">
          <button className="button solid" onClick={() => openRecordChoices('dynamic')}>
            Record New Video
          </button>
          <button className="button ghost" onClick={() => openUploadPicker('dynamic')}>
            Upload Video
          </button>
          <button className="button ghost" onClick={() => setView(VIEWS.LIBRARY)}>
            Open Library
          </button>
        </div>

        <div className="wizard-steps" role="tablist" aria-label="Dynamic video steps">
          {STEPS.map((stepLabel, index) => {
            const stepNumber = index + 1
            const active = dynamicStep === stepNumber
            const completed = dynamicStep > stepNumber
            return (
              <button
                key={stepLabel}
                className={active ? 'step-chip active' : completed ? 'step-chip done' : 'step-chip'}
                onClick={() => {
                  if (stepNumber <= dynamicStep) {
                    setDynamicStep(stepNumber)
                  }
                }}
                type="button"
              >
                <span>{stepNumber}</span>
                {stepLabel}
              </button>
            )
          })}
        </div>

        {dynamicStep === 1 ? (
          <>
            <div className="dynamic-selection">
              <h3>Choose Source Video</h3>
              {renderLibrary(true)}
            </div>

            {dynamicSelectedVideo ? (
              <section className="selected-video-shell">
                <div>
                  <h3>Selected Video</h3>
                  <p>{dynamicSelectedVideo.name}</p>
                  <p>
                    {formatDuration(dynamicSelectedVideo.duration)} • {formatBytes(dynamicSelectedVideo.size)}
                  </p>
                </div>
                <button className="button solid" onClick={openDynamicConfig}>
                  Create Dynamic Video
                </button>
              </section>
            ) : (
              <div className="empty-state">Select a video from the library above to start the dynamic flow.</div>
            )}
          </>
        ) : (
          <section className="selected-video-shell compact">
            <div>
              <h3>Source Video</h3>
              <p>{dynamicSelectedVideo?.name || 'None selected'}</p>
            </div>
            <button className="button ghost" onClick={() => setDynamicStep(1)}>
              Change Video
            </button>
          </section>
        )}

        {dynamicStep === 2 ? (
          <section className="wizard-card">
            <h3>Step 2: Dynamic Background Settings</h3>

            <label className="toggle-row">
              <span>Dynamic Background</span>
              <ToggleSwitch checked={dynamicBackgroundEnabled} onToggle={setDynamicBackgroundEnabled} />
            </label>

            {dynamicBackgroundEnabled ? (
              <div className="field-grid">
                <label>
                  Fallback URL
                  <input
                    value={fallbackUrl}
                    onChange={(event) => setFallbackUrl(event.target.value)}
                  />
                </label>

                <label>
                  Camera Bubble Position
                  <select value={bubblePosition} onChange={(event) => setBubblePosition(event.target.value)}>
                    <option value="bottom-left">Bottom Left</option>
                    <option value="bottom-right">Bottom Right</option>
                    <option value="top-left">Top Left</option>
                    <option value="top-right">Top Right</option>
                  </select>
                </label>

                <label className="toggle-row inline-toggle">
                  <span>Simulate Scrolling</span>
                  <ToggleSwitch checked={simulateScrolling} onToggle={setSimulateScrolling} />
                </label>
              </div>
            ) : null}

            <div className="wizard-nav">
              <button className="button ghost" onClick={() => setDynamicStep(1)}>
                Back
              </button>
              <button className="button solid" onClick={() => setDynamicStep(3)}>
                Continue
              </button>
            </div>
          </section>
        ) : null}

        {dynamicStep === 3 ? (
          <section className="wizard-card" onClick={() => setMergePopup(null)}>
            <h3>Step 3: Landing Page — Layout &amp; Message</h3>

            <div className="field-grid two-column">
              <div className="merge-field-wrap">
                <div className="merge-field-label">
                  <span>Header</span>
                  <div className="merge-popup-anchor">
                    <button
                      type="button"
                      className="personalize-btn"
                      onClick={(e) => { e.stopPropagation(); setMergePopup(mergePopup === 'header' ? null : 'header') }}
                    >
                      {'{ }'} Personalize
                    </button>
                    {mergePopup === 'header' && (
                      <div className="merge-popup" onClick={(e) => e.stopPropagation()}>
                        <p className="merge-popup-title">Insert Merge Tag</p>
                        {MERGE_TAGS.map((tag) => (
                          <button
                            key={tag.token}
                            type="button"
                            className="merge-tag-item"
                            onClick={() => insertMergeTag('header', tag)}
                          >
                            {tag.label}{tag.fallback ? ` | ${tag.fallback}` : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <textarea
                  ref={headerRef}
                  rows={3}
                  placeholder="e.g. Hey {{firstName | there}}!"
                  value={headerTemplate}
                  onChange={(e) => setHeaderTemplate(e.target.value)}
                  onSelect={(e) => { headerSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                  onKeyUp={(e) => { headerSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                  onClick={(e) => { headerSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                />
              </div>

              <div className="merge-field-wrap">
                <div className="merge-field-label">
                  <span>Message</span>
                  <div className="merge-popup-anchor">
                    <button
                      type="button"
                      className="personalize-btn"
                      onClick={(e) => { e.stopPropagation(); setMergePopup(mergePopup === 'message' ? null : 'message') }}
                    >
                      {'{ }'} Personalize
                    </button>
                    {mergePopup === 'message' && (
                      <div className="merge-popup" onClick={(e) => e.stopPropagation()}>
                        <p className="merge-popup-title">Insert Merge Tag</p>
                        {MERGE_TAGS.map((tag) => (
                          <button
                            key={tag.token}
                            type="button"
                            className="merge-tag-item"
                            onClick={() => insertMergeTag('message', tag)}
                          >
                            {tag.label}{tag.fallback ? ` | ${tag.fallback}` : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <textarea
                  ref={messageRef}
                  rows={3}
                  placeholder="e.g. I recorded this specifically for {{companyName | your team}}."
                  value={messageTemplate}
                  onChange={(e) => setMessageTemplate(e.target.value)}
                  onSelect={(e) => { messageSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                  onKeyUp={(e) => { messageSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                  onClick={(e) => { messageSelRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
                />
              </div>

              <label>
                CTA Button Text
                <input
                  placeholder="e.g. Book a call"
                  value={ctaText}
                  onChange={(event) => setCtaText(event.target.value)}
                />
              </label>

              <label>
                CTA URL
                <input
                  placeholder="https://..."
                  value={ctaUrl}
                  onChange={(event) => setCtaUrl(event.target.value)}
                />
              </label>
            </div>

            <div className="preview-card">
              <h4>Live Preview — first contact</h4>
              {previewHeader ? <p className="preview-header">{previewHeader}</p> : null}
              {previewMessage ? <p className="preview-message">{previewMessage}</p> : null}
              {previewCta ? <button className="button solid" type="button">{previewCta}</button> : null}
              {!previewHeader && !previewMessage && !previewCta ? (
                <p style={{color: 'var(--muted-2)', fontSize: 14, margin: 0}}>Start typing above to see a live preview with your first contact's data.</p>
              ) : null}
            </div>

            <div className="wizard-nav">
              <button className="button ghost" onClick={() => setDynamicStep(2)}>
                Back
              </button>
              <button className="button solid" onClick={() => setDynamicStep(4)}>
                Continue
              </button>
            </div>
          </section>
        ) : null}

        {dynamicStep === 4 ? (
          <section className="wizard-card">
            <h3>Step 4: Contacts and Overrides</h3>

            <div className="contacts-table-wrap">
              <table className="contacts-table">
                <thead>
                  <tr>
                    <th>First Name</th>
                    <th>Last Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Custom Field</th>
                    <th>Background URL</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td>
                        <input
                          value={contact.firstName}
                          onChange={(event) => updateContact(contact.id, 'firstName', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={contact.lastName}
                          onChange={(event) => updateContact(contact.id, 'lastName', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={contact.email}
                          onChange={(event) => updateContact(contact.id, 'email', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={contact.companyName}
                          onChange={(event) => updateContact(contact.id, 'companyName', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={contact.customField}
                          onChange={(event) => updateContact(contact.id, 'customField', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={contact.backgroundUrl}
                          onChange={(event) => updateContact(contact.id, 'backgroundUrl', event.target.value)}
                        />
                      </td>
                      <td>
                        <button className="button ghost" type="button" onClick={() => removeContact(contact.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="contacts-actions">
              <button className="button ghost" onClick={() => setContacts((previous) => [...previous, createEmptyContact()])}>
                Add Contact
              </button>
            </div>

            <div className="wizard-nav">
              <button className="button ghost" onClick={() => setDynamicStep(3)}>
                Back
              </button>
              <button className="button solid" onClick={generateVideos} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : 'Review & Generate'}
              </button>
            </div>

            {isGenerating ? (
              <div className="generation-wrap">
                <p className="generation-progress">{generationProgress}</p>
                <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={generationPercent}>
                  <div className="progress-fill" style={{ width: `${generationPercent}%` }} />
                </div>
                <p className="hint-text">{generationPercent}% complete</p>
              </div>
            ) : null}
          </section>
        ) : null}

        {dynamicStep === 5 ? (
          <section className="wizard-card">
            <h3>Step 5: Generated Videos</h3>

            {generatedVideos.length === 0 ? (
              <div className="empty-state">No outputs yet. Generate from the Contacts step.</div>
            ) : (
              <div className="output-layout">
                <div className="output-list">
                  {generatedVideos.map((item, index) => {
                    const name = item.contact?.firstName || `Contact ${index + 1}`

                    return (
                      <article
                        key={item.id}
                        className={selectedGeneratedVideo?.id === item.id ? 'output-item active' : 'output-item'}
                      >
                        <div className="output-item-header">
                          <div className="output-avatar">
                            {name.charAt(0).toUpperCase()}
                          </div>
                          <button
                            className="output-open"
                            type="button"
                            onClick={() => setSelectedGeneratedId(item.id)}
                          >
                            {name}
                          </button>
                        </div>

                        {item.status === 'success' ? (
                          <button className="button ghost btn-sm" onClick={() => downloadGeneratedVideo(item)}>
                            Download
                          </button>
                        ) : (
                          <div className="output-error-row">
                            <p className="error-text">{item.error || 'Generation failed'}</p>
                            <button
                              className="button ghost btn-sm btn-retry"
                              onClick={() => retryGenerateVideo(item)}
                              disabled={retryingIds.has(item.id)}
                            >
                              {retryingIds.has(item.id) ? 'Retrying…' : 'Try Again'}
                            </button>
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>

                <div className="output-preview">
                  {selectedGeneratedVideo && selectedGeneratedVideo.status === 'success' ? (
                    <>
                      <video controls src={selectedGeneratedVideo.previewUrl} className="video-player" />
                      {selectedGeneratedVideo.header ? <h4>{selectedGeneratedVideo.header}</h4> : null}
                      {selectedGeneratedVideo.message ? <p>{selectedGeneratedVideo.message}</p> : null}
                      {selectedGeneratedVideo.cta && selectedGeneratedVideo.ctaHref ? (
                        <a href={selectedGeneratedVideo.ctaHref} target="_blank" rel="noreferrer" className="cta-link">
                          {selectedGeneratedVideo.cta}
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <p className="empty-state">Select a generated output to preview details.</p>
                  )}
                </div>
              </div>
            )}

            <div className="wizard-nav">
              <button className="button ghost" onClick={() => setDynamicStep(4)}>
                Back
              </button>
              <button className="button solid" onClick={() => setDynamicStep(1)}>
                Start New Generation
              </button>
            </div>
          </section>
        ) : null}
      </section>
    )
  }

  return (
    <div className="layout-shell">
      <aside className="sidebar">
        <div className="brand">sendspark</div>

        <div className="topbar-actions sidebar-new">
          <button className="button menu-button full-width" onClick={() => setNewMenuOpen((open) => !open)}>
            + New
          </button>
          {newMenuOpen ? (
            <div className="menu sidebar-menu">
              <button onClick={() => handleNewAction('upload')}>Upload Video</button>
              <button onClick={() => handleNewAction('record')}>Record Video</button>
              <button onClick={() => handleNewAction('dynamic')}>Dynamic Video</button>
            </div>
          ) : null}
        </div>

        <nav className="sidebar-nav">
          <button className={view === VIEWS.HOME ? 'side-link active' : 'side-link'} onClick={() => setView(VIEWS.HOME)}>
            <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7A1 1 0 003 11h1v6a1 1 0 001 1h4v-5h2v5h4a1 1 0 001-1v-6h1a1 1 0 00.707-1.707l-7-7z"/></svg>
            Welcome
          </button>
          <button
            className={view === VIEWS.LIBRARY ? 'side-link active' : 'side-link'}
            onClick={() => setView(VIEWS.LIBRARY)}
          >
            <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z"/></svg>
            Video Library
            {videos.length > 0 && <span className="nav-badge">{videos.length}</span>}
          </button>
          <button
            className={view === VIEWS.DYNAMIC ? 'side-link active' : 'side-link'}
            onClick={() => setView(VIEWS.DYNAMIC)}
          >
            <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/></svg>
            Dynamic Studio
          </button>
        </nav>
      </aside>

      <section className="main-column">
        <header className="searchbar-wrap">
          <input className="searchbar" aria-label="Search" />
        </header>

        {error ? <div className="notice error">{error}</div> : null}
        {status ? <div className="notice">{status}</div> : null}

        <main className="content">
          {view === VIEWS.HOME ? renderHome() : null}
          {view === VIEWS.LIBRARY ? renderLibrary() : null}
          {view === VIEWS.DYNAMIC ? renderDynamic() : null}
        </main>
      </section>

      <input
        ref={uploadRef}
        type="file"
        accept="video/mp4,video/webm,video/*"
        onChange={handleUploadedFiles}
        className="hidden-input"
      />

      {dynamicConfigOpen ? (
        <div className="modal-backdrop">
          <div className="modal dynamic-modal">
            <h3>Dynamic Video Guidelines</h3>

            <label className="toggle-row">
              <span>Name Personalization</span>
              <ToggleSwitch
                checked={namePersonalization}
                onToggle={(next) => {
                  setNamePersonalization(next)
                  setDetectedTranscript('')
                }}
              />
            </label>

            {namePersonalization ? (
              <>
                <div className="keyword-instruction">Use keyword: someone in your script</div>
                <p className="hint-text">
                  At generation time, "someone" in your audio will be replaced with each contact's first name.
                </p>
              </>
            ) : (
              <p className="hint-text">Voice replacement will be skipped.</p>
            )}

            <div className="modal-actions">
              <button className="button ghost" onClick={() => setDynamicConfigOpen(false)}>
                Cancel
              </button>
              <button className="button solid" onClick={validateKeywordAndContinue}>
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modal-backdrop">
          <div className="modal confirm-modal">
            <h3>Delete Video</h3>
            <p>
              Are you sure you want to delete <strong>{deleteCandidate.name}</strong> from your video library?
            </p>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              <button className="button danger" onClick={handleDeleteVideo}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {recordChoiceOpen ? (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Record Video</h3>
            <p>Choose how to start recording:</p>
            <div className="modal-actions">
              <button className="button solid" onClick={() => launchRecorder('camera')}>
                Record with Camera + Mic
              </button>
              <button className="button ghost" onClick={() => launchRecorder('screen')}>
                Record Screen + Mic
              </button>
            </div>
            <button className="text-button" onClick={() => setRecordChoiceOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {recordMode ? (
        <RecorderStudio
          mode={recordMode}
          onClose={() => setRecordMode(null)}
          onSave={async (record) => {
            await handleSaveRecording(record)
          }}
          onError={(message) => setError(message)}
        />
      ) : null}
    </div>
  )
}

function RecorderStudio({ mode, onClose, onSave, onError }) {
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [localError, setLocalError] = useState('')
  const [timerSeconds, setTimerSeconds] = useState(0)

  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const cameraStreamRef = useRef(null)
  const screenStreamRef = useRef(null)
  const micStreamRef = useRef(null)
  const mixedStreamRef = useRef(null)
  const audioContextRef = useRef(null)
  const liveVideoRef = useRef(null)
  const timerRef = useRef(null)
  const hasAutoStartedRef = useRef(false)

  const sourceLabel = mode === 'camera' ? 'camera' : 'screen'

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }

      stopStream(cameraStreamRef.current)
      stopStream(screenStreamRef.current)
      stopStream(micStreamRef.current)
      stopStream(mixedStreamRef.current)
      stopAudioContext(audioContextRef.current)

      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [previewUrl])

  const showLiveStream = (stream) => {
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = stream
      liveVideoRef.current.play().catch(() => {
        setLocalError('Unable to auto-play live preview. Press play to continue.')
      })
    }
  }

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  // This handler intentionally captures current refs/state and is only auto-triggered once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const startRecording = async () => {
    setLocalError('')
    setSavedMessage('')
    onError('')

    try {
      const mimeType = getSupportedMimeType()

      if (mode === 'camera') {
        const cameraStream = await getCameraStream()
        cameraStreamRef.current = cameraStream
        mixedStreamRef.current = cameraStream
      } else {
        const { mixedStream, screenStream, micStream, audioContext } = await getScreenAndMicStream()
        mixedStreamRef.current = mixedStream
        screenStreamRef.current = screenStream
        micStreamRef.current = micStream
        audioContextRef.current = audioContext

        const [screenTrack] = screenStream.getVideoTracks()
        if (screenTrack) {
          screenTrack.addEventListener('ended', () => {
            stopRecording()
          })
        }
      }

      const stream = mixedStreamRef.current
      if (!stream) {
        throw new Error('Unable to initialize media stream.')
      }

      showLiveStream(stream)
      chunksRef.current = []

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        setLocalError('Recording failed. Please try again.')
      }

      recorder.onstop = async () => {
        setIsRecording(false)
        stopTimer()
        setIsProcessing(true)

        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
          const duration = await getBlobDuration(blob)

          const nextPreviewUrl = URL.createObjectURL(blob)
          if (previewUrl) {
            URL.revokeObjectURL(previewUrl)
          }
          setPreviewUrl(nextPreviewUrl)

          await onSave({
            blob,
            name: buildVideoName(sourceLabel),
            duration,
            source: sourceLabel,
            mimeType: blob.type || recorder.mimeType || 'video/webm',
            size: blob.size,
          })

          setSavedMessage('Video saved to library successfully.')
        } catch (saveError) {
          const message = saveError.message || 'Failed to save recorded video.'
          setLocalError(message)
          onError(message)
        } finally {
          setIsProcessing(false)
          stopStream(cameraStreamRef.current)
          stopStream(screenStreamRef.current)
          stopStream(micStreamRef.current)
          stopStream(mixedStreamRef.current)
          await stopAudioContext(audioContextRef.current)

          cameraStreamRef.current = null
          screenStreamRef.current = null
          micStreamRef.current = null
          mixedStreamRef.current = null
          audioContextRef.current = null

          if (liveVideoRef.current) {
            liveVideoRef.current.srcObject = null
          }
        }
      }

      recorder.start(250)
      setIsRecording(true)
      setTimerSeconds(0)
      timerRef.current = setInterval(() => {
        setTimerSeconds((current) => current + 1)
      }, 1000)
    } catch (startError) {
      const message =
        startError.name === 'NotAllowedError'
          ? 'Permission denied. Please allow access to camera, microphone, or screen.'
          : startError.message || 'Unable to start recording.'

      setLocalError(message)
      onError(message)
      stopStream(cameraStreamRef.current)
      stopStream(screenStreamRef.current)
      stopStream(micStreamRef.current)
      stopStream(mixedStreamRef.current)
      stopAudioContext(audioContextRef.current)
    }
  }

  useEffect(() => {
    if (hasAutoStartedRef.current) {
      return
    }

    hasAutoStartedRef.current = true
    startRecording()
  }, [startRecording])

  return (
    <div className="modal-backdrop">
      <div className="modal recorder-modal">
        <h3>{mode === 'camera' ? 'Camera Recording' : 'Screen Recording'}</h3>
        <p>
          {mode === 'camera'
            ? 'Records webcam video with microphone audio.'
            : 'Records shared screen with microphone audio.'}
        </p>

        <div className="recorder-layout">
          <div>
            <h4>Live preview</h4>
            <video ref={liveVideoRef} className="video-player" muted playsInline controls={false} />
          </div>
          <div>
            <h4>Recorded preview</h4>
            <video className="video-player" src={previewUrl || undefined} controls playsInline />
          </div>
        </div>

        <p className="timer">{isRecording ? `Recording: ${formatDuration(timerSeconds)}` : 'Ready to record'}</p>

        {localError ? <div className="notice error">{localError}</div> : null}
        {savedMessage ? <div className="notice">{savedMessage}</div> : null}

        <div className="modal-actions">
          <button className="button solid" onClick={startRecording} disabled={isRecording || isProcessing}>
            Start
          </button>
          <button className="button ghost" onClick={stopRecording} disabled={!isRecording || isProcessing}>
            Stop
          </button>
        </div>

        <button className="text-button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

export default App
