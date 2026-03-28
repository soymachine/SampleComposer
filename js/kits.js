/**
 * kits.js — Three factory drum kits synthesized procedurally with Web Audio API.
 * No audio files needed — everything is generated on the fly.
 */

// ─── Low-level synthesis helpers ──────────────────────────────────────────────

function makeCtx(dur, sr = 44100) {
  return new OfflineAudioContext(1, Math.ceil(dur * sr), sr);
}

function noiseBuffer(ctx, dur) {
  const len = Math.ceil(dur * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d   = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function distCurve(amount, n = 256) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return c;
}

// ─── Drum synthesizers ────────────────────────────────────────────────────────

/** 808-style kick: sine with pitch envelope */
async function kick808(startFreq = 150, endFreq = 40, dur = 0.75) {
  const ctx  = makeCtx(dur);
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.frequency.setValueAtTime(startFreq, 0);
  osc.frequency.exponentialRampToValueAtTime(endFreq, 0.08);

  gain.gain.setValueAtTime(1.0, 0);
  gain.gain.exponentialRampToValueAtTime(0.001, dur);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(0); osc.stop(dur);
  return ctx.startRendering();
}

/** Synthetic kick with distortion (punchier) */
async function kickSyn(startFreq = 200, dur = 0.55) {
  const ctx  = makeCtx(dur);
  const osc  = ctx.createOscillator();
  const dist = ctx.createWaveShaper();
  const gain = ctx.createGain();

  osc.frequency.setValueAtTime(startFreq, 0);
  osc.frequency.exponentialRampToValueAtTime(30, 0.06);

  dist.curve = distCurve(180);

  gain.gain.setValueAtTime(1.0, 0);
  gain.gain.exponentialRampToValueAtTime(0.001, dur);

  osc.connect(dist); dist.connect(gain); gain.connect(ctx.destination);
  osc.start(0); osc.stop(dur);
  return ctx.startRendering();
}

/** Noise + tone snare */
async function snare(nFreq = 2500, toneDur = 0.08, totalDur = 0.22) {
  const ctx     = makeCtx(totalDur);
  const nBuf    = noiseBuffer(ctx, totalDur);

  // Noise layer
  const nSrc    = ctx.createBufferSource();
  nSrc.buffer   = nBuf;
  const nFilt   = ctx.createBiquadFilter();
  nFilt.type    = 'bandpass';
  nFilt.frequency.value = nFreq;
  nFilt.Q.value = 0.7;
  const nEnv    = ctx.createGain();
  nEnv.gain.setValueAtTime(0.9, 0);
  nEnv.gain.exponentialRampToValueAtTime(0.001, totalDur);
  nSrc.connect(nFilt); nFilt.connect(nEnv); nEnv.connect(ctx.destination);

  // Tone layer
  const osc    = ctx.createOscillator();
  osc.frequency.setValueAtTime(200, 0);
  osc.frequency.exponentialRampToValueAtTime(140, toneDur);
  const oEnv   = ctx.createGain();
  oEnv.gain.setValueAtTime(0.6, 0);
  oEnv.gain.exponentialRampToValueAtTime(0.001, toneDur);
  osc.connect(oEnv); oEnv.connect(ctx.destination);

  nSrc.start(0); nSrc.stop(totalDur);
  osc.start(0);  osc.stop(toneDur);
  return ctx.startRendering();
}

/** Lo-fi snare with bit-like crunch */
async function snareLoFi() {
  const buf = await snare(2000, 0.06, 0.18);
  return bitCrush(buf, 7);
}

/** Closed hi-hat */
async function hihatClosed(dur = 0.07) {
  const ctx   = makeCtx(dur);
  const nSrc  = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const filt  = ctx.createBiquadFilter();
  filt.type   = 'highpass';
  filt.frequency.value = 9000;
  const env   = ctx.createGain();
  env.gain.setValueAtTime(0.8, 0);
  env.gain.exponentialRampToValueAtTime(0.001, dur);
  nSrc.connect(filt); filt.connect(env); env.connect(ctx.destination);
  nSrc.start(0); nSrc.stop(dur);
  return ctx.startRendering();
}

/** Open hi-hat */
async function hihatOpen(dur = 0.38) {
  const ctx   = makeCtx(dur);
  const nSrc  = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const filt  = ctx.createBiquadFilter();
  filt.type   = 'highpass';
  filt.frequency.value = 8000;
  const env   = ctx.createGain();
  env.gain.setValueAtTime(0.65, 0);
  env.gain.setValueAtTime(0.4, 0.05);
  env.gain.exponentialRampToValueAtTime(0.001, dur);
  nSrc.connect(filt); filt.connect(env); env.connect(ctx.destination);
  nSrc.start(0); nSrc.stop(dur);
  return ctx.startRendering();
}

/** Clap — three micro noise bursts */
async function clap(dur = 0.16) {
  const ctx   = makeCtx(dur);
  const nBuf  = noiseBuffer(ctx, dur);
  for (let b = 0; b < 3; b++) {
    const t0   = b * 0.012;
    const src  = ctx.createBufferSource();
    src.buffer = nBuf;
    const filt = ctx.createBiquadFilter();
    filt.type  = 'bandpass';
    filt.frequency.value = 1100;
    filt.Q.value = 0.5;
    const env  = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.8, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.028);
    src.connect(filt); filt.connect(env); env.connect(ctx.destination);
    src.start(t0); src.stop(dur);
  }
  return ctx.startRendering();
}

/** Rimshot */
async function rimshot(dur = 0.11) {
  const ctx  = makeCtx(dur);
  // Tone
  const osc  = ctx.createOscillator();
  osc.frequency.value = 420;
  const oEnv = ctx.createGain();
  oEnv.gain.setValueAtTime(0.5, 0);
  oEnv.gain.exponentialRampToValueAtTime(0.001, 0.07);
  osc.connect(oEnv); oEnv.connect(ctx.destination);
  osc.start(0); osc.stop(0.07);
  // Noise
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const filt = ctx.createBiquadFilter();
  filt.type  = 'bandpass';
  filt.frequency.value = 950;
  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(0.65, 0);
  nEnv.gain.exponentialRampToValueAtTime(0.001, 0.055);
  nSrc.connect(filt); filt.connect(nEnv); nEnv.connect(ctx.destination);
  nSrc.start(0); nSrc.stop(dur);
  return ctx.startRendering();
}

/** Tom (pitched, adjustable freq) */
async function tom(freq = 160, dur = 0.38) {
  const ctx  = makeCtx(dur);
  const osc  = ctx.createOscillator();
  osc.frequency.setValueAtTime(freq, 0);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.38, dur * 0.5);
  const env  = ctx.createGain();
  env.gain.setValueAtTime(0.85, 0);
  env.gain.exponentialRampToValueAtTime(0.001, dur);
  osc.connect(env); env.connect(ctx.destination);
  osc.start(0); osc.stop(dur);
  return ctx.startRendering();
}

/** Cowbell */
async function cowbell(dur = 0.55) {
  const ctx = makeCtx(dur);
  for (const freq of [562, 845]) {
    const osc  = ctx.createOscillator();
    osc.type   = 'square';
    osc.frequency.value = freq;
    const env  = ctx.createGain();
    env.gain.setValueAtTime(0.28, 0);
    env.gain.exponentialRampToValueAtTime(0.001, dur);
    osc.connect(env); env.connect(ctx.destination);
    osc.start(0); osc.stop(dur);
  }
  return ctx.startRendering();
}

/** Sub-bass note (sawtooth + LP filter envelope) */
async function bassNote(freq = 80, dur = 0.5) {
  const ctx  = makeCtx(dur);
  const osc  = ctx.createOscillator();
  osc.type   = 'sawtooth';
  osc.frequency.value = freq;
  const filt = ctx.createBiquadFilter();
  filt.type  = 'lowpass';
  filt.frequency.setValueAtTime(2400, 0);
  filt.frequency.exponentialRampToValueAtTime(220, dur * 0.3);
  const env  = ctx.createGain();
  env.gain.setValueAtTime(0.8, 0);
  env.gain.exponentialRampToValueAtTime(0.001, dur);
  osc.connect(filt); filt.connect(env); env.connect(ctx.destination);
  osc.start(0); osc.stop(dur);
  return ctx.startRendering();
}

/** Electronic zap (descending sweep) */
async function zap(dur = 0.14) {
  const ctx  = makeCtx(dur);
  const osc  = ctx.createOscillator();
  osc.frequency.setValueAtTime(1400, 0);
  osc.frequency.exponentialRampToValueAtTime(80, 0.09);
  const env  = ctx.createGain();
  env.gain.setValueAtTime(0.75, 0);
  env.gain.exponentialRampToValueAtTime(0.001, dur);
  osc.connect(env); env.connect(ctx.destination);
  osc.start(0); osc.stop(dur);
  return ctx.startRendering();
}

/** Bell / pluck tone (two detuned sines) */
async function bellTone(freq = 880, dur = 1.0) {
  const ctx = makeCtx(dur);
  for (const [f, a, d] of [[freq, 0.45, dur], [freq * 2.756, 0.2, dur * 0.5]]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    const env = ctx.createGain();
    env.gain.setValueAtTime(a, 0);
    env.gain.exponentialRampToValueAtTime(0.001, d);
    osc.connect(env); env.connect(ctx.destination);
    osc.start(0); osc.stop(d);
  }
  return ctx.startRendering();
}

/** Bit-crush post-processing (destructive, works on offline buffer) */
async function bitCrush(buffer, bits = 8) {
  const step = Math.pow(2, bits);
  const ctx  = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const raw  = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  const src  = buffer.getChannelData(0);
  const dst  = raw.getChannelData(0);
  for (let i = 0; i < src.length; i++) dst[i] = Math.round(src[i] * step) / step;
  const node = ctx.createBufferSource();
  node.buffer = raw;
  node.connect(ctx.destination);
  node.start(0);
  return ctx.startRendering();
}

// ─── Kit definitions ──────────────────────────────────────────────────────────

export const KITS = {
  '808 Classic': [
    { name: 'Kick 808',  gen: () => kick808(150, 40, 0.75) },
    { name: 'Snare',     gen: () => snare() },
    { name: 'Hi-Hat',    gen: () => hihatClosed() },
    { name: 'Open Hat',  gen: () => hihatOpen() },
    { name: 'Clap',      gen: () => clap() },
    { name: 'Rimshot',   gen: () => rimshot() },
    { name: 'Tom Lo',    gen: () => tom(100, 0.42) },
    { name: 'Tom Hi',    gen: () => tom(190, 0.32) },
    { name: 'Cowbell',   gen: () => cowbell() },
    { name: 'Bass C',    gen: () => bassNote(65)  },
    { name: 'Bass F',    gen: () => bassNote(87)  },
    { name: 'Bass G',    gen: () => bassNote(98)  },
  ],

  'Lo-Fi': [
    { name: 'Kick Fat',  gen: async () => bitCrush(await kick808(130, 35, 0.8), 8) },
    { name: 'Snare Lo',  gen: () => snareLoFi() },
    { name: 'HH Crisp',  gen: () => hihatClosed(0.06) },
    { name: 'HH Dusty',  gen: async () => bitCrush(await hihatOpen(0.28), 9) },
    { name: 'Clap Lo',   gen: async () => bitCrush(await clap(), 6) },
    { name: 'Rim',       gen: () => rimshot() },
    { name: 'Tom A',     gen: () => tom(90,  0.5) },
    { name: 'Tom B',     gen: () => tom(140, 0.4) },
    { name: 'Cowbell',   gen: async () => bitCrush(await cowbell(), 7) },
    { name: 'Sub A',     gen: () => bassNote(55)  },
    { name: 'Sub D',     gen: () => bassNote(73)  },
    { name: 'Sub E',     gen: () => bassNote(82)  },
  ],

  'Electronic': [
    { name: 'Kick Syn',  gen: () => kickSyn(220, 0.5) },
    { name: 'Snare E',   gen: () => snare(3200, 0.05, 0.18) },
    { name: 'HH E',      gen: () => hihatClosed(0.055) },
    { name: 'HH Open',   gen: () => hihatOpen(0.3) },
    { name: 'Clap',      gen: () => clap(0.13) },
    { name: 'Zap',       gen: () => zap() },
    { name: 'Tom E1',    gen: () => tom(170, 0.3) },
    { name: 'Tom E2',    gen: () => tom(240, 0.25) },
    { name: 'Bell',      gen: () => bellTone(880) },
    { name: 'Bass C',    gen: () => bassNote(65)  },
    { name: 'Lead A',    gen: () => bellTone(440, 0.7) },
    { name: 'Lead D',    gen: () => bellTone(587, 0.7) },
  ],
};

export const KIT_NAMES = Object.keys(KITS);

/**
 * Load a full kit into the SampleBank.
 * Returns a Promise that resolves when all 12 pads are populated.
 */
export async function loadKit(kitName, bank) {
  const kit = KITS[kitName];
  if (!kit) throw new Error(`Unknown kit: ${kitName}`);
  await Promise.all(
    kit.map(async ({ name, gen }, i) => {
      const buf = await gen();
      bank.setSample(i, buf, name);
    })
  );
}
