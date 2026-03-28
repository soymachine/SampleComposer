/**
 * Recorder — handles microphone capture and file import,
 * returning decoded AudioBuffers to the app.
 */
export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.isRecording = false;
    this._stream = null;
    this._mediaRecorder = null;
    this._chunks = [];
    this.onRecordingComplete = null; // (AudioBuffer) => void
  }

  async requestMicAccess() {
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return true;
    } catch (e) {
      console.warn('Mic access denied:', e);
      return false;
    }
  }

  async startRecording() {
    if (this.isRecording) return;
    this.engine.init();

    if (!this._stream) {
      const ok = await this.requestMicAccess();
      if (!ok) return;
    }

    this._chunks = [];
    this._mediaRecorder = new MediaRecorder(this._stream);

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };

    this._mediaRecorder.onstop = async () => {
      const blob = new Blob(this._chunks, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      try {
        const audioBuffer = await this.engine.decodeAudio(arrayBuffer);
        if (this.onRecordingComplete) this.onRecordingComplete(audioBuffer);
      } catch (e) {
        console.error('Decode error:', e);
      }
    };

    this._mediaRecorder.start();
    this.isRecording = true;
  }

  stopRecording() {
    if (!this.isRecording || !this._mediaRecorder) return;
    this._mediaRecorder.stop();
    this.isRecording = false;
  }

  toggleRecording() {
    this.isRecording ? this.stopRecording() : this.startRecording();
  }

  /** Load sample from a File object (drag-drop or file input) */
  async loadFile(file) {
    this.engine.init();
    const arrayBuffer = await file.arrayBuffer();
    return this.engine.decodeAudio(arrayBuffer);
  }
}
