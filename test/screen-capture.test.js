import assert from 'node:assert/strict';
import test from 'node:test';
import { createScreenCaptureService, MAX_SCREENSHOT_BYTES } from '../electron/screen-capture-main.js';
import { normalizeScreenshotAttachment, screenshotMessageContent, SCREENSHOT_DEFAULT_PROMPT } from '../electron/screenshot-attachment.js';
import { createScreenshotComposer } from '../electron/screenshot-composer.js';

const jpeg = Buffer.from([255, 216, 255, 217]);
const attachment = { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, thumbnailDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: 1280, height: 720, capturedAt: 1000 };
function nativeImage(width = 3840, height = 2160, getJpeg = () => jpeg) {
  return { isEmpty: () => false, getSize: () => ({ width, height }), toJPEG: getJpeg,
    resize: options => nativeImage(options.width, options.height || Math.round(height * options.width / width), getJpeg) };
}
function capture(options = {}) {
  return createScreenCaptureService({ platform: 'darwin', getPermissionStatus: () => 'granted',
    getDisplay: () => ({ id: 2, size: { width: 3840, height: 2160 } }),
    getSources: async () => [{ display_id: '2', thumbnail: nativeImage() }], now: () => 1000, ...options });
}

test('manual capture selects the composer display and bounds JPEG dimensions and size', async () => {
  let request;
  const service = capture({ getSources: async options => {
    request = options;
    return [{ display_id: '1', thumbnail: nativeImage(800, 600) }, { display_id: '2', thumbnail: nativeImage() }];
  } });
  const result = await service.capture();
  assert.deepEqual(request.types, ['screen']);
  assert.deepEqual(request.thumbnailSize, { width: 1920, height: 1080 });
  assert.equal(result.width, 1920); assert.equal(result.height, 1080);
  assert.equal(result.dataUrl, attachment.dataUrl);
  assert.equal(result.capturedAt, 1000);
  assert.equal(normalizeScreenshotAttachment(result).width, 1920);
});

test('permission denial does not capture; missing display never falls back to a different screen', async () => {
  let called = false;
  await assert.rejects(capture({ getPermissionStatus: () => 'denied', getSources: () => { called = true; } }).capture(), { code: 'SCREEN_PERMISSION_REQUIRED' });
  assert.equal(called, false);
  await assert.rejects(capture({ getSources: async () => [{ display_id: '1', thumbnail: nativeImage() }] }).capture(), { code: 'CAPTURE_UNAVAILABLE' });
});

test('capture lowers JPEG quality before rejecting an oversized screenshot', async () => {
  const qualities = [];
  await assert.rejects(capture({ getSources: async () => [{ display_id: '2', thumbnail: nativeImage(1920, 1080, quality => {
    qualities.push(quality); return Buffer.alloc(MAX_SCREENSHOT_BYTES + 1);
  }) }] }).capture(), { code: 'SCREENSHOT_TOO_LARGE' });
  assert.deepEqual(qualities, [80, 65, 50]);
});

test('captures cannot overlap and the busy flag clears after failure', async () => {
  let finish;
  const service = capture({ getSources: () => new Promise(resolve => { finish = resolve; }) });
  const pending = service.capture();
  await assert.rejects(service.capture(), { code: 'CAPTURE_BUSY' });
  finish([]); await assert.rejects(pending);
  const next = service.capture(); finish([]); await assert.rejects(next, { code: 'CAPTURE_UNAVAILABLE' });
});

test('native capture timeouts release the button for a subsequent attempt', async () => {
  let stalled = true;
  const service = capture({ captureTimeoutMs: 5, getSources: () => stalled ? new Promise(() => {}) : Promise.resolve([{ display_id: '2', thumbnail: nativeImage() }]) });
  await assert.rejects(service.capture(), { code: 'CAPTURE_TIMEOUT' });
  stalled = false;
  assert.equal((await service.capture()).width, 1920);
});

function composer(api = { capture: async () => ({ ok: true, attachment }) }) {
  const element = () => ({ hidden: false, disabled: false, textContent: '', listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; }, removeAttribute(name) { delete this[name]; } });
  const controls = { captureButton: element(), preview: element(), image: element(), removeButton: element(), status: element(), permissionButton: element() };
  const system = createScreenshotComposer({ api, ...controls });
  return { system, ...controls };
}

test('capture only attaches a preview; remove clears bytes and screenshot-only sends get a default prompt', async () => {
  const h = composer();
  assert.equal(h.preview.hidden, true);
  await h.captureButton.listeners.click();
  assert.equal(h.preview.hidden, false);
  assert.equal(h.image.src, attachment.dataUrl);
  assert.equal(h.system.getText(''), SCREENSHOT_DEFAULT_PROMPT);
  assert.equal(h.system.getText('  問題  '), '問題');
  h.removeButton.listeners.click();
  assert.equal(h.preview.hidden, true); assert.equal(h.system.getAttachment(), null);
  assert.equal(h.image.src, undefined);
});

test('retake failures retain the previous draft and permission recovery stays in the composer', async () => {
  let denied = false, opened = false;
  const h = composer({
    capture: async () => denied ? { ok: false, error: { code: 'SCREEN_PERMISSION_REQUIRED', message: 'Permission needed' } } : { ok: true, attachment },
    openPermissionSettings: async () => { opened = true; }
  });
  await h.captureButton.listeners.click();
  const previous = h.system.getAttachment();
  denied = true; await h.captureButton.listeners.click();
  assert.equal(h.system.getAttachment(), previous);
  assert.equal(h.permissionButton.hidden, false);
  await h.permissionButton.listeners.click();
  assert.equal(opened, true);
  assert.match(h.status.textContent, /Screen Recording/);
});

test('busy/disabled controls prevent retake and removing; clearing an old send keeps a new attachment', async () => {
  const h = composer();
  await h.captureButton.listeners.click();
  const first = h.system.getAttachment();
  h.system.setDisabled(true); h.removeButton.listeners.click();
  assert.equal(h.system.getAttachment(), first);
  h.system.setDisabled(false); await h.captureButton.listeners.click();
  const second = h.system.getAttachment();
  h.system.clear(first);
  assert.equal(h.system.getAttachment(), second);
  h.system.clear(second); assert.equal(h.system.getAttachment(), null);
});

test('only bounded JPEG data URLs are accepted, and ordinary text keeps its existing shape', () => {
  assert.equal(screenshotMessageContent('hello'), 'hello');
  assert.equal(screenshotMessageContent('hello', attachment)[1].image_url.url, attachment.dataUrl);
  assert.throws(() => normalizeScreenshotAttachment({ ...attachment, dataUrl: 'https://example.test/screen.jpg' }));
  assert.throws(() => normalizeScreenshotAttachment({ ...attachment, width: 100000 }));
  assert.throws(() => normalizeScreenshotAttachment({ ...attachment, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(3000000) }));
});
