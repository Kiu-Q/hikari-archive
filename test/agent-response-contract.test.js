import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BILINGUAL_RESPONSE_INSTRUCTIONS,
  normalizeJapaneseText
} from '../electron/agent-response-contract.js';

test('bilingual response instructions define the Traditional Chinese and Japanese fields', () => {
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /"text" and "text_ja"/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /Traditional Chinese/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /spoken Cantonese/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /faithful, natural spoken Japanese translation/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /same meaning and tone/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /1 and 500 characters/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /stage directions, ruby\/furigana markup, or romanization/);
});

test('normalizeJapaneseText trims and converts literal escaped newlines', () => {
  assert.equal(normalizeJapaneseText('  こんにちは\\n世界  '), 'こんにちは\n世界');
  assert.equal(normalizeJapaneseText('  こんにちは\r\n世界  '), 'こんにちは\n世界');
});

test('normalizeJapaneseText returns an empty string for missing or invalid values', () => {
  assert.equal(normalizeJapaneseText(), '');
  assert.equal(normalizeJapaneseText(null), '');
  assert.equal(normalizeJapaneseText(123), '');
  assert.equal(normalizeJapaneseText({ text: 'こんにちは' }), '');
  assert.equal(normalizeJapaneseText('  \n  '), '');
});

test('normalizeJapaneseText enforces the 500 character limit', () => {
  assert.equal(Array.from(normalizeJapaneseText('界'.repeat(500))).length, 500);
  assert.equal(normalizeJapaneseText('界'.repeat(501)), '');
  assert.equal(normalizeJapaneseText('🙂'.repeat(501)), '');
});
