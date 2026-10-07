import assert from 'node:assert/strict';
import test from 'node:test';
import { replyNeedsAlignmentRepair, splitSpeechSegments } from '../electron/speech-segments.js';

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
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /punctuation boundaries synchronized/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /do not add or omit a boundary/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /kana-only rule applies to words, not punctuation/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /punctuation and line breaks are required in the Japanese VO transcript too/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /1 and 500 characters/);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /text_ja.*only.*Japanese script/i);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /foreign terms or proper names.*katakana/i);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /kana-only rule.*Japanese speech field/i);
  assert.match(BILINGUAL_RESPONSE_INSTRUCTIONS, /stage directions, ruby\/furigana markup, or romanization/);
  assert.doesNotMatch(BILINGUAL_RESPONSE_INSTRUCTIONS, /Hikari|persona|act as.{0,20}\bhuman|personality|\b(?:my|your)\s+name\b|\bname\s+is\b|introduce yourself/i);
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


test('response example uses valid JSON with escaped, aligned segment breaks', () => {
  const example = JSON.parse(BILINGUAL_RESPONSE_INSTRUCTIONS.split('Example: ')[1]);
  assert.equal(example.text.split('\n').length, 2);
  assert.equal(example.text_ja.split('\n').length, 2);
  assert.equal(example.text, example.segments.map(item => item.text).join('\n'));
  assert.equal(example.text_ja, example.segments.map(item => item.text_ja).join('\n'));
  assert.equal(replyNeedsAlignmentRepair(JSON.stringify(example)), false);
  assert.equal(Object.keys(example)[0], 'segments');
  for (const pair of example.segments) {
    assert.equal(splitSpeechSegments(pair.text).length, 1);
    assert.equal(splitSpeechSegments(pair.text_ja).length, 1);
  }
});

test('prompt counterexamples fail the actual splitter, while their corrected pairs pass', () => {
  for (const match of BILINGUAL_RESPONSE_INSTRUCTIONS.matchAll(/^(INVALID pair|CORRECT pair|CORRECT pairs): (\{.*\}|\[.*\])\./gm)) {
    const value = JSON.parse(match[2]);
    const reply = JSON.stringify({ segments: Array.isArray(value) ? value : [value] });
    assert.equal(replyNeedsAlignmentRepair(reply), match[1] === 'INVALID pair');
  }
});
