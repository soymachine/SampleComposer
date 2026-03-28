/**
 * midi.js — Web MIDI API integration.
 *
 * Default note mapping (General MIDI drum map, channel 10):
 *   36 Bass Drum  → pad 0     40 Snare      → pad 1
 *   42 HH Closed → pad 2     46 HH Open    → pad 3
 *   38 Snare 2   → pad 4     37 Rimshot     → pad 5
 *   41 Tom Lo    → pad 6     45 Tom Mid    → pad 7
 *   43 Tom Hi    → pad 8     49 Crash      → pad 9
 *   51 Ride      → pad 10    39 Clap       → pad 11
 *
 * Any of the 12 pads can be re-mapped via the noteMap.
 */

export const DEFAULT_NOTE_MAP = {
  36: 0,  // Bass drum
  40: 1,  // Snare
  42: 2,  // Closed hi-hat
  46: 3,  // Open hi-hat
  38: 4,  // Snare 2
  37: 5,  // Rimshot
  41: 6,  // Tom lo
  45: 7,  // Tom mid
  43: 8,  // Tom hi
  49: 9,  // Crash
  51: 10, // Ride
  39: 11, // Clap
};

export class MidiController {
  constructor() {
    this.noteMap    = { ...DEFAULT_NOTE_MAP };
    this.enabled    = false;
    this.access     = null;
    this.inputs     = [];
    this._listeners = new Map(); // input.id → bound handler

    // Callbacks
    this.onPadHit     = null; // (padIndex, velocity) => void
    this.onStatusChange = null; // (status: 'connected'|'disconnected'|'denied'|'unsupported') => void
  }

  get isSupported() { return !!navigator.requestMIDIAccess; }

  async connect() {
    if (!this.isSupported) {
      if (this.onStatusChange) this.onStatusChange('unsupported');
      return false;
    }
    try {
      this.access   = await navigator.requestMIDIAccess({ sysex: false });
      this.enabled  = true;
      this._attachAll();
      this.access.onstatechange = () => this._onStateChange();
      if (this.onStatusChange) this.onStatusChange('connected');
      return true;
    } catch {
      if (this.onStatusChange) this.onStatusChange('denied');
      return false;
    }
  }

  disconnect() {
    this._detachAll();
    this.enabled = false;
    this.access  = null;
    if (this.onStatusChange) this.onStatusChange('disconnected');
  }

  /** Return list of connected input device names */
  getInputNames() {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values()).map(i => i.name);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _attachAll() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      if (this._listeners.has(input.id)) continue;
      const handler = (msg) => this._onMessage(msg);
      input.onmidimessage = handler;
      this._listeners.set(input.id, handler);
    }
    this.inputs = Array.from(this.access.inputs.values());
  }

  _detachAll() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null;
    }
    this._listeners.clear();
    this.inputs = [];
  }

  _onStateChange() {
    this._detachAll();
    this._attachAll();
    const count = this.access?.inputs.size ?? 0;
    if (this.onStatusChange) {
      this.onStatusChange(count > 0 ? 'connected' : 'disconnected');
    }
  }

  _onMessage(event) {
    const [status, note, velocity] = event.data;
    const type = status & 0xF0;

    // Note On (0x90) with velocity > 0
    if (type === 0x90 && velocity > 0) {
      const padIndex = this.noteMap[note];
      if (padIndex !== undefined && this.onPadHit) {
        this.onPadHit(padIndex, velocity / 127);
      }
    }
    // Note Off or Note On with velocity 0 — no action needed for one-shot pads
  }
}
