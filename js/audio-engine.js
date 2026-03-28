/**
 * AudioEngine — Web Audio API context, effects chain, master bus.
 * New in Sprint B/C: stopPad(), resampling via MediaStreamAudioDestinationNode.
 */
export class AudioEngine {
  constructor() {
    this.ctx           = null;
    this.masterGain    = null;
    this.compressor    = null;
    this.sends         = {};
    this.activeSources = new Map(); // padIndex → BufferSourceNode

    // Resampling state
    this._resampleDest     = null;
    this._mediaRecorder    = null;
    this._resampleChunks   = [];
    this.onResampleDone    = null; // (AudioBuffer) => void
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value      = 6;
    this.compressor.ratio.value     = 3;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.25;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this._buildEffects();
  }

  _buildEffects() {
    // Delay
    const delay         = this.ctx.createDelay(2.0);
    delay.delayTime.value = 0.375;
    const delayFb       = this.ctx.createGain();
    delayFb.gain.value  = 0.35;
    const delayRet      = this.ctx.createGain();
    delayRet.gain.value = 0.7;
    delay.connect(delayFb); delayFb.connect(delay);
    delay.connect(delayRet); delayRet.connect(this.compressor);
    this.sends.delay = { input: delay, param: delay.delayTime, feedbackGain: delayFb };

    // Reverb
    const reverb       = this.ctx.createConvolver();
    reverb.buffer      = this._buildImpulseResponse(2.5, 3.0, false);
    const reverbRet    = this.ctx.createGain();
    reverbRet.gain.value = 0.6;
    reverb.connect(reverbRet); reverbRet.connect(this.compressor);
    this.sends.reverb = { input: reverb };

    // Filter send
    const filter       = this.ctx.createBiquadFilter();
    filter.type        = 'lowpass';
    filter.frequency.value = 8000;
    filter.Q.value     = 1.0;
    filter.connect(this.compressor);
    this.sends.filter  = { input: filter, node: filter };

    // Distortion
    const dist         = this.ctx.createWaveShaper();
    dist.curve         = this._buildDistortionCurve(120);
    dist.oversample    = '4x';
    const distRet      = this.ctx.createGain();
    distRet.gain.value = 0.5;
    dist.connect(distRet); distRet.connect(this.compressor);
    this.sends.distortion = { input: dist };
  }

  async decodeAudio(arrayBuffer) {
    this.init();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  playSample({ buffer, when = 0, pitch = 1.0, volume = 1.0, sendLevels = {}, padIndex = null }) {
    if (!this.ctx || !buffer) return null;
    const startTime = when || this.ctx.currentTime;

    // Stop previous instance for this pad
    if (padIndex !== null && this.activeSources.has(padIndex)) {
      try { this.activeSources.get(padIndex).stop(startTime); } catch (_) {}
      this.activeSources.delete(padIndex);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = volume;

    source.connect(gainNode);
    gainNode.connect(this.compressor);

    for (const [name, level] of Object.entries(sendLevels)) {
      if (level > 0 && this.sends[name]) {
        const sg = this.ctx.createGain();
        sg.gain.value = level;
        gainNode.connect(sg);
        sg.connect(this.sends[name].input);
      }
    }

    if (padIndex !== null) {
      this.activeSources.set(padIndex, source);
      source.onended = () => {
        if (this.activeSources.get(padIndex) === source) {
          this.activeSources.delete(padIndex);
        }
      };
    }

    source.start(startTime);
    return source;
  }

  /** Stop a pad's current source at a scheduled time (used by mute groups) */
  stopPad(padIndex, when = 0) {
    if (!this.activeSources.has(padIndex)) return;
    const t = when || (this.ctx?.currentTime ?? 0);
    try { this.activeSources.get(padIndex).stop(t); } catch (_) {}
    this.activeSources.delete(padIndex);
  }

  updateDelayForBPM(bpm) {
    if (!this.sends.delay) return;
    const eighth = (60 / bpm) / 2;
    this.sends.delay.param.setTargetAtTime(eighth, this.ctx.currentTime, 0.01);
  }

  setFilterCutoff(hz) {
    if (!this.sends.filter) return;
    this.sends.filter.node.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  // ── Resampling ─────────────────────────────────────────────────────────────

  get isResampling() { return this._mediaRecorder?.state === 'recording'; }

  startResampling() {
    if (!this.ctx) throw new Error('Init audio first.');
    if (this.isResampling) return;

    this._resampleDest   = this.ctx.createMediaStreamDestination();
    this._resampleChunks = [];

    // Tap the master gain into the recording destination
    this.masterGain.connect(this._resampleDest);

    // Prefer wav if available, fall back to webm/ogg
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', '']
      .find(m => !m || MediaRecorder.isTypeSupported(m)) ?? '';

    this._mediaRecorder = new MediaRecorder(
      this._resampleDest.stream,
      mimeType ? { mimeType } : undefined
    );

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._resampleChunks.push(e.data);
    };

    this._mediaRecorder.onstop = async () => {
      this.masterGain.disconnect(this._resampleDest);
      this._resampleDest = null;

      const blob        = new Blob(this._resampleChunks);
      const arrayBuffer = await blob.arrayBuffer();
      try {
        const decoded = await this.ctx.decodeAudioData(arrayBuffer);
        if (this.onResampleDone) this.onResampleDone(decoded);
      } catch (err) {
        console.error('Resample decode failed:', err);
      }
    };

    this._mediaRecorder.start(100); // collect data every 100 ms
  }

  stopResampling() {
    if (this._mediaRecorder?.state === 'recording') {
      this._mediaRecorder.stop();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }
  get sampleRate()  { return this.ctx ? this.ctx.sampleRate  : 44100; }

  _buildImpulseResponse(duration, decay, reverse) {
    const len     = this.ctx.sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = impulse.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const n  = reverse ? len - i : i;
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / len, decay);
      }
    }
    return impulse;
  }

  _buildDistortionCurve(amount) {
    const n   = 256;
    const cur = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      cur[i]  = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return cur;
  }
}
