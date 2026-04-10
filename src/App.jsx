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
import { addVideoRecord, listVideoRecords, revokeVideoUrls } from './lib/videoStore'

const VIEWS = {
  HOME: 'home',
  LIBRARY: 'library',
  DYNAMIC: 'dynamic',
}

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
  const [dynamicSelectedId, setDynamicSelectedId] = useState(null)
  const [dynamicConfirmedVideo, setDynamicConfirmedVideo] = useState(null)

  const uploadRef = useRef(null)

  const dynamicSelectedVideo = useMemo(
    () => videos.find((video) => video.id === dynamicSelectedId) || null,
    [dynamicSelectedId, videos],
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
    }
  }, [])

  useEffect(() => {
    if (dynamicSelectedId && !videos.some((item) => item.id === dynamicSelectedId)) {
      setDynamicSelectedId(null)
    }
  }, [dynamicSelectedId, videos])

  const persistVideo = async (record) => {
    const payload = {
      ...record,
      createdAt: new Date().toISOString(),
    }

    await addVideoRecord(payload)

    const refreshed = await listVideoRecords()
    setVideos((previous) => {
      revokeVideoUrls(previous)
      return refreshed
    })
    setStatus(refreshed.length ? '' : 'No videos yet. Record or upload your first one.')

    const saved = refreshed.find((item) => item.name === payload.name && item.createdAt === payload.createdAt)
    return saved || refreshed[0] || null
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
    }

    setStatus('Recording saved to library.')
  }

  const confirmDynamicSelection = () => {
    if (!dynamicSelectedVideo) {
      setError('Select a video first to continue with Dynamic Video flow.')
      return
    }

    setDynamicConfirmedVideo(dynamicSelectedVideo)
    setError('')
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
                  onClick={() => setDynamicSelectedId(video.id)}
                >
                  {dynamicSelectedId === video.id ? 'Selected' : 'Select for Dynamic'}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )

  const renderHome = () => (
    <>
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
              Let&apos;s do what you came here to do. Get started and personalize your outreach at scale with video.
            </p>

            <div className="hero-actions">
              <button className="button solid" onClick={() => openRecordChoices('general')}>
                Get Started
              </button>
              <button className="button ghost" onClick={() => openUploadPicker('general')}>
                Upload Video
              </button>
              <button className="button ghost" onClick={() => setView(VIEWS.LIBRARY)}>
                Open Library
              </button>
            </div>

            <p className="hero-note">Instant uplift on your campaigns.</p>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="visual-card visual-card-top">Hey Bethany!</div>
            <div className="visual-card visual-card-right">Hey Brandon!</div>
            <div className="visual-circle" />
            <div className="visual-card visual-card-bottom">Hey Melissa!</div>
          </div>
        </section>
      </section>
    </>
  )

  const renderDynamic = () => (
    <section className="panel dynamic-panel">
      <div className="panel-header panel-header-block">
        <div>
          <h2>Dynamic Video</h2>
          <p>Choose to record, upload, or browse your existing library.</p>
        </div>
      </div>

      <div className="dynamic-actions">
        <button className="button solid" onClick={() => openRecordChoices('dynamic')}>
          Record New Video
        </button>
        <button className="button ghost" onClick={() => openUploadPicker('dynamic')}>
          Upload Video
        </button>
        <button
          className="button ghost"
          onClick={() => setStatus('Browse and select a video from the library section below.')}
        >
          Browse Library
        </button>
      </div>

      <div className="dynamic-selection">
        <h3>Choose from Video Library</h3>
        {renderLibrary(true)}
      </div>

      <div className="dynamic-confirm">
        <button className="button solid" onClick={confirmDynamicSelection}>
          Confirm Selected Video
        </button>
        {dynamicSelectedVideo ? (
          <p>
            Current selection: <strong>{dynamicSelectedVideo.name}</strong>
          </p>
        ) : (
          <p>No video selected yet.</p>
        )}
      </div>

      {dynamicConfirmedVideo ? (
        <div className="success-box">
          <h4>Dynamic step ready</h4>
          <p>
            <strong>{dynamicConfirmedVideo.name}</strong> is confirmed. Placeholder processing step complete and the
            selected video can now be used by downstream dynamic personalization logic.
          </p>
        </div>
      ) : null}
    </section>
  )

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
            Welcome
          </button>
          <button
            className={view === VIEWS.LIBRARY ? 'side-link active' : 'side-link'}
            onClick={() => setView(VIEWS.LIBRARY)}
          >
            Video Libraries
          </button>
          <button
            className={view === VIEWS.DYNAMIC ? 'side-link active' : 'side-link'}
            onClick={() => setView(VIEWS.DYNAMIC)}
          >
            Dynamic Videos
          </button>
        </nav>
      </aside>

      <section className="main-column">
        <header className="searchbar-wrap">
          <input className="searchbar" placeholder="Search Sendspark..." aria-label="Search" />
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
  }, [])

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
