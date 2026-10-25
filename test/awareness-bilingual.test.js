import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AwarenessController,
  buildAwarenessPrompt,
  parseAwarenessResponse
} from '../electron/desktop-awareness-renderer.js';

test('awareness prompt includes text_ja for reactions and keeps silence unchanged', () => {
  const prompt = buildAwarenessPrompt({ trigger: 'typing_session_end' });
  assert.match(prompt, /shared spoken-response protocol, including paired "segments"/);
  assert.match(prompt, /Silence:\n\{"reply":false\}/);
});

test('awareness parser preserves normalized Japanese text', () => {
  const decision = parseAwarenessResponse(JSON.stringify({
    react: true,
    text: '  有新想法。  ',
    text_ja: '  新しい考えが浮かんだね。\\nいいね。  '
  }));

  assert.equal(decision.text, '有新想法。');
  assert.equal(decision.text_ja, '新しい考えが浮かんだね。\nいいね。');
});

test('awareness accepts the same paired chunks as conversation and greeting', () => {
  const segments = [{ text: '早晨，', text_ja: 'おはよう、' }, { text: '老師！😊', text_ja: 'せんせい！' }];
  const decision = parseAwarenessResponse(JSON.stringify({ react: true, segments }));
  assert.deepEqual(decision.segments, segments);
  assert.equal(decision.text, '早晨，\n老師！😊');
  assert.equal(decision.text_ja, 'おはよう、\nせんせい！');
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
    '{"react":true,"text":"早晨！","text_ja":"おはよう！"}',
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

test('legacy and invalid Japanese fields do not reject a valid awareness reaction', () => {
  const legacy = parseAwarenessResponse('{"react":true,"text":"今次幾順。"}');
  const invalid = parseAwarenessResponse(JSON.stringify({
    react: true,
    text: '今次幾順。',
    text_ja: 7
  }));
  const oversized = parseAwarenessResponse(JSON.stringify({
    react: true,
    text: '今次幾順。',
    text_ja: '界'.repeat(501)
  }));

  assert.equal(legacy?.react, true);
  assert.equal(legacy?.text_ja, '');
  assert.equal(invalid?.react, true);
  assert.equal(invalid?.text_ja, '');
  assert.equal(oversized?.react, true);
  assert.equal(oversized?.text_ja, '');
});

test('awareness command construction passes text_ja and supplies empty for legacy replies', async () => {
  for (const reply of [
    '{"react":true,"text":"いい感じ。","text_ja":"いい感じだね。"}',
    '{"react":true,"text":"今次幾順。"}'
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

    assert.equal(commandInput.text_ja, reply.includes('いい感じだね') ? 'いい感じだね。' : '');
  }
});

test('react=false remains a silent decision and ignores translation fields', () => {
  assert.deepEqual(
    parseAwarenessResponse('{"react":false,"text":"ignored","text_ja":"無視"}'),
    { react: false }
  );
});
