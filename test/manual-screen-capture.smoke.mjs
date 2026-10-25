// Opt-in: captures one display in memory, prints only dimensions, and sends nothing.
// Run with: env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/manual-screen-capture.smoke.mjs
import { app, desktopCapturer, screen, systemPreferences } from 'electron';
import { createScreenCaptureService, MAX_SCREENSHOT_BYTES } from '../electron/screen-capture-main.js';
import assert from 'node:assert/strict';

const timeout = setTimeout(() => app.exit(1), 30000);
async function run() {
try {
  await app.whenReady();
  const service = createScreenCaptureService({
    getSources: options => desktopCapturer.getSources(options),
    getDisplay: () => screen.getPrimaryDisplay(),
    getPermissionStatus: () => systemPreferences.getMediaAccessStatus('screen')
  });
  const result = await service.capture();
  assert.ok(result.width > 0 && result.width <= 1920);
  assert.ok(result.height > 0 && result.height <= 1920);
  assert.ok(Buffer.from(result.dataUrl.split(',')[1], 'base64').length <= MAX_SCREENSHOT_BYTES);
  console.log(`MANUAL_SCREEN_CAPTURE_SMOKE_OK: ${result.width}x${result.height}; screenshot stayed in memory and was not sent.`);
  clearTimeout(timeout); app.exit(0);
} catch (error) {
  console.error(`MANUAL_SCREEN_CAPTURE_SMOKE_FAILED: ${error.code || 'CAPTURE_FAILED'}: ${error.message}`);
  clearTimeout(timeout); app.exit(1);
}
}
run();
