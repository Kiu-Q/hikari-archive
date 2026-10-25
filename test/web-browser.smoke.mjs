// npm run build:web && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/web-browser.smoke.mjs
// Isolated Chromium runtime with no Electron preload or user browser profile.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHikariServer } from '../server/index.js';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-web-smoke-'));
app.setPath('userData', profile);
const requests = [], errors = [];
const wav = Buffer.alloc(44 + 4800);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
const server = createHikariServer({ port: 3099, allowedOrigins: ['http://127.0.0.1:3099'], token: 'test-only',
  probeOpenClaw: async () => true, probeTts: async () => true,
  ttsService: { synthesize: async () => ({ audio: wav, durationSeconds: 0.1, sampleRate: 24000, channels: 1 }) },
  fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ text: '早晨！', text_ja: 'おはよう！', segments: [{ text: '早晨！', text_ja: 'おはよう！' }] }) } }] });
  }
});
let window;
const timeout = setTimeout(() => { console.error('WEB_BROWSER_SMOKE_TIMEOUT'); app.exit(1); }, 90_000);
async function run() {
try {
  console.log('WEB_BROWSER_SMOKE_START', app.isReady());
  await app.whenReady();
  console.log('WEB_BROWSER_SMOKE_APP_READY');
  const address = await server.listen();
  window = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'user-gesture-required', backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await window.loadURL(`http://127.0.0.1:${address.port}`);
  console.log('WEB_BROWSER_SMOKE_PAGE_LOADED');
  const startup = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const timer = setInterval(() => {
      if (document.getElementById('status').textContent.includes('Playing turn around') && !window.sendAgentMessage) {
        clearInterval(timer);
        const input = document.getElementById('textInputPanel'), button = document.getElementById('speakBtnPanel');
        const disabled = button.disabled;
        input.value = 'Draft during startup';
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        resolve({ disabled, draft: input.value, inputDisabled: input.disabled });
      } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Startup gap was not observed')); }
    }, 20);
  })`);
  assert.equal(startup.disabled, true);
  assert.equal(startup.inputDisabled, false);
  assert.equal(startup.draft, 'Draft during startup');
  const covering = await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(() => {
    const overlay = document.getElementById('loadingGif');
    const label = document.getElementById('webLoadingStatus');
    const input = document.getElementById('textInputPanel').getBoundingClientRect();
    resolve({ overlay: !!overlay, opacity: overlay && getComputedStyle(overlay).opacity,
      inputBlocked: document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2)?.id === 'loadingGif',
      canvasHidden: getComputedStyle(document.querySelector('canvas')).visibility === 'hidden',
      gearHidden: getComputedStyle(document.querySelector('.settings-toggle')).visibility === 'hidden',
      labelVisible: !label.hidden && getComputedStyle(label).visibility === 'visible',
      labelAbove: overlay && Number(getComputedStyle(label).zIndex) > Number(getComputedStyle(overlay).zIndex) });
  }, 2500))`);
  assert.equal(covering.overlay, true);
  assert.equal(covering.opacity, '1');
  assert.equal(covering.inputBlocked, true);
  assert.equal(covering.canvasHidden, true);
  assert.equal(covering.gearHidden, true);
  assert.equal(covering.labelVisible, true);
  assert.equal(covering.labelAbove, true);
  await writeFile('/tmp/hikari-web-loading.png', (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    if (document.getElementById('enableAudio')) throw new Error('Extra audio button is still present');
    document.querySelector('.settings-toggle').click();
    document.querySelector('.settings-toggle').click();
  `, true);
  const fade = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const timer = setInterval(() => {
      const overlay = document.getElementById('loadingGif');
      const opacity = overlay && Number(getComputedStyle(overlay).opacity);
      if (window.sendAgentMessage && overlay && opacity > 0 && opacity < 1) {
        clearInterval(timer);
        resolve({ opacity, canvasVisible: getComputedStyle(document.querySelector('canvas')).visibility === 'visible',
          labelHidden: document.getElementById('webLoadingStatus').hidden,
          loadingClass: document.body.classList.contains('web-loading') });
      } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Loading overlay did not fade out')); }
    }, 20);
  })`);
  assert.ok(fade.opacity > 0 && fade.opacity < 1);
  assert.equal(fade.canvasVisible, true);
  assert.equal(fade.labelHidden, true);
  assert.equal(fade.loadingClass, false);
  const ready = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const timer = setInterval(() => {
      if (window.sendAgentMessage && !window._directAgentRequestPending && !document.getElementById('speakBtnPanel').disabled && !document.getElementById('loadingGif')) {
        clearInterval(timer); resolve({ browser: !window.electronAPI, canvas: !!document.querySelector('canvas'), width: innerWidth });
      } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(document.getElementById('status').textContent)); }
    }, 100);
  })`);
  assert.equal(ready.browser, true); assert.equal(ready.canvas, true); assert.equal(ready.width, 390);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('textInputPanel').value`), 'Draft during startup');
  const loaded = await window.webContents.executeJavaScript(`({ overlay: !!document.getElementById('loadingGif'),
    labelHidden: document.getElementById('webLoadingStatus').hidden,
    loadingClass: document.body.classList.contains('web-loading'),
    bottomStatusHidden: getComputedStyle(document.getElementById('screenshotStatus')).display === 'none' })`);
  assert.equal(loaded.overlay, false);
  assert.equal(loaded.labelHidden, true);
  assert.equal(loaded.loadingClass, false);
  assert.equal(loaded.bottomStatusHidden, true);
  await writeFile('/tmp/hikari-web-loaded.png', (await window.webContents.capturePage()).toPNG());
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const byId = id => document.getElementById(id);
    document.querySelector('.settings-toggle').click();
    byId('settingsTabMotion').click();
    if (byId('settingsPaneMotion').hidden || !byId('settingsPaneGeneral').hidden) throw new Error('Settings tabs failed');
    const options = Array.from(byId('animationSelect').options).map(option => option.textContent);
    if (options.some(option => /^(sit|walk|start_1standUp)/i.test(option))) throw new Error('Desktop-only animation exposed');
    byId('settingsTabAppearance').click();
    byId('keyLightSlider').value = '2.2'; byId('keyLightSlider').dispatchEvent(new Event('input', { bubbles: true }));
    if (localStorage.getItem('hikari_light_keyLight') !== '2.2') throw new Error('Lighting failed');
    byId('settingsTabGeneral').click();
    byId('eyeFollowSlider').value = '35'; byId('eyeFollowSlider').dispatchEvent(new Event('input', { bubbles: true }));
    byId('desktopCursorGazeToggle').click();
    byId('resetCameraBtn').click();
    if (localStorage.getItem('electron_eye_follow_degrees') !== '35' || localStorage.getItem('desktop_cursor_gaze_enabled') !== 'false') throw new Error('Gaze settings failed');
    byId('settingsCloseBtn').click();
    const fixture = document.createElement('canvas'); fixture.width = 100; fixture.height = 80;
    const context = fixture.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0,0,100,80);
    const blob = await new Promise(resolve => fixture.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'test-red.png', { type: 'image/png' }));
    byId('imageFileInput').files = transfer.files;
    byId('imageFileInput').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve, reject) => {
      const started = Date.now(); const timer = setInterval(() => {
        if (!byId('screenshotPreview').hidden && !byId('captureScreenBtn').disabled) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error(byId('screenshotStatus').textContent)); }
      }, 50);
    });
    const reserve = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-reserve'));
    if (reserve < byId('lipSyncPanel').getBoundingClientRect().height) throw new Error('Image composer overlaps panels');
    byId('textInputPanel').value = 'Describe the red test image';
    byId('speakBtnPanel').click();
    await new Promise((resolve, reject) => {
      const started = Date.now(); const timer = setInterval(() => {
        if (byId('screenshotPreview').hidden && !byId('speakBtnPanel').disabled) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > 10000) { clearInterval(timer); reject(new Error(byId('status').textContent)); }
      }, 50);
    });
    document.querySelector('.history-toggle').click();
    const thumbnail = document.querySelector('.history-screenshot img');
    if (!thumbnail || !thumbnail.src.startsWith('data:image/jpeg')) throw new Error('Image history missing');
    if (byId('lipSyncPanel').style.display === 'none') throw new Error('History hid composer');
    return { tabs: true, gaze: true, lighting: true, imageSend: true, historyThumbnail: true, composerReserve: reserve, portraitWidth: innerWidth };
  })()`);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).content[1].type, 'image_url');
  const keyboard = await window.webContents.executeJavaScript(`(async () => {
    const viewport = window.visualViewport;
    const snapshot = () => {
      const canvas = document.querySelector('canvas');
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top - viewport.offsetTop, height: rect.height, bottom: rect.bottom - viewport.offsetTop };
      };
      return { canvas: bounds(canvas), pixels: canvas.height,
        composer: bounds(document.getElementById('lipSyncPanel')),
        history: bounds(document.getElementById('history-panel')),
        gear: bounds(document.querySelector('.settings-toggle')),
        scroll: scrollY };
    };
    const wait = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = snapshot();
    document.getElementById('textInputPanel').focus({ preventScroll: true });
    // Model iOS's reduced visual viewport and automatic pan to the focused field.
    Object.defineProperties(viewport, { height: { configurable: true, value: 500 }, offsetTop: { configurable: true, value: 160 } });
    viewport.dispatchEvent(new Event('resize')); await wait();
    const open = snapshot();
    const inputRect = document.getElementById('textInputPanel').getBoundingClientRect();
    if (document.elementFromPoint(inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2)?.id !== 'textInputPanel') {
      throw new Error('Open history covers the raised composer');
    }
    document.getElementById('textInputPanel').blur(); await wait();
    const blurred = snapshot();
    delete viewport.height; delete viewport.offsetTop;
    viewport.dispatchEvent(new Event('resize')); await wait();
    return { before, open, blurred, closed: snapshot() };
  })()`);
  assert.deepEqual(keyboard.open.canvas, keyboard.before.canvas);
  assert.equal(keyboard.open.pixels, keyboard.before.pixels);
  assert.deepEqual(keyboard.open.history, keyboard.before.history);
  assert.deepEqual(keyboard.open.gear, keyboard.before.gear);
  assert.ok(keyboard.open.composer.bottom <= 500 && keyboard.open.composer.top >= 0);
  assert.equal(keyboard.open.scroll, 0);
  assert.deepEqual(keyboard.blurred.composer, keyboard.open.composer);
  assert.deepEqual(keyboard.closed.composer, keyboard.before.composer);
  evidence.keyboard = { stationaryScene: true, composerAboveKeyboard: true };
  window.setContentSize(844, 390);
  const landscape = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector('.settings-toggle').click();
    const rect = document.getElementById('settingsPanel').getBoundingClientRect();
    const composer = document.getElementById('lipSyncPanel').getBoundingClientRect();
    resolve({ width: innerWidth, top: rect.top, bottom: rect.bottom, composerTop: composer.top });
  })))`);
  assert.equal(landscape.width, 844);
  assert.ok(landscape.top >= 0 && landscape.bottom <= landscape.composerTop, JSON.stringify(landscape));
  assert.deepEqual(errors, []);
  console.log('WEB_BROWSER_SMOKE_OK', JSON.stringify({ ...evidence, landscape }));
} catch (error) {
  console.error(error, errors); process.exitCode = 1;
} finally {
  clearTimeout(timeout); window?.destroy(); await server.close();
  await rm(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}
}
void run();
