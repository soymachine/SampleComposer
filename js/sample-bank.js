/**
 * SampleBank — stores AudioBuffers for 12 pads, handles trim/slice metadata.
 */
export class SampleBank {
  constructor() {
    // 12 slots, each: { buffer, name, trimStart, trimEnd, color }
    this.slots = Array.from({ length: 12 }, () => null);
    this.onChange = null; // (padIndex) => void
  }

  setSample(padIndex, buffer, name = 'sample') {
    this.slots[padIndex] = {
      buffer,
      name,
      trimStart: 0,            // 0.0 – 1.0 normalized
      trimEnd: 1,
      pitch: 1.0,
      volume: 1.0,
      sendLevels: { reverb: 0, delay: 0, filter: 0, distortion: 0 },
    };
    if (this.onChange) this.onChange(padIndex);
  }

  getBuffer(padIndex) {
    const slot = this.slots[padIndex];
    if (!slot) return null;
    return this._sliceBuffer(slot.buffer, slot.trimStart, slot.trimEnd);
  }

  getSample(padIndex) {
    return this.slots[padIndex];
  }

  hasSample(padIndex) {
    return !!this.slots[padIndex];
  }

  clear(padIndex) {
    this.slots[padIndex] = null;
    if (this.onChange) this.onChange(padIndex);
  }

  setTrim(padIndex, start, end) {
    if (!this.slots[padIndex]) return;
    this.slots[padIndex].trimStart = Math.max(0, Math.min(1, start));
    this.slots[padIndex].trimEnd = Math.max(0, Math.min(1, end));
  }

  setSendLevel(padIndex, sendName, level) {
    if (!this.slots[padIndex]) return;
    this.slots[padIndex].sendLevels[sendName] = Math.max(0, Math.min(1, level));
  }

  /** Return a trimmed AudioBuffer copy */
  _sliceBuffer(buffer, start, end) {
    if (start === 0 && end === 1) return buffer;
    const startSample = Math.floor(start * buffer.length);
    const endSample = Math.floor(end * buffer.length);
    const length = endSample - startSample;
    if (length <= 0) return buffer;

    const ctx = new OfflineAudioContext(buffer.numberOfChannels, length, buffer.sampleRate);
    const sliced = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      sliced.copyToChannel(buffer.getChannelData(c).subarray(startSample, endSample), c);
    }
    return sliced;
  }

  /** Get waveform peak data (for visualization), downsampled to `points` values */
  getWaveformData(padIndex, points = 200) {
    const slot = this.slots[padIndex];
    if (!slot) return null;
    const data = slot.buffer.getChannelData(0);
    const blockSize = Math.floor(data.length / points);
    const peaks = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const abs = Math.abs(data[i * blockSize + j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }
    return peaks;
  }
}
