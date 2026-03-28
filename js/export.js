/**
 * export.js — Render the current pattern to a downloadable WAV file.
 *
 * Uses OfflineAudioContext to render N bars at full quality without
 * real-time constraints. Swing is applied identically to the live sequencer.
 */
import { audioBufferToWAV, downloadBlob } from './wav-utils.js';

/**
 * @param {AudioEngine}  engine
 * @param {SampleBank}   bank
 * @param {Sequencer}    seq
 * @param {object}       opts
 * @param {number}       opts.bars       Number of bars to render (default 4)
 * @param {string}       opts.filename   Download filename (default 'beat-export.wav')
 * @param {Function}     opts.onProgress Called with (0..1) as rendering progresses
 */
export async function exportWAV(engine, bank, seq, {
  bars       = 4,
  filename   = 'beat-export.wav',
  onProgress = null,
} = {}) {

  if (!engine.ctx) throw new Error('Audio context not initialised — press Play first.');

  const sampleRate     = engine.sampleRate;
  const stepDuration   = seq.stepDuration;           // seconds per 16th note
  const totalSteps     = bars * seq.stepsPerPattern;
  const swing          = seq.swing ?? 0;
  const tailSec        = 1.5;                        // silence tail for reverb decay
  const totalDuration  = totalSteps * stepDuration + tailSec;

  const offline = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);

  // ── Build a minimal effects chain in the offline context ──────────────────
  const masterGain = offline.createGain();
  masterGain.gain.value = 0.9;
  masterGain.connect(offline.destination);

  // Delay (BPM-synced 8th note)
  const delay          = offline.createDelay(2.0);
  delay.delayTime.value = (60 / seq.bpm) / 2;
  const delayFb        = offline.createGain();
  delayFb.gain.value   = 0.35;
  const delayRet       = offline.createGain();
  delayRet.gain.value  = 0.7;
  delay.connect(delayFb); delayFb.connect(delay);
  delay.connect(delayRet); delayRet.connect(masterGain);

  // Reverb (simple noise IR)
  const reverb = offline.createConvolver();
  reverb.buffer = _buildIR(offline, 2.2, 2.8);
  const reverbRet = offline.createGain();
  reverbRet.gain.value = 0.6;
  reverb.connect(reverbRet); reverbRet.connect(masterGain);

  // Filter send
  const filterSend = offline.createBiquadFilter();
  filterSend.type  = 'lowpass';
  filterSend.frequency.value = 800;
  filterSend.connect(masterGain);

  // Distortion send
  const dist = offline.createWaveShaper();
  dist.curve = _distCurve(120);
  const distRet = offline.createGain();
  distRet.gain.value = 0.5;
  dist.connect(distRet); distRet.connect(masterGain);

  const sends = { delay, reverb: reverb, filter: filterSend, distortion: dist };

  // ── Schedule every step ───────────────────────────────────────────────────
  const group = seq.groups[seq.activeGroup];

  // Replicate the exact swing grid used by the live sequencer
  let evenGridTime = 0;
  let nextStepTime = 0;

  for (let stepI = 0; stepI < totalSteps; stepI++) {
    const stepInPattern = stepI % seq.stepsPerPattern;
    const time          = nextStepTime;

    // Advance grid (mirrors Sequencer._advance with swing)
    if (stepI % 2 === 0) {
      nextStepTime = evenGridTime + stepDuration + swing * stepDuration;
    } else {
      evenGridTime += 2 * stepDuration;
      nextStepTime  = evenGridTime;
    }

    for (let pad = 0; pad < 12; pad++) {
      const s = group[pad][stepInPattern];
      if (!s.active)              continue;
      if (!bank.isAudible(pad))   continue;

      const buf  = bank.getBuffer(pad);
      if (!buf)                   continue;

      const slot      = bank.getSample(pad);
      const pitch     = s.pitch      || slot?.pitch      || 1;
      const vol       = s.volume     || slot?.volume     || 1;
      const sndLevels = Object.keys(s.sendLevels ?? {}).length
        ? s.sendLevels
        : (slot?.sendLevels ?? {});

      const src = offline.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;

      const gain = offline.createGain();
      gain.gain.value = vol;

      src.connect(gain);
      gain.connect(masterGain);

      // Connect to effect sends
      for (const [name, level] of Object.entries(sndLevels)) {
        if (level > 0 && sends[name]) {
          const sg = offline.createGain();
          sg.gain.value = level;
          gain.connect(sg);
          sg.connect(sends[name]);
        }
      }

      src.start(Math.max(0, time));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (onProgress) {
    // OfflineAudioContext fires oncomplete but no per-sample progress events
    // — we fake a quick pulse while waiting
    const id = setInterval(() => onProgress(0.5), 120);
    const rendered = await offline.startRendering();
    clearInterval(id);
    onProgress(1);
    downloadBlob(audioBufferToWAV(rendered), filename);
    return rendered;
  }

  const rendered = await offline.startRendering();
  downloadBlob(audioBufferToWAV(rendered), filename);
  return rendered;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _buildIR(ctx, duration, decay) {
  const len = Math.ceil(ctx.sampleRate * duration);
  const ir  = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

function _distCurve(amount, n = 256) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return c;
}
