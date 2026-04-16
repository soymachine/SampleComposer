import { AudioEngine }      from './audio-engine.js';
import { Sequencer }        from './sequencer.js';
import { Recorder }         from './recorder.js';
import { SampleBank }       from './sample-bank.js';
import { Slicer }           from './slicer.js';
import { ProjectManager }   from './project.js';
import { exportWAV }        from './export.js';
import { loadKit }          from './kits.js';
import { MidiController }   from './midi.js';
import { getSupabase, SUPABASE_ENABLED } from './supabase-client.js';
import { AuthManager }      from './auth.js';
import { CloudManager }     from './cloud.js';

// ─── Core ─────────────────────────────────────────────────────────────────────
const engine    = new AudioEngine();
const bank      = new SampleBank();
const seq       = new Sequencer(engine);
const recorder  = new Recorder(engine);
const slicer    = new Slicer(engine, bank);
const project   = new ProjectManager(engine, bank, seq);
const midi      = new MidiController();
const auth      = new AuthManager(null);   // sb client injected after lazy load
const cloud     = new CloudManager(null, auth, engine);

let activePad     = null;
let isRecordArmed = false;
let stepLength    = 8;

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
  btn.addEventListener('click', (e) => {
    if (activePad === null || stepIdx >= stepLength) return;

    const s = seq.groups[seq.activeGroup][activePad][stepIdx];

    if (e.shiftKey && s.active) {
      // Shift+click on active step → cycle probability
      const prob = seq.cycleStepProbability(seq.activeGroup, activePad, stepIdx);
      _applyStepProbabilityStyle(btn, prob);
      displayInfo.textContent = `P${Math.round(prob * 100)}%`;
      return;
    }

    const active = seq.toggleStep(seq.activeGroup, activePad, stepIdx);
    btn.classList.toggle('on', active);
    btn.removeAttribute('data-prob'); // reset opacity when toggling
  });
});

function _applyStepProbabilityStyle(btn, prob) {
  btn.removeAttribute('data-prob');
  if (prob < 1) btn.dataset.prob = Math.round(prob * 100).toString();
}

function updateStepGrid() {
  if (activePad === null) return;
  steps.forEach((btn, stepIdx) => {
    const s = seq.groups[seq.activeGroup][activePad][stepIdx];
    btn.classList.toggle('on',       s.active);
    btn.classList.toggle('inactive', stepIdx >= stepLength);
    btn.removeAttribute('data-prob');
    if (s.active && s.probability < 1) {
      btn.dataset.prob = Math.round(s.probability * 100).toString();
    }
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

// ─── Loop recording ───────────────────────────────────────────────────────────
// REC arms loop step-recording. On first press:
//   • clears the active group pattern
//   • starts the sequencer (if stopped)
//   • records every pad hit at the current step position
// At loop end, if still armed, enters overdub: the recorded pattern plays back
// while new hits layer on top. Press REC again to stop.

let recLoopCount = 0;   // how many loops have completed while recording

btnRecord.addEventListener('click', () => {
  if (seq.isRecording) {
    // ── Stop recording ────────────────────────────────────────────────────
    seq.isRecording = false;
    isRecordArmed   = false;
    recLoopCount    = 0;
    btnRecord.classList.remove('armed');
    displayInfo.textContent = seq.isPlaying ? 'PLAY' : 'STOP';
    return;
  }

  // ── Start recording ───────────────────────────────────────────────────
  engine.init();
  recLoopCount = 0;

  // Clear the active group so loop 1 starts from silence
  seq.clearPattern(seq.activeGroup);
  updateStepGrid();

  // Start sequencer if not already running
  if (!seq.isPlaying) {
    seq.start();
    btnPlay.classList.add('active');
    btnStop.classList.remove('active');
  }

  seq.isRecording = true;
  isRecordArmed   = true;
  btnRecord.classList.add('armed');
  displayInfo.textContent = 'REC 1';
});

// On each loop wrap-around while recording: stay in overdub (don't clear),
// update the step grid so the user can see what was just captured.
seq.onLoopEnd = () => {
  if (!seq.isRecording) return;
  recLoopCount++;
  updateStepGrid();
  displayInfo.textContent = `REC ${recLoopCount + 1}`;
};

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
const padMuteBtn    = document.getElementById('pad-mute-btn');
const padSoloBtn    = document.getElementById('pad-solo-btn');
const padReverseBtn = document.getElementById('pad-reverse-btn');
const mgBtns        = Array.from(document.querySelectorAll('.mg-btn'));

function updatePadStateUI(padIndex) {
  padMuteBtn.classList.toggle('mute-active',  bank.isMuted(padIndex));
  padSoloBtn.classList.toggle('solo-active',  bank.isSoloed(padIndex));
  padReverseBtn.classList.toggle('rev-active', bank.isReversed(padIndex));
  const mg = bank.getMuteGroup(padIndex);
  mgBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.mg) === mg));
}

// Keep backwards-compatible alias used in earlier code
function updateMuteSoloBtns(padIndex) { updatePadStateUI(padIndex); }

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

padReverseBtn.addEventListener('click', () => {
  if (activePad === null) return;
  const rev = bank.toggleReverse(activePad);
  padReverseBtn.classList.toggle('rev-active', rev);
  drawWaveform(activePad); // re-draw mirrored waveform
  displayInfo.textContent = rev ? `PAD ${activePad + 1} REV` : `PAD ${activePad + 1} FWD`;
});

// ── Mute groups ───────────────────────────────────────────────────────────────
mgBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (activePad === null) return;
    const mg = parseInt(btn.dataset.mg);
    bank.setMuteGroup(activePad, mg);
    mgBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.mg) === mg));
    displayInfo.textContent = mg === 0 ? 'GRP NONE' : `GRP ${mg}`;
  });
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
    renderSongChain();
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

// ─── Song mode ────────────────────────────────────────────────────────────────
const songChainEl   = document.getElementById('song-chain');
const btnSongToggle = document.getElementById('btn-song-toggle');
const btnSongAdd    = document.getElementById('btn-song-add');
const btnSongClear  = document.getElementById('btn-song-clear');

function renderSongChain() {
  songChainEl.innerHTML = '';
  if (seq.songChain.length === 0) {
    songChainEl.innerHTML = '<span class="song-empty">add groups to chain then toggle ON</span>';
    return;
  }
  seq.songChain.forEach((groupIdx, pos) => {
    const btn = document.createElement('button');
    btn.className  = 'song-slot';
    btn.textContent = 'ABCD'[groupIdx];
    btn.title = 'Left-click: cycle group  |  Right-click: remove';
    if (seq.songMode && seq._songPos === pos) btn.classList.add('active-slot');
    // Left click → cycle group A→B→C→D
    btn.addEventListener('click', () => {
      seq.setChainSlot(pos, (groupIdx + 1) % 4);
      renderSongChain();
    });
    // Right-click → remove slot
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      seq.removeChainSlot(pos);
      renderSongChain();
    });
    songChainEl.appendChild(btn);
  });
}

btnSongToggle.addEventListener('click', () => {
  const on = seq.toggleSongMode();
  btnSongToggle.textContent = on ? 'ON' : 'OFF';
  btnSongToggle.classList.toggle('active', on);
  displayInfo.textContent = on ? 'SONG ON' : 'SONG OFF';
  if (on && seq.songChain.length > 0) {
    seq.activeGroup = seq.songChain[0];
    groupBtns.forEach((b, i) => b.classList.toggle('active', i === seq.activeGroup));
    updateStepGrid();
  }
  renderSongChain();
});

btnSongAdd.addEventListener('click', () => {
  seq.addChainSlot(seq.activeGroup);
  renderSongChain();
});

btnSongClear.addEventListener('click', () => {
  seq.setSongChain([]);
  if (seq.songMode) {
    seq.songMode = false;
    btnSongToggle.textContent = 'OFF';
    btnSongToggle.classList.remove('active');
  }
  renderSongChain();
});

// Update song chain UI when group auto-advances in song mode
seq.onGroupChange = (groupIdx) => {
  groupBtns.forEach((b, i) => b.classList.toggle('active', i === groupIdx));
  updateStepGrid();
  renderSongChain(); // re-highlights active slot
  displayInfo.textContent = `SONG ${'ABCD'[groupIdx]}`;
};

// ─── Resampling ───────────────────────────────────────────────────────────────
const btnResample = document.getElementById('btn-resample');

engine.onResampleDone = (buf) => {
  // Find the first empty pad, or fall back to the active pad
  let target = activePad;
  for (let i = 0; i < 12; i++) {
    if (!bank.hasSample(i)) { target = i; break; }
  }
  bank.setSample(target, buf, `RESAMPLE`);
  selectPad(target);
  btnResample.classList.remove('armed');
  btnResample.textContent = '⏺ RES';
  displayInfo.textContent = `PAD ${target + 1} RES`;
};

btnResample.addEventListener('click', () => {
  engine.init();
  if (engine.isResampling) {
    engine.stopResampling();
    btnResample.classList.remove('armed');
    btnResample.textContent = '⏺ RES';
    displayInfo.textContent = 'RES STOP';
  } else {
    engine.startResampling();
    btnResample.classList.add('armed');
    btnResample.textContent = '■ STOP';
    displayInfo.textContent = 'REC RES…';
  }
});

// ─── MIDI ─────────────────────────────────────────────────────────────────────
const btnMidi    = document.getElementById('btn-midi');
const midiStatus = document.getElementById('midi-status');

midi.onStatusChange = (status) => {
  const labels = {
    connected:   'CONNECTED',
    disconnected: 'NO DEVICE',
    denied:      'DENIED',
    unsupported: 'NO SUPPORT',
  };
  midiStatus.textContent = labels[status] ?? status.toUpperCase();
  midiStatus.classList.toggle('connected', status === 'connected');
  btnMidi.classList.toggle('active', status === 'connected');
};

midi.onPadHit = (padIndex, velocity) => {
  // Trigger pad exactly as if clicked — velocity scales volume
  engine.init();
  const buf = bank.getBuffer(padIndex);
  if (buf && bank.isAudible(padIndex)) {
    const slot = bank.getSample(padIndex);
    engine.playSample({
      buffer:     buf,
      pitch:      slot.pitch,
      volume:     slot.volume * velocity,
      sendLevels: slot.sendLevels,
      padIndex,
    });
  }
  const padEl = pads[padIndex];
  padEl.classList.add('flash');
  setTimeout(() => padEl.classList.remove('flash'), 120);
  if (seq.isRecording) seq.recordHit(padIndex, velocity);
};

btnMidi.addEventListener('click', async () => {
  if (midi.enabled) {
    midi.disconnect();
    btnMidi.textContent = 'CONNECT';
  } else {
    btnMidi.textContent = '…';
    await midi.connect();
    btnMidi.textContent = midi.enabled ? 'DISCONNECT' : 'CONNECT';
  }
});

// ─── Slicer ───────────────────────────────────────────────────────────────────
const slicerOverlay    = document.getElementById('slicer-overlay');
const slicerCanvas     = document.getElementById('slicer-canvas');
const slicerFileInput  = document.getElementById('slicer-file-input');
const slicerDropZone   = document.getElementById('slicer-drop-zone');
const slicerFilename   = document.getElementById('slicer-filename');
const slicerPadBtns    = Array.from(document.querySelectorAll('.slicer-pad-btn'));
const slicerModeSingle = document.getElementById('slicer-mode-single');
const slicerModeChop   = document.getElementById('slicer-mode-chop');
const slicerDetectCtrl = document.getElementById('slicer-detect-controls');
const slicerDetectBtn  = document.getElementById('slicer-detect');
const slicerSensSlider = document.getElementById('slicer-sensitivity');
const slicerClearMkrs  = document.getElementById('slicer-clear-markers');
const slicerMkrCount   = document.getElementById('slicer-marker-count');
const slicerLoopBtn    = document.getElementById('slicer-loop');
const slicerAssignAll  = document.getElementById('slicer-assign-all');
const slicerHint       = document.getElementById('slicer-hint');
let   slicerRaf        = null;

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
  _updateMarkerCount();
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
slicerCanvas.addEventListener('mousedown',  (e) => { slicer.onMouseDown(slicerCanvas, e); });
slicerCanvas.addEventListener('mousemove',  (e) => slicer.onMouseMove(slicerCanvas, e));
slicerCanvas.addEventListener('mouseup',    ()  => slicer.onMouseUp());
slicerCanvas.addEventListener('mouseleave', ()  => slicer.onMouseUp());
slicerCanvas.addEventListener('dblclick',   (e) => slicer.onDoubleClick(slicerCanvas, e));
slicerCanvas.addEventListener('contextmenu',(e) => { e.preventDefault(); /* handled in slicer */ });

// Scroll wheel → zoom
slicerCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const cur    = parseFloat(document.getElementById('slicer-zoom').value);
  const factor = e.deltaY > 0 ? 0.85 : 1.18;
  const next   = Math.max(1, Math.min(32, cur * factor));
  document.getElementById('slicer-zoom').value = next;
  slicer.setZoom(next);
}, { passive: false });

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

// ── Mode toggle ────────────────────────────────────────────────────────────
function _setSlicerMode(mode) {
  slicer.setMode(mode);
  slicerModeSingle.classList.toggle('active', mode === 'single');
  slicerModeChop.classList.toggle('active',   mode === 'chop');
  const isChop = mode === 'chop';
  slicerAssignAll.classList.toggle('hidden', !isChop);
  slicerHint.textContent = isChop
    ? 'dbl-click = add marker · right-click = remove · drag = move'
    : 'drag handles to trim · drag region to move';
  _updateMarkerCount();
}

slicerModeSingle.addEventListener('click', () => _setSlicerMode('single'));
slicerModeChop.addEventListener(  'click', () => _setSlicerMode('chop'));

// ── Transient detection ─────────────────────────────────────────────────────
slicer.onMarkersChanged = _updateMarkerCount;

function _updateMarkerCount() {
  const n = slicer.sliceCount;
  slicerMkrCount.textContent = `${n} SLICE${n !== 1 ? 'S' : ''}`;
  slicerAssignAll.classList.toggle('hidden', slicer.mode !== 'chop' || n < 2);
}

slicerDetectBtn.addEventListener('click', () => {
  engine.init();
  if (!slicer.buffer) return;
  const sens = parseFloat(slicerSensSlider.value);
  const n    = slicer.detectTransients(sens, 0.07);
  _setSlicerMode('chop');
  displayInfo.textContent = `${n} SLICES`;
});

slicerClearMkrs.addEventListener('click', () => {
  slicer.clearMarkers();
  _updateMarkerCount();
});

// ── Playback ────────────────────────────────────────────────────────────────
document.getElementById('slicer-play').addEventListener('click', () => {
  engine.init();
  slicer.playRegion(false);
  slicerLoopBtn.classList.remove('loop-active');
});

slicerLoopBtn.addEventListener('click', () => {
  engine.init();
  if (slicer.isPlaying && slicer._looping) {
    slicer.stopRegion();
    slicerLoopBtn.classList.remove('loop-active');
  } else {
    slicer.playRegion(true);
    slicerLoopBtn.classList.add('loop-active');
  }
});

document.getElementById('slicer-stop').addEventListener('click', () => {
  slicer.stopRegion();
  slicerLoopBtn.classList.remove('loop-active');
});

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
    btn.classList.add('just-sent');
    setTimeout(() => btn.classList.remove('just-sent'), 600);
    displayInfo.textContent = `PAD ${padIndex + 1} SET`;
  });
});

// Assign All: distributes chop slices → pads 1-12 in order
slicerAssignAll.addEventListener('click', () => {
  if (!slicer.buffer) return;
  const count = slicer.assignAllToPads();
  syncSlicerPadStates();
  displayInfo.textContent = `${count} PADS SET`;
  // Flash all assigned pad buttons
  slicerPadBtns.slice(0, count).forEach((btn, i) => {
    setTimeout(() => {
      btn.classList.add('just-sent');
      setTimeout(() => btn.classList.remove('just-sent'), 500);
    }, i * 60);
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

// ─── Auth + Cloud ─────────────────────────────────────────────────────────────
const authBtn       = document.getElementById('auth-btn');
const authModal     = document.getElementById('auth-modal');
const authClose     = document.getElementById('auth-close');
const authForm      = document.getElementById('auth-form');
const authEmailInp  = document.getElementById('auth-email');
const authPassInp   = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('btn-auth-submit');
const authError     = document.getElementById('auth-error');
const authNote      = document.getElementById('auth-note');
const authTabs      = Array.from(document.querySelectorAll('.auth-tab'));
const btnGoogle     = document.getElementById('btn-google');
const authTitle     = document.getElementById('auth-modal-title');

const cloudModal         = document.getElementById('cloud-modal');
const cloudClose         = document.getElementById('cloud-close');
const cloudUserLabel     = document.getElementById('cloud-user-label');
const btnSignout         = document.getElementById('btn-signout');
const cloudTabs          = Array.from(document.querySelectorAll('.cloud-tab'));
const cloudProjectsPanel = document.getElementById('cloud-projects-panel');
const cloudSamplesPanel  = document.getElementById('cloud-samples-panel');
const cloudProjectsList  = document.getElementById('cloud-projects-list');
const cloudSamplesList   = document.getElementById('cloud-samples-list');
const btnCloudSave       = document.getElementById('btn-cloud-save');
const cloudSaveStatus    = document.getElementById('cloud-save-status');
const btnCloudUpSample   = document.getElementById('btn-cloud-upload-sample');
const cloudUploadStatus  = document.getElementById('cloud-upload-status');
const uploadPadNum       = document.getElementById('upload-pad-num');
const btnCloud           = document.getElementById('btn-cloud');

let _authMode = 'signin'; // 'signin' | 'register'

// Bootstrap Supabase lazily so the SDK only loads when actually used
async function _ensureSupabase() {
  if (auth._sb) return true;
  if (!SUPABASE_ENABLED) return false;
  const sb = await getSupabase();
  if (!sb) return false;
  auth._sb  = sb;
  cloud._sb = sb;
  await auth.init();
  return true;
}

function _syncAuthUI() {
  if (auth.isLoggedIn) {
    authBtn.textContent = auth.userInitial;
    authBtn.classList.add('logged-in');
    authBtn.title = auth.userEmail;
    btnCloud.classList.add('cloud-active');
    cloudUserLabel.textContent = auth.userEmail;
  } else {
    authBtn.textContent = 'SIGN IN';
    authBtn.classList.remove('logged-in');
    authBtn.title = 'Sign in for cloud save';
    btnCloud.classList.remove('cloud-active');
  }
}

auth.onAuthChange = (_user) => { _syncAuthUI(); };

// Auth button: open auth modal if logged out, cloud modal if logged in
authBtn.addEventListener('click', async () => {
  engine.init();
  if (auth.isLoggedIn) {
    _openCloudModal();
  } else {
    await _ensureSupabase();
    if (!SUPABASE_ENABLED) {
      displayInfo.textContent = 'NO CONFIG';
      return;
    }
    authModal.classList.remove('hidden');
  }
});

authClose.addEventListener('click', () => authModal.classList.add('hidden'));
authModal.addEventListener('click', (e) => { if (e.target === authModal) authModal.classList.add('hidden'); });

// Tab switch
authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    _authMode = tab.dataset.tab;
    authTabs.forEach(t => t.classList.toggle('active', t === tab));
    authSubmitBtn.textContent = _authMode === 'signin' ? 'SIGN IN' : 'CREATE ACCOUNT';
    authTitle.textContent     = _authMode === 'signin' ? 'SIGN IN' : 'REGISTER';
    authError.textContent     = '';
    authNote.textContent      = '';
  });
});

// Google sign-in
btnGoogle.addEventListener('click', async () => {
  authError.textContent = '';
  try { await auth.signInWithGoogle(); }
  catch (e) { authError.textContent = e.message; }
});

// Email/password submit
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.textContent = '';
  authNote.textContent  = '';
  const email    = authEmailInp.value.trim();
  const password = authPassInp.value;
  try {
    if (_authMode === 'signin') {
      await auth.signInWithEmail(email, password);
      authModal.classList.add('hidden');
      displayInfo.textContent = 'SIGNED IN';
    } else {
      await auth.signUpWithEmail(email, password);
      authNote.textContent = 'CHECK YOUR EMAIL TO CONFIRM';
    }
  } catch (err) {
    authError.textContent = err.message.toUpperCase().slice(0, 50);
  }
});

// ── Cloud modal ────────────────────────────────────────────────────────────────

async function _openCloudModal() {
  if (!auth.isLoggedIn) { authModal.classList.remove('hidden'); return; }
  cloudModal.classList.remove('hidden');
  _refreshCloudProjects();
}

cloudClose.addEventListener('click', () => cloudModal.classList.add('hidden'));
cloudModal.addEventListener('click', (e) => { if (e.target === cloudModal) cloudModal.classList.add('hidden'); });

// Cloud tab switch
cloudTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    cloudTabs.forEach(t => t.classList.toggle('active', t === tab));
    cloudProjectsPanel.classList.toggle('hidden', tab.dataset.tab !== 'projects');
    cloudSamplesPanel.classList.toggle( 'hidden', tab.dataset.tab !== 'samples');
    if (tab.dataset.tab === 'samples') _refreshCloudSamples();
  });
});

// Cloud button (in project controls)
btnCloud.addEventListener('click', async () => {
  engine.init();
  await _ensureSupabase();
  if (!auth.isLoggedIn) {
    authModal.classList.remove('hidden');
  } else {
    _openCloudModal();
  }
});

// Sign out
btnSignout.addEventListener('click', async () => {
  await auth.signOut();
  cloudModal.classList.add('hidden');
  _syncAuthUI();
  displayInfo.textContent = 'SIGNED OUT';
});

// Save current project to cloud
btnCloudSave.addEventListener('click', async () => {
  cloudSaveStatus.textContent = 'SAVING…';
  try {
    const name = prompt('Project name:', 'My Beat') || 'Untitled';
    const json = await project.toJSON(name);
    await cloud.saveProject(name, json);
    cloudSaveStatus.textContent = 'SAVED ✓';
    displayInfo.textContent = 'CLOUD SAVED';
    _refreshCloudProjects();
    setTimeout(() => cloudSaveStatus.textContent = '', 3000);
  } catch (err) {
    cloudSaveStatus.textContent = err.message.slice(0, 30);
  }
});

// Refresh projects list
async function _refreshCloudProjects() {
  cloudProjectsList.innerHTML = '<span class="cloud-empty">Loading…</span>';
  try {
    const projects = await cloud.listProjects();
    if (!projects.length) {
      cloudProjectsList.innerHTML = '<span class="cloud-empty">No projects yet — save one above.</span>';
      return;
    }
    cloudProjectsList.innerHTML = '';
    for (const p of projects) {
      const date   = new Date(p.updated_at).toLocaleDateString();
      const sizeKB = p.size_bytes ? `${Math.round(p.size_bytes / 1024)}KB` : '';
      const row    = document.createElement('div');
      row.className = 'cloud-row';
      row.innerHTML = `
        <span class="cloud-row-name" title="${p.name}">${p.name}</span>
        <span class="cloud-row-meta">${date} ${sizeKB}</span>
        <div class="cloud-row-actions">
          <button class="cloud-row-btn load" data-id="${p.id}">LOAD</button>
          <button class="cloud-row-btn delete" data-id="${p.id}" title="Delete">✕</button>
        </div>
      `;
      row.querySelector('.load').addEventListener('click', async () => {
        cloudSaveStatus.textContent = 'LOADING…';
        try {
          const data = await cloud.loadProject(p.id);
          await project.loadFromData(data, { onPadLoaded: (i) => drawWaveform(i) });
          selectPad(0); updateStepGrid(); renderSongChain();
          displayInfo.textContent = p.name.toUpperCase().slice(0, 8);
          cloudModal.classList.add('hidden');
          cloudSaveStatus.textContent = '';
        } catch (e) { cloudSaveStatus.textContent = e.message.slice(0, 30); }
      });
      row.querySelector('.delete').addEventListener('click', async () => {
        if (!confirm(`Delete "${p.name}"?`)) return;
        await cloud.deleteProject(p.id);
        _refreshCloudProjects();
      });
      cloudProjectsList.appendChild(row);
    }
  } catch (err) {
    cloudProjectsList.innerHTML = `<span class="cloud-empty">${err.message}</span>`;
  }
}

// Refresh samples list
async function _refreshCloudSamples() {
  cloudSamplesList.innerHTML = '<span class="cloud-empty">Loading…</span>';
  uploadPadNum.textContent   = (activePad ?? 0) + 1;
  try {
    const samples = await cloud.listSamples();
    if (!samples.length) {
      cloudSamplesList.innerHTML = '<span class="cloud-empty">No samples yet — upload one above.</span>';
      return;
    }
    cloudSamplesList.innerHTML = '';
    for (const s of samples) {
      const dur = s.duration_s ? `${s.duration_s.toFixed(2)}s` : '';
      const row = document.createElement('div');
      row.className = 'cloud-row';
      row.innerHTML = `
        <span class="cloud-row-name" title="${s.name}">${s.name}</span>
        <span class="cloud-row-meta">${dur}</span>
        <div class="cloud-row-actions">
          <button class="cloud-row-btn load" data-path="${s.storage_path}" data-name="${s.name}">→ PAD</button>
          <button class="cloud-row-btn delete" data-id="${s.id}" title="Delete">✕</button>
        </div>
      `;
      row.querySelector('.load').addEventListener('click', async () => {
        try {
          const buf = await cloud.downloadSample(s.storage_path);
          const target = activePad ?? 0;
          bank.setSample(target, buf, s.name);
          selectPad(target);
          displayInfo.textContent = s.name.toUpperCase().slice(0, 8);
          cloudModal.classList.add('hidden');
        } catch (e) { cloudUploadStatus.textContent = e.message.slice(0, 30); }
      });
      row.querySelector('.delete').addEventListener('click', async () => {
        if (!confirm(`Delete "${s.name}"?`)) return;
        await cloud.deleteSample(s.id);
        _refreshCloudSamples();
      });
      cloudSamplesList.appendChild(row);
    }
  } catch (err) {
    cloudSamplesList.innerHTML = `<span class="cloud-empty">${err.message}</span>`;
  }
}

// Upload current pad's sample to cloud
btnCloudUpSample.addEventListener('click', async () => {
  const target = activePad ?? 0;
  const slot   = bank.getSample(target);
  if (!slot?.buffer) { cloudUploadStatus.textContent = 'NO SAMPLE ON PAD'; return; }
  cloudUploadStatus.textContent = 'UPLOADING…';
  try {
    await cloud.uploadSample(slot.name || `PAD ${target + 1}`, slot.buffer);
    cloudUploadStatus.textContent = 'UPLOADED ✓';
    _refreshCloudSamples();
    setTimeout(() => cloudUploadStatus.textContent = '', 3000);
  } catch (e) { cloudUploadStatus.textContent = e.message.slice(0, 30); }
});

// Boot Supabase in the background (no blocking)
_ensureSupabase().then(() => { if (auth.isLoggedIn) _syncAuthUI(); });

// ─── Panel switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.panel-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    document.querySelectorAll('.panel-content').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'panel-' + panel);
      p.classList.toggle('active', p.id === 'panel-' + panel);
    });
    document.querySelectorAll('.panel-tab-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
  });
});

// ─── Sample list (Library panel) ──────────────────────────────────────────────
function refreshSampleList() {
  const list = document.getElementById('sample-list');
  if (!list) return;
  list.innerHTML = '';
  let hasAny = false;
  for (let i = 0; i < 12; i++) {
    const slot = bank.getSample(i);
    if (!slot) continue;
    hasAny = true;
    const grp = 'ABCD'[Math.floor(i / 3)];
    const num = (i % 3) + 1;
    const row = document.createElement('div');
    row.className = 'sample-row' + (i === activePad ? ' selected' : '');
    row.innerHTML =
      `<span class="sr-grp">${grp}</span>` +
      `<span class="sr-num">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="sr-name">${slot.name.toUpperCase().slice(0, 14)}</span>` +
      `<span class="sr-key">${['A','S','D','F','G','H','J','K','Z','X','C','V'][i]}</span>`;
    row.addEventListener('click', () => selectPad(i));
    list.appendChild(row);
  }
  if (!hasAny) {
    list.innerHTML = '<div class="sample-empty">DROP SAMPLES ON PADS</div>';
  }
}

// Hook into the already-wrapped bank.onChange
const _origOnChange2 = bank.onChange;
bank.onChange = (padIndex) => {
  if (_origOnChange2) _origOnChange2(padIndex);
  refreshSampleList();
};

// ─── Init ─────────────────────────────────────────────────────────────────────
displayBPM.textContent = String(seq.bpm).padStart(3, '0');
bpmValue.textContent   = seq.bpm;
bpmSlider.value        = seq.bpm;
groupBtns[0].classList.add('active');
applyStepLength(8);
selectPad(0);
refreshSampleList();
