import assert from 'node:assert/strict';
import test from 'node:test';
import { createJapaneseSpeechPlayer } from '../electron/japanese-speech-player.js';
import { prepareSpeech } from '../shared/speech-preparation.js';

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
      createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }),
      createDynamicsCompressor: () => ({
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
        attack: { value: 0 }, release: { value: 0 }, connect() {},
      }),
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

test('beforePlay voiceGain ramps through a peak-catching Web Audio compressor', async () => {
  let sourceTarget, analyserTarget, gainTarget, compressorTarget, compressorValues, scheduled;
  const audio = {
    paused: true,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute() {}, load() {},
  };
  const player = createJapaneseSpeechPlayer({
    synthesize: async () => result,
    createUrl: () => 'blob:voice',
    revokeUrl: () => {},
    createAudio: () => audio,
    createContext: () => ({
      currentTime: 4,
      destination: {},
      createAnalyser: () => ({ fftSize: 256, connect(target) { analyserTarget = target; } }),
      createGain: () => ({
        gain: {
          cancelScheduledValues: time => { scheduled = { cancelledAt: time }; },
          setValueAtTime: (value, time) => { scheduled.initial = [value, time]; },
          linearRampToValueAtTime: (value, time) => { scheduled.ramp = [value, time]; },
        },
        connect(target) { gainTarget = target; },
      }),
      createDynamicsCompressor: () => {
        compressorValues = {
          threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
          attack: { value: 0 }, release: { value: 0 },
        };
        compressorValues.connect = target => { compressorTarget = target; };
        return compressorValues;
      },
      createMediaElementSource: () => ({ connect(target) { sourceTarget = target; } }),
      resume: async () => {}, close: async () => {},
    }),
  });

  const speaking = player.speak('こんにちは', 1, {
    beforePlay: ({ canBoost }) => {
      assert.equal(canBoost, true);
      return { voiceGain: 0.9 / 0.7 };
    },
  });
  await tick();
  assert.ok(sourceTarget);
  assert.ok(analyserTarget);
  assert.ok(gainTarget);
  assert.ok(compressorTarget);
  assert.deepEqual({
    threshold: compressorValues.threshold.value,
    knee: compressorValues.knee.value,
    ratio: compressorValues.ratio.value,
    attack: compressorValues.attack.value,
    release: compressorValues.release.value,
  }, { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });
  assert.deepEqual(scheduled, { cancelledAt: 4, initial: [0, 4], ramp: [0.9 / 0.7, 4.25] });
  audio.onended();
  assert.equal(await speaking, true);
});

test('native audio fallback ramps from silence to 90% voice level', async () => {
  const h = controlledAudioHarness(async () => result);
  const speaking = h.player.speak('こんにちは', 1, {
    beforePlay: ({ canBoost }) => {
      assert.equal(canBoost, false);
      return { voiceGain: 0.9 };
    },
  });
  await tick();
  assert.equal(h.audios[0].volume, 0);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(h.audios[0].volume > 0 && h.audios[0].volume < 1);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(h.audios[0].volume, 0.9);
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

test('native player consumes prepared synthesis without a duplicate request', async () => {
  let synthesisCalls = 0;
  const prepared = prepareSpeech(async () => { synthesisCalls++; return result; }, 'こんにちは', 1.2);
  const h = controlledAudioHarness(async () => { throw new Error('must use prepared audio'); });
  const speaking = h.player.speak('こんにちは', 1.2, { prepared });
  await tick();
  assert.equal(synthesisCalls, 1);
  assert.equal(h.playCount, 1);
  h.audios[0].onended();
  assert.equal(await speaking, true);
});

test('stopping native playback aborts pending prepared synthesis', async () => {
  let signal;
  let finish;
  const prepared = prepareSpeech((_input, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, 'こんにちは');
  const h = controlledAudioHarness(async () => { throw new Error('must use prepared audio'); });
  const speaking = h.player.speak('こんにちは', 1, { prepared });
  await tick();
  h.player.stop();
  assert.equal(await speaking, false);
  assert.equal(signal.aborted, true);
  finish(result);
  await tick();
  assert.equal(h.audios.length, 0);
});

test('native player treats a pre-cancelled prepared handle as a clean stop', async () => {
  const prepared = prepareSpeech(() => new Promise(() => {}), 'こんにちは');
  prepared.cancel();
  const h = controlledAudioHarness(async () => { throw new Error('must use prepared audio'); });
  assert.equal(await h.player.speak('こんにちは', 1, { prepared }), false);
  assert.equal(h.audios.length, 0);
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

test('blocked browser playback retries the same audio from a gesture without resynthesis', async () => {
  let generated = 0, attempts = 0, retry, audio;
  const player = createJapaneseSpeechPlayer({
    synthesize: async () => { generated++; return result; },
    createContext: () => null,
    createUrl: () => 'blob:blocked', revokeUrl() {},
    createAudio: () => (audio = {
      paused: true, pause() {}, removeAttribute() {}, load() {},
      play() {
        attempts++;
        if (attempts === 1) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
        this.paused = false;
        this.onplaying?.();
        return Promise.resolve();
      }
    }),
    onPlaybackBlocked: handler => { retry = handler; },
  });
  const pending = player.speak('こんにちは');
  await tick();
  assert.equal(typeof retry, 'function');
  await retry();
  audio.onended();
  assert.equal(await pending, true);
  assert.equal(generated, 1);
  assert.equal(attempts, 2);
});

test('stopping a blocked browser reply cancels its prompt and prevents late playback', async () => {
  let signal, retry, attempts = 0;
  const player = createJapaneseSpeechPlayer({
    synthesize: async () => result,
    createContext: () => null,
    createUrl: () => 'blob:blocked', revokeUrl() {},
    createAudio: () => ({
      pause() {}, removeAttribute() {}, load() {},
      play() { attempts++; return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); }
    }),
    onPlaybackBlocked: (handler, cancelSignal) => {
      retry = handler; signal = cancelSignal;
      return new Promise(() => {});
    },
  });
  const pending = player.speak('こんにちは');
  await tick();
  player.stop();
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  await assert.rejects(retry(), /cancelled/);
  assert.equal(attempts, 1);
});

test('latency stage hooks expose setup and playback request before actual playing', async () => {
  const stages = [];
  const h = controlledAudioHarness(async () => result);
  const speaking = h.player.speak('おはよう。', 1, {
    fadeIn: false,
    onTiming: stage => stages.push(stage),
    beforePlay: async () => {},
    onStart: () => stages.push('actual_speech_start'),
  });
  await tick();
  assert.deepEqual(stages, ['audio_setup_started', 'audio_setup_finished', 'before_play_started', 'before_play_finished', 'playback_requested']);
  h.audios[0].onplaying();
  assert.equal(stages.at(-1), 'actual_speech_start');
  h.audios[0].onended();
  await speaking;
});
