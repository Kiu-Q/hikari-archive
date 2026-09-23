// Run manually with: node_modules/.bin/electron test/japanese-voice.smoke.mjs
// Uses the installed custom voice, real preload IPC, and Chromium audio decoding.
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalTtsService } from '../electron/local-tts-main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'hikari-voice-smoke-')));
let service, window;
const timeout = setTimeout(() => { console.error('Voice smoke test timed out'); app.exit(1); }, 480_000);
async function run() {
try {
  await app.whenReady();
  service = createLocalTtsService({ toolDir: path.join(root, 'tools/companion-tts') });
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'electron/preload.js'), contextIsolation: true,
    nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required',
    backgroundThrottling: false,
  } });
  window.webContents.setAudioMuted(true);
  let spokenText;
  ipcMain.handle('tts:synthesize', (event, input) => {
    assert.equal(event.sender, window.webContents);
    spokenText = input.text;
    return service.synthesize(input);
  });
  await window.loadURL('data:text/html,<html><body><div id="subtitle"></div></body></html>');
  const playerSource = readFileSync(path.join(root, 'electron/japanese-speech-player.js'), 'utf8')
    .replace('export function createJapaneseSpeechPlayer', 'function createJapaneseSpeechPlayer');
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    ${playerSource}
    const command = {text: '老師，早晨！', text_ja: '先生、おはよう。'};
    const mouth = [];
    let prepared = false, synchronized = false;
    const player = createJapaneseSpeechPlayer({
      synthesize: async input => {
        const result = await window.electronAPI.tts.synthesize(input);
        if (document.getElementById('subtitle').textContent !== '') throw new Error('Caption appeared before voice was ready');
        return result;
      },
      onMouth: shape => mouth.push(shape),
      onPlaying: () => { synchronized = prepared && document.getElementById('subtitle').textContent === command.text; },
    });
    const completed = await player.speak(command.text_ja, 1, {
      beforePlay: () => { prepared = true; },
      onStart: () => { document.getElementById('subtitle').textContent = command.text; },
    });
    return { completed, synchronized, display: document.getElementById('subtitle').textContent,
      openFrames: mouth.filter(shape => shape === 'aa').length,
      closedFrames: mouth.filter(shape => shape === 'neutral').length,
      finalMouth: mouth.at(-1) };
  })()`);
  assert.equal(spokenText, '先生、おはよう。');
  assert.equal(evidence.display, '老師，早晨！');
  assert.equal(evidence.completed, true);
  assert.equal(evidence.synchronized, true);
  assert.ok(evidence.openFrames > 0, 'Mouth must open on real audio');
  assert.ok(evidence.closedFrames > 0, 'Mouth must close for silence/end');
  assert.equal(evidence.finalMouth, 'neutral');
  console.log('JAPANESE_VOICE_SMOKE_OK', JSON.stringify(evidence));
  await service.dispose();
  clearTimeout(timeout);
  app.exit(0);
} catch (error) {
  console.error(error);
  await service?.dispose();
  clearTimeout(timeout);
  app.exit(1);
}
}
void run();
