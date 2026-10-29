// In-browser recorder for the "Add recording" form: record button, timer, level meter and a preview to check before
// submitting. Produces a File like the file picker does, so the upload path doesn't care where the audio came from.

const BITRATE = 64000; // compressed, so the upload limit holds a few minutes rather than seconds
// Browsers tune the mic for calls by default; all of these would flatten or gate ambient sound.
const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
// First supported wins. Safari only does MP4/AAC, which the pipeline already accepts as .m4a.
const FORMATS = [
  { mimeType: 'audio/webm;codecs=opus', ext: '.webm' },
  { mimeType: 'audio/mp4', ext: '.m4a' },
  { mimeType: 'audio/ogg;codecs=opus', ext: '.ogg' },
];

export const recordingSupported = () =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && FORMATS.some((f) => MediaRecorder.isTypeSupported(f.mimeType));

export function createRecorder({ maxBytes, onStart }) {
  const element = document.createElement('div');
  element.className = 'recorder';
  element.innerHTML = `
    <div class="controls">
      <button type="button" class="rec" aria-label="Start recording"><span></span></button>
      <div class="readout">
        <div class="time">0:00</div>
        <div class="meter"><span></span></div>
        <div class="size"></div>
      </div>
    </div>
    <audio controls hidden></audio>
    <div class="after" hidden>
      <button type="button" data-action="discard">Discard and record again</button>
    </div>
    <p class="note"></p>
  `;
  const recButton = element.querySelector('.rec');
  const timeEl = element.querySelector('.time');
  const meterEl = element.querySelector('.meter span');
  const sizeEl = element.querySelector('.size');
  const preview = element.querySelector('audio');
  const after = element.querySelector('.after');
  const note = element.querySelector('.note');
  const format = FORMATS.find((f) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(f.mimeType));
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  let recorder = null;
  let session = null; // { stream, ctx, wakeLock, timer, frame }
  let file = null;

  async function start() {
    note.textContent = '';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    } catch (err) {
      note.textContent = `Couldn't use the microphone: ${err.message}`;
      return;
    }
    onStart?.();

    const chunks = [];
    let bytes = 0;
    const startedAt = Date.now();
    const thisRecorder = (recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: BITRATE }));
    recorder.addEventListener('dataavailable', (e) => {
      chunks.push(e.data);
      bytes += e.data.size;
      sizeEl.textContent = `${mb(bytes)} of ${mb(maxBytes)} MB`;
      // Stop a little short of the limit: the final chunk written on stop still adds a few KB.
      if (bytes > maxBytes * 0.95 && recorder.state === 'recording') {
        stop();
        note.textContent = `Stopped automatically at the ${mb(maxBytes)} MB upload limit.`;
      }
    });
    recorder.addEventListener('stop', () => {
      if (recorder !== thisRecorder) return; // discarded (reset) while it was finishing
      const type = recorder.mimeType || format.mimeType;
      const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[-:T]/g, '');
      file = new File(chunks, `recording-${stamp}${format.ext}`, { type });
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
      after.hidden = false;
      recButton.hidden = true;
      sizeEl.textContent = `${mb(file.size)} MB`;
    });
    recorder.start(1000); // a chunk every second, so the size readout and limit check stay current

    session = { stream, timer: setInterval(() => (timeEl.textContent = clock(Date.now() - startedAt)), 250) };
    startMeter(stream);
    // Keep the screen awake: on phones, locking it stops the recording.
    navigator.wakeLock?.request('screen').then((lock) => (session ? (session.wakeLock = lock) : lock.release())).catch(() => {});

    recButton.classList.add('recording');
    recButton.setAttribute('aria-label', 'Stop recording');
  }

  function startMeter(stream) {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      // Map roughly -60..0 dBFS onto the bar, so quiet ambience still visibly moves it.
      const level = Math.max(0, Math.min(1, (20 * Math.log10(rms || 1e-6) + 60) / 60));
      meterEl.style.width = `${level * 100}%`;
      session.frame = requestAnimationFrame(draw);
    };
    session.ctx = ctx;
    draw();
  }

  function stop() {
    if (recorder?.state === 'recording') recorder.stop();
    if (!session) return;
    clearInterval(session.timer);
    cancelAnimationFrame(session.frame);
    session.ctx?.close();
    session.wakeLock?.release().catch(() => {});
    session.stream.getTracks().forEach((t) => t.stop());
    session = null;
    meterEl.style.width = '0';
    recButton.classList.remove('recording');
    recButton.setAttribute('aria-label', 'Start recording');
  }

  function reset() {
    stop();
    recorder = null;
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.removeAttribute('src');
    preview.hidden = true;
    after.hidden = true;
    recButton.hidden = false;
    file = null;
    timeEl.textContent = '0:00';
    sizeEl.textContent = '';
    note.textContent = '';
  }

  recButton.addEventListener('click', () => (session ? stop() : start()));
  element.querySelector('[data-action="discard"]').addEventListener('click', reset);

  return {
    element,
    reset,
    stop,
    isRecording: () => !!session,
    getFile: () => file,
  };
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
