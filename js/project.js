/**
 * project.js — Save / load the full session as a self-contained .koweb.json file.
 *
 * The JSON stores:
 *   • BPM, stepsPerPattern, swing, activeGroup
 *   • All 4 group patterns (active flags + per-step volume/pitch/sends)
 *   • Per-pad metadata (name, volume, pitch, sendLevels, trimStart/End, muted, soloed)
 *   • Per-pad audio encoded as base64 WAV — fully portable, no server needed
 */
import { audioBufferToBase64, base64ToAudioBuffer, downloadBlob } from './wav-utils.js';

const FORMAT_VERSION = 2;

export class ProjectManager {
  constructor(engine, bank, seq) {
    this.engine = engine;
    this.bank   = bank;
    this.seq    = seq;
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async save(projectName = 'project') {
    const pads = [];
    for (let i = 0; i < 12; i++) {
      const slot = this.bank.getSample(i);
      if (slot?.buffer) {
        pads.push({
          name:       slot.name,
          volume:     slot.volume,
          pitch:      slot.pitch,
          sendLevels: { ...slot.sendLevels },
          trimStart:  slot.trimStart ?? 0,
          trimEnd:    slot.trimEnd   ?? 1,
          muted:      this.bank.isMuted(i),
          soloed:     this.bank.isSoloed(i),
          reverse:    slot.reverse   ?? false,
          muteGroup:  slot.muteGroup ?? 0,
          audio:      audioBufferToBase64(slot.buffer),
        });
      } else {
        pads.push(null);
      }
    }

    const data = {
      version:         FORMAT_VERSION,
      name:            projectName,
      savedAt:         new Date().toISOString(),
      bpm:             this.seq.bpm,
      stepsPerPattern: this.seq.stepsPerPattern,
      swing:           this.seq.swing,
      activeGroup:     this.seq.activeGroup,
      // Deep-copy the groups array (strip non-serialisable references)
      groups: this.seq.groups.map(g =>
        g.map(pad =>
          pad.map(step => ({
            active:      step.active,
            volume:      step.volume,
            pitch:       step.pitch,
            sendLevels:  { ...step.sendLevels },
            probability: step.probability ?? 1,
          }))
        )
      ),
      songChain: seq.songChain.slice(),
      pads,
    };

    const json = JSON.stringify(data);
    downloadBlob(
      new Blob([json], { type: 'application/json' }),
      `${projectName.replace(/[^a-z0-9_\-]/gi, '_')}.koweb.json`,
      'application/json'
    );
  }

  // ─── Load ──────────────────────────────────────────────────────────────────

  async load(file, { onPadLoaded } = {}) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Invalid project file — could not parse JSON.'); }
    if (!data.version || !data.groups) throw new Error('File does not look like a KO·WEB project.');

    this.engine.init();

    // Sequencer state
    if (typeof data.bpm === 'number')             this.seq.setBPM(data.bpm);
    if (typeof data.stepsPerPattern === 'number') this.seq.stepsPerPattern = data.stepsPerPattern;
    if (typeof data.swing === 'number')           this.seq.swing = data.swing;
    if (typeof data.activeGroup === 'number')     this.seq.setGroup(data.activeGroup);
    if (Array.isArray(data.songChain))            this.seq.setSongChain(data.songChain);

    // Patterns
    if (Array.isArray(data.groups)) {
      // Merge so the structure always has 4 groups × 12 pads × 16 steps
      for (let g = 0; g < 4; g++) {
        for (let p = 0; p < 12; p++) {
          for (let s = 0; s < 16; s++) {
            const src = data.groups[g]?.[p]?.[s];
            if (src) Object.assign(this.seq.groups[g][p][s], src);
          }
        }
      }
    }

    // Reset mute/solo before loading
    this.bank.mutedPads.clear();
    this.bank.soloedPads.clear();

    // Pads — decode audio in parallel, notify via onPadLoaded for progressive UI
    const padPromises = (data.pads || []).map(async (padData, i) => {
      if (!padData || !padData.audio) {
        this.bank.clear(i);
        return;
      }
      try {
        const buf  = await base64ToAudioBuffer(padData.audio, this.engine.ctx);
        this.bank.setSample(i, buf, padData.name ?? `PAD ${i + 1}`);
        const slot = this.bank.getSample(i);
        if (slot) {
          slot.volume     = padData.volume     ?? 1;
          slot.pitch      = padData.pitch      ?? 1;
          slot.sendLevels = { reverb: 0, delay: 0, filter: 0, distortion: 0, ...(padData.sendLevels ?? {}) };
          slot.trimStart  = padData.trimStart  ?? 0;
          slot.trimEnd    = padData.trimEnd    ?? 1;
        }
        if (padData.muted)  this.bank.mutedPads.add(i);
        if (padData.soloed) this.bank.soloedPads.add(i);
        if (slot) {
          slot.reverse   = padData.reverse    ?? false;
          slot.muteGroup = padData.muteGroup  ?? 0;
        }
      } catch (err) {
        console.warn(`KO·WEB: pad ${i + 1} failed to decode audio`, err);
        this.bank.clear(i);
      }
      if (onPadLoaded) onPadLoaded(i);
    });

    await Promise.all(padPromises);

    // Fire onChange for all pads so UI re-renders
    for (let i = 0; i < 12; i++) {
      if (this.bank.onChange) this.bank.onChange(i);
    }

    return data.name ?? 'project';
  }
}
