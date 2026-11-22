import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createJapaneseSpeechPlayer } from '../electron/japanese-speech-player.js';
import { prepareSpeechSegments, cancelSpeechPreparations, splitSpeechSegments } from '../electron/speech-segments.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('    function createLipSyncSystem()'), source.indexOf('    function createBlinkSystem()'));
const synthesizeSource = source.slice(source.indexOf('function synthesizeSpeech('), source.indexOf('function setupTokenDialog()'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const voice = { audio: new Uint8Array([1]), durationSeconds: 1 };

function harness({ synthesize = async () => voice, begin = async () => ({ sessionId: 'reply', voiceGain: 0.9 }), saved = {} } = {}) {
  const subtitles = [], audios = [], ended = [], requests = [];
  const context = vm.createContext({
    window: { electronAPI: { replyAudio: { begin, end: async id => ended.push(id) } } },
    localStorage: { getItem: key => saved[key] ?? null },
    services: { synthesize: (input, options) => { requests.push(input); return synthesize(input, options); } },
    createJapaneseSpeechPlayer: options => createJapaneseSpeechPlayer({ ...options,
      createContext: () => null,
      createUrl: () => 'blob:test', revokeUrl() {},
      createAudio: () => {
        const audio = { paused: true, play() { this.paused = false; return Promise.resolve(); },
          pause() { this.paused = true; }, removeAttribute() {}, load() {} };
        audios.push(audio);
        return audio;
      },
    }),
    prepareSpeechSegments, cancelSpeechPreparations, splitSpeechSegments,
    logger: { info() {}, warn() {} },
    updateHikariState() {}, currentIdleTimeout: null, idleSuspended: false,
    showSpeakingBubble: text => subtitles.push(text), displayCharacterAtIndex() {}, getWordCount: () => 1,
    hideSpeakingBubble() {}, scheduleRandomIdle() {}, statusDiv: { textContent: '' },
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
  });
  const system = vm.runInContext(synthesizeSource + factory + '\ncreateLipSyncSystem();', context);
  return { system, subtitles, audios, ended, requests, context };
}

test('Electron streams prepared lines in order and presents corresponding subtitles at audio start', async () => {
  let finishSecond;
  let beginCalls = 0, historyCalls = 0, setupCalls = 0;
  const h = harness({
    synthesize: ({ text }) => text === 'にばん。' ? new Promise(resolve => { finishSecond = resolve; }) : voice,
    begin: async () => { beginCalls++; return { sessionId: 'reply', voiceGain: 0.9 }; },
  });
  const speaking = h.system.startSpeaking('いちばん。\nにばん。', {
    beforePlay: () => { setupCalls++; }, onStart: () => { historyCalls++; },
  });
  assert.deepEqual(h.requests.map(input => input.text), ['いちばん。', 'にばん。']);
  await tick();
  assert.deepEqual(h.subtitles, []);
  h.audios[0].onplaying();
  assert.deepEqual(h.subtitles, ['いちばん。']);
  h.audios[0].onended();
  await tick();
  assert.equal(h.audios.length, 1, 'second audio must wait for its own synthesis');
  finishSecond(voice);
  await tick();
  h.audios[1].onplaying();
  assert.deepEqual(h.subtitles, ['いちばん。', 'にばん。']);
  h.audios[1].onended();
  await speaking;
  assert.equal(historyCalls, 1);
  assert.equal(setupCalls, 1);
  assert.equal(beginCalls, 1);
  assert.deepEqual(h.ended, ['reply']);
  assert.equal(h.system.isTalking(), false);
});

test('Electron speech preparation uses the current saved TTS configuration and keeps its abort signal', async () => {
  const saved = { tts_url: 'https://tts.example', tts_token: 'test-token', tts_model: 'speech-model' };
  const optionsUsed = [];
  const h = harness({ saved, synthesize: async (_input, options) => { optionsUsed.push(options); return voice; } });

  const speaking = h.system.startSpeaking('おはよう！');
  const { signal, ...config } = optionsUsed[0];
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(config, { ttsUrl: saved.tts_url, ttsToken: saved.tts_token, ttsModel: saved.tts_model });
  h.system.stopSpeaking();
  await speaking;

  delete saved.tts_url;
  const next = h.system.startSpeaking('またね。');
  assert.equal(optionsUsed[1].ttsUrl, null);
  h.system.stopSpeaking();
  await next;
});

test('Electron streams Japanese phrases without requiring line breaks', async () => {
  const h = harness();
  const speaking = h.system.startSpeaking('おはよう、せんせい！またね。');
  assert.deepEqual(h.requests.map(input => input.text), ['おはよう、', 'せんせい！', 'またね。']);
  for (let index = 0; index < 3; index++) {
    await tick();
    h.audios[index].onplaying();
    h.audios[index].onended();
  }
  await speaking;
  assert.deepEqual(h.subtitles, ['おはよう、', 'せんせい！', 'またね。']);
});

test('stopping during animation preparation prevents a late volume adjustment or subtitle', async () => {
  let finishSetup, beginCalls = 0;
  const h = harness({ begin: async () => { beginCalls++; return { sessionId: 'late' }; } });
  const speaking = h.system.startSpeaking('おはよう！', {
    beforePlay: () => new Promise(resolve => { finishSetup = resolve; }),
  });
  await tick();
  h.system.stopSpeaking();
  await speaking;
  finishSetup();
  await tick();
  assert.equal(beginCalls, 0);
  assert.deepEqual(h.subtitles, []);
});

test('stopping while volume setup is pending restores the late session', async () => {
  let finishBegin;
  const h = harness({ begin: () => new Promise(resolve => { finishBegin = resolve; }) });
  const speaking = h.system.startSpeaking('おはよう！');
  await tick();
  h.system.stopSpeaking();
  await speaking;
  finishBegin({ sessionId: 'late', voiceGain: 0.9 });
  await tick();
  assert.deepEqual(h.ended, ['late']);
  assert.deepEqual(h.subtitles, []);
});

test('a later synthesis failure preserves the full reply without duplicating history', async () => {
  let historyCalls = 0;
  const h = harness({ synthesize: ({ text }) => text === 'にばん。' ? Promise.reject(new Error('offline')) : voice });
  const speaking = h.system.startSpeaking('いちばん。\nにばん。', {
    onStart: () => { historyCalls++; }, onTextOnly: () => { historyCalls++; },
  });
  await tick();
  h.audios[0].onplaying(); h.audios[0].onended();
  await speaking;
  assert.deepEqual(h.subtitles, ['いちばん。', 'いちばん。\nにばん。']);
  assert.equal(historyCalls, 1);
  assert.deepEqual(h.ended, ['reply']);
});

test('the drag expression releases at audible speech, after preparation and before the reply expression', async () => {
  let finishSynthesis;
  const events = [];
  const h = harness({ synthesize: () => new Promise(resolve => { finishSynthesis = resolve; }) });
  h.context.window.releaseDragExpression = () => events.push('release-shy');
  const speaking = h.system.startSpeaking('おはよう！', { onStart: () => events.push('reply-expression') });
  await tick();
  assert.equal(h.system.isTalking(), true, 'the talking flag includes preparation');
  assert.deepEqual(events, []);
  finishSynthesis(voice);
  await tick();
  assert.equal(h.audios[0].paused, false, 'play() was called');
  assert.deepEqual(events, [], 'play() alone must not release the held reaction');
  h.audios[0].onplaying();
  assert.deepEqual(events, ['release-shy', 'reply-expression']);
  h.audios[0].onended();
  await speaking;
});

test('failed voice synthesis does not release shy before the next actual spoken reply', async () => {
  const h = harness({ synthesize: async () => { throw new Error('offline'); } });
  let released = 0;
  h.context.window.releaseDragExpression = () => released++;
  await h.system.startSpeaking('おはよう！');
  assert.equal(released, 0);
  assert.equal(h.audios.length, 0);
});
