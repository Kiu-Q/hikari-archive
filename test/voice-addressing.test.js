import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAddressingGate, suppressSelfVoice } from '../electron/voice-addressing.js';

test('wake invocation is stripped and addressed content passes through', () => {
  const gate = new VoiceAddressingGate();
  assert.deepEqual(gate.process('Hikari, What time is it?', 100), { addressed: true, wakeActivated: false, wakeExpiresAt: 0, text: 'What time is it?' });
});

test('wake-only opens a short session for the next utterance', () => {
  const gate = new VoiceAddressingGate({ wakeDurationMs: 8000 });
  const wake = gate.process('Hey Hikari', 100);
  assert.equal(wake.wakeActivated, true);
  assert.equal(gate.process('Please help me', 700).addressed, true);
  assert.equal(gate.process('ambient words', 9000).addressed, false);
});

test('ambient speech is discarded and self voice is suppressed through the tail', () => {
  const gate = new VoiceAddressingGate();
  assert.deepEqual(gate.process('just talking to someone', 10), { addressed: false, wakeActivated: false, wakeExpiresAt: 0, text: '' });
  assert.equal(suppressSelfVoice({ speaking: true, now: 20 }), true);
  assert.equal(suppressSelfVoice({ speaking: false, now: 100, tailUntil: 101 }), true);
  assert.equal(suppressSelfVoice({ speaking: false, now: 102, tailUntil: 101 }), false);
});
