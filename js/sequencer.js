/**
 * Sequencer — lookahead scheduler, 4 groups × 12 patterns × 16 steps.
 *
 * New in Sprint B/C:
 *   • Per-step probability (0–1): step fires only if Math.random() < probability
 *   • Song mode: chain groups in order, auto-advance at end of each pattern
 *   • Swing: delays odd-numbered 16th notes by (swing × stepDuration)
 */
export class Sequencer {
  constructor(engine) {
    this.engine = engine;

    this.bpm             = 120;
    this.stepsPerPattern = 16;
    this.swing           = 0;      // 0.0 – 0.5
    this.currentStep     = 0;
    this.isPlaying       = false;
    this.isRecording     = false;

    // 4 groups (A-D), each: 12 pads × 16 steps
    // step: { active, volume, pitch, sendLevels, probability }
    this.groups = Array.from({ length: 4 }, () =>
      Array.from({ length: 12 }, () =>
        Array.from({ length: 16 }, () => ({
          active:      false,
          volume:      1.0,
          pitch:       1.0,
          sendLevels:  {},
          probability: 1.0,   // ← NEW: 1 = always, 0.5 = 50% chance
        }))
      )
    );

    this.activeGroup = 0;

    // ── Song mode ────────────────────────────────────────────────────────────
    this.songMode      = false;    // ← NEW
    this.songChain     = [];       // ← NEW: e.g. [0, 1, 0, 2]
    this._songPos      = 0;

    // Lookahead state
    this._nextStepTime      = 0;
    this._evenGridTime      = 0;
    this._scheduleAheadTime = 0.1;
    this._lookaheadMs       = 25;
    this._timerID           = null;

    // Callbacks
    this.onStep        = null;   // (step) => void
    this.onPlay        = null;
    this.onStop        = null;
    this.onGroupChange = null;   // ← NEW: (groupIndex) => void
  }

  get stepDuration() { return (60 / this.bpm) / 4; }

  start() {
    if (this.isPlaying) return;
    this.engine.init();
    this.isPlaying     = true;
    this.currentStep   = 0;
    this._songPos      = 0;
    const t            = this.engine.currentTime + 0.05;
    this._evenGridTime = t;
    this._nextStepTime = t;
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

  toggle() { this.isPlaying ? this.stop() : this.start(); }

  setBPM(bpm) {
    this.bpm = Math.max(40, Math.min(300, bpm));
    this.engine.updateDelayForBPM(this.bpm);
  }

  setGroup(g) { this.activeGroup = Math.max(0, Math.min(3, g)); }

  setSwing(value) { this.swing = Math.max(0, Math.min(0.5, value)); }

  // ── Song mode ──────────────────────────────────────────────────────────────

  toggleSongMode() {
    this.songMode = !this.songMode;
    if (this.songMode && this.songChain.length === 0) {
      // Seed chain with current group
      this.songChain.push(this.activeGroup);
    }
    this._songPos = 0;
    return this.songMode;
  }

  setSongChain(chain) { this.songChain = chain.slice(); }

  addChainSlot(groupIndex = -1) {
    if (this.songChain.length >= 16) return;
    this.songChain.push(groupIndex >= 0 ? groupIndex : this.activeGroup);
  }

  removeChainSlot(pos) {
    this.songChain.splice(pos, 1);
    if (this._songPos >= this.songChain.length) this._songPos = 0;
  }

  setChainSlot(pos, groupIndex) {
    if (pos < this.songChain.length) this.songChain[pos] = groupIndex;
  }

  // ── Per-step probability ───────────────────────────────────────────────────

  /** Cycle step probability: 1 → 0.75 → 0.5 → 0.25 → 1 */
  cycleStepProbability(group, pad, step) {
    const s   = this.groups[group][pad][step];
    const map = [1, 0.75, 0.5, 0.25];
    const idx = map.findIndex(v => Math.abs(v - (s.probability ?? 1)) < 0.01);
    s.probability = map[(idx + 1) % map.length];
    return s.probability;
  }

  setStepProbability(group, pad, step, value) {
    this.groups[group][pad][step].probability = Math.max(0.05, Math.min(1, value));
  }

  // ── Pattern ops ───────────────────────────────────────────────────────────

  toggleStep(group, pad, step) {
    const s  = this.groups[group][pad][step];
    s.active = !s.active;
    if (s.active) s.probability = 1.0; // reset probability on re-enable
    return s.active;
  }

  setStep(group, pad, step, data) {
    Object.assign(this.groups[group][pad][step], data);
  }

  recordHit(pad, volume = 1.0, pitch = 1.0) {
    if (!this.isRecording || !this.isPlaying) return;
    const s      = this.groups[this.activeGroup][pad][this.currentStep];
    s.active     = true;
    s.volume     = volume;
    s.pitch      = pitch;
    s.probability = 1.0;
  }

  clearPattern(group) {
    this.groups[group] = Array.from({ length: 12 }, () =>
      Array.from({ length: 16 }, () => ({
        active: false, volume: 1.0, pitch: 1.0, sendLevels: {}, probability: 1.0,
      }))
    );
  }

  setSampleResolver(fn) { this._sampleForPad = fn; }
  setBank(bank)         { this._bank = bank; }

  // ── Private ────────────────────────────────────────────────────────────────

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
      if (!s.active)                                        continue;
      if (this._bank && !this._bank.isAudible(pad))         continue;

      // ── Probability gate ────────────────────────────────────────────────
      const prob = s.probability ?? 1;
      if (prob < 1 && Math.random() > prob)                 continue;

      if (!this._sampleForPad)                              continue;
      const buf = this._sampleForPad(pad);
      if (!buf)                                             continue;

      // ── Mute group: cut peers before playing ────────────────────────────
      if (this._bank) {
        const peers = this._bank.getMuteGroupPeers(pad);
        for (const peer of peers) this.engine.stopPad(peer, time);
      }

      this.engine.playSample({
        buffer:     buf,
        when:       time,
        pitch:      s.pitch,
        volume:     s.volume,
        sendLevels: s.sendLevels,
        padIndex:   pad,
      });
    }
    const snap = step;
    setTimeout(() => { if (this.onStep) this.onStep(snap); }, 0);
  }

  _advance() {
    // Swing grid
    if (this.currentStep % 2 === 0) {
      const swingDelay   = this.swing * this.stepDuration;
      this._nextStepTime = this._evenGridTime + this.stepDuration + swingDelay;
    } else {
      this._evenGridTime += 2 * this.stepDuration;
      this._nextStepTime  = this._evenGridTime;
    }

    this.currentStep = (this.currentStep + 1) % this.stepsPerPattern;

    // ── Song mode: advance group at end of pattern ─────────────────────────
    if (this.currentStep === 0 && this.songMode && this.songChain.length > 0) {
      this._songPos    = (this._songPos + 1) % this.songChain.length;
      this.activeGroup = this.songChain[this._songPos];
      if (this.onGroupChange) this.onGroupChange(this.activeGroup);
    }
  }
}
