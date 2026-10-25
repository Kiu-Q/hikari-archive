import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const start = source.indexOf('    if (speakBtnPanel) {', source.indexOf('function setupUIEventListeners()'));
const handler = source.slice(start, source.indexOf('    // Speaking speed control', start));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ attachment = { dataUrl: 'test-image' }, result = true, capturing = false } = {}) {
  const sent = [], cleared = [], status = { textContent: '' };
  const textInputPanel = { value: '  睇吓畫面  ', addEventListener() {} };
  const speakBtnPanel = { addEventListener(name, callback) { this[name] = callback; } };
  const context = vm.createContext({
    textInputPanel, speakBtnPanel,
    window: { lipSyncSystem: {}, sendAgentMessage: (text, options) => { sent.push({ text, ...options }); return Promise.resolve(result); } },
    document: { getElementById: () => status },
    CoreModule: { disableMessaging() {}, setMessagingThinking() {}, enableMessaging() {} },
    logger: { info() {} },
    screenshotComposer: { isCapturing: () => capturing, getAttachment: () => attachment,
      getText: text => text.trim() || (attachment ? 'Describe this screenshot.' : ''), clear: item => cleared.push(item) },
  });
  vm.runInContext(handler, context);
  return { sent, cleared, status, textInputPanel, speakBtnPanel, context };
}

test('normal Send submits the captured attachment and clears exactly that draft on success', async () => {
  const h = harness();
  h.speakBtnPanel.click(); await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, '睇吓畫面');
  assert.equal(h.sent[0].attachment.dataUrl, 'test-image');
  assert.equal(h.cleared[0], h.sent[0].attachment);
});

test('an early Send keeps its draft and never disables controls before the chat API is ready', async () => {
  const h = harness();
  let disabled = false;
  h.context.window.sendAgentMessage = undefined;
  h.context.CoreModule.disableMessaging = () => { disabled = true; };
  h.speakBtnPanel.click(); await tick();
  assert.equal(disabled, false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.textInputPanel.value, '  睇吓畫面  ');
  assert.match(h.status.textContent, /still starting.*draft is kept/);
});

test('Send accepts screenshot-only input, waits for capture, and preserves failed drafts', async () => {
  const imageOnly = harness(); imageOnly.textInputPanel.value = '';
  imageOnly.speakBtnPanel.click(); await tick();
  assert.equal(imageOnly.sent[0].text, 'Describe this screenshot.');
  const busy = harness({ capturing: true }); busy.speakBtnPanel.click(); await tick();
  assert.equal(busy.sent.length, 0);
  const failed = harness({ result: false }); failed.speakBtnPanel.click(); await tick();
  assert.equal(failed.cleared.length, 0);
  assert.equal(failed.textInputPanel.value, '睇吓畫面');
  assert.match(failed.status.textContent, /draft is kept/);
});

test('a successful text-only send never clears an attachment captured later', async () => {
  const h = harness({ attachment: null });
  h.speakBtnPanel.click(); await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.cleared.length, 0);
});

test('IME confirmation with Enter does not accidentally send a message', async () => {
  const h = harness();
  let prevented = false;
  // Rerun with keyboard capture to exercise the real shared input handler.
  h.textInputPanel.addEventListener = (name, callback) => { h.textInputPanel[name] = callback; };
  let sends = 0;
  h.speakBtnPanel.addEventListener = () => {};
  h.speakBtnPanel.click = () => { sends++; };
  vm.runInContext(handler, h.context);
  h.textInputPanel.keypress({ key: 'Enter', isComposing: true, preventDefault() { prevented = true; } });
  h.textInputPanel.keypress({ key: 'Enter', keyCode: 229, preventDefault() { prevented = true; } });
  assert.equal(sends, 0);
  assert.equal(prevented, false);
  h.textInputPanel.keypress({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(sends, 1);
  assert.equal(prevented, true);
});
