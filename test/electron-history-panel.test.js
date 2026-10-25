import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { splitSpeechSegments, formatHistoryChunk } from '../electron/speech-segments.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');

function harness() {
  const elements = new Map(), prompts = [];
  function element() {
    return { style: {}, children: [], listeners: {},
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      addEventListener(name, callback) { this.listeners[name] = callback; },
    };
  }
  const composer = element();
  composer.style.display = 'none';
  elements.set('lipSyncPanel', composer);
  const context = vm.createContext({
    document: { createElement: element, body: element(), getElementById: id => elements.get(id) },
    window: { electronAPI: {},
      showMessagingPanel: () => { composer.style.display = 'flex'; },
      hideMessagingPanel: () => {
        composer.style.display = 'none';
        elements.get('history-panel').style.display = 'none';
      },
    },
    logger: { info() {} },
    splitSpeechSegments, formatHistoryChunk,
    sendEventToAgent: (type, message, options) => prompts.push({ type, message, options }),
    toggleHistoryBtn: element(),
  });
  const moduleStart = source.indexOf('const HistoryModule =');
  const moduleEnd = source.indexOf('// ELECTRON-SPECIFIC SETUP', moduleStart);
  vm.runInContext(source.slice(moduleStart, moduleEnd) + '\nHistoryModule.initHistoryPanel();', context);
  vm.runInContext('const CoreModule = { showMessagingPanel: window.showMessagingPanel };', context);
  const handlerStart = source.indexOf("    toggleHistoryBtn.addEventListener('click'");
  const handlerEnd = source.indexOf('    const webComposerRow', handlerStart);
  vm.runInContext(source.slice(handlerStart, handlerEnd), context);
  return { context, elements, prompts, click: context.toggleHistoryBtn.listeners.click };
}

test('composer-only press is silent; only actual history opening notifies', () => {
  const h = harness();
  h.click();
  assert.equal(h.elements.get('lipSyncPanel').style.display, 'flex');
  assert.equal(h.elements.get('history-panel').style.display, 'none');
  assert.deepEqual(h.prompts, []);
  h.click();
  assert.equal(h.elements.get('history-panel').style.display, 'flex');
  assert.match(h.prompts[0].message, /manually shown/);
  h.click();
  assert.equal(h.elements.get('history-panel').style.display, 'none');
  assert.equal(h.prompts.length, 1);
});

test('history close button and automatic changes stay silent', () => {
  const h = harness();
  vm.runInContext('HistoryModule.showHistoryPanel();', h.context);
  assert.deepEqual(h.prompts, []);
  const close = h.elements.get('history-panel').children[0].children[1];
  close.listeners.click();
  close.listeners.click();
  assert.equal(h.prompts.length, 0);
  vm.runInContext('HistoryModule.showHistoryPanel(); HistoryModule.hideHistoryPanel();', h.context);
  assert.equal(h.prompts.length, 0);
});

test('history opening reply guard expires on close and does not revive on reopening', () => {
  const h = harness();
  h.click(); h.click();
  const first = h.prompts[0].options.shouldPresent;
  assert.equal(first(), true);
  h.click();
  assert.equal(first(), false);
  h.click(); h.click();
  assert.equal(first(), false);
  assert.equal(h.prompts.at(-1).options.shouldPresent(), true);
});

test('history reaction opt-out keeps the panel functional and cancels pending opening replies', () => {
  const h = harness();
  let enabled = false;
  h.context.window.isAnimationEnabled = key => key !== 'history_panel' || enabled;
  h.click(); h.click();
  assert.equal(h.elements.get('history-panel').style.display, 'flex');
  assert.equal(h.prompts.length, 0);
  h.click();
  enabled = true;
  h.click(); h.click();
  const pending = h.prompts[0].options.shouldPresent;
  assert.equal(pending(), true);
  enabled = false;
  assert.equal(pending(), false);
});

test('history chunks hide ending punctuation, keep emoji, and preserve internal user punctuation', () => {
  const h = harness();
  vm.runInContext('HistoryModule.addLocalHistoryMessage("agent", "早晨，老師！😊\\n返嚟啦。👩🏽‍💻");', h.context);
  const cards = h.elements.get('history-messages').children;
  assert.deepEqual(cards.map(card => card.children.at(-1).textContent), ['早晨', '老師😊', '返嚟啦👩🏽‍💻']);
  vm.runInContext('HistoryModule.addLocalHistoryMessage("user", "早晨，老師！");', h.context);
  assert.equal(cards.at(-1).children.at(-1).textContent, '早晨，老師');
});

test('sent screenshot is displayed once in history using only its small thumbnail', () => {
  const h = harness();
  vm.runInContext('HistoryModule.addLocalHistoryMessage("user", "睇吓畫面！", { thumbnailDataUrl: "data:image/jpeg;base64,/9j/2Q==", dataUrl: "full-image-is-not-used" });', h.context);
  const card = h.elements.get('history-messages').children[0];
  const attachment = card.children.find(child => child.className === 'history-screenshot');
  assert.equal(attachment.children[0].src, 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(attachment.children[1].textContent, '📷 Screen screenshot');
  assert.equal(JSON.stringify(card).includes('full-image-is-not-used'), false);
});
