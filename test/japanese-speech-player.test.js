import assert from 'node:assert/strict';
import test from 'node:test';
import { createJapaneseSpeechPlayer } from '../electron/japanese-speech-player.js';

function harness(synthesize) {
  const mouth = [], revoked = [], audios = [];
  let amplitude = 128;
  const player = createJapaneseSpeechPlayer({
    synthesize,
    onMouth: shape => mouth.push(shape),
    createUrl: () => 'blob:voice',
    revokeUrl: url => revoked.push(url),
    createAudio: () => {
      const audio = {
        paused: true,
        play() { this.paused = false; this.onplaying?.(); return Promise.resolve(); },
        pause() { this.paused = true; },
        removeAttribute() {}, load() {},
      };
      audios.push(audio);
      return audio;
    },
    createContext: () => ({
      destination: {},
      createAnalyser: () => ({ fftSize: 256, connect() {}, getByteTimeDomainData(data) { data.fill(amplitude); } }),
      createMediaElementSource: () => ({ connect() {} }),
      resume: async () => {}, close: async () => {},
    }),
  });
  return { player, mouth, revoked, audios, setAmplitude: value => { amplitude = value; } };
}

function controlledAudioHarness(synthesize, onPlaying = () => {}) {
  const audios = [], revoked = [];
  let playCount = 0;
  const player = createJapaneseSpeechPlayer({
    synthesize,
    onPlaying,
    createUrl: () => 'blob:voice',
    revokeUrl: url => revoked.push(url),
    createAudio: () => {
      const audio = {
        paused: true,
        play() { playCount++; this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; },
        removeAttribute() {}, load() {},
      };
      audios.push(audio);
      return audio;
    },
    createContext: () => null,
  });
  return { player, audios, revoked, get playCount() { return playCount; } };
}

const result = { audio: new Uint8Array([1, 2]), durationSeconds: 2 };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('beforePlay waits for synthesis and onStart waits for actual playback once', async () => {
  let finishSynthesis, finishBeforePlay;
  let captionCalls = 0, animationCalls = 0, beforePlayCalls = 0;
  let onStartCalls = 0, onPlayingCalls = 0;
  const h = controlledAudioHarness(
    () => new Promise(resolve => { finishSynthesis = resolve; }),
    () => { onPlayingCalls++; }
  );
  const speaking = h.player.speak('先生、おはよう。', 1, {
    beforePlay: async () => {
      beforePlayCalls++;
      captionCalls++;
      animationCalls++;
      await new Promise(resolve => { finishBeforePlay = resolve; });
    },
    onStart: () => { onStartCalls++; },
  });

  await tick();
  assert.equal(beforePlayCalls, 0);
  assert.equal(captionCalls, 0);
  assert.equal(animationCalls, 0);
  assert.equal(onStartCalls, 0);
  assert.equal(h.playCount, 0);

  finishSynthesis(result);
  await tick();
  assert.equal(beforePlayCalls, 1);
  assert.equal(captionCalls, 1);
  assert.equal(animationCalls, 1);
  assert.equal(h.playCount, 0, 'audio must wait for beforePlay to finish');
  assert.equal(onStartCalls, 0);

  finishBeforePlay();
  await tick();
  assert.equal(h.playCount, 1);
  assert.equal(onStartCalls, 0, 'play() alone is not the actual playing event');

  h.audios[0].onplaying();
  h.audios[0].onplaying();
  assert.equal(onStartCalls, 1);
  assert.equal(onPlayingCalls, 2, 'the existing onPlaying callback still follows each playing event');
  h.audios[0].onended();
  assert.equal(await speaking, true);
});

test('cancelling during pending beforePlay never starts audio', async () => {
  let finishBeforePlay;
  const h = controlledAudioHarness(async () => result);
  let onStartCalls = 0;
  const speaking = h.player.speak('こんにちは', 1, {
    beforePlay: () => new Promise(resolve => { finishBeforePlay = resolve; }),
    onStart: () => { onStartCalls++; },
  });

  await tick();
  assert.equal(h.playCount, 0);
  assert.equal(typeof finishBeforePlay, 'function');
  h.player.stop();
  assert.equal(await speaking, false);

  finishBeforePlay();
  await tick();
  assert.equal(h.playCount, 0);
  assert.equal(onStartCalls, 0);
  assert.equal(h.audios[0].paused, true);
});

test('voice receives Japanese; mouth follows sound and silence; finishes on audio end', async () => {
  let input;
  const h = harness(async value => { input = value; return result; });
  let completed = false;
  const playing = h.player.speak('先生、おはよう。', 1.1).then(value => { completed = true; return value; });
  await tick();
  assert.deepEqual(input, { text: '先生、おはよう。', speed: 1.1 });
  assert.equal(completed, false);
  h.setAmplitude(180);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(h.mouth.at(-1), 'aa');
  h.setAmplitude(128);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(h.mouth.at(-1), 'neutral');
  h.audios[0].onended();
  assert.equal(await playing, true);
  assert.deepEqual(h.revoked, ['blob:voice']);
  assert.equal(h.mouth.at(-1), 'neutral');
});

test('cancel during generation prevents late audio playback', async () => {
  let deliver;
  const h = harness(() => new Promise(resolve => { deliver = resolve; }));
  const playing = h.player.speak('こんにちは');
  await tick();
  h.player.stop();
  assert.equal(await playing, false);
  deliver(result);
  await tick();
  assert.equal(h.audios.length, 0);
});

test('cancel during playback closes mouth and releases audio', async () => {
  const h = harness(async () => result);
  const playing = h.player.speak('こんにちは');
  await tick();
  h.player.stop();
  assert.equal(await playing, false);
  assert.equal(h.audios[0].paused, true);
  assert.deepEqual(h.revoked, ['blob:voice']);
  assert.equal(h.mouth.at(-1), 'neutral');
});

test('generation failure propagates without constructing fallback speech', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  await assert.rejects(h.player.speak('こんにちは'), /offline/);
  assert.equal(h.audios.length, 0);
  assert.equal(h.mouth.at(-1), 'neutral');
});

test('audio errors reject and clean up the object URL', async () => {
  const h = harness(async () => result);
  const playing = h.player.speak('こんにちは');
  await tick();
  const rejection = assert.rejects(playing, /playback failed/);
  h.audios[0].onerror();
  await rejection;
  assert.deepEqual(h.revoked, ['blob:voice']);
});
