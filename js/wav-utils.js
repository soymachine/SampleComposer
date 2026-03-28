/**
 * wav-utils.js — AudioBuffer ↔ WAV encoding, base64 helpers, download trigger.
 */

/** Encode an AudioBuffer as a 16-bit PCM WAV ArrayBuffer */
export function audioBufferToWAV(buffer) {
  const numChannels = Math.min(buffer.numberOfChannels, 2);
  const sampleRate  = buffer.sampleRate;
  const numSamples  = buffer.length;
  const dataSize    = numSamples * numChannels * 2; // 16-bit = 2 bytes
  const out         = new ArrayBuffer(44 + dataSize);
  const view        = new DataView(out);

  const str = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

  str(0,  'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  str(8,  'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);                       // PCM chunk size
  view.setUint16(20, 1,  true);                       // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
  view.setUint16(32, numChannels * 2, true);          // block align
  view.setUint16(34, 16, true);                       // bits per sample
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let pos = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      pos += 2;
    }
  }
  return out;
}

/** Trigger a browser download of a Blob or ArrayBuffer */
export function downloadBlob(data, filename, type = 'audio/wav') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** AudioBuffer → base64-encoded WAV string */
export function audioBufferToBase64(buffer) {
  const wav    = audioBufferToWAV(buffer);
  const bytes  = new Uint8Array(wav);
  let   binary = '';
  // Process in chunks to avoid call-stack limits on large buffers
  const CHUNK  = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64-encoded WAV string → AudioBuffer */
export async function base64ToAudioBuffer(base64, audioCtx) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return audioCtx.decodeAudioData(bytes.buffer.slice(0));
}
