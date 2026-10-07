// Tests native image handling with synthetic captures only; no screen is read or sent.
// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/awareness-screen-capture.smoke.mjs
import assert from 'node:assert/strict';
import { app, nativeImage } from 'electron';
import { DesktopAwarenessService } from '../electron/desktop-awareness-main.js';
import { normalizeScreenshotAttachment } from '../electron/screenshot-attachment.js';

const timeout = setTimeout(() => app.exit(1), 30000);
async function run() {
try {
  await app.whenReady();
  let captures = 0, foreground = 0, resolveCapture, waitForCapture;
  let image = nativeImage.createFromBitmap(Buffer.alloc(1600 * 2400 * 4, 255), { width: 1600, height: 2400 });
  const service = new DesktopAwarenessService({
    activeWindowProvider: async () => { foreground++; return { id: 42, title: 'notes.md', owner: { name: 'Editor', processId: 12345 }, bounds: { x: 0, y: 0, width: 1600, height: 2400 } }; },
    captureSourcesProvider: async () => {
      captures++;
      waitForCapture?.();
      if (resolveCapture === true) await new Promise(resolve => { resolveCapture = resolve; });
      return [{ id: 'window:42:0', name: 'notes.md', thumbnail: image }];
    },
  });
  service.refreshScreenCaptureStatus = () => { service.status.screenCaptureAvailable = true; };
  assert.equal(await service.captureScreen(), null);
  assert.equal(foreground, 0);
  assert.equal(captures, 0);
  service.enabled = true;
  const first = normalizeScreenshotAttachment(await service.captureScreen());
  assert.equal(captures, 1);
  assert.equal(first.width, 1280);
  assert.equal(first.height, 1920);
  assert.ok(first.capturedAt > 0);
  image = nativeImage.createFromBitmap(Buffer.alloc(1600 * 2400 * 4, 128), { width: 1600, height: 2400 });
  const second = await service.captureScreen();
  assert.equal(captures, 2);
  assert.notEqual(first.dataUrl, second.dataUrl, 'Each agent request gets a fresh capture');
  assert.equal(second.context.appName, 'Editor');
  assert.equal(second.context.windowTitle, 'notes.md');
  assert.equal(service.snapshots.size, 0, 'Requested images are not persisted in the event snapshot cache');

  service.lastDirectInteractionAt = Date.now();
  assert.equal(await service.captureScreen(), null);
  assert.equal(captures, 2);
  service.lastDirectInteractionAt = 0;
  resolveCapture = true;
  const capturing = new Promise(resolve => { waitForCapture = resolve; });
  const pending = service.captureScreen();
  await capturing;
  service.enabled = false;
  resolveCapture();
  assert.equal(await pending, null, 'Disabling awareness drops a late native capture');
  service.enabled = true;
  service.refreshScreenCaptureStatus = () => { service.status.screenCaptureAvailable = false; };
  assert.equal(await service.captureScreen(), null);
  assert.equal(captures, 3, 'Missing permission never invokes the native capture provider');
  console.log('AWARENESS_SCREEN_CAPTURE_SMOKE_OK: fresh synthetic captures, bounded JPEG, permission and cancellation checks passed.');
  clearTimeout(timeout); app.exit(0);
} catch (error) {
  console.error('AWARENESS_SCREEN_CAPTURE_SMOKE_FAILED', error);
  clearTimeout(timeout); app.exit(1);
}
}
run();
