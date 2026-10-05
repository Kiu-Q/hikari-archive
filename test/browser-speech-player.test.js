import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSpeechPlayer } from '../shared/browser-speech-player.js';
import { prepareSpeech } from '../shared/speech-preparation.js';

const result = { audio: new Uint8Array([1, 2, 3]), durationSeconds: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(synthesize = async () => result, { resume: resumeContext } = {}) {
  let contexts = 0, prompts = 0, amplitude = 128, resumeCalls = 0;
  const sources = [], mouths = [];
  const context = Object.assign(new EventTarget(), {
    state: 'suspended', sampleRate: 48000, currentTime: 0, destination: {},
    resume() {
      resumeCalls++;
      if (resumeContext) return resumeContext.call(this, resumeCalls);
      this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve();
    },
    close() { this.state = 'closed'; return Promise.resolve(); },
    createBuffer: () => ({ silent: true }),
    decodeAudioData: async () => ({ duration: 1 }),
    createBufferSource() {
      const source = { buffer: null, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
    createAnalyser: () => ({ fftSize: 256, connect() {}, disconnect() {}, getByteTimeDomainData(data) { data.fill(amplitude); } }),
    createGain: () => ({ connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }),
  });
  const player = createBrowserSpeechPlayer({
    synthesize,
    createContext: () => { contexts++; return context; },
    onMouth: shape => mouths.push(shape),
    onPlaybackBlocked: (_retry, signal) => {
      prompts++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    },
  });
  return {
    player, context, sources, mouths,
    setAmplitude: value => { amplitude = value; },
    get contexts() { return contexts; },
    get prompts() { return prompts; },
    get resumeCalls() { return resumeCalls; }
  };
}

async function waitFor(predicate, timeoutMs = 1_200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, 'condition should become true before timeout');
}

test('one ordinary gesture unlocks a persistent context for successive network replies', async () => {
  const h = harness();
  await h.player.unlock();
  for (let i = 0; i < 2; i++) {
    let started = false;
    const playing = h.player.speak('こんにちは', 1, { onStart: () => { started = true; } });
    await tick();
    assert.equal(started, true);
    const source = h.sources.at(-1);
    assert.equal(source.started, true);
    source.onended();
    assert.equal(await playing, true);
    assert.equal(h.context.state, 'running');
  }
  assert.equal(h.contexts, 1);
  assert.equal(h.prompts, 0);
  h.player.dispose();
});

test('a suspended context auto-resumes before fallback and plays without a prompt', async () => {
  const h = harness();
  const playing = h.player.speak('こんにちは');
  await tick();
  assert.equal(h.context.state, 'running');
  assert.equal(h.prompts, 0);
  assert.equal(h.sources.at(-1).started, true);
  h.sources.at(-1).onended();
  assert.equal(await playing, true);
  assert.equal(h.resumeCalls, 1);
  h.player.dispose();
});

test('unlock happens during the gesture even when synthesis has not returned', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const playing = h.player.speak('こんにちは');
  await tick();
  await h.player.unlock();
  finish(result);
  await tick();
  assert.equal(h.prompts, 0);
  h.sources.at(-1).onended();
  assert.equal(await playing, true);
  h.player.dispose();
});

test('an interrupted context resumes from any page gesture without pressing the fallback button', async () => {
  const h = harness(async () => result, {
    resume(call) {
      if (call === 1) return new Promise(() => {});
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }
  });
  const playing = h.player.speak('こんにちは');
  await tick();
  await waitFor(() => h.prompts === 1);
  assert.equal(h.prompts, 1);
  await h.player.unlock();
  await tick();
  assert.equal(h.sources.at(-1).started, true);
  h.sources.at(-1).onended();
  assert.equal(await playing, true);
  h.player.dispose();
});

test('cancellation during generation prevents late playback without closing the unlocked context', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  await h.player.unlock();
  const playing = h.player.speak('こんにちは');
  await tick();
  h.player.stop();
  assert.equal(await playing, false);
  finish(result);
  await tick();
  assert.equal(h.sources.length, 1, 'only the silent unlock buffer was created');
  assert.equal(h.context.state, 'running');
  h.player.dispose();
});

test('buffer playback drives lip sync and stop releases only the active nodes', async () => {
  const h = harness();
  await h.player.unlock();
  h.setAmplitude(150);
  const playing = h.player.speak('こんにちは');
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.ok(h.mouths.includes('aa'));
  h.player.stop();
  assert.equal(await playing, false);
  assert.equal(h.sources.at(-1).stopped, true);
  assert.equal(h.mouths.at(-1), 'neutral');
  assert.equal(h.context.state, 'running');
  h.player.dispose();
});

test('an interrupted active source resumes without synthesizing a second time', async () => {
  let synthesisCalls = 0;
  const h = harness(async () => { synthesisCalls++; return result; });
  const playing = h.player.speak('こんにちは');
  await tick();
  const source = h.sources.at(-1);
  assert.equal(source.started, true);
  h.context.state = 'suspended';
  h.context.dispatchEvent(new Event('statechange'));
  await tick();

  assert.equal(h.context.state, 'running');
  assert.equal(h.prompts, 0);
  assert.equal(h.resumeCalls, 2);
  assert.equal(synthesisCalls, 1);
  assert.equal(h.sources.at(-1), source);
  source.onended();
  assert.equal(await playing, true);
  h.player.dispose();
});

test('browser player consumes prepared synthesis without a second request', async () => {
  let synthesisCalls = 0;
  const prepared = prepareSpeech(async () => { synthesisCalls++; return result; }, 'こんにちは', 1);
  const h = harness(async () => { throw new Error('must use prepared audio'); });
  await h.player.unlock();
  const playing = h.player.speak('こんにちは', 1, { prepared });
  await tick();
  assert.equal(synthesisCalls, 1);
  assert.equal(h.sources.at(-1).started, true);
  h.sources.at(-1).onended();
  assert.equal(await playing, true);
  h.player.dispose();
});

test('stopping browser playback aborts pending prepared synthesis', async () => {
  let signal;
  let finish;
  const prepared = prepareSpeech((_input, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, 'こんにちは');
  const h = harness(async () => { throw new Error('must use prepared audio'); });
  const playing = h.player.speak('こんにちは', 1, { prepared });
  await tick();
  h.player.stop();
  assert.equal(await playing, false);
  assert.equal(signal.aborted, true);
  finish(result);
  await tick();
  assert.equal(h.sources.length, 0, 'cancelled synthesis must not create playback nodes');
});

test('browser player treats a pre-cancelled prepared handle as a clean stop', async () => {
  const prepared = prepareSpeech(() => new Promise(() => {}), 'こんにちは');
  prepared.cancel();
  const h = harness(async () => { throw new Error('must use prepared audio'); });
  assert.equal(await h.player.speak('こんにちは', 1, { prepared }), false);
  assert.equal(h.sources.length, 0);
  h.player.dispose();
});

test('cancelling a reply waiting for audio unlock prevents playback on a later gesture', async () => {
  const h = harness(async () => result, {
    resume(call) {
      if (call === 1) return new Promise(() => {});
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }
  });
  const playing = h.player.speak('こんにちは');
  await tick();
  await waitFor(() => h.prompts === 1);
  assert.equal(h.prompts, 1);
  h.player.stop();
  assert.equal(await playing, false);
  await h.player.unlock();
  await tick();
  assert.equal(h.sources.length, 1, 'later gesture starts only the silent unlock buffer');
  h.player.dispose();
});

test('lifecycle resume does not create an audio context before one exists', async () => {
  const h = harness();
  assert.equal(await h.player.resume(), false);
  assert.equal(h.contexts, 0);
});

test('stop aborts the pending synthesis transport', async () => {
  let requestSignal;
  const h = harness((_input, { signal }) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  const playing = h.player.speak('こんにちは');
  await tick();
  h.player.stop();
  assert.equal(requestSignal.aborted, true);
  assert.equal(await playing, false);
  h.player.dispose();
});

test('unlock rejects when a browser resumes without actually permitting audio', async () => {
  const h = harness();
  h.context.resume = async () => {};
  await assert.rejects(h.player.unlock(), /still suspended/);
  h.player.dispose();
});
