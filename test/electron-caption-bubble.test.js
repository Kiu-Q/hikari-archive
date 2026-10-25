import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatCaption } from '../electron/speech-segments.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const show = source.slice(source.indexOf('    function showSpeakingBubble('), source.indexOf('    function hideSpeakingBubble('));
const display = source.slice(source.indexOf('    function displayCharacterAtIndex('), source.indexOf('    function getWordCount('));

test('complete caption reserves intrinsic space throughout typing and follows each new clean chunk', () => {
  const bubble = { style: { setProperty() {} } }, sizer = { textContent: '' }, caption = { textContent: '' };
  const units = text => [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map(item => item.segment);
  Object.defineProperty(bubble, 'offsetWidth', { get() { throw new Error('Caption width must not be locked to a rounded integer'); } });
  const context = vm.createContext({
    speakingBubble: bubble, speakingBubbleSizer: sizer, speakingBubbleCaption: caption,
    bubbleHideTimer: null, bubbleFadeTimer: null, wordDisplayTimer: null,
    formatCaption, clearTimeout() {}, clearCachedHeadBone() {}, updateSpeakingBubblePosition() {},
    requestAnimationFrame: callback => callback(), splitIntoGraphemes: units,
  });
  vm.runInContext(show + display + '\nshowSpeakingBubble("早晨， 老師！😊");', context);
  assert.equal(sizer.textContent, '早晨老師😊');
  assert.equal(caption.textContent, '早');
  vm.runInContext('displayCharacterAtIndex(99);', context);
  assert.equal(caption.textContent, '早晨老師😊');
  assert.equal(sizer.textContent, caption.textContent);
  vm.runInContext('showSpeakingBubble("好。😊"); displayCharacterAtIndex(99);', context);
  assert.equal(caption.textContent, '好😊');
  assert.equal(sizer.textContent, '好😊');
});
