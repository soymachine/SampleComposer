import { AudioEngine } from './audio-engine.js';
import { Sequencer } from './sequencer.js';
import { Recorder } from './recorder.js';
import { SampleBank } from './sample-bank.js';

// ─── State ────────────────────────────────────────────────────────────────────
const engine = new AudioEngine();
const bank = new SampleBank();
const seq = new Sequencer(engine);
const recorder = new Recorder(engine);

let activePad = null;      // currently selected pad (0–11)
let recordTargetPad = null; // pad we're about to record into
let isRecordArmed = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const pads = Array.from(document.querySelectorAll('.pad'));
const steps = Array.from(document.querySelectorAll('.step-btn'));
const displayBPM = document.getElementById('disp-bpm');
const displayInfo = document.getElementById('disp-info');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const btnRecord = document.getElementById('btn-record');
const bpmSlider = document.getElementById('bpm-slider');
const bpmValue = document.getElementById('bpm-value');
const groupBtns = Array.from(document.querySelectorAll('.group-btn'));
const waveCanvas = document.getElementById('waveform');
const fileInput = document.getElementById('file-input');
const padName = document.getElementById('pad-name');
const sendKnobs = document.querySelectorAll('.send-knob');

// ─── Sample bank wiring ───────────────────────────────────────────────────────
seq.setSampleResolver((pad) => bank.getBuffer(pad));

bank.onChange = (padIndex) => {
  const padEl = pads[padIndex];
  const hasSample = bank.hasSample(padIndex);
  padEl.classList.toggle('has-sample', hasSample);
  const slot = bank.getSample(padIndex);
  if (slot) {
    padEl.querySelector('.pad-label').textContent = slot.name.slice(0, 6).toUpperCase();
  } else {
    padEl.querySelector('.pad-label').textContent = padEl.dataset.key.toUpperCase();
  }
  if (padIndex === activePad) drawWaveform(padIndex);
};

// ─── Pad interaction ──────────────────────────────────────────────────────────
pads.forEach((padEl, i) => {
  const trigger = (e) => {
    e.preventDefault();
    engine.init();
    selectPad(i);

    const buf = bank.getBuffer(i);
    if (buf) {
      const slot = bank.getSample(i);
      engine.playSample({
        buffer: buf,
        pitch: slot.pitch,
        volume: slot.volume,
        sendLevels: slot.sendLevels,
      });
    }

    padEl.classList.add('active');
    setTimeout(() => padEl.classList.remove('active'), 100);

    if (seq.isRecording) seq.recordHit(i);
  };

  padEl.addEventListener('mousedown', trigger);
  padEl.addEventListener('touchstart', trigger, { passive: false });

  // Drag-drop sample files onto pads
  padEl.addEventListener('dragover', (e) => { e.preventDefault(); padEl.classList.add('drag-over'); });
  padEl.addEventListener('dragleave', () => padEl.classList.remove('drag-over'));
  padEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    padEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
      const buf = await recorder.loadFile(file);
      bank.setSample(i, buf, file.name.replace(/\.[^.]+$/, ''));
    }
  });
});

function selectPad(i) {
  activePad = i;
  pads.forEach((p, idx) => p.classList.toggle('selected', idx === i));
  drawWaveform(i);
  updateSendKnobs(i);
  const slot = bank.getSample(i);
  padName.textContent = slot ? slot.name : `PAD ${i + 1}`;
  updateStepGridForActivePad();
}

// ─── Step sequencer grid ──────────────────────────────────────────────────────
steps.forEach((btn, stepIdx) => {
  btn.addEventListener('click', () => {
    if (activePad === null) return;
    const active = seq.toggleStep(seq.activeGroup, activePad, stepIdx);
    btn.classList.toggle('on', active);
  });
});

function updateStepGridForActivePad() {
  if (activePad === null) return;
  steps.forEach((btn, stepIdx) => {
    const s = seq.groups[seq.activeGroup][activePad][stepIdx];
    btn.classList.toggle('on', s.active);
  });
}

seq.onStep = (step) => {
  steps.forEach((btn, i) => btn.classList.toggle('playing', i === step));
  displayInfo.textContent = `STEP ${String(step + 1).padStart(2, '0')}`;
};

seq.onStop = () => {
  steps.forEach(btn => btn.classList.remove('playing'));
  displayInfo.textContent = 'STOP';
};

seq.onPlay = () => { displayInfo.textContent = 'PLAY'; };

// ─── Transport ────────────────────────────────────────────────────────────────
btnPlay.addEventListener('click', () => {
  engine.init();
  seq.start();
  btnPlay.classList.add('active');
  btnStop.classList.remove('active');
});

btnStop.addEventListener('click', () => {
  seq.stop();
  btnStop.classList.add('active');
  btnPlay.classList.remove('active');
});

btnRecord.addEventListener('click', () => {
  isRecordArmed = !isRecordArmed;
  btnRecord.classList.toggle('armed', isRecordArmed);
  if (isRecordArmed) {
    displayInfo.textContent = 'REC ARM';
    // Arm mic recording — next pad tap records a new sample
    recorder.onRecordingComplete = (buf) => {
      if (recordTargetPad !== null) {
        bank.setSample(recordTargetPad, buf, `MIC ${recordTargetPad + 1}`);
        recordTargetPad = null;
      }
      displayInfo.textContent = 'REC OK';
    };
  } else {
    recorder.stopRecording();
    displayInfo.textContent = 'STOP';
  }
});

// Long-press pad while record armed → mic record into that pad
pads.forEach((padEl, i) => {
  let holdTimer = null;
  padEl.addEventListener('mousedown', () => {
    if (!isRecordArmed) return;
    holdTimer = setTimeout(async () => {
      recordTargetPad = i;
      displayInfo.textContent = `REC PAD ${i + 1}`;
      await recorder.startRecording();
    }, 400);
  });
  const cancel = () => {
    clearTimeout(holdTimer);
    if (recorder.isRecording) recorder.stopRecording();
  };
  padEl.addEventListener('mouseup', cancel);
  padEl.addEventListener('mouseleave', cancel);
});

// ─── BPM control ─────────────────────────────────────────────────────────────
bpmSlider.addEventListener('input', () => {
  const bpm = parseInt(bpmSlider.value, 10);
  seq.setBPM(bpm);
  bpmValue.textContent = bpm;
  displayBPM.textContent = String(bpm).padStart(3, '0');
});

// ─── Group selector ───────────────────────────────────────────────────────────
groupBtns.forEach((btn, g) => {
  btn.addEventListener('click', () => {
    seq.setGroup(g);
    groupBtns.forEach((b, idx) => b.classList.toggle('active', idx === g));
    updateStepGridForActivePad();
    displayInfo.textContent = `GRP ${['A','B','C','D'][g]}`;
  });
});

// ─── File import ──────────────────────────────────────────────────────────────
document.getElementById('btn-import').addEventListener('click', () => {
  if (activePad === null) { displayInfo.textContent = 'SEL PAD'; return; }
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file || activePad === null) return;
  engine.init();
  const buf = await recorder.loadFile(file);
  bank.setSample(activePad, buf, file.name.replace(/\.[^.]+$/, ''));
  fileInput.value = '';
});

// ─── Send effect knobs ────────────────────────────────────────────────────────
sendKnobs.forEach((knob) => {
  knob.addEventListener('input', () => {
    if (activePad === null) return;
    const send = knob.dataset.send;
    const val = parseFloat(knob.value);
    bank.setSendLevel(activePad, send, val);
    knob.parentElement.querySelector('.knob-val').textContent = Math.round(val * 100);
  });
});

function updateSendKnobs(padIndex) {
  const slot = bank.getSample(padIndex);
  sendKnobs.forEach((knob) => {
    const send = knob.dataset.send;
    const val = slot ? (slot.sendLevels[send] || 0) : 0;
    knob.value = val;
    knob.parentElement.querySelector('.knob-val').textContent = Math.round(val * 100);
  });
}

// ─── Waveform canvas ──────────────────────────────────────────────────────────
function drawWaveform(padIndex) {
  const ctx = waveCanvas.getContext('2d');
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const peaks = bank.getWaveformData(padIndex);
  if (!peaks) {
    ctx.strokeStyle = '#3a3a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }

  ctx.fillStyle = '#0d1f0d';
  ctx.fillRect(0, 0, w, h);

  // Waveform bars
  const barW = w / peaks.length;
  ctx.fillStyle = '#39ff14';
  for (let i = 0; i < peaks.length; i++) {
    const barH = peaks[i] * h * 0.9;
    ctx.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1), barH);
  }

  // Center line
  ctx.strokeStyle = 'rgba(57,255,20,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
const keyMap = {
  'a': 0, 's': 1, 'd': 2, 'f': 3,
  'g': 4, 'h': 5, 'j': 6, 'k': 7,
  'z': 8, 'x': 9, 'c': 10, 'v': 11,
};

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  const pad = keyMap[e.key.toLowerCase()];
  if (pad !== undefined) {
    pads[pad].dispatchEvent(new MouseEvent('mousedown'));
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    seq.toggle();
    btnPlay.classList.toggle('active', seq.isPlaying);
    btnStop.classList.toggle('active', !seq.isPlaying);
  }
});

// ─── Init display ─────────────────────────────────────────────────────────────
displayBPM.textContent = String(seq.bpm).padStart(3, '0');
displayInfo.textContent = 'STOP';
bpmValue.textContent = seq.bpm;
bpmSlider.value = seq.bpm;
selectPad(0);
groupBtns[0].classList.add('active');
