import assert from 'node:assert/strict';
import test from 'node:test';
import { AwarenessController, buildAwarenessPrompt, parseAwarenessResponse } from '../electron/desktop-awareness-renderer.js';
import { awarenessConfig } from '../electron/awareness-config.js';

const candidate = { id: 'event-1', timestamp: Date.now(), trigger: 'window_changed', priority: 'normal', context: { appName: 'Editor', windowTitle: 'notes.md' } };
const capture = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1120, height: 630, capturedAt: Date.now(), context: { appName: 'Browser', windowTitle: 'New page' } };
const spoken = JSON.stringify({ reply: true, text: '有新進展。', text_ja: '進んだね。' });
const captureRequest = '{"capture_screen":true}';

function harness(replies, captureImpl = async () => capture) {
  const requests = [], commands = [], history = [], visuals = [], errors = [];
  let captures = 0, busy = false, speaking = false, reactions = true;
  const controller = new AwarenessController({
    api: { captureScreen: () => { captures++; return captureImpl(); }, noteDirectInteraction() {} },
    logger: { info() {}, error: (...args) => errors.push(args) },
    config: { ...awarenessConfig, debug: false },
    sendAgentMessageRaw: async (prompt, options) => {
      requests.push({ prompt, options });
      const reply = replies[requests.length - 1];
      return typeof reply === 'function' ? reply() : reply;
    },
    parseAgentResponse: JSON.parse, executeAgentCommand: async command => commands.push(command),
    addHistoryMessage: (...args) => history.push(args), applyVisualReaction: (...args) => visuals.push(args),
    isAgentBusy: () => busy, isSpeaking: () => speaking, reactionsEnabled: () => reactions,
  });
  controller.enabled = true;
  return { controller, requests, commands, history, visuals, errors, get captures() { return captures; },
    setBusy: value => { busy = value; }, setSpeaking: value => { speaking = value; }, setReactions: value => { reactions = value; } };
}

test('awareness policy includes the capture upfront and offers only reply or silence', () => {
  const prompt = buildAwarenessPrompt(candidate);
  assert.match(prompt, /one of two outcomes/);
  assert.match(prompt, /fresh screenshot is attached/);
  assert.doesNotMatch(prompt, /capture_screen|follow-up|Visual-only reaction/);
  assert.match(prompt, /\{"reply":false\}/);
  assert.match(prompt, /add "reply":true/);
  assert.deepEqual(parseAwarenessResponse('{"reply":false}'), { react: false });
  assert.equal(parseAwarenessResponse(captureRequest), null);
  assert.deepEqual(parseAwarenessResponse('{"react":false,"capture_screen":true}'), { react: false });
  assert.equal(parseAwarenessResponse('{"capture_screen":"true"}'), null);
  assert.equal(parseAwarenessResponse('{"reply":"true","text":"invalid"}'), null);
});

test('reply and silence both receive a capture in their only agent request', async () => {
  for (const reply of [spoken, '{"reply":false}', 'invalid']) {
    const h = harness([reply]);
    await h.controller.analyzeCandidate(candidate);
    assert.equal(h.captures, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.attachment.dataUrl, capture.dataUrl);
    assert.equal(h.commands.length, reply === spoken ? 1 : 0);
    assert.equal(h.history.length, 0);
  }
});

test('automatic capture happens before analysis and only the response is presented', async () => {
  const h = harness([spoken], async () => {
    assert.equal(h.requests.length, 0, 'Capture precedes the first agent request');
    return capture;
  });
  await h.controller.analyzeCandidate(candidate);
  assert.equal(h.captures, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.attachment.dataUrl, capture.dataUrl);
  assert.match(h.requests[0].prompt, /fresh screenshot is attached/);
  assert.match(h.requests[0].prompt, /Screenshot application: Browser/);
  assert.match(h.requests[0].prompt, /Screenshot window: New page/);
  assert.doesNotMatch(h.requests[0].prompt, /capture_screen/);
  assert.equal(h.requests[0].options.requestType, 'awareness');
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].text, '有新進展。');
  assert.equal(h.commands[0].text_ja, '進んだね。');
  assert.equal(h.history.length, 0);
  assert.equal(h.controller.recentReactions.length, 1);
  assert.equal(h.controller.reactionTimes.length, 1);
  assert.equal(h.errors.length, 0);
});

test('silence and legacy visual reactions do not produce speech or capture history', async () => {
  for (const reply of ['{"reply":false}', '{"react":true,"speak":false,"visualReaction":"surprised"}']) {
    const h = harness([reply]);
    await h.controller.analyzeCandidate(candidate);
    assert.equal(h.captures, 1);
    assert.equal(h.commands.length, 0);
    assert.equal(h.visuals.length, reply.includes('surprised') ? 1 : 0);
    assert.equal(h.history.length, 0);
    assert.equal(h.controller.reactionTimes.length, 0);
  }
});

test('unavailable, invalid or denied capture stays invisible and gives the agent a metadata-only decision', async () => {
  for (const captureImpl of [async () => null, async () => ({ dataUrl: 'invalid' }), async () => { throw new Error('permission denied'); }]) {
    const h = harness(['{"reply":false}'], captureImpl);
    await h.controller.analyzeCandidate(candidate);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.attachment, undefined);
    assert.match(h.requests[0].prompt, /No screenshot is attached/);
    assert.equal(h.commands.length, 0);
    assert.equal(h.visuals.length, 0);
    assert.equal(h.history.length, 0);
    assert.equal(h.errors.length, 0);
  }
});

test('the removed capture decision ends silently without another capture or request', async () => {
  const h = harness([captureRequest]);
  await h.controller.analyzeCandidate(candidate);
  assert.equal(h.captures, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.commands.length, 0);
  assert.equal(h.controller.recentReactions.length, 0);
});

test('busy state, direct conversation or disabled reactions prevent capture and analysis', async () => {
  for (const stop of [h => h.controller.onUserMessageStarted(), h => h.setReactions(false), h => { h.controller.enabled = false; }, h => h.setBusy(true), h => h.setSpeaking(true)]) {
    const h = harness([spoken]);
    stop(h);
    await h.controller.analyzeCandidate(candidate);
    assert.equal(h.captures, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.commands.length, 0);
  }
});

test('interruption during capture discards the image without sending it or responding', async () => {
  for (const stop of [h => h.controller.onUserMessageStarted(), h => h.setReactions(false), h => { h.controller.enabled = false; }, h => h.setBusy(true), h => h.setSpeaking(true)]) {
    let release, started;
    const capturing = new Promise(resolve => { started = resolve; });
    const h = harness([spoken], () => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = h.controller.analyzeCandidate(candidate);
    await capturing;
    stop(h); release(capture); await pending;
    assert.equal(h.requests.length, 0);
    assert.equal(h.commands.length, 0);
    assert.equal(h.controller.analysisRunning, false);
  }
});

test('an interrupted awareness request cannot present a late response', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const h = harness([() => { started(); return new Promise(resolve => { release = resolve; }); }]);
  const pending = h.controller.analyzeCandidate(candidate);
  await waiting;
  h.controller.onUserMessageStarted();
  release(spoken); await pending;
  assert.equal(h.commands.length, 0);
  assert.equal(h.controller.recentReactions.length, 0);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test('a queued final reaction remains interruptible without cancelling its own speech', async () => {
  const h = harness([spoken]);
  h.controller.executeAgentCommand = async (_command, { shouldPresent }) => {
    h.setSpeaking(true);
    assert.equal(shouldPresent(), true, 'Its own speech does not invalidate the reaction');
    h.controller.onUserMessageStarted();
    assert.equal(shouldPresent(), false, 'A direct conversation cancels queued presentation');
    return false;
  };
  await h.controller.analyzeCandidate(candidate);
  assert.equal(h.controller.recentReactions.length, 0);
  assert.equal(h.controller.reactionTimes.length, 0);
});
