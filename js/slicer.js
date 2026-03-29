/**
 * Slicer — Sprint C upgrade.
 *
 * MODES
 *   'single'  — classic 2-handle trim. Sends one slice to one pad.
 *   'chop'    — N internal markers divide the audio into N+1 slices.
 *               Each slice can be sent individually or all at once.
 *
 * NEW FEATURES
 *   • Multi-marker chop mode (double-click = add, right-click = remove)
 *   • Transient / onset detection  (detectTransients)
 *   • Continuous loop preview      (playRegion with loop flag)
 *   • Scroll-wheel zoom            (handled in app.js via setZoom)
 */
export class Slicer {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank   = bank;

    this.buffer   = null;
    this.filename = '';

    // ── Single mode ──────────────────────────────────────────────────────────
    this.selStart = 0.0;
    this.selEnd   = 0.2;

    // ── Chop mode ────────────────────────────────────────────────────────────
    /** Internal boundary positions, 0-exclusive 1-exclusive, always sorted */
    this.markers = [];
    this._activeSliceIdx = 0;

    // ── Mode ─────────────────────────────────────────────────────────────────
    this.mode = 'single'; // 'single' | 'chop'

    // ── View window (zoom/pan) ───────────────────────────────────────────────
    this.viewStart = 0;
    this.viewEnd   = 1;

    // ── Drag state ───────────────────────────────────────────────────────────
    this._drag              = null;  // 'start'|'end'|'region'|'marker'
    this._dragAnchor        = 0;
    this._dragSelStartAnchor = 0;
    this._dragSelEndAnchor   = 0;
    this._dragMarkerIdx     = null;

    // ── Playback ─────────────────────────────────────────────────────────────
    this._playSource         = null;
    this._playStartAudioTime = 0;
    this._playStartNorm      = 0;
    this._looping            = false;
    this.isPlaying           = false;

    // ── Animation ────────────────────────────────────────────────────────────
    this._raf = null;

    // ── Callbacks set by app ─────────────────────────────────────────────────
    this.onClose          = null;
    this.onMarkersChanged = null; // () => void — update marker count badge
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  loadBuffer(buffer, filename) {
    this.buffer    = buffer;
    this.filename  = filename;
    this.selStart  = 0;
    this.selEnd    = Math.min(1, 4 / buffer.duration);
    this.viewStart = 0;
    this.viewEnd   = 1;
    this.markers   = [];
    this._activeSliceIdx = 0;
    this.stopRegion();
  }

  // ── Mode ────────────────────────────────────────────────────────────────────

  setMode(mode) {
    if (mode !== 'single' && mode !== 'chop') return;
    this.mode = mode;
    this.stopRegion();
    if (this.onMarkersChanged) this.onMarkersChanged();
  }

  // ── Chop / marker API ───────────────────────────────────────────────────────

  /** Add an internal marker at normalised position (clamped away from edges) */
  addMarker(norm) {
    norm = Math.max(0.002, Math.min(0.998, norm));
    // Avoid duplicates within 2px equivalent (~0.001)
    if (this.markers.some(m => Math.abs(m - norm) < 0.002)) return;
    this.markers.push(norm);
    this.markers.sort((a, b) => a - b);
    if (this.onMarkersChanged) this.onMarkersChanged();
  }

  /** Remove an internal marker by its index in the sorted markers array */
  removeMarker(idx) {
    if (idx < 0 || idx >= this.markers.length) return;
    this.markers.splice(idx, 1);
    this._activeSliceIdx = Math.min(this._activeSliceIdx, this.sliceCount - 1);
    if (this.onMarkersChanged) this.onMarkersChanged();
  }

  clearMarkers() {
    this.markers = [];
    this._activeSliceIdx = 0;
    if (this.onMarkersChanged) this.onMarkersChanged();
  }

  /** Returns array of { start, end, index } for all slices */
  getSlices() {
    const bounds = [0, ...this.markers, 1];
    const out = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      out.push({ start: bounds[i], end: bounds[i + 1], index: i });
    }
    return out;
  }

  get sliceCount() { return this.markers.length + 1; }

  get activeSlice() {
    const s = this.getSlices();
    return s[this._activeSliceIdx] ?? s[0];
  }

  /** Assign all chop slices to pads 0..N, returns count assigned */
  assignAllToPads() {
    if (!this.buffer) return 0;
    const slices = this.getSlices();
    let count = 0;
    slices.forEach((sl, i) => {
      if (i >= 12) return; // max 12 pads
      const buf   = this._sliceBuffer(sl.start, sl.end);
      const dur   = ((sl.end - sl.start) * this.buffer.duration).toFixed(2);
      const label = `${this.filename.replace(/\.[^.]+$/, '').slice(0, 8)}·${i + 1}`;
      this.bank.setSample(i, buf, label);
      count++;
    });
    return count;
  }

  // ── Transient / onset detection ─────────────────────────────────────────────

  /**
   * Detect drum onsets via RMS energy derivative.
   * @param {number} sensitivity  0 (very sensitive) – 1 (only loud hits). Default 0.3.
   * @param {number} minGapSec    Minimum distance between detected onsets. Default 0.08s.
   * @returns {number} Number of slices created.
   */
  detectTransients(sensitivity = 0.3, minGapSec = 0.08) {
    if (!this.buffer) return 0;

    const data    = this.buffer.getChannelData(0);
    const sr      = this.buffer.sampleRate;
    const winSize = 1024;             // ~23ms window at 44.1kHz
    const hopSize = winSize >> 1;     // 50% overlap
    const minHops = Math.max(1, Math.floor((minGapSec * sr) / hopSize));
    const nHops   = Math.floor((data.length - winSize) / hopSize);

    if (nHops < 4) return 0;

    // 1. RMS energy per hop
    const energy = new Float32Array(nHops);
    for (let i = 0; i < nHops; i++) {
      const off = i * hopSize;
      let s = 0;
      for (let j = 0; j < winSize; j++) s += data[off + j] ** 2;
      energy[i] = Math.sqrt(s / winSize);
    }

    // 2. Smooth (simple 3-point average)
    const sm = new Float32Array(nHops);
    sm[0]         = energy[0];
    sm[nHops - 1] = energy[nHops - 1];
    for (let i = 1; i < nHops - 1; i++) {
      sm[i] = (energy[i - 1] + energy[i] * 2 + energy[i + 1]) / 4;
    }

    // 3. Positive first derivative (onset strength)
    const onset = new Float32Array(nHops);
    for (let i = 1; i < nHops; i++) onset[i] = Math.max(0, sm[i] - sm[i - 1]);

    // 4. Adaptive threshold = mean × (1 + k·sensitivity)
    let mean = 0;
    for (let i = 0; i < nHops; i++) mean += onset[i];
    mean /= nHops;
    const k         = 2 + sensitivity * 18; // 2..20
    const threshold = mean * k;

    // 5. Peak-pick above threshold, respecting minimum gap
    const found    = [];
    let   lastHop  = -minHops - 1;
    for (let i = 1; i < nHops - 1; i++) {
      if (
        onset[i] > threshold &&
        onset[i] >= onset[i - 1] &&
        onset[i] >= onset[i + 1] &&
        (i - lastHop) >= minHops
      ) {
        const normPos = (i * hopSize) / data.length;
        // Skip hits extremely close to start/end
        if (normPos > 0.005 && normPos < 0.995) found.push(normPos);
        lastHop = i;
      }
    }

    this.markers = found.sort((a, b) => a - b);
    this._activeSliceIdx = 0;
    this.mode = 'chop';
    if (this.onMarkersChanged) this.onMarkersChanged();
    return this.sliceCount;
  }

  // ── Playback ─────────────────────────────────────────────────────────────────

  /** Play the current selection (single mode) or active slice (chop mode). */
  playRegion(loop = false) {
    if (!this.buffer || !this.engine.ctx) return;
    this.stopRegion();

    const { start, end } = this.mode === 'chop' ? this.activeSlice
                                                 : { start: this.selStart, end: this.selEnd };
    const startSec = start * this.buffer.duration;
    const endSec   = end   * this.buffer.duration;
    const durSec   = endSec - startSec;
    if (durSec <= 0) return;

    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.buffer;

    if (loop) {
      src.loop      = true;
      src.loopStart = startSec;
      src.loopEnd   = endSec;
      src.start(0, startSec);
    } else {
      src.start(0, startSec, durSec);
      src.onended = () => { this.isPlaying = false; this._playSource = null; };
    }

    src.connect(this.engine.compressor);
    this._playSource         = src;
    this._playStartAudioTime = this.engine.ctx.currentTime;
    this._playStartNorm      = start;
    this._looping            = loop;
    this.isPlaying           = true;
  }

  stopRegion() {
    if (this._playSource) {
      try { this._playSource.stop(); } catch (_) {}
      this._playSource = null;
    }
    this.isPlaying = false;
    this._looping  = false;
  }

  toggleLoop() {
    if (this.isPlaying && this._looping) {
      this.stopRegion();
      return false;
    }
    this.playRegion(true);
    return true;
  }

  /** Normalised position of the playhead (0–1 over full buffer) */
  get playheadPos() {
    if (!this.isPlaying || !this.buffer) return null;
    const elapsed = this.engine.ctx.currentTime - this._playStartAudioTime;

    if (this._looping) {
      const { start, end } = this.mode === 'chop' ? this.activeSlice
                                                   : { start: this.selStart, end: this.selEnd };
      const loopDur = (end - start) * this.buffer.duration;
      if (loopDur <= 0) return start;
      return start + ((elapsed % loopDur) / this.buffer.duration);
    }

    return Math.min(
      this.mode === 'chop' ? this.activeSlice.end : this.selEnd,
      this._playStartNorm + elapsed / this.buffer.duration,
    );
  }

  // ── Timing helpers ───────────────────────────────────────────────────────────

  get startTimeSec() {
    if (!this.buffer) return 0;
    const s = this.mode === 'chop' ? this.activeSlice.start : this.selStart;
    return s * this.buffer.duration;
  }
  get endTimeSec() {
    if (!this.buffer) return 0;
    const e = this.mode === 'chop' ? this.activeSlice.end : this.selEnd;
    return e * this.buffer.duration;
  }
  get durSec() { return this.endTimeSec - this.startTimeSec; }

  /** Send active single/chop selection to a pad */
  sendToPad(padIndex) {
    if (!this.buffer) return;
    const { start, end } = this.mode === 'chop' ? this.activeSlice
                                                 : { start: this.selStart, end: this.selEnd };
    const sliced = this._sliceBuffer(start, end);
    const dur    = ((end - start) * this.buffer.duration).toFixed(2);
    const label  = this.filename.replace(/\.[^.]+$/, '').slice(0, 12) + `·${dur}s`;
    this.bank.setSample(padIndex, sliced, label);
  }

  // ── Canvas drawing ───────────────────────────────────────────────────────────

  draw(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    // Background
    ctx.fillStyle = '#0a140a';
    ctx.fillRect(0, 0, W, H);

    if (!this.buffer) {
      ctx.fillStyle = '#1a3a1a';
      ctx.font = '11px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DROP MP3 HERE OR CLICK LOAD', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    // Waveform
    const peaks = this._getPeaks(W, this.viewStart, this.viewEnd);
    const barW  = W / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp  = peaks[i];
      const barH = amp * (H - 4) * 0.88;
      ctx.fillStyle = amp > 0.7  ? '#52ff2a'
                    : amp > 0.4  ? '#2ed40a'
                    : amp > 0.15 ? '#1a9006'
                    :              '#0f5203';
      ctx.fillRect(i * barW, (H - barH) / 2, Math.max(1, barW - 1), barH);
    }

    // Centre line
    ctx.strokeStyle = 'rgba(57,255,20,0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    const toX = (n) => ((n - this.viewStart) / (this.viewEnd - this.viewStart)) * W;

    if (this.mode === 'single') {
      this._drawSingle(ctx, W, H, toX);
    } else {
      this._drawChop(ctx, W, H, toX);
    }

    // Playhead
    const ph = this.playheadPos;
    if (ph !== null) {
      const px = toX(ph);
      if (px >= 0 && px <= W) {
        ctx.strokeStyle = this._looping ? '#00d4ff' : '#ffcc00';
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      }
    }
  }

  _drawSingle(ctx, W, H, toX) {
    const x0 = toX(this.selStart);
    const x1 = toX(this.selEnd);

    // Selection fill
    ctx.fillStyle = 'rgba(255,106,0,0.16)';
    ctx.fillRect(x0, 0, x1 - x0, H);

    // Selection border
    ctx.strokeStyle = 'rgba(255,106,0,0.55)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();

    this._drawHandle(ctx, x0, H, '#ff6a00');
    this._drawHandle(ctx, x1, H, '#ff6a00');
  }

  _drawChop(ctx, W, H, toX) {
    const slices = this.getSlices();
    const colors = [
      'rgba(255,106,0,0.14)',   // orange
      'rgba(0,180,255,0.10)',   // cyan
      'rgba(140,80,255,0.10)',  // purple
      'rgba(57,255,20,0.08)',   // green
    ];

    // Draw each slice region
    slices.forEach((sl, i) => {
      const x0 = toX(sl.start);
      const x1 = toX(sl.end);
      if (x1 < 0 || x0 > W) return; // outside view

      const isActive = i === this._activeSliceIdx;
      ctx.fillStyle = isActive
        ? 'rgba(255,106,0,0.25)'
        : colors[i % colors.length];
      ctx.fillRect(x0, 0, x1 - x0, H);

      // Slice number label
      const lx = Math.max(x0 + 5, 4);
      ctx.font      = `bold 10px "Share Tech Mono", monospace`;
      ctx.fillStyle = isActive ? '#ff6a00' : 'rgba(255,255,255,0.3)';
      ctx.textAlign = 'left';
      if (lx < W - 10) ctx.fillText(i + 1, lx, 14);
    });

    // Draw internal marker handles
    this.markers.forEach((m, idx) => {
      const x = toX(m);
      if (x < -10 || x > W + 10) return;
      ctx.strokeStyle = 'rgba(255,106,0,0.7)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      this._drawHandle(ctx, x, H, '#ff6a00');
    });

    // Outer boundaries (faint)
    [0, 1].forEach(b => {
      const x = toX(b);
      ctx.strokeStyle = 'rgba(57,255,20,0.25)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    });
  }

  _drawHandle(ctx, x, H, color) {
    const s = 8;
    ctx.fillStyle   = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x - s, s * 1.4); ctx.lineTo(x + s, s * 1.4);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, H); ctx.lineTo(x - s, H - s * 1.4); ctx.lineTo(x + s, H - s * 1.4);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ── Mouse interaction ────────────────────────────────────────────────────────

  onMouseDown(canvas, e) {
    if (!this.buffer) return;
    const norm = this._xToNorm(canvas, e.offsetX);

    if (this.mode === 'single') {
      this._singleMouseDown(canvas, e, norm);
    } else {
      this._chopMouseDown(canvas, e, norm);
    }
  }

  _singleMouseDown(canvas, e, norm) {
    const x0   = this._normToX(canvas, this.selStart);
    const x1   = this._normToX(canvas, this.selEnd);
    const SNAP = 12;

    if (Math.abs(e.offsetX - x0) < SNAP) {
      this._drag = 'start';
    } else if (Math.abs(e.offsetX - x1) < SNAP) {
      this._drag = 'end';
    } else if (e.offsetX > x0 && e.offsetX < x1) {
      this._drag = 'region';
      this._dragAnchor         = e.offsetX;
      this._dragSelStartAnchor = this.selStart;
      this._dragSelEndAnchor   = this.selEnd;
    } else {
      if (Math.abs(e.offsetX - x0) < Math.abs(e.offsetX - x1)) {
        this.selStart = Math.max(0, Math.min(this.selEnd - 0.001, norm));
      } else {
        this.selEnd = Math.max(this.selStart + 0.001, Math.min(1, norm));
      }
    }
  }

  _chopMouseDown(canvas, e, norm) {
    // Right-click → remove nearest internal marker
    if (e.button === 2) {
      const idx = this._nearestMarkerIdx(canvas, e.offsetX);
      if (idx !== null) this.removeMarker(idx);
      return;
    }
    const SNAP = 12;

    // Check if near an internal marker → drag it
    const idx = this._nearestMarkerIdx(canvas, e.offsetX);
    if (idx !== null) {
      this._drag           = 'marker';
      this._dragMarkerIdx  = idx;
      return;
    }

    // Otherwise: set active slice from click position
    const slices = this.getSlices();
    for (const sl of slices) {
      if (norm >= sl.start && norm <= sl.end) {
        this._activeSliceIdx = sl.index;
        break;
      }
    }
  }

  onMouseMove(canvas, e) {
    if (!this._drag || !this.buffer) return;
    const norm  = this._xToNorm(canvas, e.offsetX);
    const viewW = this.viewEnd - this.viewStart;

    if (this._drag === 'start') {
      this.selStart = Math.max(this.viewStart, Math.min(this.selEnd - 0.001, norm));
    } else if (this._drag === 'end') {
      this.selEnd = Math.max(this.selStart + 0.001, Math.min(this.viewEnd, norm));
    } else if (this._drag === 'region') {
      const dNorm = ((e.offsetX - this._dragAnchor) / canvas.width) * viewW;
      const dur   = this._dragSelEndAnchor - this._dragSelStartAnchor;
      let ns = this._dragSelStartAnchor + dNorm;
      let ne = this._dragSelEndAnchor   + dNorm;
      if (ns < 0) { ns = 0; ne = dur; }
      if (ne > 1) { ne = 1; ns = 1 - dur; }
      this.selStart = ns;
      this.selEnd   = ne;
    } else if (this._drag === 'marker' && this._dragMarkerIdx !== null) {
      const clamped = Math.max(0.002, Math.min(0.998, norm));
      this.markers[this._dragMarkerIdx] = clamped;
      this.markers.sort((a, b) => a - b);
      if (this.onMarkersChanged) this.onMarkersChanged();
    }
  }

  onMouseUp() { this._drag = null; this._dragMarkerIdx = null; }

  /** Call on dblclick in chop mode to add a marker */
  onDoubleClick(canvas, e) {
    if (this.mode !== 'chop' || !this.buffer) return;
    const norm = this._xToNorm(canvas, e.offsetX);
    this.addMarker(norm);
  }

  // ── Zoom / Pan ───────────────────────────────────────────────────────────────

  zoomToSelection() {
    const s   = this.mode === 'chop' ? this.activeSlice : { start: this.selStart, end: this.selEnd };
    const pad = (s.end - s.start) * 0.2;
    this.viewStart = Math.max(0, s.start - pad);
    this.viewEnd   = Math.min(1, s.end   + pad);
  }

  zoomFull()  { this.viewStart = 0; this.viewEnd = 1; }

  setZoom(level) {
    const mid  = (this.selStart + this.selEnd) / 2;
    const half = 0.5 / Math.max(1, level);
    this.viewStart = Math.max(0, mid - half);
    this.viewEnd   = Math.min(1, mid + half);
    if (this.viewEnd - this.viewStart < 0.001) this.viewEnd = this.viewStart + 0.001;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _xToNorm(canvas, x) {
    return this.viewStart + (x / canvas.width) * (this.viewEnd - this.viewStart);
  }

  _normToX(canvas, norm) {
    return ((norm - this.viewStart) / (this.viewEnd - this.viewStart)) * canvas.width;
  }

  /** Find the index into this.markers whose canvas X is within SNAP px of offsetX */
  _nearestMarkerIdx(canvas, offsetX) {
    const SNAP = 12;
    let best = null, bestDist = SNAP + 1;
    this.markers.forEach((m, i) => {
      const x = this._normToX(canvas, m);
      const d = Math.abs(offsetX - x);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  _getPeaks(numBars, vs, ve) {
    const data      = this.buffer.getChannelData(0);
    const startSmp  = Math.floor(vs * data.length);
    const endSmp    = Math.floor(ve * data.length);
    const blockSize = Math.max(1, Math.floor((endSmp - startSmp) / numBars));
    const peaks     = new Float32Array(numBars);
    for (let i = 0; i < numBars; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const abs = Math.abs(data[startSmp + i * blockSize + j] || 0);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  _sliceBuffer(start, end) {
    const ctx       = this.engine.ctx;
    const s0        = Math.floor(start * this.buffer.length);
    const s1        = Math.floor(end   * this.buffer.length);
    const length    = Math.max(1, s1 - s0);
    const sliced    = ctx.createBuffer(this.buffer.numberOfChannels, length, this.buffer.sampleRate);
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      sliced.copyToChannel(this.buffer.getChannelData(c).subarray(s0, s1), c);
    }
    return sliced;
  }

  _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }

  fmtStart() { return this._fmt(this.startTimeSec); }
  fmtEnd()   { return this._fmt(this.endTimeSec);   }
  fmtDur()   { return this._fmt(this.durSec);       }
}
