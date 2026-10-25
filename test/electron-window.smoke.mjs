// npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/electron-window.smoke.mjs
// Exercise production desktop UI with isolated storage and only window IPC enabled.
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain, screen, session } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constrainWindow, keepWindowOnScreen } from '../electron/window-geometry.js';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-desktop-smoke-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const preload = path.join(profile, 'preload.cjs');
await writeFile(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  getWindowBounds: () => ipcRenderer.invoke('bounds:get'),
  setWindowBounds: (x, y, width, height) => ipcRenderer.invoke('bounds:set', { x, y, width, height }),
  getWindowPosition: () => ipcRenderer.invoke('bounds:get'),
  setWindowPosition: (x, y) => ipcRenderer.invoke('position:set', { x, y }),
  setIgnoreMouseEvents: async () => true
});`);
let window;
const errors = [];
const timeout = setTimeout(() => { console.error('ELECTRON_WINDOW_SMOKE_TIMEOUT'); app.exit(1); }, 90_000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
function contained(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}
async function measure() {
  return evaluate(`(() => {
    const ids = ['settingsPanel', 'lipSyncPanel', 'history-panel', 'textInputPanel', 'speakBtnPanel'];
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { width: innerWidth, height: innerHeight, cameraDistance: camera.position.distanceTo(controls.target),
      scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-ui-scale')),
      elements: Object.fromEntries(ids.map(id => [id, rect(document.getElementById(id))])),
      toggle: rect(document.querySelector('.settings-toggle')) };
  })()`);
}
function panelsInside(value) {
  for (const rect of Object.values(value.elements)) {
    assert.ok(rect.x >= -1 && rect.y >= -1, JSON.stringify(rect));
    assert.ok(rect.right <= value.width + 1 && rect.bottom <= value.height + 1, JSON.stringify(rect));
  }
}
async function checkReadableFonts() {
  const smallText = await evaluate(`(() => {
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-ui-scale'));
    return [...document.querySelectorAll('.controls *, .settings-panel *, #history-panel *, #speakingBubble')]
      .filter(element => element.getBoundingClientRect().width &&
        ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || element.matches('input[type="text"], input[type="password"]')))
      .map(element => ({ id: element.id || element.className, size: parseFloat(getComputedStyle(element).fontSize) * scale }))
      .filter(item => item.size < 11.99);
  })()`);
  assert.deepEqual(smallText, [], 'Every displayed text font must be at least 12px after UI zoom');
}
async function checkAvatarFraming() {
  await evaluate(`(() => { const style = document.createElement('style'); style.id = 'avatar-only-test';
    style.textContent = 'body > :not(canvas) { display: none !important; }'; document.head.appendChild(style); })()`);
  await sleep(150);
  const snapshot = await window.webContents.capturePage();
  await writeFile('/tmp/hikari-electron-avatar.png', snapshot.toPNG());
  const { width, height } = snapshot.getSize();
  const pixels = snapshot.toBitmap();
  let top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 32) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  await evaluate(`document.getElementById('avatar-only-test').remove()`);
  await sleep(150);
  console.log('AVATAR_FRAMING', { top: top / height, bottom: bottom / height, ratio: (bottom - top) / height });
  assert.ok(top / height >= 0.01, 'The avatar head must fit inside the window');
  assert.ok(bottom / height < 0.91, 'The avatar feet must sit above the composer');
  assert.ok((bottom - top) / height > 0.70, 'The avatar must fill most of the window');
}
async function run() {
  try {
    await app.whenReady();
    // Keep the test disconnected from the user's OpenClaw/TTS services.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') });
    });
    window = new BrowserWindow({ show: false, width: 600, height: 900, transparent: true, frame: false,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, webSecurity: false, backgroundThrottling: false } });
    window.setIgnoreMouseEvents(true, { forward: true });
    keepWindowOnScreen(window, screen);
    ipcMain.handle('bounds:get', () => window.getBounds());
    ipcMain.handle('bounds:set', (_event, bounds) => constrainWindow(window, screen, bounds));
    ipcMain.handle('position:set', (_event, position) => constrainWindow(window, screen, { ...window.getBounds(), ...position }));
    window.webContents.on('console-message', event => {
      if (event.level === 'error' && /Initialization error|Uncaught|failed to resize/.test(event.message)) errors.push(event.message);
    });
    await window.loadFile(process.env.HIKARI_PACKAGED_RESOURCES
      ? path.join(process.env.HIKARI_PACKAGED_RESOURCES, 'app.asar', 'dist', 'index.html')
      : path.resolve('dist/index.html'));
    // macOS can return incomplete compositor tiles for a fully hidden window.
    window.showInactive();
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 35000;
      const timer = setInterval(() => {
        if (window.sendAgentMessage && !document.getElementById('loadingGif')) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(document.getElementById('status').textContent)); }
      }, 50);
    })`);
    await evaluate(`document.getElementById('settingsPanel').style.display = 'flex';
      document.getElementById('lipSyncPanel').style.display = 'flex';
      document.getElementById('history-panel').style.display = 'flex';
      window.addLocalHistoryMessage('user', 'Readable history text');`);
    const initial = await measure();
    console.log('INITIAL_DESKTOP_SIZE', initial.width, initial.height, initial.scale);
    panelsInside(initial); contained(window.getBounds());
    await evaluate(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true }));
      document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 400 / 3, cancelable: true }));`);
    await sleep(450);
    const small = await measure();
    panelsInside(small); contained(window.getBounds());
    assert.equal(small.scale, 0.5);
    assert.equal(small.width, 300); assert.equal(small.height, 450);
    assert.ok(Math.abs(small.toggle.width - 35) < 1);
    assert.ok(small.elements.speakBtnPanel.width >= 18);
    assert.ok(small.elements.textInputPanel.height >= 17);
    await checkReadableFonts();
    assert.ok(Math.abs(small.cameraDistance - initial.cameraDistance) < 1e-9);
    await checkAvatarFraming();
    await evaluate(`document.getElementById('settingsPanel').style.display = 'none'; document.getElementById('history-panel').style.display = 'none'`);
    await sleep(150);
    await writeFile('/tmp/hikari-electron-small.png', (await window.webContents.capturePage()).toPNG());
    // Shrink further while retaining the previous minimum button and font sizes.
    await evaluate(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true }))`);
    await sleep(400);
    await evaluate(`document.querySelectorAll('.controls, .settings-panel, #history-panel').forEach(panel => panel.style.display = 'flex')`);
    const tiny = await measure();
    panelsInside(tiny); contained(window.getBounds());
    assert.equal(tiny.width, 200); assert.equal(tiny.height, 300); assert.equal(tiny.scale, 0.5);
    assert.ok(Math.abs(tiny.toggle.width - small.toggle.width) < 0.1);
    assert.ok(Math.abs(tiny.elements.speakBtnPanel.width - small.elements.speakBtnPanel.width) < 0.1);
    assert.ok(Math.abs(tiny.elements.textInputPanel.height - small.elements.textInputPanel.height) < 0.1);
    await checkReadableFonts();
    await evaluate(`document.getElementById('settingsTabMotion').click()`);
    panelsInside(await measure());
    await checkReadableFonts();
    const compactMotion = await evaluate(`({
      columns: getComputedStyle(document.querySelector('.anim-checkbox-grid')).gridTemplateColumns.split(' ').length,
      labels: ['anim-drag', 'anim-history_panel'].map(id => document.getElementById(id).parentElement.textContent.trim()),
      scrollable: document.querySelector('.settings-body').scrollHeight > document.querySelector('.settings-body').clientHeight
    })`);
    assert.equal(compactMotion.columns, 1);
    assert.deepEqual(compactMotion.labels, ['Drag', 'History panel']);
    assert.equal(compactMotion.scrollable, true);
    await evaluate(`document.getElementById('history-panel').style.display = 'none'; document.getElementById('lipSyncPanel').style.display = 'none'`);
    await sleep(150);
    await writeFile('/tmp/hikari-electron-tiny-settings.png', (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.getElementById('settingsTabGeneral').click(); document.getElementById('lipSyncPanel').style.display = 'flex'`);
    await checkAvatarFraming();
    await evaluate(`document.getElementById('settingsPanel').style.display = 'none'; document.getElementById('history-panel').style.display = 'none'`);
    await sleep(150);
    await writeFile('/tmp/hikari-electron-tiny.png', (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true }))`);
    await sleep(200);
    assert.equal((await measure()).width, 200, 'Further zoom out must stay at the new minimum');
    // Every corner must constrain the native window, even with all panels hidden.
    await evaluate(`document.querySelectorAll('.controls, .settings-panel, #history-panel').forEach(panel => panel.style.display = 'none')`);
    for (const x of [-10000, 10000]) for (const y of [-10000, 10000]) {
      await evaluate(`window.electronAPI.setWindowPosition(${x}, ${y})`);
      contained(window.getBounds());
    }
    for (let index = 0; index < 8; index++) {
      await evaluate(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -200, cancelable: true }))`);
    }
    await sleep(500);
    await evaluate(`document.querySelectorAll('.controls, .settings-panel, #history-panel').forEach(panel => panel.style.display = 'flex')`);
    const large = await measure();
    panelsInside(large); contained(window.getBounds());
    assert.ok(large.toggle.width > small.toggle.width);
    assert.ok(Math.abs(large.cameraDistance - initial.cameraDistance) < 1e-9);
    await checkAvatarFraming();
    await evaluate(`document.getElementById('settingsPanel').style.display = 'none'; document.getElementById('history-panel').style.display = 'none'`);
    await sleep(150);
    await writeFile('/tmp/hikari-electron-large.png', (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true }))`);
    await sleep(300);
    assert.ok((await measure()).width < large.width, 'Zoom out must shrink immediately after reaching the display limit');
    // A reload restores the new minimum and keeps its controls at the old floor.
    await evaluate(`localStorage.setItem('electron_zoom_scale', JSON.stringify({ zoom: 1 / 3, width: 200, height: 300 }))`);
    window.reload();
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const timer = setInterval(() => {
        if (window.camera && Math.abs(camera.position.distanceTo(controls.target) - ${tiny.cameraDistance}) < 0.001 && innerWidth === 200) {
          clearInterval(timer); resolve();
        } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Restored desktop framing was not ready')); }
      }, 50);
    })`);
    const restored = await evaluate(`({ scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-ui-scale')), width: innerWidth, height: innerHeight, distance: camera.position.distanceTo(controls.target) })`);
    assert.equal(restored.scale, 0.5); assert.equal(restored.width, 200); assert.equal(restored.height, 300);
    assert.ok(Math.abs(restored.distance - tiny.cameraDistance) < 1e-9);
    assert.deepEqual(errors, []);
    console.log('ELECTRON_WINDOW_SMOKE_OK', JSON.stringify({ initial, small, tiny, large, restored }));
    clearTimeout(timeout); window.destroy();
    await rm(profile, { recursive: true, force: true }); app.exit(0);
  } catch (error) {
    console.error('ELECTRON_WINDOW_SMOKE_FAILED', error, errors);
    clearTimeout(timeout); window?.destroy();
    await rm(profile, { recursive: true, force: true }); app.exit(1);
  }
}
void run();
