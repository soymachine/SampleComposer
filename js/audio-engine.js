/**
 * AudioEngine — wraps Web Audio API context, effects chain, and master bus.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.sends = {}; // named effect send buses
  }

  /** Must be called from a user gesture to unlock AudioContext */
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master compressor (always on, subtle glue)
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 6;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this._buildEffects();
  }

  _buildEffects() {
    // Delay send
    const delay = this.ctx.createDelay(2.0);
    delay.delayTime.value = 0.375; // 8th note at 80bpm-ish default
    const delayFeedback = this.ctx.createGain();
    delayFeedback.gain.value = 0.35;
    const delayReturn = this.ctx.createGain();
    delayReturn.gain.value = 0.7;
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(delayReturn);
    delayReturn.connect(this.compressor);
    this.sends.delay = { input: delay, param: delay.delayTime, feedbackGain: delayFeedback };

    // Reverb send (simple convolver approximation with a gain-based IR)
    const reverb = this.ctx.createConvolver();
    reverb.buffer = this._buildImpulseResponse(2.5, 3.0, false);
    const reverbReturn = this.ctx.createGain();
    reverbReturn.gain.value = 0.6;
    reverb.connect(reverbReturn);
    reverbReturn.connect(this.compressor);
    this.sends.reverb = { input: reverb };

    // Filter send (low-pass sweep)
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 8000;
    filter.Q.value = 1.0;
    filter.connect(this.compressor);
    this.sends.filter = { input: filter, node: filter };

    // Distortion / saturation send
    const distortion = this.ctx.createWaveShaper();
    distortion.curve = this._buildDistortionCurve(120);
    distortion.oversample = '4x';
    const distReturn = this.ctx.createGain();
    distReturn.gain.value = 0.5;
    distortion.connect(distReturn);
    distReturn.connect(this.compressor);
    this.sends.distortion = { input: distortion };
  }

  /** Decode raw ArrayBuffer into AudioBuffer */
  async decodeAudio(arrayBuffer) {
    this.init();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  /**
   * Play a buffer immediately or at a scheduled time.
   * Returns the source node so caller can stop it.
   */
  playSample({ buffer, when = 0, pitch = 1.0, volume = 1.0, sendLevels = {} }) {
    if (!this.ctx || !buffer) return null;
    const startTime = when || this.ctx.currentTime;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = volume;

    source.connect(gainNode);
    gainNode.connect(this.compressor);

    // Route to sends
    for (const [name, level] of Object.entries(sendLevels)) {
      if (level > 0 && this.sends[name]) {
        const sendGain = this.ctx.createGain();
        sendGain.gain.value = level;
        gainNode.connect(sendGain);
        sendGain.connect(this.sends[name].input);
      }
    }

    source.start(startTime);
    return source;
  }

  /** Update delay time based on BPM (synced to 8th notes) */
  updateDelayForBPM(bpm) {
    if (!this.sends.delay) return;
    const eighthNote = (60 / bpm) / 2;
    this.sends.delay.param.setTargetAtTime(eighthNote, this.ctx.currentTime, 0.01);
  }

  setFilterCutoff(hz) {
    if (!this.sends.filter) return;
    this.sends.filter.node.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  // --- helpers ---

  _buildImpulseResponse(duration, decay, reverse) {
    const length = this.ctx.sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const channel = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const n = reverse ? length - i : i;
        channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
      }
    }
    return impulse;
  }

  _buildDistortionCurve(amount) {
    const samples = 256;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}
