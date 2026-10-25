import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFloat32Wav, SpeechToTextService } from '../electron/speech-to-text-main.js';

test('Apple Speech adapter reports unavailable cleanly when native helper is absent', () => {
  const service = new SpeechToTextService({ executable: '', platform: 'darwin' });
  assert.deepEqual(service.getStatus(), {
    available: false,
    status: 'unavailable',
    language: 'system',
    backend: 'apple-speech-on-device',
    reason: 'native_speech_helper_missing'
  });
});

test('transient WAV encoder produces mono 16 kHz PCM without changing its input', () => {
  const samples = new Float32Array([-1, 0, 1]);
  const wav = encodeFloat32Wav(samples);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(44), -32767);
  assert.equal(wav.readInt16LE(48), 32767);
  assert.deepEqual([...samples], [-1, 0, 1]);
});
