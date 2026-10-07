// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/electron-caption-bubble.smoke.mjs
// Measure the production caption code in Chromium, including fractional UI zoom.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-caption-smoke-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const source = await readFile(new URL('../electron/app.js', import.meta.url), 'utf8');
const captions = await readFile(new URL('../electron/speech-segments.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../electron/index.html', import.meta.url), 'utf8');
const desktopStyles = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const captionHelpers = captions.slice(captions.indexOf('const graphemes'), captions.indexOf('function appendSegment')).replace('export function', 'function');
const bubbleCode = source.slice(source.indexOf('    let speakingBubble,'), source.indexOf('    function getWordCount('));
let window;
const timeout = setTimeout(() => { console.error('CAPTION_BUBBLE_SMOKE_TIMEOUT'); app.exit(1); }, 30_000);
async function run() {
try {
  await app.whenReady();
  console.log('CAPTION_BUBBLE_APP_READY');
  window = new BrowserWindow({ show: false, width: 600, height: 900, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL('about:blank');
  console.log('CAPTION_BUBBLE_PAGE_LOADED');
  await window.webContents.executeJavaScript(`
    document.head.innerHTML = '<style>' + ${JSON.stringify(desktopStyles)} + '</style>';
    const currentVrm = null, logger = { info() {} };
    ${captionHelpers}
    ${bubbleCode}
    initSpeakingBubble();
    window.checkCaption = (text, scale, desktop) => {
      const root = document.documentElement.style;
      root.setProperty('--desktop-ui-scale', String(scale));
      root.setProperty('--desktop-ui-width', (innerWidth / scale) + 'px');
      root.setProperty('--desktop-min-font', (12 / scale) + 'px');
      speakingBubble.style.zoom = desktop ? String(scale) : '1';
      if (!desktop) root.removeProperty('--desktop-min-font');
      showSpeakingBubble(text);
      const before = speakingBubble.getBoundingClientRect().width;
      displayCharacterAtIndex(999);
      const box = speakingBubble.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(speakingBubbleCaption);
      return { before, width: box.width, left: box.left, right: box.right,
        lines: [...range.getClientRects()].map(r => ({ top: r.top, right: r.right })),
        text: speakingBubbleCaption.textContent, expected: formatCaption(text) };
    };
    void 0;
  `);
  for (const [width, height, scale, desktop] of [[600,900,1,true], [300,450,.5,true], [200,300,.5,true], [337,505,.5616666667,true], [390,844,1,false]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    for (const text of ['老師今日辛苦晒😊', '早晨老師👩🏽‍💻', 'A little company']) {
      const result = await window.webContents.executeJavaScript(`checkCaption(${JSON.stringify(text)}, ${scale}, ${desktop})`);
      assert.equal(result.text, result.expected);
      assert.ok(Math.abs(result.before - result.width) < .1, 'Typing must preserve bubble width');
      assert.equal(new Set(result.lines.map(line => Math.round(line.top))).size, 1, JSON.stringify({ width, scale, text, result }));
      assert.ok(result.left >= 7 && result.right <= width - 7, JSON.stringify({ width, scale, text, result }));
    }
    const long = await window.webContents.executeJavaScript(`checkCaption('老師今日辛苦晒'.repeat(12), ${scale}, ${desktop})`);
    assert.ok(new Set(long.lines.map(line => Math.round(line.top))).size > 1, 'Long captions must still wrap');
    assert.ok(long.left >= 7 && long.right <= width - 7);
    console.log('CAPTION_LAYOUT_OK', { width, scale, desktop });
  }
  console.log('CAPTION_BUBBLE_SMOKE_OK');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  window?.destroy();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(process.exitCode || 0);
}
}
void run();
