import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AwarenessController,
  buildAwarenessPrompt,
  parseAwarenessResponse
} from '../electron/desktop-awareness-renderer.js';

test('awareness uses the shared response protocol and keeps silence', () => {
  const prompt = buildAwarenessPrompt({ trigger: 'typing_session_end' });
  assert.match(prompt, /shared spoken-response protocol/);
  assert.match(prompt, /Silence:\n\{"reply":false\}/);
});

test('awareness parser preserves normalized Japanese text', () => {
  const decision = parseAwarenessResponse(JSON.stringify({ react: true, text: '  いいね。  ' }));
  assert.equal(decision.text, 'いいね。');
});

test('Environment Reactions off suppresses analysis and a reply already in flight', async () => {
  let reactionsEnabled = false, requests = 0, commands = 0, visuals = 0, release;
  const controller = new AwarenessController({
    logger: { info() {}, error() {} },
    reactionsEnabled: () => reactionsEnabled,
    sendAgentMessageRaw: () => { requests++; return new Promise(resolve => { release = resolve; }); },
    parseAgentResponse: JSON.parse, executeAgentCommand: async () => { commands++; },
    applyVisualReaction: () => { visuals++; }, isAgentBusy: () => false, isSpeaking: () => false,
  });
  controller.enabled = true;
  const candidate = { trigger: 'typing_session_end', priority: 'normal', context: {} };
  await controller.analyzeCandidate(candidate);
  assert.equal(requests, 0);
  for (const reply of [
    '{"react":true,"text":"おはよう！"}',
    '{"react":true,"speak":false,"visualReaction":"surprised"}',
  ]) {
    reactionsEnabled = true;
    const pending = controller.analyzeCandidate(candidate);
    reactionsEnabled = false;
    release(reply); await pending;
  }
  assert.equal(commands, 0);
  assert.equal(visuals, 0);
});

test('awareness rejects invalid and oversized dialogue', () => {
  for (const text of [7, 'hello', '界'.repeat(501)]) {
    assert.equal(parseAwarenessResponse(JSON.stringify({ react: true, text })), null);
  }
});

test('awareness command construction passes Japanese dialogue', async () => {
  for (const reply of [
    '{"reply":true,"text":"いい感じだね。"}',
    '{"react":true,"text":"じゅんちょうだね。"}'
  ]) {
    let commandInput;
    const controller = new AwarenessController({
      logger: { info() {}, error() {} },
      sendAgentMessageRaw: async () => reply,
      parseAgentResponse: (value) => {
        commandInput = JSON.parse(value);
        return commandInput;
      },
      executeAgentCommand: async () => {},
      isAgentBusy: () => false,
      isSpeaking: () => false
    });
    controller.enabled = true;

    await controller.analyzeCandidate({
      trigger: 'typing_session_end',
      priority: 'normal',
      context: { appName: 'Editor', windowTitle: 'note.txt' }
    });

    assert.equal(commandInput.text, JSON.parse(reply).text);
  }
});

test('react=false remains a silent decision and ignores dialogue', () => {
  assert.deepEqual(
    parseAwarenessResponse('{"react":false,"text":"ignored"}'),
    { react: false }
  );
});
