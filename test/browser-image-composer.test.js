import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserImageComposer, prepareBrowserImage } from '../shared/browser-image-composer.js';

const dataUrl = 'data:image/jpeg;base64,/9j/2Q==';
const attachment = { dataUrl, width: 100, height: 100 };
const element = () => ({ hidden: false, disabled: false, textContent: '', listeners: {},
  addEventListener(event, callback) { this.listeners[event] = callback; },
  removeAttribute(name) { delete this[name]; }, click() { this.clicked = true; } });
function harness(prepare = async () => attachment) {
  const elements = Object.fromEntries(['captureButton', 'fileInput', 'preview', 'image', 'removeButton', 'status'].map(id => [id, element()]));
  const composer = createBrowserImageComposer({ ...elements, prepare });
  const choose = async () => {
    elements.fileInput.files = [{ type: 'image/png', size: 100 }];
    await elements.fileInput.listeners.change();
  };
  return { ...elements, composer, choose };
}

test('image picker creates a local preview, supports image-only messages and removes drafts', async () => {
  const h = harness();
  h.captureButton.listeners.click();
  assert.equal(h.fileInput.clicked, true);
  await h.choose();
  assert.equal(h.preview.hidden, false);
  assert.equal(h.image.src, dataUrl);
  assert.match(h.composer.getText(''), /圖片/);
  assert.equal(h.composer.getText('  hello  '), 'hello');
  assert.equal(h.fileInput.value, '');
  h.removeButton.listeners.click();
  assert.equal(h.preview.hidden, true);
  assert.equal(h.composer.getAttachment(), null);
  assert.equal(h.image.src, undefined);
});

test('replacing an image keeps the prior draft on failure and clears only the sent attachment', async () => {
  let fail = false;
  const h = harness(async () => { if (fail) throw new Error('Could not decode'); return attachment; });
  await h.choose();
  fail = true; await h.choose();
  assert.equal(h.composer.getAttachment(), attachment);
  assert.match(h.status.textContent, /Could not decode/);
  h.composer.clear({ dataUrl });
  assert.equal(h.composer.getAttachment(), attachment);
  h.composer.clear(attachment);
  assert.equal(h.composer.getAttachment(), null);
});

test('preparation and disabled messaging prevent overlapping uploads and removal', async () => {
  let finish, calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.choose();
  assert.equal(h.composer.isCapturing(), true);
  assert.equal(h.captureButton.disabled, true);
  await h.choose();
  assert.equal(calls, 1);
  finish(attachment); await pending;
  h.composer.setDisabled(true);
  await h.choose();
  h.removeButton.listeners.click();
  assert.equal(calls, 1);
  assert.equal(h.composer.getAttachment(), attachment);
  h.composer.setDisabled(false);
  assert.equal(h.captureButton.disabled, false);
});

function conversion({ fail = false, oversized = false } = {}) {
  const draws = [], qualities = [], revoked = [];
  const image = { naturalWidth: 4000, naturalHeight: 3000, async decode() { if (fail) throw new DOMException('Cannot decode', 'EncodingError'); }, removeAttribute() {} };
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() { draws.push([canvas.width, canvas.height]); } }),
    toDataURL(type, quality) { qualities.push(quality); return oversized && canvas.width > 320 && quality > 0.5 ? 'data:image/jpeg;base64,' + 'A'.repeat(3_000_000) : dataUrl; } };
  return { image, canvas, draws, qualities, revoked, options: { createImage: () => image, createCanvas: () => canvas,
    url: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) }, now: () => 123 } };
}

test('conversion bounds photos to 1920px, compresses JPEG, builds a thumbnail and releases decoded resources', async () => {
  const h = conversion({ oversized: true });
  const result = await prepareBrowserImage({ type: 'image/png', size: 1000 }, h.options);
  assert.equal(result.width, 1920); assert.equal(result.height, 1440);
  assert.equal(result.capturedAt, 123);
  assert.deepEqual(h.draws, [[1920, 1440], [320, 240]]);
  assert.deepEqual(h.qualities, [0.8, 0.65, 0.5, 0.6]);
  assert.equal(result.thumbnailDataUrl, dataUrl);
  assert.deepEqual(h.revoked, ['blob:test']);
  assert.equal(h.canvas.width, 0);
});

test('invalid files and undecodable images are rejected without retaining temporary URLs', async () => {
  const h = conversion({ fail: true });
  await assert.rejects(prepareBrowserImage({ type: 'text/plain', size: 100 }, h.options), /photo or screenshot/);
  await assert.rejects(prepareBrowserImage({ type: 'image/png', size: 21 * 1024 * 1024 }, h.options), /20 MB/);
  assert.equal(h.revoked.length, 0);
  await assert.rejects(prepareBrowserImage({ type: 'image/png', size: 100 }, h.options), /JPEG or PNG/);
  assert.deepEqual(h.revoked, ['blob:test']);
});
