import assert from 'node:assert/strict';
import test from 'node:test';
import { splitSpeechSegments, prepareSpeechSegments, formatCaption, normalizePairedSegments, replyNeedsAlignmentRepair } from '../electron/speech-segments.js';

test('Electron splits Chinese, Japanese, and Latin punctuation and keeps closing quotes', () => {
  assert.deepEqual(splitSpeechSegments('「早晨，老師！」好嗎？\n再見。'), ['「早晨，', '老師！」', '好嗎？', '再見。']);
  assert.deepEqual(splitSpeechSegments('おはよう、せんせい！げんき？'), ['おはよう、', 'せんせい！', 'げんき？']);
  assert.deepEqual(splitSpeechSegments('One, two; three: four... Really?! Yes.'),
    ['One,', 'two;', 'three:', 'four...', 'Really?!', 'Yes.']);
});

test('Electron handles escaped/newline boundaries, decimals, times, and empty segments', () => {
  assert.deepEqual(splitSpeechSegments('  3.14 at 10:30.\\nNext\r\n\nLast\rEnd  '),
    ['3.14 at 10:30.', 'Next', 'Last', 'End']);
  assert.deepEqual(splitSpeechSegments(null), []);
  assert.deepEqual(splitSpeechSegments('老師！\n。\n😊'), ['老師！。😊']);
});

test('Electron prepares each punctuation phrase immediately in playback order', async () => {
  const requests = [];
  const prepared = prepareSpeechSegments(input => { requests.push(input); return input.text; }, 'はい、わかった！', 1.2);
  assert.deepEqual(requests, [{ text: 'はい、', speed: 1.2 }, { text: 'わかった！', speed: 1.2 }]);
  assert.deepEqual(await Promise.all(prepared.map(item => item.result)), ['はい、', 'わかった！']);
});

test('emoji tails stay on the final phrase, including newlines, flags, keycaps and ZWJ sequences', () => {
  for (const emoji of ['😊', '👩🏽‍💻', '🇭🇰', '1️⃣', '❤️']) {
    assert.deepEqual(splitSpeechSegments(`早晨，老師！\n ${emoji}`), ['早晨，', `老師！${emoji}`]);
    assert.equal(formatCaption(`老師！ ${emoji}`), `老師${emoji}`);
  }
});

test('captions remove punctuation and CJK boundary spacing without changing VO text', () => {
  assert.equal(formatCaption('「早晨， 老師！」'), '早晨老師');
  assert.equal(formatCaption(' Hello, world! '), 'Hello world');
  assert.equal(formatCaption('第一句。\n第二句！'), '第一句第二句');
  assert.deepEqual(splitSpeechSegments('早晨，老師！'), ['早晨，', '老師！']);
});

test('paired protocol validates internal punctuation and merges accidental emoji-only pairs', () => {
  assert.deepEqual(normalizePairedSegments([
    { text: '早晨，老師！', text_ja: 'おはよう、せんせい！' },
    { text: '😊', text_ja: '' },
  ]), [{ text: '早晨，', text_ja: 'おはよう、' }, { text: '老師！😊', text_ja: 'せんせい！' }]);
  const unaligned = [{ text: '早晨，老師！', text_ja: 'おはよう！' }];
  assert.equal(normalizePairedSegments(unaligned, { requireAlignment: true }), null);
  assert.deepEqual(normalizePairedSegments(unaligned), unaligned);
  assert.equal(replyNeedsAlignmentRepair(JSON.stringify({ text: '早晨，老師！', text_ja: 'おはよう！' })), true);
  assert.equal(replyNeedsAlignmentRepair('{"react":false}'), false);
});
