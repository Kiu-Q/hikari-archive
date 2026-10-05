import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { ATTENTION_CONFIG } from '../electron/local-attention.js';
import { VoiceAddressingGate } from '../electron/voice-addressing.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../electron/index.html', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const angleSetter = section('    function setMouseLookMaxAngle(', '    function setEnvironmentLookTarget(');

function harness(saved = {}) {
  const storage = new Map(Object.entries(saved)), elements = new Map(), speeds = [], motionChanges = [];
  for (const match of html.matchAll(/<(input|button|span)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const markup = match[0];
    elements.set(match[2], {
      value: /\bvalue="([^"]*)"/.exec(markup)?.[1] || '',
      checked: /\bchecked\b/.test(markup), disabled: /\bdisabled\b/.test(markup),
      textContent: '', style: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      click() { this.listeners.click?.(); },
    });
  }
  const context = vm.createContext({
    THREE, ATTENTION_CONFIG, EYE_FOLLOW_STORAGE_KEY: 'electron_eye_follow_degrees',
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { getElementById: id => elements.get(id), addEventListener() {} },
    window: { electronAPI: {}, _internalLipSync: { setSpeakingSpeed: speed => speeds.push(speed) } },
    logger: { info() {}, warn() {}, error() {} }, noteDirectHikariInteraction() {},
    setupLightControls() {},
    screenshotComposer: null,
    CoreModule: { refreshAnimationSettings: key => motionChanges.push(key) },
  });
  vm.runInContext(angleSetter + '\nCoreModule.setMouseLookMaxAngle = setMouseLookMaxAngle;', context);
  vm.runInContext(section('const animationToggleKeys =', '// Expose globally so CoreModule can access'), context);
  vm.runInContext(section('function setupWebSocketUrlInput()', '/**\n * Setup token configuration dialog'), context);
  vm.runInContext(section('function setupUIEventListeners()', '/**\n * Setup light brightness controls') + '\nsetupUIEventListeners();', context);
  return { context, elements, storage, speeds, motionChanges,
    input(id, value) { const element = elements.get(id); element.value = value; element.listeners.input({ target: element }); },
    toggle(id, checked) { const element = elements.get(id); element.checked = checked; element.listeners.change(); },
  };
}

test('Eye follow uses the complete advertised range and keeps thumb, label and saved value synchronized', () => {
  const h = harness({ electron_eye_follow_degrees: '35' });
  assert.equal(h.elements.get('eyeFollowSlider').value, '35');
  assert.equal(h.elements.get('eyeFollowValue').textContent, '35°');
  h.input('eyeFollowSlider', '45');
  assert.equal(vm.runInContext('mouseLookMaxYaw', h.context), Math.PI / 4);
  assert.equal(h.storage.get('electron_eye_follow_degrees'), '45');
  h.input('eyeFollowSlider', '90');
  assert.equal(h.elements.get('eyeFollowSlider').value, '45');
  assert.equal(h.elements.get('eyeFollowValue').textContent, '45°');
  h.input('eyeFollowSlider', '0');
  assert.equal(vm.runInContext('mouseLookMaxYaw', h.context), 0);
});

test('speaking speed saves and restores, including edits before the speech system is ready', () => {
  const h = harness({ electron_speaking_speed: '1.5' });
  assert.equal(h.elements.get('speakingSpeedSlider').value, '1.5');
  assert.equal(h.elements.get('speakingSpeedValue').textContent, '1.5x');
  h.input('speakingSpeedSlider', '1.8');
  assert.deepEqual(h.speeds, [1.8]);
  h.context.window._internalLipSync = null;
  h.input('speakingSpeedSlider', '0.7');
  assert.equal(h.storage.get('electron_speaking_speed'), '0.7');
  assert.equal(h.elements.get('speakingSpeedValue').textContent, '0.7x');
});

test('all Motion checkboxes persist their value and control their animation filename/category', () => {
  const h = harness();
  for (const key of vm.runInContext('animationToggleKeys', h.context)) {
    h.toggle(`anim-${key}`, false);
    assert.equal(vm.runInContext(`isAnimationUrlEnabled('VRMA/${key}.vrma')`, h.context), false);
    assert.equal(JSON.parse(h.storage.get('animation_settings'))[key], false);
    assert.equal(h.motionChanges.at(-1), key);
  }
  for (const filename of ['walk_left', 'walk_right', 'sit_down', 'sit_up', 'sitWave']) {
    assert.equal(vm.runInContext(`isAnimationUrlEnabled('${filename}.vrma')`, h.context), false);
  }
  h.toggle('anim-idle_loop', true);
  assert.equal(vm.runInContext("isAnimationEnabled('idle_loop')", h.context), true);
});

test('connection Save and Enter update or clear the exact keys used by requests', () => {
  const h = harness({ websocket_url: 'http://localhost:18789', openclaw_token: 'test-token' });
  const url = h.elements.get('websocketUrlInput'), token = h.elements.get('tokenInput');
  assert.equal(url.value, 'http://localhost:18789');
  url.value = ' http://localhost:12345 ';
  token.value = ' changed-test-token ';
  url.listeners.keypress({ key: 'Enter' });
  assert.equal(h.storage.get('websocket_url'), 'http://localhost:12345');
  assert.equal(h.storage.get('openclaw_token'), 'changed-test-token');
  url.value = ''; token.value = '';
  h.elements.get('saveConnectBtn').click();
  assert.equal(h.storage.has('websocket_url'), false);
  assert.equal(h.storage.has('openclaw_token'), false);
});

test('cursor/environment opt-outs are restored before renderer initialization', () => {
  const h = harness({ desktop_cursor_gaze_enabled: 'false', environment_reactions_enabled: 'false' });
  assert.equal(h.elements.get('desktopCursorGazeToggle').checked, false);
  assert.equal(h.elements.get('environmentReactionsToggle').checked, false);
});

test('Eye follow changes the actual world target and zero disables automatic eye rotation', () => {
  const h = harness();
  const head = new THREE.Object3D(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 800 / 600, 0.1, 20);
  scene.add(head);
  camera.position.set(0, 0, 5); camera.updateMatrixWorld();
  const lookAt = { yaw: 10, pitch: 5,
    getLookAtWorldPosition: output => head.getWorldPosition(output),
    getLookAtWorldQuaternion: output => output.identity(), getFaceFrontQuaternion: output => output.identity(),
  };
  Object.assign(h.context, { camera, currentVrm: { scene, humanoid: { getRawBoneNode: () => head }, lookAt },
    localOwnsMotion: true, mouseLookActive: true, environmentLookActive: false,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600 }) } },
  });
  for (const name of ['mouseLookDesired', 'mouseLookCurrent', 'mouseLookHeadPosition', 'mouseLookHeadScreenPosition', 'mouseLookForward', 'mouseLookRight', 'mouseLookUp']) h.context[name] = new THREE.Vector3();
  h.context.mouseLookClientPosition = new THREE.Vector2(800, 300);
  h.context.mouseLookPointer = new THREE.Vector2();
  h.context.mouseLookHeadQuaternion = new THREE.Quaternion();
  h.context.mouseLookFaceQuaternion = new THREE.Quaternion();
  h.context.mouseLookTarget = new THREE.Object3D();
  vm.runInContext(section('    function updateMouseLook(', '    /**\n     * Handle window resize'), h.context);
  h.input('eyeFollowSlider', '20');
  vm.runInContext('updateMouseLook(0.05);', h.context);
  const at20 = h.context.mouseLookDesired.x;
  h.input('eyeFollowSlider', '45');
  vm.runInContext('updateMouseLook(0.05);', h.context);
  assert.ok(h.context.mouseLookDesired.x > at20 * 2);
  assert.equal(lookAt.autoUpdate, true);
  h.input('eyeFollowSlider', '0');
  vm.runInContext('updateMouseLook(0.05);', h.context);
  assert.equal(lookAt.target, null);
  assert.equal(lookAt.autoUpdate, false);
  assert.ok(lookAt.yaw < 10);
});

test('disabled animations are blocked before loading, and idle-loop opt-out pauses the base pose', async () => {
  const h = harness();
  let loads = 0;
  const idleClip = {}, idleClips = new WeakSet([idleClip]);
  const action = { paused: false, getClip: () => idleClip };
  Object.assign(h.context, {
    currentVrm: {}, currentAction: action, idleClips, statusDiv: { textContent: '' },
    CONFIG: { T_OFFSET: 0.5, TRANSITION_TIME: 0.5 }, isWindowDragging: false,
    loader: { loadAsync: async () => { loads++; return { userData: { vrmAnimations: [{}] } }; } },
    getVRMAUrl: file => file, createVRMAnimationClip: () => idleClip,
    blendToAnimation: async () => action,
  });
  h.context.window.isAnimationUrlEnabled = url => vm.runInContext(`isAnimationUrlEnabled(${JSON.stringify(url)})`, h.context);
  h.context.window.isAnimationEnabled = key => vm.runInContext(`isAnimationEnabled(${JSON.stringify(key)})`, h.context);
  vm.runInContext(section('    async function startSmoothTransition(', '    function blendToAnimation('), h.context);
  h.toggle('anim-start_2turnAround', false);
  assert.equal(await vm.runInContext("startSmoothTransition('start_2turnAround.vrma')", h.context), null);
  assert.equal(await vm.runInContext("prepareSpeakingAnimation('start_2turnAround.vrma')", h.context), null);
  assert.equal(loads, 0);
  vm.runInContext(section('    async function loadIdleLoop(', '    async function loadVRMA('), h.context);
  h.toggle('anim-idle_loop', false);
  assert.equal(await vm.runInContext('loadIdleLoop()', h.context), true);
  assert.equal(action.paused, true);
  h.toggle('anim-idle_loop', true);
  await vm.runInContext('loadIdleLoop()', h.context);
  assert.equal(action.paused, false);
});

test('voice settings save wake words/follow-up and serialize microphone start/stop; failures restore Off', async () => {
  const h = harness();
  let releaseStart, failStart = false, stopped = 0;
  Object.assign(h.context, {
    voiceAddressingGate: new VoiceAddressingGate(), voicePerception: null, awarenessController: null,
    worldStateStore: { applyPatch() {} }, updateHikariState() {}, setTimeout, clearTimeout,
    VoicePerception: class {
      async start() { if (failStart) throw new Error('test permission denial'); await new Promise(resolve => { releaseStart = resolve; }); }
      async stop() { stopped++; }
    },
  });
  h.context.window.electronAPI.voice = { setEnabled: async () => ({ stt: { available: true } }) };
  vm.runInContext(section("        const voiceToggle = document.getElementById('voiceListeningToggle');", "        window.addEventListener('beforeunload'"), h.context);
  const wake = h.elements.get('wakeWordInput'), followUp = h.elements.get('voiceFollowUpToggle');
  wake.value = '  小光  '; wake.listeners.change();
  assert.equal(h.storage.get('voice_wake_word'), '小光');
  assert.deepEqual(Array.from(h.context.voiceAddressingGate.wakeWords), ['小光']);
  followUp.checked = true; followUp.listeners.change();
  assert.equal(h.context.voiceAddressingGate.followUpDurationMs, 5000);
  followUp.checked = false; followUp.listeners.change();
  assert.equal(h.context.voiceAddressingGate.followUpDurationMs, 0);
  const voice = h.elements.get('voiceListeningToggle');
  voice.checked = true;
  const starting = voice.listeners.change();
  assert.equal(voice.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  releaseStart(); await starting;
  assert.equal(voice.disabled, false);
  assert.equal(h.storage.get('voice_listening_enabled'), 'true');
  voice.checked = false; await voice.listeners.change();
  assert.equal(stopped, 1);
  assert.equal(h.storage.get('voice_listening_enabled'), 'false');
  failStart = true; voice.checked = true; await voice.listeners.change();
  assert.equal(voice.checked, false);
  assert.equal(voice.disabled, false);
  assert.equal(h.storage.get('voice_listening_enabled'), 'false');
});
