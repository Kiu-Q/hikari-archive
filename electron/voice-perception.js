import { suppressSelfVoice } from './voice-addressing.js';

// Lightweight local RMS VAD. Speech transcription is delegated to Electron's
// main-process adapter; captured samples exist only in memory and are cleared.
export class VoicePerception {
  constructor({ transcribe, onSpeechStart = () => {}, onTranscript = () => {}, onError = () => {}, isSpeaking = () => false, now = () => Date.now(), threshold = 0.018, speechStartMs = 300, silenceEndMs = 750 } = {}) {
    this.transcribe = transcribe; this.onSpeechStart = onSpeechStart; this.onTranscript = onTranscript;
    this.onError = onError; this.isSpeaking = isSpeaking; this.now = now; this.threshold = threshold; this.speechStartMs = speechStartMs; this.silenceEndMs = silenceEndMs;
    this.stream = null; this.context = null; this.processor = null; this.active = false;
    this.chunks = []; this.speechMs = 0; this.silenceMs = 0; this.tailUntil = 0;
  }

  async start() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    const silentOutput = this.context.createGain();
    silentOutput.gain.value = 0;
    this.processor.onaudioprocess = (event) => this.processFrame(event.inputBuffer.getChannelData(0), this.context.sampleRate);
    source.connect(this.processor); this.processor.connect(silentOutput); silentOutput.connect(this.context.destination);
    this.active = true;
  }

  processFrame(frame, sampleRate = 48000) {
    const now = this.now();
    if (this.isSpeaking()) this.tailUntil = now + 900;
    if (suppressSelfVoice({ speaking: this.isSpeaking(), now, tailUntil: this.tailUntil })) { this.clearSegment(); return; }
    let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(frame.length, 1));
    const frameMs = frame.length / sampleRate * 1000;
    if (rms >= this.threshold) {
      this.speechMs += frameMs; this.silenceMs = 0;
      if (this.speechMs >= this.speechStartMs) {
        if (!this.chunks.length) this.onSpeechStart();
        this.chunks.push(new Float32Array(frame));
      }
    } else if (this.chunks.length) {
      this.silenceMs += frameMs;
      if (this.silenceMs >= this.silenceEndMs) void this.finishSegment();
      else this.chunks.push(new Float32Array(frame));
    } else this.speechMs = 0;
  }

  async finishSegment() {
    const chunks = this.chunks; const frames = chunks.reduce((n, item) => n + item.length, 0);
    this.chunks = []; this.speechMs = 0; this.silenceMs = 0;
    if (frames < 3200 || !this.transcribe) { for (const chunk of chunks) chunk.fill(0); return; }
    const merged = new Float32Array(frames); let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
    const samples = downsample(merged, this.context?.sampleRate || 48000, 16000); merged.fill(0);
    try { const transcript = await this.transcribe(samples); this.tailUntil = this.now() + 900; if (transcript?.trim()) this.onTranscript(transcript.trim()); }
    catch (error) { this.onError(error); }
    finally { samples.fill(0); }
  }

  clearSegment() { for (const chunk of this.chunks) chunk.fill(0); this.chunks = []; this.speechMs = 0; this.silenceMs = 0; }

  async stop() {
    this.active = false; this.clearSegment();
    if (this.processor) { this.processor.disconnect(); this.processor.onaudioprocess = null; }
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close(); this.stream = null; this.context = null; this.processor = null;
  }
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return new Float32Array(input);
  const length = Math.floor(input.length * toRate / fromRate); const output = new Float32Array(length); const ratio = fromRate / toRate;
  for (let i = 0; i < length; i++) { const start = Math.floor(i * ratio); const end = Math.min(input.length, Math.floor((i + 1) * ratio)); let sum = 0; for (let j = start; j < end; j++) sum += input[j]; output[i] = sum / Math.max(1, end - start); }
  return output;
}
