import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { AnimationClip, AnimationMixer, NumberKeyframeTrack, Object3D } from 'three';
import { MusicSway } from '../electron/music-sway.js';
import { MusicBeatDetector } from '../electron/music-beat.js';
import { localMotionAllowed } from '../electron/local-attention.js';
import { IDLE_VRMA_FILE_NAMES } from '../electron/animation-catalog.js';
import { completeStandingIdleClip } from '../shared/standing-idle.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function playRandomIdle()');
const idle = source.slice(start, source.indexOf('    // ANIMATION DROPDOWN HANDLING', start));
test('music allows random idle sequences, while direct replies and dragging postpone them', async () => {
  const events = [];
  const context = vm.createContext({
    currentVrm: {}, currentAction: null, isPlayingSequence: false, isPlayingWalkSequence: false, isWindowDragging: false,
    window: { electronAPI: {}, hikariMusicBeat: { active: true, updatedAt: Date.now() } },
    document: { getElementById: () => ({ checked: true }) },
    logger: { info() {}, warn() {}, error() {} },
    VRMA_ANIMATION_URLS: ['walk.vrma', 'sit.vrma', 'start_2turnAround.vrma', 'idle_loop.vrma', 'idle_vSign.vrma'],
    IDLE_VRMA_FILE_NAMES, Math: { random: () => 0, floor: Math.floor }, statusDiv: {},
    getVRMAFileName: value => value, THREE: { LoopOnce: 1 },
    startSmoothTransition: async value => { events.push(value); return {}; },
    waitForActionEnd: async () => events.push('finished'),
    scheduleRandomIdle: () => events.push('timer'), loadIdleLoop: async () => { events.push('idle'); return true; },
  });
  vm.runInContext(idle, context);
  await context.playRandomIdle();
  assert.deepEqual(events, ['idle_vSign.vrma', 'finished', 'idle', 'timer']);
  events.length = 0;
  context.window.isAgentInteractionPending = () => true;
  await context.playRandomIdle();
  assert.deepEqual(events, ['timer']);
  events.length = 0;
  context.window.isAgentInteractionPending = () => false;
  context.isWindowDragging = true;
  await context.playRandomIdle();
  assert.deepEqual(events, ['timer']);
});

test('idle freezes during sway, eases back in during fades, and respects drag and saved opt-outs', () => {
  const root = new Object3D(), mixer = new AnimationMixer(root);
  const clip = new AnimationClip('idle_loop', 2, [new NumberKeyframeTrack('.position[x]', [0, 2], [0, 1])]);
  const action = mixer.clipAction(clip).play(); action.time = .4; mixer.update(0);
  const musicSway = new MusicSway(), spine = new Object3D();
  const vrm = { humanoid: { getNormalizedBoneNode: name => name === 'spine' ? spine : null } };
  let idleEnabled = true;
  const context = vm.createContext({ currentAction: action, idleClips: new WeakSet([clip]), idleActions: new Set(), musicSway, isWindowDragging: false,
    window: { isAnimationEnabled: () => idleEnabled } });
  const helperStart = source.indexOf('    function updateMusicIdleLoop(');
  vm.runInContext(source.slice(helperStart, source.indexOf('    function animate()', helperStart)), context);
  const step = (now, active = true, options = {}) => {
    const data = { active, intervalMs: 500, beat: 4 + Math.floor(now / 500),
      lastBeatAt: Math.floor(now / 500) * 500, updatedAt: now };
    const motion = { enabled: true, delta: .02, now, ...options };
    musicSway.restore(); context.updateMusicIdleLoop(data, motion); mixer.update(.02);
    musicSway.update(vrm, data, motion);
  };
  for (let now = 0; now <= 1200; now += 20) {
    step(now); assert.equal(action.time, .4); assert.equal(root.position.x, .2);
  }
  let previousScale = 0;
  for (let now = 1220; now <= 4000; now += 20) {
    step(now, false);
    assert.ok(action.timeScale >= previousScale && action.timeScale - previousScale < .11);
    previousScale = action.timeScale;
  }
  assert.ok(action.timeScale > .99); assert.equal(action.paused, false);
  step(4020); assert.equal(action.paused, true);
  step(4040, true, { blocked: true }); assert.equal(action.paused, false);
  step(4060); assert.equal(action.paused, true);
  step(4080, true, { enabled: false }); assert.equal(action.paused, false);
  context.isWindowDragging = true;
  step(4090, true, { blocked: true }); assert.equal(action.paused, true, 'dragging must retain its own idle pause');
  context.isWindowDragging = false;
  step(4095, true, { blocked: true }); assert.equal(action.paused, false);
  idleEnabled = false;
  step(4100, false, { enabled: false }); assert.equal(action.paused, true, 'respect the saved idle-loop opt-out');
  const scripted = mixer.clipAction(new AnimationClip('scripted', 2, [])); scripted.paused = false;
  context.currentAction = scripted;
  step(4120); assert.equal(scripted.paused, false, 'never pause a scripted animation');
});

test('unknown or stale music tempo never pauses the normal idle loop', () => {
  const sway = new MusicSway();
  for (const data of [null, { active: true, updatedAt: 0, lastBeatAt: 0, intervalMs: null },
    { active: true, updatedAt: 0, lastBeatAt: 0, intervalMs: 500 }]) {
    assert.equal(sway.shouldPauseIdle(data, { enabled: true, now: 2000 }), false);
  }
});

test('random idle spacing doubles when music sway is enabled, including brief silence', () => {
  const delays = [];
  let enabled = true;
  const context = vm.createContext({ currentIdleTimeout: null,
    window: { electronAPI: {} }, document: { getElementById: () => ({ checked: enabled }) },
    CONFIG: { RANDOM_IDLE_MIN_DELAY: 20000, RANDOM_IDLE_MAX_DELAY: 40000 },
    Math: { random: () => .5 }, logger: { info() {} }, playRandomIdle() {},
    setTimeout: (_callback, delay) => { delays.push(delay); return 1; }, clearTimeout() {} });
  const begin = source.indexOf('    function scheduleRandomIdle()');
  vm.runInContext(source.slice(begin, source.indexOf('    // ANIMATION LOOP', begin)), context);
  context.scheduleRandomIdle();
  enabled = false; context.scheduleRandomIdle();
  enabled = true; context.window.electronAPI = undefined; context.scheduleRandomIdle();
  assert.deepEqual(delays, [60000, 30000, 30000]);
});

test('real energy frames bridge a three-second song gap without pausing idle ownership or snapping sway', () => {
  const detector = new MusicBeatDetector(), sway = new MusicSway();
  const spine = new Object3D(), vrm = { humanoid: { getNormalizedBoneNode: name => name === 'spine' ? spine : null } };
  let lastAngle = 0;
  for (let now = 0; now <= 8000; now += 20) {
    const silent = now > 3500 && now < 6520;
    const data = detector.update({ level: silent ? 0 : .08, bass: !silent && now % 500 < 40 ? .08 : .001 }, now);
    sway.restore(); sway.update(vrm, data, { enabled: true, delta: .02, now });
    if (now >= 3500) {
      assert.equal(sway.shouldPauseIdle(data, { enabled: true, now }), true);
      assert.ok(sway.weight > .99);
      assert.ok(Math.abs(sway.angle - lastAngle) < .007);
      assert.equal(data.intervalMs, 500);
    }
    lastAngle = sway.angle;
  }
});

function loopHarness() {
  let time = 0, pending = false, talking = false, loads = 0;
  const root = new Object3D(), mixer = new AnimationMixer(root), sway = new MusicSway(), spine = new Object3D();
  const clip = name => new AnimationClip(name, 2, [new NumberKeyframeTrack('.position[x]', [0, 2], [0, 1])]);
  const first = clip('idle-a'), second = clip('idle-b');
  const a = mixer.clipAction(first).play(), b = mixer.clipAction(second).play(); a.time = .4; b.time = .8;
  const vrm = { humanoid: { getNormalizedBoneNode: name => name === 'spine' ? spine : null, resetNormalizedPose() {} } };
  const context = vm.createContext({ currentAction: a, currentMixer: mixer, currentVrm: vrm,
    idleClips: new WeakSet([first, second]), idleExpressionClips: new WeakSet(), updateIdleExpression() {},
    idleActions: new Set([a, b]), musicSway: sway,
    isWindowDragging: false, isTransitioning: false, isPlayingSequence: false, isPlayingWalkSequence: false,
    localMotionReleaseAt: 0, lipSyncSystem: { isTalking: () => talking }, localMotionAllowed,
    Date: { now: () => time }, performance: { now: () => time },
    window: { electronAPI: {}, isAnimationEnabled: () => true, isAgentInteractionPending: () => pending },
    document: { getElementById: () => ({ checked: true }) }, worldStateStore: { getSnapshot: () => ({ hikari: {} }) },
    logger: { info() {}, warn() {}, error() {} }, statusDiv: {}, getVRMAUrl: value => value, getVRMAFileName: url => url.split('/').pop(),
    loader: { loadAsync: async () => { loads++; return { userData: { vrmAnimations: [{}] } }; } },
    createVRMAnimationClip: () => clip('idle-return'), completeStandingIdleClip, THREE: { LoopRepeat: 2201, LoopOnce: 2200 },
    CONFIG: { T_OFFSET: 0, TRANSITION_TIME: .5 }, speakingAnimationEndCleanup: null,
    restoreReactiveHead() {}, setTimeout: () => 1,
  });
  for (const [begin, end] of [['    function getMusicMotionOptions(', '    function animate()'],
    ['    function blendToAnimation(', '    async function loadVRMA(']]) {
    const offset = source.indexOf(begin); vm.runInContext(source.slice(offset, source.indexOf(end, offset)), context);
  }
  const step = now => {
    time = now;
    context.window.hikariMusicBeat = { active: true, updatedAt: now, lastBeatAt: Math.floor(now / 500) * 500,
      intervalMs: 500, beat: 8 + Math.floor(now / 500) };
    const motion = context.getMusicMotionOptions(.02);
    sway.restore(); context.updateMusicIdleLoop(context.window.hikariMusicBeat, motion); mixer.update(.02);
    sway.update(vrm, context.window.hikariMusicBeat, motion);
  };
  return { context, a, b, mixer, sway, clip, step, setPending: value => { pending = value; },
    setTalking: value => { talking = value; }, get loads() { return loads; } };
}

test('after drag and speech, all live idle actions freeze again and repeated idle requests reuse the loop', async () => {
  const h = loopHarness();
  for (let now = 0; now <= 2000; now += 20) h.step(now);
  assert.equal(h.a.time, .4); assert.equal(h.b.time, .8);
  h.context.isWindowDragging = true;
  for (let now = 2020; now <= 2500; now += 20) h.step(now);
  h.context.isWindowDragging = false; h.setPending(true);
  for (let now = 2520; now <= 3500; now += 20) h.step(now);
  h.setTalking(true);
  for (let now = 3520; now <= 4500; now += 20) h.step(now);
  h.setPending(false); h.setTalking(false);
  await h.context.blendToAnimation(h.clip('reply'), 2200);
  for (let now = 4520; now <= 5000; now += 20) h.step(now);
  assert.equal(await h.context.loadIdleLoop(), true);
  assert.equal(h.loads, 1);
  const returning = h.context.currentAction;
  for (let now = 5020; now <= 6500; now += 20) h.step(now);
  const times = [h.a.time, h.b.time, returning.time];
  assert.equal(await h.context.loadIdleLoop(), true);
  assert.equal(h.context.currentAction, returning);
  assert.equal(h.loads, 1, 'reply cleanup must not restart another idle clip');
  for (let now = 6520; now <= 8500; now += 20) h.step(now);
  assert.deepEqual([h.a.time, h.b.time, returning.time], times);
  assert.ok(h.sway.weight > .99);
  assert.equal(returning.paused, true);
});

test('a delayed idle load cannot replace a newer speaking or random-idle action', async () => {
  const h = loopHarness(); h.step(1000);
  await h.context.blendToAnimation(h.clip('reply'), 2200);
  let resolveLoad;
  h.context.loader.loadAsync = () => new Promise(resolve => { resolveLoad = resolve; });
  const loading = h.context.loadIdleLoop();
  await h.context.blendToAnimation(h.clip('newer-reaction'), 2200);
  const newer = h.context.currentAction;
  resolveLoad({ userData: { vrmAnimations: [{}] } });
  assert.equal(await loading, false);
  assert.equal(h.context.currentAction, newer);
});

test('releasing a quick drag cancels its late-loading hang clip before it can replace idle', async () => {
  const h = loopHarness();
  const offset = source.indexOf('    async function startSmoothTransition(');
  vm.runInContext(source.slice(offset, source.indexOf('    // Load and convert the clip', offset)), h.context);
  let finishLoad, dragging = true;
  h.context.loader.loadAsync = () => new Promise(resolve => { finishLoad = resolve; });
  h.context.isWindowDragging = true;
  const loading = h.context.startSmoothTransition('hang.vrma', { allowDuringDrag: true, shouldStart: () => dragging });
  h.context.isWindowDragging = false; dragging = false;
  finishLoad({ userData: { vrmAnimations: [{}] } });
  assert.equal(await loading, null);
  assert.equal(h.context.currentAction, h.a);
});
