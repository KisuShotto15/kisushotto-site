// notes/recorder.js — wrapper around MediaRecorder for audio notes.

let stream = null;
let recorder = null;
let chunks = [];

export async function startRecording() {
  if (recorder && recorder.state === 'recording') throw new Error('Ya está grabando');
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  chunks = [];
  recorder.addEventListener('dataavailable', e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  recorder.start();
  return true;
}

export function isRecording() {
  return recorder && recorder.state === 'recording';
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recorder) return reject(new Error('No hay grabación activa'));
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      stream?.getTracks().forEach(t => t.stop());
      recorder = null;
      stream = null;
      chunks = [];
      resolve(blob);
    });
    recorder.addEventListener('error', e => reject(e.error || e));
    recorder.stop();
  });
}

export function cancelRecording() {
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  stream?.getTracks().forEach(t => t.stop());
  recorder = null;
  stream = null;
  chunks = [];
}
