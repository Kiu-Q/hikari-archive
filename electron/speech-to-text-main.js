import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Local Apple Speech framework adapter. The helper receives a transient WAV
// over stdin and enforces on-device recognition; it never writes audio files.
export class SpeechToTextService {
  constructor({ executable = '', spawn = nodeSpawn, platform = process.platform, locale = process.env.HIKARI_STT_LOCALE || '', timeoutMs = 45_000 } = {}) {
    this.executable = executable;
    this.spawn = spawn;
    this.platform = platform;
    this.locale = locale;
    this.timeoutMs = timeoutMs;
    this.running = false;
  }

  getStatus() {
    const available = this.platform === 'darwin' && Boolean(this.executable && existsSync(this.executable));
    return { available, status: available ? 'ready' : 'unavailable', language: this.locale || 'system', backend: 'apple-speech-on-device', reason: available ? '' : 'native_speech_helper_missing' };
  }

  async transcribe(samples) {
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason);
    if (this.running) throw new Error('transcription_busy');
    if (!(samples instanceof Float32Array) || samples.length < 1600 || samples.length > 1_600_000) throw new TypeError('Expected 0.1 to 100 seconds of 16 kHz mono audio');
    this.running = true;
    const wav = encodeFloat32Wav(samples, 16000);
    try {
      return await new Promise((resolve, reject) => {
        const args = this.locale ? ['--locale', this.locale] : [];
        const child = this.spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('transcription_timeout')); }, this.timeoutMs);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 65536) child.kill('SIGKILL'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.slice(0, 4096); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          let result;
          try { result = JSON.parse(stdout); } catch { result = null; }
          if (code !== 0 || !result || result.error) reject(new Error(result?.error || stderr.trim() || `speech_exit_${code}`));
          else resolve(String(result.text || '').trim());
        });
        child.stdin.end(wav);
      });
    } finally {
      this.running = false;
      wav.fill(0);
      samples.fill(0);
    }
  }
}

export function encodeFloat32Wav(samples, sampleRate = 16000) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buffer;
}
