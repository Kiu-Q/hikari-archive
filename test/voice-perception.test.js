import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePerception } from '../electron/voice-perception.js';

test('local VAD waits for sustained audio before announcing speech and guards TTS echo', () => {
  let starts = 0;
  let now = 1000;
  let speaking = false;
  const perception = new VoicePerception({
    transcribe: async () => '',
    onSpeechStart: () => { starts += 1; },
    isSpeaking: () => speaking,
    now: () => now,
    threshold: 0.01,
    speechStartMs: 200
  });
  const voice = new Float32Array(1600).fill(0.1);
  perception.processFrame(voice, 16000);
  assert.equal(starts, 0);
  perception.processFrame(voice, 16000);
  assert.equal(starts, 1);
  speaking = true;
  now += 100;
  perception.processFrame(voice, 16000);
  assert.equal(perception.chunks.length, 0);
  assert.equal(perception.tailUntil, now + 900);
  void perception.stop();
});
