/**
 * Sequencer — lookahead scheduler, 4 groups × 12 patterns × 16 steps.
 * Uses the "clock worker" pattern for accurate timing independent of JS event loop.
 */
export class Sequencer {
  constructor(engine) {
    this.engine = engine;

    this.bpm = 120;
    this.stepsPerPattern = 16;
    this.currentStep = 0;
    this.isPlaying = false;
    this.isRecording = false;

    // 4 groups (A-D), each group has 12 pads, each pad has 16 steps
    // groups[g][pad][step] = { active, volume, pitch, sendLevels }
    this.groups = Array.from({ length: 4 }, () =>
      Array.from({ length: 12 }, () =>
        Array.from({ length: 16 }, () => ({ active: false, volume: 1.0, pitch: 1.0, sendLevels: {} }))
      )
    );

    this.activeGroup = 0;

    // Lookahead scheduling state
    this._nextStepTime = 0;
    this._scheduleAheadTime = 0.1; // seconds
    this._lookaheadMs = 25;        // how often to run scheduler
    this._timerID = null;

    // Callbacks
    this.onStep = null;   // (step) => void
    this.onPlay = null;
    this.onStop = null;
  }

  get stepDuration() {
    return (60 / this.bpm) / 4; // 16th note
  }

  start() {
    if (this.isPlaying) return;
    this.engine.init();
    this.isPlaying = true;
    this.currentStep = 0;
    this._nextStepTime = this.engine.currentTime + 0.05;
    this._timerID = setInterval(() => this._scheduler(), this._lookaheadMs);
    this.engine.updateDelayForBPM(this.bpm);
    if (this.onPlay) this.onPlay();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.isRecording = false;
    clearInterval(this._timerID);
    this._timerID = null;
    this.currentStep = 0;
    if (this.onStop) this.onStop();
  }

  toggle() {
    this.isPlaying ? this.stop() : this.start();
  }

  setBPM(bpm) {
    this.bpm = Math.max(40, Math.min(300, bpm));
    this.engine.updateDelayForBPM(this.bpm);
  }

  setGroup(g) {
    this.activeGroup = g;
  }

  toggleStep(group, pad, step) {
    const s = this.groups[group][pad][step];
    s.active = !s.active;
    return s.active;
  }

  setStep(group, pad, step, data) {
    Object.assign(this.groups[group][pad][step], data);
  }

  /** Called when a pad is hit during recording — stamp the nearest step */
  recordHit(pad, volume = 1.0, pitch = 1.0) {
    if (!this.isRecording || !this.isPlaying) return;
    const step = this.currentStep;
    const s = this.groups[this.activeGroup][pad][step];
    s.active = true;
    s.volume = volume;
    s.pitch = pitch;
  }

  clearPattern(group) {
    this.groups[group] = Array.from({ length: 12 }, () =>
      Array.from({ length: 16 }, () => ({ active: false, volume: 1.0, pitch: 1.0, sendLevels: {} }))
    );
  }

  // --- private ---

  _scheduler() {
    while (this._nextStepTime < this.engine.currentTime + this._scheduleAheadTime) {
      this._scheduleStep(this.currentStep, this._nextStepTime);
      this._advance();
    }
  }

  _scheduleStep(step, time) {
    const group = this.groups[this.activeGroup];
    for (let pad = 0; pad < 12; pad++) {
      const s = group[pad][step];
      if (s.active && this._sampleForPad) {
        const buf = this._sampleForPad(pad);
        if (buf) {
          this.engine.playSample({
            buffer: buf,
            when: time,
            pitch: s.pitch,
            volume: s.volume,
            sendLevels: s.sendLevels,
            padIndex: pad,
          });
        }
      }
    }
    // Notify UI on next animation frame
    const stepSnapshot = step;
    setTimeout(() => { if (this.onStep) this.onStep(stepSnapshot); }, 0);
  }

  _advance() {
    this._nextStepTime += this.stepDuration;
    this.currentStep = (this.currentStep + 1) % this.stepsPerPattern;
  }

  /** Inject sample resolver from app */
  setSampleResolver(fn) {
    this._sampleForPad = fn;
  }
}
