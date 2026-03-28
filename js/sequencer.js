/**
 * Sequencer — lookahead scheduler, 4 groups × 12 patterns × 16 steps.
 * Uses the "clock worker" pattern for accurate timing independent of JS event loop.
 *
 * Swing: delays every odd-numbered 16th note by (swing × stepDuration).
 *   swing = 0   → no swing (straight 16ths)
 *   swing = 0.17 → subtle groove
 *   swing = 0.33 → classic triplet shuffle (66% feel)
 *   swing = 0.5  → maximum swing
 */
export class Sequencer {
  constructor(engine) {
    this.engine = engine;

    this.bpm            = 120;
    this.stepsPerPattern = 16;
    this.swing          = 0;        // ← NEW: 0.0 – 0.5
    this.currentStep    = 0;
    this.isPlaying      = false;
    this.isRecording    = false;

    // 4 groups (A-D), each group has 12 pads, each pad has 16 steps
    this.groups = Array.from({ length: 4 }, () =>
      Array.from({ length: 12 }, () =>
        Array.from({ length: 16 }, () => ({ active: false, volume: 1.0, pitch: 1.0, sendLevels: {} }))
      )
    );

    this.activeGroup = 0;

    // Lookahead scheduling state
    this._nextStepTime     = 0;
    this._evenGridTime     = 0;    // ← NEW: backbone "even-step" clock for swing
    this._scheduleAheadTime = 0.1;
    this._lookaheadMs      = 25;
    this._timerID          = null;

    // Callbacks
    this.onStep = null;
    this.onPlay = null;
    this.onStop = null;
  }

  get stepDuration() {
    return (60 / this.bpm) / 4; // 16th note in seconds
  }

  start() {
    if (this.isPlaying) return;
    this.engine.init();
    this.isPlaying     = true;
    this.currentStep   = 0;
    const startTime    = this.engine.currentTime + 0.05;
    this._evenGridTime = startTime;
    this._nextStepTime = startTime;
    this._timerID      = setInterval(() => this._scheduler(), this._lookaheadMs);
    this.engine.updateDelayForBPM(this.bpm);
    if (this.onPlay) this.onPlay();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying   = false;
    this.isRecording = false;
    clearInterval(this._timerID);
    this._timerID    = null;
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

  /** Set swing (0 = straight, 0.5 = max shuffle) */
  setSwing(value) {
    this.swing = Math.max(0, Math.min(0.5, value));
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
    const s    = this.groups[this.activeGroup][pad][step];
    s.active   = true;
    s.volume   = volume;
    s.pitch    = pitch;
  }

  clearPattern(group) {
    this.groups[group] = Array.from({ length: 12 }, () =>
      Array.from({ length: 16 }, () => ({ active: false, volume: 1.0, pitch: 1.0, sendLevels: {} }))
    );
  }

  /** Inject sample resolver from app */
  setSampleResolver(fn) {
    this._sampleForPad = fn;
  }

  /** Inject bank reference so sequencer can honour mute/solo */
  setBank(bank) {
    this._bank = bank;
  }

  // ── private ──────────────────────────────────────────────────────────────

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
      if (!s.active)                                         continue;
      if (this._bank && !this._bank.isAudible(pad))          continue;
      if (!this._sampleForPad)                               continue;
      const buf = this._sampleForPad(pad);
      if (!buf)                                              continue;

      this.engine.playSample({
        buffer:     buf,
        when:       time,
        pitch:      s.pitch,
        volume:     s.volume,
        sendLevels: s.sendLevels,
        padIndex:   pad,
      });
    }
    // Notify UI on next animation frame
    const snap = step;
    setTimeout(() => { if (this.onStep) this.onStep(snap); }, 0);
  }

  /**
   * Advance the clock to the next step, applying swing.
   *
   * Even steps (0, 2, 4…) always fire exactly on the grid.
   * Odd steps  (1, 3, 5…) are delayed by (swing × stepDuration).
   *
   * Total duration of each even+odd pair stays 2 × stepDuration,
   * so overall tempo is unaffected.
   */
  _advance() {
    if (this.currentStep % 2 === 0) {
      // Current step is even → next step is odd (will be swung)
      const swingDelay   = this.swing * this.stepDuration;
      this._nextStepTime = this._evenGridTime + this.stepDuration + swingDelay;
    } else {
      // Current step is odd → next step is even (back on grid)
      this._evenGridTime += 2 * this.stepDuration;
      this._nextStepTime  = this._evenGridTime;
    }
    this.currentStep = (this.currentStep + 1) % this.stepsPerPattern;
  }
}
