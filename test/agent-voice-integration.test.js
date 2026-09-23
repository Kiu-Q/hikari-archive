import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BILINGUAL_RESPONSE_INSTRUCTIONS, normalizeJapaneseText } from '../electron/agent-response-contract.js';

// Exercise the real API module in the existing monolithic renderer without loading Three.js.
const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const moduleSource = source.slice(source.indexOf('const AgentApiModule ='), source.indexOf('const HistoryModule ='))
  .replaceAll('import.meta.env', 'testEnv');

function harness(reply, speak = async () => {}) {
  const requests = [], history = [], events = [];
  const window = {
    electronAPI: {}, VRMA_ANIMATION_FILE_NAMES: ['wave_fast.vrma'],
    addLocalHistoryMessage: (role, text) => history.push({ role, text }),
    lipSyncSystem: {
      startSpeaking: async (text, japanese, presentation) => {
        if (japanese) {
          await presentation?.beforePlay?.();
          presentation?.onStart?.();
        } else presentation?.onTextOnly?.();
        return speak(text, japanese);
      },
      setAgentCommandActive() {},
    },
    startSmoothTransition: async () => { events.push('animation'); return null; },
  };
  const context = vm.createContext({
    window, document: { getElementById: () => null },
    localStorage: { getItem: () => null }, testEnv: {},
    BILINGUAL_RESPONSE_INSTRUCTIONS, normalizeJapaneseText,
    awarenessController: null, isExpectedAwarenessAbort: () => false,
    THREE: { LoopOnce: 2200 },
    logger: { info() {}, warn() {}, error() {} },
    setTimeout: callback => setTimeout(callback, 0),
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) };
    },
  });
  const api = vm.runInContext(moduleSource + '\nAgentApiModule;', context);
  return { api, requests, history, events, window };
}

test('HTTP prompt asks for bilingual JSON while history and speech remain separate', async () => {
  const spoken = [];
  const h = harness('{"text":"老師，早晨！","text_ja":"先生、おはよう！"}', async (...args) => spoken.push(args));
  await h.api.sendAgentMessage('早晨');
  assert.match(h.requests[0].messages[0].content, /text_ja/);
  assert.match(h.requests[0].messages[0].content, /Japanese translation/);
  assert.equal(h.history.at(-1).text, '老師，早晨！');
  assert.deepEqual(spoken[0], ['老師，早晨！', '先生、おはよう！']);
  await h.api.sendAgentMessageRaw('Desktop awareness event');
  assert.match(h.requests[1].messages[0].content, /text_ja/);
});

test('legacy replies preserve Chinese but never use it as Japanese speech', async () => {
  const spoken = [];
  const h = harness('{"text":"老師，早晨！"}', async (...args) => spoken.push(args));
  await h.api.sendAgentMessage('早晨');
  assert.deepEqual(spoken[0], ['老師，早晨！', '']);
  const parsed = h.api.parseAgentResponse("{'text':'老師，早晨！','text_ja':'先生、おはよう！'}");
  assert.equal(parsed.text_ja, '先生、おはよう！');
});

test('after animation waits for real playback completion promise', async () => {
  let finish;
  const h = harness('', () => new Promise(resolve => { finish = resolve; }));
  const execution = h.api.executeAgentCommand({ text: '老師，早晨！', text_ja: '先生、おはよう！',
    animation: { file: 'wave_fast.vrma', timing: 'after' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.events, []);
  finish();
  await execution;
  assert.deepEqual(h.events, ['animation']);
});

test('command waits for the after-animation completion event before returning to idle', async () => {
  const h = harness('');
  let finishAnimation, notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  h.window.startSmoothTransition = async () => ({ id: 'clip' });
  h.window.waitForActionEnd = () => {
    notifyWaiting();
    return new Promise(resolve => { finishAnimation = resolve; });
  };
  h.window.loadIdleLoop = async () => h.events.push('idle');
  const execution = h.api.executeAgentCommand({ text: '早晨', text_ja: 'おはよう',
    animation: { file: 'wave_fast.vrma', timing: 'after' } });
  await waiting;
  assert.deepEqual(h.events, []);
  finishAnimation(true);
  await execution;
  assert.deepEqual(h.events, ['idle']);
});

test('reply history, during animation and expression are deferred to audio start', async () => {
  const h = harness('');
  let presentation, finish;
  h.window.lipSyncSystem.startSpeaking = (_text, _japanese, callbacks) => {
    presentation = callbacks;
    return new Promise(resolve => { finish = resolve; });
  };
  h.window.prepareSpeakingAnimation = async () => {
    h.events.push('prepared');
    return () => h.events.push('during-animation');
  };
  h.window.applyFacialExpression = () => h.events.push('expression');
  const execution = h.api.executeAgentCommand({ text: '早晨', text_ja: 'おはよう',
    animation: { file: 'wave_fast.vrma', timing: 'during' }, expression: { name: 'shy' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.history, []);
  assert.deepEqual(h.events, []);
  await presentation.beforePlay();
  assert.deepEqual(h.events, ['prepared']);
  assert.deepEqual(h.history, []);
  presentation.onStart();
  assert.deepEqual(h.history, [{ role: 'agent', text: '早晨' }]);
  assert.deepEqual(h.events, ['prepared', 'during-animation', 'expression']);
  finish();
  await execution;
});
