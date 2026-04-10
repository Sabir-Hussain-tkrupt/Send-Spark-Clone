export function isMediaRecordingSupported() {
  return Boolean(
    navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      navigator.mediaDevices.getDisplayMedia &&
      window.MediaRecorder,
  );
}

export function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export async function getCameraStream() {
  return navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
}

export async function getScreenAndMicStream() {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const Context = window.AudioContext || window.webkitAudioContext;
  const audioContext = new Context();
  const destination = audioContext.createMediaStreamDestination();

  const screenAudioTracks = screenStream.getAudioTracks();
  if (screenAudioTracks.length > 0) {
    const screenAudioSource = audioContext.createMediaStreamSource(new MediaStream(screenAudioTracks));
    screenAudioSource.connect(destination);
  }

  const micAudioSource = audioContext.createMediaStreamSource(new MediaStream(micStream.getAudioTracks()));
  micAudioSource.connect(destination);

  const mixedStream = new MediaStream([
    ...screenStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  return { mixedStream, screenStream, micStream, audioContext };
}

export function stopStream(stream) {
  if (!stream) {
    return;
  }

  stream.getTracks().forEach((track) => track.stop());
}

export async function stopAudioContext(audioContext) {
  if (!audioContext) {
    return;
  }

  if (audioContext.state !== 'closed') {
    await audioContext.close();
  }
}

export function getBlobDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');

    video.preload = 'metadata';
    video.src = url;

    video.onloadedmetadata = () => {
      const seconds = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(seconds);
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to read video metadata.'));
    };
  });
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) {
    return '0:00';
  }

  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
