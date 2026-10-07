// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/reply-media-detection.smoke.mjs
// Check native detection with an active, silent Hikari-owned audio graph.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-media-smoke-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.on('window-all-closed', () => {});
const execute = promisify(execFile);
const helper = path.resolve('tools/media-state/media-state');
const external = async () => (await execute(helper, ['playing-except', String(process.pid),
  ...app.getAppMetrics().map(metric => String(metric.pid))])).stdout.trim();
let window;
const timeout = setTimeout(() => { console.error('MEDIA_DETECTION_TIMEOUT'); app.exit(1); }, 20_000);
async function run() {
  let exitCode = 0;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
    await window.loadURL('about:blank');
    const baseline = await external();
    assert.match(baseline, /^[01]$/);
    await window.webContents.executeJavaScript(`(async () => {
      window.testContext = new AudioContext();
      const source = testContext.createOscillator();
      const silent = testContext.createGain(); silent.gain.value = 0;
      source.connect(silent); silent.connect(testContext.destination);
      source.start(); await testContext.resume();
      await new Promise(resolve => setTimeout(resolve, 500));
    })()`);
    const output = (await execute(helper, [])).stdout.trim();
    const filtered = await external();
    assert.equal(output, '1', 'The active silent graph opens the output device');
    assert.equal(filtered, baseline, 'Hikari output must not count as external media');
    // Even when other media is already active, isolate this app by excluding
    // every other PID, then check that excluding this app removes its output.
    const pids = (await execute('/bin/ps', ['-axo', 'pid='])).stdout.trim().split(/\s+/);
    const own = new Set([String(process.pid), ...app.getAppMetrics().map(metric => String(metric.pid))]);
    const ownOnly = (await execute(helper, ['playing-except', ...pids.filter(pid => !own.has(pid))])).stdout.trim();
    const none = (await execute(helper, ['playing-except', ...pids])).stdout.trim();
    assert.equal(ownOnly, '1', 'The test app must be an active audio process');
    assert.equal(none, '0', 'Excluding all audio processes must remove the playback signal');
    await window.webContents.executeJavaScript('testContext.close().then(() => true)');
    console.log('MEDIA_DETECTION_SMOKE_OK', { baseline, output, filtered, ownOnly, none });
  } catch (error) {
    console.error(error); exitCode = 1;
  } finally {
    clearTimeout(timeout); window?.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(exitCode);
  }
}
void run();
