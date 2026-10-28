// Every recording is routed: <audio> element -> MediaElementSource -> GainNode -> master -> speakers.
// Streaming through <audio> elements (instead of decoding into AudioBuffers) keeps memory low
// for long field recordings. Single-play mode is "one gain up, the rest at 0"; a future composite
// mode only needs to set every gain at once (see setGains).

const FADE_SECONDS = 1.5;

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.voices = new Map(); // id -> { el, gain }
    this.current = null;
  }

  // Must be called from a user gesture (click/tap) or browsers keep the context suspended.
  async unlock() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  add(recording) {
    const el = new Audio();
    el.crossOrigin = 'anonymous'; // required for Web Audio if files are hosted on another origin
    el.preload = 'none';
    el.src = recording.file;

    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.master);

    el.addEventListener('ended', () => {
      if (this.current === recording.id) {
        this.current = null;
        this.onEnded?.(recording.id);
      }
    });

    this.voices.set(recording.id, { el, gain });
  }

  play(id) {
    if (this.current && this.current !== id) this.stop(this.current);
    const voice = this.voices.get(id);
    if (!voice) return;
    this.#rampTo(voice.gain, 1);
    voice.el.play();
    this.current = id;
  }

  stop(id) {
    const voice = this.voices.get(id);
    if (!voice) return;
    this.#rampTo(voice.gain, 0);
    clearTimeout(voice.pauseTimer);
    voice.pauseTimer = setTimeout(() => {
      // Only pause if nothing has faded this voice back in meanwhile.
      if (this.current !== id) voice.el.pause();
    }, FADE_SECONDS * 1000);
    if (this.current === id) this.current = null;
  }

  // For the future composite mode: { id: 0..1, ... }
  setGains(levels, rampSeconds = 0.2) {
    for (const [id, level] of Object.entries(levels)) {
      const voice = this.voices.get(id);
      if (voice) this.#rampTo(voice.gain, level, rampSeconds);
    }
  }

  #rampTo(gainNode, value, seconds = FADE_SECONDS) {
    const g = gainNode.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(value, now + seconds);
  }
}
