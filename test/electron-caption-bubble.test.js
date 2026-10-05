import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatCaption } from '../electron/speech-segments.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const show = source.slice(source.indexOf('    function showSpeakingBubble('), source.indexOf('    function hideSpeakingBubble('));
const display = source.slice(source.indexOf('    function displayCharacterAtIndex('), source.indexOf('    function getWordCount('));

test('caption width includes padding once, follows each new chunk, and measures clean text', () => {
  const bubble = { textContent: '', style: { setProperty() {} } };
  const units = text => [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map(item => item.segment);
  Object.defineProperty(bubble, 'offsetWidth', { get() {
    if (bubble.style.width === 'auto') return units(bubble.textContent).length * 16 + 34;
    return parseFloat(bubble.style.width) + (bubble.style.boxSizing === 'border-box' ? 0 : 34);
  } });
  const context = vm.createContext({
    speakingBubble: bubble, bubbleHideTimer: null, bubbleFadeTimer: null, wordDisplayTimer: null,
    formatCaption, clearTimeout() {}, clearCachedHeadBone() {}, updateSpeakingBubblePosition() {},
    requestAnimationFrame: callback => callback(), splitIntoGraphemes: units,
  });
  vm.runInContext(show + display + '\nshowSpeakingBubble("早晨， 老師！😊"); displayCharacterAtIndex(99);', context);
  assert.equal(bubble.textContent, '早晨老師😊');
  assert.equal(bubble.offsetWidth, 5 * 16 + 34);
  vm.runInContext('showSpeakingBubble("好。😊"); displayCharacterAtIndex(99);', context);
  assert.equal(bubble.textContent, '好😊');
  assert.equal(bubble.offsetWidth, 2 * 16 + 34);
});
