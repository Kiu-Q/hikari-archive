// Regression for a fresh phone page whose greeting request never completes.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHikariServer } from '../server/index.js';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-web-startup-'));
app.setPath('userData', profile);
const requests = [], errors = [];
const audio = Buffer.alloc(44 + 4800);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(4800, 40);
const server = createHikariServer({ port: 3098, allowedOrigins: ['http://127.0.0.1:3098'], token: 'test-only',
  probeOpenClaw: async () => true, probeTts: async () => true,
  ttsService: { synthesize: async () => ({ audio, durationSeconds: 0.1, sampleRate: 24000, channels: 1 }) },
  fetch: async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    if (request.messages.at(-1).content.includes('The application is starting.')) {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Test greeting cancelled', 'AbortError'));
        if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return Response.json({ choices: [{ message: { content: '{"text":"收到","text_ja":"わかりました"}' } }] });
  }
});
let window;
const timeout = setTimeout(() => { console.error('WEB_STARTUP_SMOKE_TIMEOUT'); app.exit(1); }, 90_000);
async function run() {
  try {
    await app.whenReady();
    await server.listen();
    window = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'user-gesture-required', backgroundThrottling: false } });
    window.webContents.setAudioMuted(true);
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await window.loadURL('http://127.0.0.1:3098');
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const timer = setInterval(() => {
        if (window.sendAgentMessage && !document.getElementById('speakBtnPanel').disabled && !document.getElementById('loadingGif')) {
          clearInterval(timer); resolve();
        } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Phone composer never became ready')); }
      }, 50);
    })`);
    assert.equal(requests.length, 1);
    assert.equal(await window.webContents.executeJavaScript('window._directAgentRequestPending'), true);
    // This is the page's first interaction; there is no preliminary audio tap.
    await window.webContents.executeJavaScript(`
      document.getElementById('textInputPanel').value = 'My first phone message';
      document.getElementById('speakBtnPanel').click();
      if (!document.getElementById('speakBtnPanel').disabled || document.getElementById('screenshotStatus').textContent !== 'Sending…') {
        throw new Error('Send has no delivery feedback');
      }
    `, true);
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        if (!window._directAgentRequestPending && !document.getElementById('speakBtnPanel').disabled) {
          clearInterval(timer); resolve({ history: document.getElementById('history-messages').textContent,
            input: document.getElementById('textInputPanel').value, status: document.getElementById('screenshotStatus').textContent });
        } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('First Send is stuck behind greeting')); }
      }, 50);
    })`);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.at(-1).content, 'My first phone message');
    assert.match(result.history, /My first phone message/); assert.match(result.history, /收到/);
    assert.equal(result.input, ''); assert.equal(result.status, '');
    assert.deepEqual(errors, []);
    console.log('WEB_STARTUP_SMOKE_OK: first Send completes while greeting is stalled, with no preliminary tap');
  } catch (error) { console.error(error, errors); process.exitCode = 1; }
  finally {
    clearTimeout(timeout); window?.destroy(); await server.close();
    await rm(profile, { recursive: true, force: true }); app.exit(process.exitCode || 0);
  }
}
void run();
