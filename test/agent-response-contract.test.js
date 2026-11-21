import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESPONSE_INSTRUCTIONS,
  normalizeJapaneseText
} from '../electron/agent-response-contract.js';

test('response instructions define a raw Japanese dialogue command', () => {
  assert.match(RESPONSE_INSTRUCTIONS, /one raw JSON object/);
  assert.match(RESPONSE_INSTRUCTIONS, /"text".*natural spoken Japanese/);
  assert.match(RESPONSE_INSTRUCTIONS, /between 1 and 500 characters/);
  assert.match(RESPONSE_INSTRUCTIONS, /"timing": "during"\|"after"/);
  assert.match(RESPONSE_INSTRUCTIONS, /小光 as ヒカリ.*ノゾミ.*キヴォトス.*シュッチョウシュコウ/);
});

test('normalizeJapaneseText trims and converts literal escaped newlines', () => {
  assert.equal(normalizeJapaneseText('  こんにちは\\n世界  '), 'こんにちは\n世界');
  assert.equal(normalizeJapaneseText('  こんにちは\r\n世界  '), 'こんにちは\n世界');
});

test('normalizeJapaneseText returns an empty string for missing or invalid values', () => {
  assert.equal(normalizeJapaneseText(), '');
  assert.equal(normalizeJapaneseText(null), '');
  assert.equal(normalizeJapaneseText(123), '');
  assert.equal(normalizeJapaneseText('Hello'), '');
  assert.equal(normalizeJapaneseText({ text: 'こんにちは' }), '');
  assert.equal(normalizeJapaneseText('  \n  '), '');
});

test('normalizeJapaneseText enforces the 500 character limit', () => {
  assert.equal(Array.from(normalizeJapaneseText('界'.repeat(500))).length, 500);
  assert.equal(normalizeJapaneseText('界'.repeat(501)), '');
  assert.equal(normalizeJapaneseText('🙂'.repeat(501)), '');
});
