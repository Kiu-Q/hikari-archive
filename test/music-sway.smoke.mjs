// npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/music-sway.smoke.mjs
// Production VRM and settings with isolated storage and synthetic beat IPC.
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hikari-sway-smoke-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.on('window-all-closed', () => {});
const fixture = path.join(profile, 'renderer');
cpSync(path.resolve('dist'), fixture, { recursive: true });
const bundle = path.join(fixture, 'app.js'), original = readFileSync(bundle, 'utf8');
const instrumented = original.replace(/[\w$]+\.info\("vrm","VRM loaded:",([\w$]+)\)/,
  (match, vrm) => `(globalThis.__swayTestVrm=${vrm},${match})`);
assert.notEqual(instrumented, original, 'Expose the loaded model only in this temporary test bundle');
writeFileSync(bundle, instrumented);
const preload = path.join(profile, 'preload.cjs');
await writeFile(preload, `const { contextBridge, ipcRenderer } = require('electron');
  const subscribe = (channel, callback) => {
    const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
  contextBridge.exposeInMainWorld('electronAPI', {
    setIgnoreMouseEvents: async () => true,
    getWindowPosition: async () => ({ x: 100, y: 100 }),
    setWindowPosition: async (x, y) => ({ x, y }),
    musicBeat: { setEnabled: enabled => ipcRenderer.invoke('music:set', enabled),
      onSignal: callback => subscribe('music-beat:signal', callback),
      onStatus: callback => subscribe('music-beat:status', callback),
      openPermissionSettings: async () => true }
  });`);
let window, pulse;
const enabled = [], errors = [];
const timeout = setTimeout(() => { console.error('MUSIC_SWAY_SMOKE_TIMEOUT'); app.exit(1); }, 90_000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => window.webContents.executeJavaScript(source);
function centroid(snapshot, from, to) {
  const { width, height } = snapshot.getSize(), pixels = snapshot.toBitmap();
  let total = 0, count = 0;
  for (let y = Math.floor(height * from); y < height * to; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 100) { total += x; count++; }
  }
  assert.ok(count > 100); return total / count;
}
async function pose(name) {
  const snapshot = await window.webContents.capturePage();
  await writeFile(`/tmp/hikari-sway-${name}.png`, snapshot.toPNG());
  return { upper: centroid(snapshot, .08, .4), lower: centroid(snapshot, .77, .86) };
}
async function run() {
  let code = 0;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
    ipcMain.handle('music:set', (_event, value) => { enabled.push(value); return { state: value ? 'listening' : 'off' }; });
    window = new BrowserWindow({ show: false, width: 600, height: 900, useContentSize: true, transparent: true, frame: false,
      webPreferences: { preload, webSecurity: false, backgroundThrottling: false } });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.on('console-message', event => { if (event.level === 'error' && /Uncaught|Initialization error/.test(event.message)) errors.push(event.message); });
    await window.loadFile(path.join(fixture, 'index.html')); window.showInactive();
    await evaluate(`new Promise((resolve,reject) => {
      const until = Date.now()+35000; const timer = setInterval(() => {
        if (window.sendAgentMessage && !document.getElementById('loadingGif') && !window.isAgentInteractionPending()) { clearInterval(timer); resolve(); }
        else if (Date.now()>until) { clearInterval(timer); reject(new Error('Renderer not ready')); }
      },50);
    })`);
    assert.deepEqual(enabled, []);
    await evaluate(`(async () => {
      window.animationSettings.idle_loop = true; await window.loadIdleLoop();
      for (const input of document.querySelectorAll('[id^="anim-idle_"]')) {
        input.checked = input.id === 'anim-idle_loop'; input.dispatchEvent(new Event('change'));
      }
      document.getElementById('desktopCursorGazeToggle').checked = false;
      document.getElementById('musicSwayToggle').click();
      const style = document.createElement('style');
      style.textContent = 'body > :not(canvas) { display:none !important; }'; document.head.appendChild(style);
    })()`);
    await sleep(1200);
    assert.deepEqual(enabled, [true]);
    assert.equal(await evaluate(`document.getElementById('anim-idle_loop').checked`), true);
    const started = Date.now();
    const send = () => {
      const now = Date.now(), beats = Math.floor((now - started) / 500);
      window.webContents.send('music-beat:signal', {
        active: true, level: .1, beat: 4 + beats, intervalMs: 500,
        lastBeatAt: started + beats * 500, updatedAt: now,
      });
    };
    send(); pulse = setInterval(send, 40);
    await sleep(1200);
    const poses = [];
    // Sample a complete continuous cycle rather than artificially holding a beat.
    for (let i = 0; i < 12; i++) { poses.push(await pose(`frame-${i}`)); await sleep(180); }
    const range = field => Math.max(...poses.map(value => value[field])) - Math.min(...poses.map(value => value[field]));
    console.log('MUSIC_SWAY_RENDER', { upperRange: range('upper'), lowerRange: range('lower') });
    assert.ok(range('upper') > 20, 'The wider upper-body sway must be clearly visible');
    assert.ok(range('lower') < 2, 'The lower body must stay planted');

    // Reproduce a gesture that finishes leaning, even if the property's saved
    // mixer state was already tilted. Returning to the partial idle must replace it.
    await evaluate(`(async () => {
      window.animationSettings.idle_stretch = true;
      const action = await window.startSmoothTransition(window.getVRMAAnimationUrl('idle_stretch.vrma'), { loopMode: 2200, transitionTime: 0 });
      const vrm = __swayTestVrm, hips = vrm.humanoid.getNormalizedBoneNode('hips'), spine = vrm.humanoid.getNormalizedBoneNode('spine');
      const rest = vrm.humanoid.normalizedRestPose;
      const axis = spine.position.clone().set(0,0,1), lean = spine.quaternion.clone().setFromAxisAngle(axis, .35).toArray();
      for (const track of action.getClip().tracks) {
        if (track.name === spine.name + '.quaternion') {
          for (let i = 0; i < track.values.length; i += 4) track.values.set(lean, i);
        }
        if (track.name === hips.name + '.position') {
          for (let i = 0; i < track.values.length; i += 3) track.values.set([rest.hips.position[0] + .08, rest.hips.position[1], rest.hips.position[2]], i);
        }
      }
      action.time = action.getClip().duration - .05; action.getMixer().update(0);
      window.smokeLeanBeforeReturn = Math.abs(spine.rotation.z);
      await window.waitForActionEnd(action, 1000, false);
      await window.loadIdleLoop();
      window.animationSettings.idle_stretch = false;
    })()`);
    assert.ok(await evaluate(`window.smokeLeanBeforeReturn > .3`), 'The regression starts from a visible twenty-degree lean');
    await sleep(1200);
    const centered = await evaluate(`(() => {
      const vrm = __swayTestVrm, rest = vrm.humanoid.normalizedRestPose;
      const hips = vrm.humanoid.getNormalizedBoneNode('hips'), spine = vrm.humanoid.getNormalizedBoneNode('spine');
      const chest = vrm.humanoid.getNormalizedBoneNode('chest') || vrm.humanoid.getNormalizedBoneNode('upperChest');
      return { hipOffset: Math.abs(hips.position.x - rest.hips.position[0]),
        torsoTilt: Math.abs(spine.rotation.z + (chest?.rotation.z || 0)) };
    })()`);
    assert.ok(centered.hipOffset < 1e-5, 'Return to the standing center before resuming music');
    assert.ok(centered.torsoTilt < 6.1 * Math.PI / 180, 'Only the music sway angle remains, not the outgoing lean');
    console.log('MUSIC_SWAY_CENTERED_RETURN', centered);

    await evaluate(`window._directAgentRequestPending = true;
      document.querySelector('canvas').dispatchEvent(new MouseEvent('mousedown', {
        bubbles:true, button:0, clientX:300, clientY:400, screenX:500, screenY:500 }));`);
    await sleep(40);
    await evaluate(`document.querySelector('canvas').dispatchEvent(new MouseEvent('mousemove', {
      bubbles:true, clientX:-50, clientY:400, screenX:150, screenY:500 }));`);
    assert.equal(await evaluate(`window.isWindowDragging`), true);
    await sleep(300);
    await evaluate(`document.querySelector('canvas').dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button:0 }));`);
    assert.equal(await evaluate(`window.isWindowDragging`), false);
    await sleep(1000);
    // A silent WAV exercises actual speech playback without contacting a service.
    await evaluate(`(async () => {
      const rate = 24000, samples = 6000, audio = new Uint8Array(44 + samples * 2), data = new DataView(audio.buffer);
      const ascii = (at, text) => [...text].forEach((char, i) => audio[at + i] = char.charCodeAt(0));
      ascii(0,'RIFF'); data.setUint32(4,audio.length-8,true); ascii(8,'WAVE'); ascii(12,'fmt ');
      data.setUint32(16,16,true); data.setUint16(20,1,true); data.setUint16(22,1,true);
      data.setUint32(24,rate,true); data.setUint32(28,rate*2,true); data.setUint16(32,2,true); data.setUint16(34,16,true);
      ascii(36,'data'); data.setUint32(40,samples*2,true);
      let start;
      await window.lipSyncSystem.startSpeaking('好呀！', 'はい！', {
        prepared:[{result:Promise.resolve({audio, durationSeconds:.25, sampleRate:rate, channels:1})}],
        beforePlay:async () => { start = await window.prepareSpeakingAnimation(window.getVRMAAnimationUrl('wave_fast.vrma')); },
        onStart:() => { window.smokeVoiceStarted = true; start?.(); },
      });
      window._directAgentRequestPending = false;
    })()`);
    assert.equal(await evaluate(`window.smokeVoiceStarted`), true);
    await sleep(3500);
    await evaluate(`(async () => { await window.loadIdleLoop(); await window.loadIdleLoop(); })()`);
    await sleep(1300);
    const returned = [];
    for (let i = 0; i < 12; i++) { returned.push(await pose(`after-reply-${i}`)); await sleep(180); }
    const returnedRange = field => Math.max(...returned.map(value => value[field])) - Math.min(...returned.map(value => value[field]));
    console.log('MUSIC_SWAY_AFTER_DRAG_REPLY', { upperRange: returnedRange('upper'), lowerRange: returnedRange('lower') });
    assert.ok(returnedRange('upper') > 20, 'Sway must resume after dragging, real speech and duplicate idle cleanup');
    assert.ok(returnedRange('lower') < 2, 'The returned idle loop must not animate over music sway');
    clearInterval(pulse);
    await evaluate(`document.getElementById('musicSwayToggle').click()`);
    await sleep(50);
    assert.deepEqual(enabled, [true, false]);
    assert.equal(await evaluate(`localStorage.getItem('music_sway_enabled')`), 'false');
    assert.equal(await evaluate(`document.getElementById('anim-idle_loop').checked`), true, 'pausing music must preserve the idle-loop preference');
    assert.deepEqual(errors, []);
    console.log('MUSIC_SWAY_SMOKE_OK');
  } catch (error) { console.error(error); code = 1; }
  finally {
    clearTimeout(timeout); clearInterval(pulse); window?.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); app.exit(code);
  }
}
void run();
