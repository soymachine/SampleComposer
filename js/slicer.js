/**
 * Slicer — loads a full audio file, lets the user drag handles to select a
 * region, preview it, and send the slice to any pad in the SampleBank.
 */
export class Slicer {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank   = bank;

    this.buffer   = null;
    this.filename = '';

    // Selection as normalised 0–1 positions
    this.selStart = 0.0;
    this.selEnd   = 0.2;

    // View window for zoom/pan (normalised)
    this.viewStart = 0;
    this.viewEnd   = 1;

    // Drag state
    this._drag      = null;  // 'start' | 'end' | 'region' | 'view'
    this._dragAnchor = 0;    // mouseX at drag start (pixels)
    this._dragSelStartAnchor = 0;
    this._dragSelEndAnchor   = 0;

    // Playback
    this._playSource = null;
    this._playStartAudioTime = 0;
    this._playStartNorm      = 0;
    this.isPlaying = false;

    // Animation
    this._raf = null;

    // Callbacks set by app
    this.onClose = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  loadBuffer(buffer, filename) {
    this.buffer   = buffer;
    this.filename = filename;
    this.selStart = 0;
    this.selEnd   = Math.min(1, 4 / buffer.duration); // default: first 4 s
    this.viewStart = 0;
    this.viewEnd   = 1;
  }

  /** Slice the selected region and assign it to padIndex */
  sendToPad(padIndex) {
    if (!this.buffer) return;
    const sliced = this._sliceBuffer(this.selStart, this.selEnd);
    const dur    = ((this.selEnd - this.selStart) * this.buffer.duration).toFixed(2);
    const label  = this.filename.replace(/\.[^.]+$/, '').slice(0, 12) + `·${dur}s`;
    this.bank.setSample(padIndex, sliced, label);
  }

  playRegion() {
    if (!this.buffer || !this.engine.ctx) return;
    this.stopRegion();
    const startSec = this.selStart * this.buffer.duration;
    const endSec   = this.selEnd   * this.buffer.duration;
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.engine.compressor);
    src.start(0, startSec, endSec - startSec);
    src.onended = () => { this.isPlaying = false; this._playSource = null; };
    this._playSource          = src;
    this._playStartAudioTime  = this.engine.ctx.currentTime;
    this._playStartNorm       = this.selStart;
    this.isPlaying            = true;
  }

  stopRegion() {
    if (this._playSource) {
      try { this._playSource.stop(); } catch (_) {}
      this._playSource = null;
    }
    this.isPlaying = false;
  }

  /** Normalised position of the playhead (0–1 over full buffer) */
  get playheadPos() {
    if (!this.isPlaying || !this.buffer) return null;
    const elapsed = this.engine.ctx.currentTime - this._playStartAudioTime;
    return Math.min(this.selEnd, this._playStartNorm + elapsed / this.buffer.duration);
  }

  get startTimeSec() { return this.buffer ? this.selStart * this.buffer.duration : 0; }
  get endTimeSec()   { return this.buffer ? this.selEnd   * this.buffer.duration : 0; }
  get durSec()       { return this.endTimeSec - this.startTimeSec; }

  // ── Canvas drawing ──────────────────────────────────────────────────────────

  /** Call this every animation frame while the panel is open */
  draw(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#0a140a';
    ctx.fillRect(0, 0, W, H);

    if (!this.buffer) {
      ctx.fillStyle = '#1a3a1a';
      ctx.font = '11px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DROP MP3 HERE OR USE THE LOAD BUTTON', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    // Waveform peaks for the visible view window
    const peaks = this._getPeaks(canvas.width, this.viewStart, this.viewEnd);

    // Draw waveform bars
    const barW = W / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp  = peaks[i];
      const barH = amp * (H - 4) * 0.9;
      ctx.fillStyle = amp > 0.65 ? '#39ff14' : amp > 0.3 ? '#28b80e' : '#1a7008';
      ctx.fillRect(i * barW, (H - barH) / 2, Math.max(1, barW - 1), barH);
    }

    // Centre line
    ctx.strokeStyle = 'rgba(57,255,20,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    // Convert normalised buffer position to canvas X within the view window
    const toX = (norm) => {
      const ratio = (norm - this.viewStart) / (this.viewEnd - this.viewStart);
      return ratio * W;
    };

    const x0 = toX(this.selStart);
    const x1 = toX(this.selEnd);

    // Selection overlay
    ctx.fillStyle = 'rgba(255,106,0,0.18)';
    ctx.fillRect(x0, 0, x1 - x0, H);

    // Selection border lines
    ctx.strokeStyle = 'rgba(255,106,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();

    // Handles (triangles at top)
    this._drawHandle(ctx, x0, H, 'start');
    this._drawHandle(ctx, x1, H, 'end');

    // Playhead
    const ph = this.playheadPos;
    if (ph !== null) {
      const px = toX(ph);
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
  }

  _drawHandle(ctx, x, H, type) {
    const size = 9;
    ctx.fillStyle = '#ff6a00';
    ctx.shadowColor = 'rgba(255,106,0,0.6)';
    ctx.shadowBlur  = 6;
    // Triangle at top
    ctx.beginPath();
    ctx.moveTo(x,        0);
    ctx.lineTo(x - size, size * 1.4);
    ctx.lineTo(x + size, size * 1.4);
    ctx.closePath();
    ctx.fill();
    // Triangle at bottom
    ctx.beginPath();
    ctx.moveTo(x,        H);
    ctx.lineTo(x - size, H - size * 1.4);
    ctx.lineTo(x + size, H - size * 1.4);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ── Mouse interaction ───────────────────────────────────────────────────────

  onMouseDown(canvas, e) {
    if (!this.buffer) return;
    const norm = this._xToNorm(canvas, e.offsetX);
    const x0   = this._normToX(canvas, this.selStart);
    const x1   = this._normToX(canvas, this.selEnd);
    const SNAP = 12; // px

    if (Math.abs(e.offsetX - x0) < SNAP) {
      this._drag = 'start';
    } else if (Math.abs(e.offsetX - x1) < SNAP) {
      this._drag = 'end';
    } else if (e.offsetX > x0 && e.offsetX < x1) {
      this._drag = 'region';
      this._dragAnchor          = e.offsetX;
      this._dragSelStartAnchor  = this.selStart;
      this._dragSelEndAnchor    = this.selEnd;
    } else {
      // Click outside region: move nearest handle
      const distStart = Math.abs(e.offsetX - x0);
      const distEnd   = Math.abs(e.offsetX - x1);
      if (distStart < distEnd) {
        this.selStart = Math.max(0, Math.min(this.selEnd - 0.001, norm));
      } else {
        this.selEnd = Math.max(this.selStart + 0.001, Math.min(1, norm));
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
      const dx   = e.offsetX - this._dragAnchor;
      const dNorm = (dx / canvas.width) * viewW;
      const dur   = this._dragSelEndAnchor - this._dragSelStartAnchor;
      let ns = this._dragSelStartAnchor + dNorm;
      let ne = this._dragSelEndAnchor   + dNorm;
      if (ns < 0)  { ns = 0;     ne = dur; }
      if (ne > 1)  { ne = 1;     ns = 1 - dur; }
      this.selStart = ns;
      this.selEnd   = ne;
    }
  }

  onMouseUp() { this._drag = null; }

  // ── Zoom / Pan ──────────────────────────────────────────────────────────────

  zoomToSelection() {
    const pad = (this.selEnd - this.selStart) * 0.15;
    this.viewStart = Math.max(0, this.selStart - pad);
    this.viewEnd   = Math.min(1, this.selEnd   + pad);
  }

  zoomFull() {
    this.viewStart = 0;
    this.viewEnd   = 1;
  }

  setZoom(level) {
    // level: 1 = full, >1 = zoomed. Centre on selection midpoint.
    const mid   = (this.selStart + this.selEnd) / 2;
    const half  = 0.5 / level;
    this.viewStart = Math.max(0, mid - half);
    this.viewEnd   = Math.min(1, mid + half);
    if (this.viewEnd - this.viewStart < 0.001) this.viewEnd = this.viewStart + 0.001;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _xToNorm(canvas, x) {
    const ratio = x / canvas.width;
    return this.viewStart + ratio * (this.viewEnd - this.viewStart);
  }

  _normToX(canvas, norm) {
    return ((norm - this.viewStart) / (this.viewEnd - this.viewStart)) * canvas.width;
  }

  _getPeaks(numBars, viewStart, viewEnd) {
    const data       = this.buffer.getChannelData(0);
    const startSmp   = Math.floor(viewStart * data.length);
    const endSmp     = Math.floor(viewEnd   * data.length);
    const blockSize  = Math.max(1, Math.floor((endSmp - startSmp) / numBars));
    const peaks      = new Float32Array(numBars);
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
    const ctx        = this.engine.ctx;
    const startSamp  = Math.floor(start * this.buffer.length);
    const endSamp    = Math.floor(end   * this.buffer.length);
    const length     = Math.max(1, endSamp - startSamp);
    const sliced     = ctx.createBuffer(this.buffer.numberOfChannels, length, this.buffer.sampleRate);
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      sliced.copyToChannel(
        this.buffer.getChannelData(c).subarray(startSamp, endSamp),
        c
      );
    }
    return sliced;
  }

  _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }

  fmtStart() { return this._fmt(this.startTimeSec); }
  fmtEnd()   { return this._fmt(this.endTimeSec); }
  fmtDur()   { return this._fmt(this.durSec); }
}
