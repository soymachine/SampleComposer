import { AudioEngine }    from './audio-engine.js';
import { Sequencer }      from './sequencer.js';
import { Recorder }       from './recorder.js';
import { SampleBank }     from './sample-bank.js';
import { Slicer }         from './slicer.js';
import { ProjectManager } from './project.js';
import { exportWAV }      from './export.js';
import { loadKit, KIT_NAMES } from './kits.js';

// ─── Core ─────────────────────────────────────────────────────────────────────
const engine    = new AudioEngine();
const bank      = new SampleBank();
const seq       = new Sequencer(engine);
const recorder  = new Recorder(engine);
const slicer    = new Slicer(engine, bank);
const project   = new ProjectManager(engine, bank, seq);

let activePad       = null;
let recordTargetPad = null;
let isRecordArmed   = false;
let stepLength      = 8;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const pads          = Array.from(document.querySelectorAll('.pad'));
const steps         = Array.from(document.querySelectorAll('.step-btn'));
const displayBPM    = document.getElementById('disp-bpm');
const displayInfo   = document.getElementById('disp-info');
const displayPad    = document.getElementById('disp-pad');
const beatDots      = Array.from(document.querySelectorAll('.beat-dot'));
const btnPlay       = document.getElementById('btn-play');
const btnStop       = document.getElementById('btn-stop');
const btnRecord     = document.getElementById('btn-record');
const btnTap        = document.getElementById('btn-tap');
const bpmSlider     = document.getElementById('bpm-slider');
const bpmValue      = document.getElementById('bpm-value');
const groupBtns     = Array.from(document.querySelectorAll('.group-btn'));
const waveCanvas    = document.getElementById('waveform');
const fileInput     = document.getElementById('file-input');
const padNameEl     = document.getElementById('pad-name');
const padCtrlTitle  = document.getElementById('pad-controls-title');
const sendKnobs     = document.querySelectorAll('.send-knob');
const padVolume     = document.getElementById('pad-volume');
const padPitch      = document.getElementById('pad-pitch');
const padVolumeVal  = document.getElementById('pad-volume-val');
const padPitchVal   = document.getElementById('pad-pitch-val');
const stepLenBtns   = Array.from(document.querySelectorAll('.step-len-btn'));

// ─── Sample bank ──────────────────────────────────────────────────────────────
seq.setSampleResolver((pad) => bank.getBuffer(pad));
seq.setBank(bank); // allow sequencer to check mute/solo

bank.onChange = (padIndex) => {
  const padEl = pads[padIndex];
  const slot  = bank.getSample(padIndex);
  padEl.classList.toggle('has-sample', !!slot);
  padEl.querySelector('.pad-label').textContent = slot
    ? slot.name.slice(0, 6).toUpperCase()
    : padEl.dataset.key.toUpperCase();
  // Mute / solo visual state
  const muted    = bank.isMuted(padIndex);
  const soloed   = bank.isSoloed(padIndex);
  const silenced = bank.anySoloed() && !soloed;
  padEl.classList.toggle('muted',    muted);
  padEl.classList.toggle('soloed',   soloed);
  padEl.classList.toggle('silenced', silenced && !muted);
  if (padIndex === activePad) {
    drawWaveform(padIndex);
    padNameEl.textContent = slot ? slot.name.toUpperCase() : 'NO SAMPLE';
    updateMuteSoloBtns(padIndex);
  }
};

// ─── Pad interaction ──────────────────────────────────────────────────────────
pads.forEach((padEl, i) => {
  const trigger = (e) => {
    e.preventDefault();
    engine.init();
    selectPad(i);

    const buf = bank.getBuffer(i);
    if (buf && bank.isAudible(i)) {
      const slot = bank.getSample(i);
      engine.playSample({ buffer: buf, pitch: slot.pitch, volume: slot.volume, sendLevels: slot.sendLevels, padIndex: i });
    }

    // Press + glow
    padEl.classList.add('active');
    padEl.classList.add('flash');
    setTimeout(() => {
      padEl.classList.remove('active');
      padEl.classList.remove('flash');
    }, 120);

    if (seq.isRecording) seq.recordHit(i);
  };

  padEl.addEventListener('mousedown', trigger);
  padEl.addEventListener('touchstart', trigger, { passive: false });

  // Drag-drop
  padEl.addEventListener('dragover',  (e) => { e.preventDefault(); padEl.classList.add('drag-over'); });
  padEl.addEventListener('dragleave', ()  => padEl.classList.remove('drag-over'));
  padEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    padEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
      engine.init();
      const buf = await recorder.loadFile(file);
      bank.setSample(i, buf, file.name.replace(/\.[^.]+$/, ''));
    }
  });

  // Long-press while REC armed → mic record
  let holdTimer = null;
  padEl.addEventListener('mousedown', () => {
    if (!isRecordArmed) return;
    holdTimer = setTimeout(async () => {
      recordTargetPad = i;
      displayInfo.textContent = `REC ${i + 1}`;
      await recorder.startRecording();
    }, 400);
  });
  const cancel = () => {
    clearTimeout(holdTimer);
    if (recorder.isRecording) recorder.stopRecording();
  };
  padEl.addEventListener('mouseup',    cancel);
  padEl.addEventListener('mouseleave', cancel);
});

function selectPad(i) {
  activePad = i;
  pads.forEach((p, idx) => p.classList.toggle('selected', idx === i));
  drawWaveform(i);
  updatePadControls(i);
  updateMuteSoloBtns(i);
  const slot = bank.getSample(i);
  padNameEl.textContent    = slot ? slot.name.toUpperCase() : 'NO SAMPLE';
  padCtrlTitle.textContent = `PAD ${i + 1} — ${slot ? slot.name : 'empty'}`;
  displayPad.textContent   = String(i + 1).padStart(2, '0');
  updateStepGrid();
}

// ─── Step grid ────────────────────────────────────────────────────────────────
function applyStepLength(len) {
  stepLength = len;
  seq.stepsPerPattern = len;
  steps.forEach((btn, i) => {
    btn.classList.toggle('inactive', i >= len);
  });
  stepLenBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.len) === len));
}

stepLenBtns.forEach(btn => {
  btn.addEventListener('click', () => applyStepLength(parseInt(btn.dataset.len)));
});

steps.forEach((btn, stepIdx) => {
  btn.addEventListener('click', () => {
    if (activePad === null || stepIdx >= stepLength) return;
    const active = seq.toggleStep(seq.activeGroup, activePad, stepIdx);
    btn.classList.toggle('on', active);
  });
});

function updateStepGrid() {
  if (activePad === null) return;
  steps.forEach((btn, stepIdx) => {
    const s = seq.groups[seq.activeGroup][activePad][stepIdx];
    btn.classList.toggle('on', s.active);
    btn.classList.toggle('inactive', stepIdx >= stepLength);
  });
}

document.getElementById('btn-clear').addEventListener('click', () => {
  seq.clearPattern(seq.activeGroup);
  updateStepGrid();
  displayInfo.textContent = 'CLR';
});

// ─── Sequencer callbacks ──────────────────────────────────────────────────────
seq.onStep = (step) => {
  steps.forEach((btn, i) => btn.classList.toggle('playing', i === step));

  // Beat dot: step 0,4,8,12 → dots 0–3
  const beat = Math.floor(step / 4) % 4;
  beatDots.forEach((d, i) => d.classList.toggle('active', i === beat));

  displayInfo.textContent = `STEP ${String(step + 1).padStart(2, '0')}`;
};

seq.onStop = () => {
  steps.forEach(btn => btn.classList.remove('playing'));
  beatDots.forEach(d => d.classList.remove('active'));
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
    recorder.onRecordingComplete = (buf) => {
      if (recordTargetPad !== null) {
        bank.setSample(recordTargetPad, buf, `MIC ${recordTargetPad + 1}`);
        recordTargetPad = null;
      }
      displayInfo.textContent = 'REC OK';
      isRecordArmed = false;
      btnRecord.classList.remove('armed');
    };
  } else {
    recorder.stopRecording();
    displayInfo.textContent = seq.isPlaying ? 'PLAY' : 'STOP';
  }
});

// ─── Tap tempo ────────────────────────────────────────────────────────────────
const tapTimes = [];
btnTap.addEventListener('click', () => {
  const now = performance.now();
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round(60000 / avg);
    seq.setBPM(bpm);
    bpmSlider.value      = bpm;
    bpmValue.textContent = bpm;
    displayBPM.textContent = String(bpm).padStart(3, '0');
  }
  // Flash BPM display
  displayBPM.style.opacity = '0.4';
  setTimeout(() => { displayBPM.style.opacity = '1'; }, 80);
});

// ─── BPM slider ───────────────────────────────────────────────────────────────
bpmSlider.addEventListener('input', () => {
  const bpm = parseInt(bpmSlider.value, 10);
  seq.setBPM(bpm);
  bpmValue.textContent   = bpm;
  displayBPM.textContent = String(bpm).padStart(3, '0');
  tapTimes.length = 0; // reset tap on manual change
});

// ─── Group selector ───────────────────────────────────────────────────────────
groupBtns.forEach((btn, g) => {
  btn.addEventListener('click', () => {
    seq.setGroup(g);
    groupBtns.forEach((b, i) => b.classList.toggle('active', i === g));
    updateStepGrid();
    displayInfo.textContent = `GRP ${'ABCD'[g]}`;
  });
});

// ─── File import / clear pad ──────────────────────────────────────────────────
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

document.getElementById('btn-clear-pad').addEventListener('click', () => {
  if (activePad === null) return;
  bank.clear(activePad);
  drawWaveform(activePad);
  displayInfo.textContent = 'CLR PAD';
});

// ─── Pad controls (volume, pitch, sends) ─────────────────────────────────────
padVolume.addEventListener('input', () => {
  if (activePad === null) return;
  const val = parseFloat(padVolume.value);
  bank.getSample(activePad) && (bank.getSample(activePad).volume = val);
  padVolumeVal.textContent = Math.round(val * 100);
});

padPitch.addEventListener('input', () => {
  if (activePad === null) return;
  const val = parseFloat(padPitch.value);
  bank.getSample(activePad) && (bank.getSample(activePad).pitch = val);
  padPitchVal.textContent = val.toFixed(2) + '×';
});

sendKnobs.forEach((knob) => {
  knob.addEventListener('input', () => {
    if (activePad === null) return;
    const send = knob.dataset.send;
    const val  = parseFloat(knob.value);
    bank.setSendLevel(activePad, send, val);
    knob.closest('.pad-ctrl').querySelector('.ctrl-val').textContent = Math.round(val * 100);
  });
});

function updatePadControls(padIndex) {
  const slot = bank.getSample(padIndex);
  padVolume.value         = slot ? slot.volume : 1;
  padPitch.value          = slot ? slot.pitch  : 1;
  padVolumeVal.textContent = Math.round((slot ? slot.volume : 1) * 100);
  padPitchVal.textContent  = (slot ? slot.pitch : 1).toFixed(2) + '×';
  sendKnobs.forEach((knob) => {
    const send = knob.dataset.send;
    const val  = slot ? (slot.sendLevels[send] || 0) : 0;
    knob.value = val;
    knob.closest('.pad-ctrl').querySelector('.ctrl-val').textContent = Math.round(val * 100);
  });
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
function drawWaveform(padIndex) {
  const ctx = waveCanvas.getContext('2d');
  const w   = waveCanvas.width;
  const h   = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const peaks = bank.getWaveformData(padIndex);
  if (!peaks) {
    ctx.strokeStyle = '#1a3a1a';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  ctx.fillStyle = '#0a160a';
  ctx.fillRect(0, 0, w, h);

  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const amp  = peaks[i];
    const barH = amp * h * 0.88;
    // Gradient colour: quiet=dim, loud=bright
    ctx.fillStyle = amp > 0.6
      ? '#39ff14'
      : amp > 0.3
        ? '#28cc0e'
        : '#1a8a0a';
    ctx.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1), barH);
  }

  ctx.strokeStyle = 'rgba(57,255,20,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
const keyMap = { a:0, s:1, d:2, f:3, g:4, h:5, j:6, k:7, z:8, x:9, c:10, v:11 };

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
  if (e.key === 't' || e.key === 'T') btnTap.click();
});

// ─── Swing ────────────────────────────────────────────────────────────────────
const swingSlider = document.getElementById('swing-slider');
const swingValue  = document.getElementById('swing-value');

swingSlider.addEventListener('input', () => {
  const val = parseFloat(swingSlider.value);
  seq.setSwing(val);
  swingValue.textContent = Math.round(val / 0.5 * 100) + '%';
});

// ─── Mute / Solo ──────────────────────────────────────────────────────────────
const padMuteBtn = document.getElementById('pad-mute-btn');
const padSoloBtn = document.getElementById('pad-solo-btn');

function updateMuteSoloBtns(padIndex) {
  padMuteBtn.classList.toggle('mute-active', bank.isMuted(padIndex));
  padSoloBtn.classList.toggle('solo-active', bank.isSoloed(padIndex));
}

padMuteBtn.addEventListener('click', () => {
  if (activePad === null) return;
  bank.toggleMute(activePad);
  updateMuteSoloBtns(activePad);
  displayInfo.textContent = bank.isMuted(activePad) ? `PAD ${activePad + 1} MUTE` : `PAD ${activePad + 1} ON`;
});

padSoloBtn.addEventListener('click', () => {
  if (activePad === null) return;
  bank.toggleSolo(activePad);
  updateMuteSoloBtns(activePad);
  displayInfo.textContent = bank.isSoloed(activePad) ? `PAD ${activePad + 1} SOLO` : 'SOLO OFF';
});

// ─── Factory Kits ─────────────────────────────────────────────────────────────
const kitSelect = document.getElementById('kit-select');

kitSelect.addEventListener('change', async () => {
  const kitName = kitSelect.value;
  if (!kitName) return;
  engine.init();
  displayInfo.textContent = 'LOADING…';
  kitSelect.disabled = true;
  try {
    await loadKit(kitName, bank);
    displayInfo.textContent = kitName.toUpperCase().slice(0, 8);
    if (activePad !== null) selectPad(activePad);
  } catch (e) {
    console.error(e);
    displayInfo.textContent = 'KIT ERR';
  }
  kitSelect.disabled = false;
  kitSelect.value = '';  // reset so same kit can be reloaded
});

// ─── Project save / load ──────────────────────────────────────────────────────
const projectFileInput = document.getElementById('project-file-input');

document.getElementById('btn-save').addEventListener('click', async () => {
  const name = prompt('Project name:', 'my-beat') || 'my-beat';
  displayInfo.textContent = 'SAVING…';
  try {
    await project.save(name);
    displayInfo.textContent = 'SAVED!';
  } catch (e) {
    console.error(e);
    displayInfo.textContent = 'SAVE ERR';
  }
});

document.getElementById('btn-load-proj').addEventListener('click', () => {
  projectFileInput.click();
});

projectFileInput.addEventListener('change', async () => {
  const file = projectFileInput.files[0];
  if (!file) return;
  engine.init();
  displayInfo.textContent = 'LOADING…';
  try {
    const loadedName = await project.load(file, {
      onPadLoaded: (i) => {
        displayInfo.textContent = `PAD ${i + 1}…`;
      },
    });
    // Sync all UI
    bpmSlider.value        = seq.bpm;
    bpmValue.textContent   = seq.bpm;
    displayBPM.textContent = String(seq.bpm).padStart(3, '0');
    swingSlider.value      = seq.swing;
    swingValue.textContent = Math.round(seq.swing / 0.5 * 100) + '%';
    applyStepLength(seq.stepsPerPattern);
    groupBtns.forEach((b, i) => b.classList.toggle('active', i === seq.activeGroup));
    selectPad(activePad ?? 0);
    updateStepGrid();
    displayInfo.textContent = loadedName.toUpperCase().slice(0, 8);
  } catch (e) {
    console.error(e);
    displayInfo.textContent = 'LOAD ERR';
  }
  projectFileInput.value = '';
});

// ─── WAV Export ───────────────────────────────────────────────────────────────
document.getElementById('btn-export-wav').addEventListener('click', async () => {
  engine.init();
  const barsStr = prompt('Export how many bars?', '4');
  const bars    = parseInt(barsStr, 10);
  if (isNaN(bars) || bars < 1) return;
  displayInfo.textContent = 'RENDER…';
  document.getElementById('btn-export-wav').disabled = true;
  try {
    await exportWAV(engine, bank, seq, {
      bars,
      filename: `beat-${seq.bpm}bpm-${bars}bars.wav`,
      onProgress: (p) => {
        displayInfo.textContent = p >= 1 ? 'DONE!' : 'RENDER…';
      },
    });
    displayInfo.textContent = 'EXPORTED';
  } catch (e) {
    console.error(e);
    displayInfo.textContent = e.message.slice(0, 8).toUpperCase();
  }
  document.getElementById('btn-export-wav').disabled = false;
});

// ─── Slicer ───────────────────────────────────────────────────────────────────
const slicerOverlay   = document.getElementById('slicer-overlay');
const slicerCanvas    = document.getElementById('slicer-canvas');
const slicerFileInput = document.getElementById('slicer-file-input');
const slicerDropZone  = document.getElementById('slicer-drop-zone');
const slicerFilename  = document.getElementById('slicer-filename');
const slicerPadBtns   = Array.from(document.querySelectorAll('.slicer-pad-btn'));
let slicerRaf         = null;

function openSlicer() {
  engine.init();
  slicerOverlay.classList.remove('hidden');
  // Wait one frame for the browser to reflow before reading offsetWidth
  requestAnimationFrame(() => {
    slicerCanvas.width = slicerCanvas.offsetWidth || 720;
    startSlicerLoop();
  });
  syncSlicerPadStates();
}

function closeSlicer() {
  slicer.stopRegion();
  slicerOverlay.classList.add('hidden');
  cancelAnimationFrame(slicerRaf);
}

function startSlicerLoop() {
  const loop = () => {
    slicer.draw(slicerCanvas);
    updateSlicerTimes();
    slicerRaf = requestAnimationFrame(loop);
  };
  loop();
}

function updateSlicerTimes() {
  document.getElementById('slicer-start').textContent = slicer.fmtStart();
  document.getElementById('slicer-end').textContent   = slicer.fmtEnd();
  document.getElementById('slicer-dur').textContent   = slicer.fmtDur();
  const total = slicer.buffer ? slicer._fmt(slicer.buffer.duration) : '—';
  document.getElementById('slicer-total').textContent = total;
}

function syncSlicerPadStates() {
  slicerPadBtns.forEach((btn, i) => {
    btn.classList.toggle('has-sample', bank.hasSample(i));
  });
}

async function loadSlicerFile(file) {
  if (!file || !file.type.startsWith('audio/')) return;
  engine.init();
  const buf = await recorder.loadFile(file);
  slicer.loadBuffer(buf, file.name);
  slicerFilename.textContent = file.name;
  document.getElementById('slicer-zoom').value = 1;
}

// Open slicer button
document.getElementById('btn-slicer').addEventListener('click', () => {
  openSlicer();
});

document.getElementById('slicer-close').addEventListener('click', closeSlicer);

// Close on overlay background click
slicerOverlay.addEventListener('click', (e) => {
  if (e.target === slicerOverlay) closeSlicer();
});

// Load button inside slicer
document.getElementById('slicer-load-btn').addEventListener('click', () => slicerFileInput.click());
slicerFileInput.addEventListener('change', async () => {
  await loadSlicerFile(slicerFileInput.files[0]);
  slicerFileInput.value = '';
});

// Drag-drop onto slicer canvas
slicerDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  slicerDropZone.classList.remove('drag-over');
  await loadSlicerFile(e.dataTransfer.files[0]);
});

// Canvas mouse interaction
slicerCanvas.addEventListener('mousedown',  (e) => slicer.onMouseDown(slicerCanvas, e));
slicerCanvas.addEventListener('mousemove',  (e) => slicer.onMouseMove(slicerCanvas, e));
slicerCanvas.addEventListener('mouseup',    ()  => slicer.onMouseUp());
slicerCanvas.addEventListener('mouseleave', ()  => slicer.onMouseUp());

// Touch support for slicer canvas
slicerCanvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const r   = slicerCanvas.getBoundingClientRect();
  const t   = e.touches[0];
  slicer.onMouseDown(slicerCanvas, { offsetX: t.clientX - r.left, offsetY: t.clientY - r.top });
}, { passive: false });
slicerCanvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const r = slicerCanvas.getBoundingClientRect();
  const t = e.touches[0];
  slicer.onMouseMove(slicerCanvas, { offsetX: t.clientX - r.left, offsetY: t.clientY - r.top });
}, { passive: false });
slicerCanvas.addEventListener('touchend', () => slicer.onMouseUp());

// Slicer transport
document.getElementById('slicer-play').addEventListener('click', () => {
  engine.init();
  slicer.playRegion();
});
document.getElementById('slicer-stop').addEventListener('click', () => slicer.stopRegion());

// Zoom
const slicerZoomSlider = document.getElementById('slicer-zoom');
slicerZoomSlider.addEventListener('input', () => {
  slicer.setZoom(parseFloat(slicerZoomSlider.value));
});
document.getElementById('slicer-zoom-sel').addEventListener('click', () => {
  slicer.zoomToSelection();
  slicerZoomSlider.value = 1; // approximate
});
document.getElementById('slicer-zoom-full').addEventListener('click', () => {
  slicer.zoomFull();
  slicerZoomSlider.value = 1;
});

// Pad assignment buttons
slicerPadBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!slicer.buffer) return;
    const padIndex = parseInt(btn.dataset.pad);
    slicer.sendToPad(padIndex);
    syncSlicerPadStates();
    // Flash confirmation
    btn.classList.add('just-sent');
    setTimeout(() => btn.classList.remove('just-sent'), 600);
    displayInfo.textContent = `PAD ${padIndex + 1} SET`;
  });
});

// Keep slicer pad states in sync when bank changes
const _origBankOnChange = bank.onChange;
bank.onChange = (padIndex) => {
  if (_origBankOnChange) _origBankOnChange(padIndex);
  syncSlicerPadStates();
};

// Resize slicer canvas on window resize
window.addEventListener('resize', () => {
  if (!slicerOverlay.classList.contains('hidden')) {
    slicerCanvas.width = slicerCanvas.offsetWidth || 720;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
displayBPM.textContent = String(seq.bpm).padStart(3, '0');
bpmValue.textContent   = seq.bpm;
bpmSlider.value        = seq.bpm;
groupBtns[0].classList.add('active');
applyStepLength(8);
selectPad(0);
