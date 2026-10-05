import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createReplyTimingRecorder } from '../electron/reply-timing.js';
import { createServices } from '../shared/services.js';
import {
  BILINGUAL_RESPONSE_INSTRUCTIONS,
  JAPANESE_TTS_INSTRUCTIONS,
  normalizeJapaneseText
} from '../electron/agent-response-contract.js';
import { prepareReplySpeech, cancelSpeechPreparations, normalizePairedSegments, replyNeedsAlignmentRepair, buildAlignmentRepairPrompt } from '../electron/speech-segments.js';
import { normalizeScreenshotAttachment, screenshotMessageContent } from '../electron/screenshot-attachment.js';

// Exercise the real API module in the existing monolithic renderer without loading Three.js.
const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const moduleSource = source.slice(source.indexOf('const AgentApiModule ='), source.indexOf('const HistoryModule ='))
  .replaceAll('import.meta.env', 'testEnv');

function harness(reply, speak = async () => {}, awareness = null, { browser = false } = {}) {
  const requests = [], history = [], events = [], syntheses = [], presentations = [];
  const window = {
    location: { origin: 'http://hikari.test' },
    electronAPI: browser ? undefined : { awareness }, VRMA_ANIMATION_FILE_NAMES: ['wave_fast.vrma'],
    addLocalHistoryMessage: (role, text, attachment) => history.push({ role, text, ...(attachment ? { attachment } : {}) }),
    lipSyncSystem: {
      startSpeaking: async (text, japanese, presentation) => {
        presentations.push(presentation);
        await Promise.all((presentation?.prepared || []).map(item => item.result));
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
  const services = createServices({ electronAPI: window.electronAPI, fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    const content = Array.isArray(reply) ? reply[Math.min(requests.length - 1, reply.length - 1)] : reply;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  } });
  services.synthesize = async (input, options = {}) => {
    syntheses.push({ input, signal: options.signal });
    return { audio: new Uint8Array([1]), durationSeconds: 0.1, sampleRate: 24_000, channels: 1 };
  };
  const context = vm.createContext({
    window, createReplyTimingRecorder, document: { getElementById: () => null },
    localStorage: { getItem: () => null }, testEnv: {},
    BILINGUAL_RESPONSE_INSTRUCTIONS, JAPANESE_TTS_INSTRUCTIONS, normalizeJapaneseText, prepareReplySpeech, cancelSpeechPreparations, normalizePairedSegments, replyNeedsAlignmentRepair, buildAlignmentRepairPrompt,
    normalizeScreenshotAttachment, screenshotMessageContent,
    worldStateStore: { applyPatch() {}, serializeForAgent: () => '' },
    awarenessController: null, isExpectedAwarenessAbort: () => false,
    THREE: { LoopOnce: 2200 },
    logger: { info() {}, warn() {}, error() {} },
    setTimeout: callback => setTimeout(callback, 0),
    clearTimeout,
    services,
  });
  const api = vm.runInContext(moduleSource + '\nAgentApiModule;', context);
  return { api, requests, history, events, syntheses, presentations, window };
}

test('normal chat and awareness use the same functional response protocol', async () => {
  const spoken = [];
  const h = harness('{"text":"老師，早晨！","text_ja":"先生、おはよう！"}', async (...args) => spoken.push(args));
  await h.api.sendAgentMessage('早晨');
  const systemInstructions = h.requests[0].messages.find(message => message.role === 'system')?.content;
  assert.ok(systemInstructions, 'normal chat should include system formatting instructions');
  assert.match(systemInstructions, /JSON/);
  assert.match(systemInstructions, /text_ja/);
  assert.match(systemInstructions, /Japanese translation/);
  assert.match(systemInstructions, /text_ja.*only.*Japanese script/i);
  assert.match(systemInstructions, /foreign terms or proper names.*katakana/i);
  assert.match(systemInstructions, /animation/i);
  assert.doesNotMatch(systemInstructions, /Hikari|persona|act as.{0,20}\bhuman|personality|\b(?:my|your)\s+name\b|\bname\s+is\b|introduce yourself/i);
  assert.equal(h.history.at(-1).text, '老師，早晨！');
  assert.deepEqual(spoken[0], ['老師，早晨！', '先生、おはよう！']);

  const awarenessPrompt = 'Desktop awareness event: the user has been idle.';
  await h.api.sendAgentMessageRaw(awarenessPrompt, { requestType: 'awareness' });
  assert.equal(h.requests[1].messages[0].content, systemInstructions);
  assert.deepEqual(h.requests[1].messages.at(-1), { role: 'user', content: awarenessPrompt });
  assert.equal(h.requests[1].messages.length, 2);
});

test('screenshots use the existing chat protocol only for their own turn, including repair', async () => {
  const malformed = '{"text":"早晨，老師！","text_ja":"おはよう！"}';
  const fixed = '{"text":"早晨！","text_ja":"おはよう！"}';
  const h = harness([malformed, fixed, fixed]);
  const attachment = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1280, height: 720 };
  assert.equal(await h.api.sendAgentMessage('睇吓畫面', { attachment }), true);
  const first = h.requests[0].messages.at(-1);
  assert.equal(first.content[0].text, '睇吓畫面');
  assert.equal(first.content[1].image_url.url, attachment.dataUrl);
  assert.equal(h.requests[1].messages.at(-1).content[1].image_url.url, attachment.dataUrl);
  assert.equal(h.history[0].attachment.thumbnailDataUrl, attachment.thumbnailDataUrl);
  await h.api.sendAgentMessage('下一句');
  assert.ok(h.requests[2].messages.every(message => typeof message.content === 'string'));
  assert.ok(!JSON.stringify(h.requests[2]).includes(attachment.dataUrl));
  assert.match(h.requests[2].messages[1].content, /Screenshot attached to this turn/);
});

test('queued screenshot input is copied at enqueue time so later draft edits cannot replace it', async () => {
  const h = harness('{"text":"早晨！","text_ja":"おはよう！"}');
  const attachment = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1280, height: 720 };
  const sending = h.api.sendAgentMessage('畫面', { attachment });
  attachment.dataUrl = 'changed-draft';
  await sending;
  assert.equal(h.requests[0].messages.at(-1).content[1].image_url.url, 'data:image/jpeg;base64,/9j/2Q==');
});

test('greeting, touch, conversation, panel events and awareness share one system protocol', async () => {
  const h = harness('{"text":"早晨！","text_ja":"おはよう！"}');
  await h.api.prepareInitialGreeting();
  await h.api.sendAgentMessage('User touched your head.');
  await h.api.sendAgentMessage('早晨');
  await h.api.sendAgentMessageRaw('The conversation history panel has been manually shown by the user.');
  await h.api.sendAgentMessageRaw('Desktop awareness event.', { requestType: 'awareness' });
  const protocol = h.requests[0].messages[0].content;
  assert.match(protocol, /"segments"/);
  assert.equal(h.requests.length, 5);
  for (const request of h.requests) assert.equal(request.messages[0].content, protocol);
});

test('mismatched normal reply is repaired once before synthesis and history persistence', async () => {
  const malformed = JSON.stringify({ text: '早晨，老師！', text_ja: 'おはよう！' });
  const fixed = JSON.stringify({ segments: [
    { text: '早晨，', text_ja: 'おはよう、' },
    { text: '老師！😊', text_ja: 'せんせい！' },
  ] });
  const h = harness([malformed, fixed]);
  await h.api.sendAgentMessage('早晨');
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].messages.at(-1).content, /Repair only/);
  assert.deepEqual(h.syntheses.map(item => item.input.text), ['おはよう、', 'せんせい！']);
  assert.deepEqual(h.presentations[0].segments, JSON.parse(fixed).segments);
  assert.equal(h.history.at(-1).text, '早晨，\n老師！😊');
});

test('alignment repair is bounded and retains the whole legacy reply instead of cancelling it', async () => {
  const h = harness('{"text":"早晨，老師！","text_ja":"おはよう！"}');
  await h.api.sendAgentMessage('早晨');
  assert.equal(h.requests.length, 2);
  assert.equal(h.syntheses.length, 1);
  assert.equal(h.history.at(-1).text, '早晨，老師！');
  assert.match(h.requests[1].messages.at(-1).content, /punctuation in the Japanese VO transcript text_ja too/);
});

test('greeting survives a repeated punctuation mismatch using explicit complete pairs', async () => {
  const segments = [{ text: '早晨，老師！😊', text_ja: 'おはよう！' }];
  const h = harness(JSON.stringify({ segments }));
  await h.api.prepareInitialGreeting();
  await h.api.startSession();
  assert.equal(h.requests.length, 2);
  assert.equal(h.presentations.length, 1);
  assert.deepEqual(h.presentations[0].segments, segments);
  assert.deepEqual(h.syntheses.map(item => item.input.text), ['おはよう！']);
  assert.equal(h.history.at(-1).text, '早晨，老師！😊');
});

test('initial greeting uses desktop context and the shared response protocol', async () => {
  let contextCalls = 0;
  const h = harness('{"text":"早晨！","text_ja":"おはよう！"}', async () => {}, {
    getGreetingContext: async () => {
      contextCalls += 1;
      return {
        activeWindow: { appName: 'Safari', windowTitle: 'Morning playlist' },
        mediaPlaybackState: 'playing',
      };
    },
  });

  await h.api.prepareInitialGreeting();

  assert.equal(contextCalls, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, 'openclaw/default');
  assert.equal(h.requests[0].messages.length, 2, 'greeting shares the system contract without chat history');
  assert.equal(h.requests[0].messages.at(-1).role, 'user');
  const prompt = h.requests[0].messages.map(item => item.content).join("\n");
  assert.match(prompt, /Open application: Safari/);
  assert.match(prompt, /Open window: Morning playlist/);
  assert.match(prompt, /System media output: Active/);
  assert.match(prompt, /brief, natural greeting that suits the available desktop context/i);
  assert.match(prompt, /prioritize acknowledging it if it would feel socially natural and useful/i);
  assert.match(prompt, /not the actual contents of the window/i);
  assert.match(prompt, /Do not force a reference/i);
  assert.match(prompt, /one JSON command/);
  assert.match(prompt, /spoken Cantonese/);
  assert.match(prompt, /same number and order of phrases/);
  assert.match(prompt, /text_ja.*only.*Japanese script/i);
  assert.match(prompt, /foreign terms or proper names.*katakana/i);
  assert.doesNotMatch(prompt, /Hikari|persona|act as.{0,20}\bhuman|personality|\b(?:my|your)\s+name\b|\bname\s+is\b|introduce yourself/i);
  assert.deepEqual(h.history, [], 'the startup greeting must not add chat history');
});

test('initial greeting degrades unavailable desktop context to Unknown', async () => {
  const h = harness('{"text":"早晨！","text_ja":"おはよう！"}', async () => {}, {
    getGreetingContext: async () => { throw new Error('permission unavailable'); },
  });

  await h.api.prepareInitialGreeting();

  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].messages.length, 2);
  const prompt = h.requests[0].messages.map(item => item.content).join("\n");
  assert.match(prompt, /Open application: Unknown/);
  assert.match(prompt, /Open window: Unknown/);
  assert.match(prompt, /System media output: Unknown/);
  assert.deepEqual(h.history, []);
});

test('Electron greeting starts segmented Japanese synthesis before presentation', async () => {
  const h = harness(JSON.stringify({ text: '早晨！\n今日點呀？', text_ja: 'おはよう！\nきょうはどう？' }));

  await h.api.prepareInitialGreeting();

  assert.equal(h.requests.length, 1, 'Electron startup should request its greeting');
  assert.equal(h.requests[0].messages.at(-1).role, 'user');
  assert.equal(h.syntheses.length, 2, 'each line should synthesize before startup presentation');
  assert.deepEqual(h.syntheses[0].input, { text: 'おはよう！', speed: 1 });
  assert.equal(h.presentations.length, 0);

  await h.api.startSession();
  assert.equal(h.syntheses.length, 2, 'presentation should reuse the preparation results');
  assert.equal(h.presentations.length, 1);
  assert.equal(h.presentations[0].prepared[0].result instanceof Promise, true);
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

test('queued command synthesis starts while an earlier command waits for its animation', async () => {
  const h = harness('');
  let finishAnimation, notifyAnimationWait;
  const animationWait = new Promise(resolve => { notifyAnimationWait = resolve; });
  const firstAnimation = new Promise(resolve => { finishAnimation = resolve; });
  h.window.startSmoothTransition = async () => ({ id: 'clip' });
  h.window.waitForActionEnd = () => {
    notifyAnimationWait();
    return firstAnimation;
  };

  const first = h.api.executeAgentCommand({
    text: 'First reply', text_ja: '一つ目',
    animation: { file: 'wave_fast.vrma', timing: 'after' }
  });
  await animationWait;
  assert.deepEqual(h.syntheses.map(({ input }) => input.text), ['一つ目']);

  const second = h.api.executeAgentCommand({ text: 'Second reply', text_ja: '二つ目' });
  assert.deepEqual(h.syntheses.map(({ input }) => input.text), ['一つ目', '二つ目'],
    'queued voice should synthesize immediately instead of waiting behind animation playback');
  assert.equal(h.presentations.length, 1, 'the queued command should not start presentation before the earlier animation ends');

  finishAnimation(true);
  await Promise.all([first, second]);
  assert.equal(h.presentations.length, 2);
});


test('greeting is prepared and presented once even when desktop context never resolves', async () => {
  const h = harness('{"text":"早晨！","text_ja":"おはよう！"}', async () => {}, {
    getGreetingContext: () => new Promise(() => {}),
  });
  const first = h.api.prepareInitialGreeting();
  assert.equal(h.api.prepareInitialGreeting(), first);
  await first;
  assert.match(h.requests[0].messages.at(-1).content, /Open application: Unknown/);
  await Promise.all([h.api.startSession(), h.api.startSession()]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.syntheses.length, 1);
  assert.equal(h.presentations.length, 1);
});

test('failed command cancels unused speech and releases command ownership for the next reply', async () => {
  const h = harness('');
  const active = [];
  h.window.lipSyncSystem.setAgentCommandActive = value => active.push(value);
  h.window.lipSyncSystem.startSpeaking = async () => { throw new Error('playback failed'); };
  await assert.rejects(h.api.executeAgentCommand({ text: '早晨', text_ja: 'おはよう' }), /playback failed/);
  assert.equal(h.syntheses[0].signal.aborted, true);
  assert.equal(active.at(-1), false);
  h.window.lipSyncSystem.startSpeaking = async () => {};
  await h.api.executeAgentCommand({ text: '再試', text_ja: 'もういちど' });
  assert.equal(active.at(-1), false);
});

test('reported history reply repair supplies the actual three-versus-four boundaries', async () => {
  const malformed = JSON.stringify({ segments: [{
    text: '知道啦，老師——對話歷史面板而家隱藏咗，唔影響我哋繼續傾偈💚',
    text_ja: 'わかりました、せんせい。かいわのれきしパネルはいま かくされていても、これからも はなせます。',
  }] });
  const fixed = { segments: [
    { text: '知道啦，', text_ja: 'わかりました、' },
    { text: '老師——對話歷史面板而家隱藏咗，', text_ja: 'せんせいがかいわのれきしパネルをかくしても、' },
    { text: '唔影響我哋繼續傾偈💚', text_ja: 'これからもはなせます。' },
  ] };
  const h = harness([malformed, JSON.stringify(fixed)]);
  await h.api.sendAgentMessage('繼續傾偈');
  const repair = h.requests[1].messages.at(-1).content;
  assert.match(repair, /"chineseCount":3,"japaneseCount":4/);
  assert.match(repair, /Translate each phrase individually/);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.presentations[0].segments, fixed.segments);
  assert.equal(h.syntheses.length, 3);
});

test('real reply path records both HTTP attempts, synthesis and first speech start under one ID', async () => {
  const h = harness([
    JSON.stringify({ text: '早晨，老師！', text_ja: 'おはよう！' }),
    JSON.stringify({ segments: [{ text: '早晨，', text_ja: 'おはよう、' }, { text: '老師！', text_ja: 'せんせい！' }] }),
  ]);
  await h.api.sendAgentMessage('早晨');
  const records = h.window.hikariReplyTimings.getRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'completed');
  assert.equal(records[0].httpAttempts, 2);
  assert.equal(records[0].spans.filter(item => item.stage === 'audio_render').length, 2);
  assert.ok(records[0].totalToSpeechMs >= records[0].agentReplyMs);
  assert.ok(records[0].marks.speech_started >= records[0].marks.first_audio_ready);
  assert.equal(records[0].totalToSpeechMs, records[0].marks.speech_started);
  assert.equal(h.window.hikariReplyTimings.exportJSON().includes('早晨'), false);
});
