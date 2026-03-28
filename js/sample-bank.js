/**
 * SampleBank — stores AudioBuffers for 12 pads.
 * Features: trim, mute/solo, reverse playback, pad mute-groups.
 */
export class SampleBank {
  constructor() {
    this.slots      = Array.from({ length: 12 }, () => null);
    this.mutedPads  = new Set();
    this.soloedPads = new Set();
    this.onChange   = null; // (padIndex) => void
  }

  setSample(padIndex, buffer, name = 'sample') {
    this.slots[padIndex] = {
      buffer,
      name,
      trimStart:  0,
      trimEnd:    1,
      pitch:      1.0,
      volume:     1.0,
      sendLevels: { reverb: 0, delay: 0, filter: 0, distortion: 0 },
      reverse:    false,       // ← reverse playback
      muteGroup:  0,           // ← 0 = no group, 1-4 = exclusive group
      _revCache:  null,        // lazy reversed-buffer cache
    };
    if (this.onChange) this.onChange(padIndex);
  }

  getBuffer(padIndex) {
    const slot = this.slots[padIndex];
    if (!slot) return null;
    const buf = this._sliceBuffer(slot.buffer, slot.trimStart, slot.trimEnd);
    return slot.reverse ? this._reverseBuf(slot, buf) : buf;
  }

  getSample(padIndex) { return this.slots[padIndex]; }
  hasSample(padIndex) { return !!this.slots[padIndex]; }

  clear(padIndex) {
    this.slots[padIndex] = null;
    if (this.onChange) this.onChange(padIndex);
  }

  setTrim(padIndex, start, end) {
    if (!this.slots[padIndex]) return;
    this.slots[padIndex].trimStart  = Math.max(0, Math.min(1, start));
    this.slots[padIndex].trimEnd    = Math.max(0, Math.min(1, end));
    this.slots[padIndex]._revCache  = null; // invalidate cache
  }

  setSendLevel(padIndex, sendName, level) {
    if (!this.slots[padIndex]) return;
    this.slots[padIndex].sendLevels[sendName] = Math.max(0, Math.min(1, level));
  }

  // ── Reverse ────────────────────────────────────────────────────────────────

  toggleReverse(padIndex) {
    const slot = this.slots[padIndex];
    if (!slot) return false;
    slot.reverse    = !slot.reverse;
    slot._revCache  = null; // rebuild on next getBuffer call
    if (this.onChange) this.onChange(padIndex);
    return slot.reverse;
  }

  isReversed(padIndex) {
    return !!this.slots[padIndex]?.reverse;
  }

  // ── Mute Groups ────────────────────────────────────────────────────────────

  /** Group 0 = no group (always plays). Groups 1-4 are exclusive. */
  setMuteGroup(padIndex, group) {
    if (!this.slots[padIndex]) return;
    this.slots[padIndex].muteGroup = Math.max(0, Math.min(4, group));
    if (this.onChange) this.onChange(padIndex);
  }

  getMuteGroup(padIndex) {
    return this.slots[padIndex]?.muteGroup ?? 0;
  }

  /** Returns all pad indices that share the same mute group (>0), excluding self */
  getMuteGroupPeers(padIndex) {
    const g = this.getMuteGroup(padIndex);
    if (g === 0) return [];
    const peers = [];
    for (let i = 0; i < 12; i++) {
      if (i !== padIndex && this.getMuteGroup(i) === g) peers.push(i);
    }
    return peers;
  }

  // ── Mute / Solo ────────────────────────────────────────────────────────────

  isMuted(padIndex)  { return this.mutedPads.has(padIndex); }
  isSoloed(padIndex) { return this.soloedPads.has(padIndex); }
  anySoloed()        { return this.soloedPads.size > 0; }

  isAudible(padIndex) {
    if (this.mutedPads.has(padIndex))                                return false;
    if (this.soloedPads.size > 0 && !this.soloedPads.has(padIndex)) return false;
    return true;
  }

  toggleMute(padIndex) {
    this.mutedPads.has(padIndex)
      ? this.mutedPads.delete(padIndex)
      : this.mutedPads.add(padIndex);
    if (this.onChange) this.onChange(padIndex);
  }

  toggleSolo(padIndex) {
    this.soloedPads.has(padIndex)
      ? this.soloedPads.delete(padIndex)
      : this.soloedPads.add(padIndex);
    for (let i = 0; i < 12; i++) {
      if (this.onChange) this.onChange(i);
    }
  }

  clearMuteSolo() {
    this.mutedPads.clear();
    this.soloedPads.clear();
    for (let i = 0; i < 12; i++) {
      if (this.onChange) this.onChange(i);
    }
  }

  // ── Waveform ───────────────────────────────────────────────────────────────

  getWaveformData(padIndex, points = 200) {
    const slot = this.slots[padIndex];
    if (!slot) return null;
    const data      = slot.buffer.getChannelData(0);
    const blockSize = Math.floor(data.length / points);
    const peaks     = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const abs = Math.abs(data[i * blockSize + j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }
    // If reversed, mirror the peaks for visual accuracy
    return slot.reverse ? peaks.slice().reverse() : peaks;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _sliceBuffer(buffer, start, end) {
    if (start === 0 && end === 1) return buffer;
    const s0  = Math.floor(start * buffer.length);
    const s1  = Math.floor(end   * buffer.length);
    const len = s1 - s0;
    if (len <= 0) return buffer;
    const out = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length:           len,
      sampleRate:       buffer.sampleRate,
    });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      out.copyToChannel(buffer.getChannelData(c).subarray(s0, s1), c);
    }
    return out;
  }

  _reverseBuf(slot, buf) {
    // Use cached reversed buffer if the source hasn't changed
    if (slot._revCache && slot._revCache.length === buf.length) {
      return slot._revCache;
    }
    const rev = new AudioBuffer({
      numberOfChannels: buf.numberOfChannels,
      length:           buf.length,
      sampleRate:       buf.sampleRate,
    });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = rev.getChannelData(c);
      for (let i = 0; i < src.length; i++) {
        dst[i] = src[src.length - 1 - i];
      }
    }
    slot._revCache = rev;
    return rev;
  }
}
