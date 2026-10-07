import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createBrowserSpeechPlayer } from '../shared/browser-speech-player.js';

const source = readFileSync(new URL('../web/audio-start.js', import.meta.url), 'utf8').replace('export function ', 'function ');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let instances = 0, gesture = false;
  const sources = [], listeners = new Map();
  const document = {
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    gesture(name = 'click') { gesture = true; for (const callback of [...(listeners.get(name) || [])]) callback(); gesture = false; }
  };
  class AudioContext extends EventTarget {
    constructor() { super(); instances++; this.state = 'suspended'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; }
    resume() {
      if (!gesture) return new Promise(() => {});
      this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve();
    }
    createBuffer() { return {}; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() {} }; sources.push(source); return source; }
    decodeAudioData() { return Promise.resolve({ duration: 0.1 }); }
    createAnalyser() { return { fftSize: 256, connect() {}, disconnect() {}, getByteTimeDomainData(values) { values.fill(128); } }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const window = { AudioContext };
  vm.runInNewContext(source, { window, document, DOMException });
  return { window, document, sources, get instances() { return instances; } };
}

test('a page tap before renderer startup unlocks the same context used by the first network reply', async () => {
  const h = harness();
  h.document.gesture('touchend');
  const player = createBrowserSpeechPlayer({ createContext: h.window.hikariCreateAudioContext,
    synthesize: async () => ({ audio: new Uint8Array([1]), durationSeconds: 0.1 }),
    onPlaybackBlocked: () => { throw new Error('An ordinary initial gesture should suffice'); }
  });
  const speaking = player.speak('おはよう');
  await tick();
  assert.equal(h.instances, 1);
  assert.equal(h.sources.at(-1).started, true);
  h.sources.at(-1).onended();
  assert.equal(await speaking, true);
  player.dispose();
});

test('ordinary page interactions retry existing blocked audio without any dedicated button', async () => {
  const h = harness();
  const controller = new AbortController();
  let retried = 0;
  const waiting = h.window.hikariPlaybackPrompt(() => { retried++; return Promise.resolve(); }, controller.signal);
  h.document.gesture('keydown');
  await waiting;
  h.document.gesture();
  assert.equal(retried, 1);
  const stopped = new AbortController();
  const cancelled = h.window.hikariPlaybackPrompt(() => { retried++; }, stopped.signal);
  stopped.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  h.document.gesture();
  assert.equal(retried, 1);
});
