import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { IDLE_VRMA_FILE_NAMES } from '../electron/animation-catalog.js';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function harness(file, { enabled = true, x = 100 } = {}) {
  const clips = [], positions = [], waits = [], events = [];
  let elapsed = 0;
  const context = vm.createContext({
    currentVrm: { scene: { rotation: { y: 0.2 } }, humanoid: { resetNormalizedPose() {} } },
    currentAction: null, currentMixer: { uncacheAction() {} },
    isPlayingSequence: false, isPlayingWalkSequence: false, isWindowDragging: false,
    isTransitioning: false, isSitAnimationActive: false, idleSuspended: false,
    currentIdleTimeout: null, walkingInitialRotY: 0, walkingWindowInitialPos: null,
    statusDiv: {}, animationSelect: { value: `VRMA/${file}`, addEventListener(_name, handler) { this.change = handler; } },
    logger: { info() {}, warn() {}, error() {} },
    window: {
      electronAPI: {
        getWindowPosition: async () => ({ x, y: 50 }),
        getWindowBounds: async () => ({ width: 600 }),
        setWindowPosition: (x, y) => positions.push({ x, y }),
      },
      screen: { width: 1920 },
      isAnimationEnabled: key => !['idle_sit', 'idle_walk'].includes(key) || enabled,
      isAnimationUrlEnabled: url => !url.endsWith(file) || enabled,
      hideAllPanels: () => events.push('hide-panels'),
      hideMessagingPanel: () => events.push('hide-messaging'),
    },
    HistoryModule: { hideHistoryPanel: () => events.push('hide-history') },
    sendEventToAgent: type => events.push(type),
    CONFIG: { RANDOM_IDLE_MIN_DELAY: 20000, RANDOM_IDLE_MAX_DELAY: 40000,
      WALK_TIME_SCALE: 0.5, WALK_START_DELAY: 0, WALK_WALK_DURATION: 4,
      WALK_TURN_DURATION: 1, WALK_WINDOW_OFFSET: 600 },
    THREE: { LoopOnce: 2200, LoopRepeat: 2201 }, IDLE_VRMA_FILE_NAMES,
    VRMA_ANIMATION_URLS: [`VRMA/${file}`], getVRMAFileName: url => url.split('/').pop(),
    getVRMAUrl: name => `VRMA/${name}`,
    Math: { random: () => 0, floor: Math.floor, min: Math.min, round: Math.round, PI: Math.PI },
    performance: { now: () => elapsed },
    requestAnimationFrame: callback => { elapsed += 100; callback(); },
    setTimeout: (callback, delay) => { waits.push(delay); callback(); return 1; }, clearTimeout() {},
    startSmoothTransition: async (url, options) => {
      const action = { stop() {}, getClip: () => ({}), setEffectiveTimeScale(value) { this.timeScale = value; } };
      clips.push({ url, options, action }); return action;
    },
    waitForActionEnd: async () => events.push('clip-finished'),
    loadIdleLoop: async () => { events.push('idle-loop'); return true; },
    scheduleRandomIdle: () => events.push('schedule-idle'),
  });
  vm.runInContext(section('    async function runElectronWalkSequence(', '    async function startAutomaticSequence('), context);
  vm.runInContext(section('    async function playRandomIdle()', '    // ANIMATION DROPDOWN HANDLING'), context);
  vm.runInContext(section('    function setupAnimationDropdown()', '    // INITIALIZATION') + '\nsetupAnimationDropdown();', context);
  return { context, clips, positions, waits, events };
}

for (const manual of [false, true]) {
  const entry = manual ? 'picker' : 'random idle';
  test(`${entry} plays the full Sit procedure with the renamed idle asset`, async () => {
    const h = harness('idle_sit.vrma');
    await (manual ? h.context.animationSelect.change() : h.context.playRandomIdle());
    assert.deepEqual(h.clips.map(clip => clip.url), ['VRMA/sit_down.vrma', 'VRMA/idle_sit.vrma', 'VRMA/sit_up.vrma']);
    assert.deepEqual(h.clips.map(clip => clip.options.loopMode), [2200, 2201, 2200]);
    assert.ok(h.waits.includes(20000), 'hold the sitting loop before standing up');
    assert.equal(h.events.filter(event => event === 'clip-finished').length, 2);
    assert.ok(h.events.includes('idle-loop'));
  });

  for (const x of [100, 1100]) {
    test(`${entry} walks from x=${x}, turns back, and returns to idle`, async () => {
      const h = harness('idle_walk.vrma', { x });
      await (manual ? h.context.animationSelect.change() : h.context.playRandomIdle());
      assert.equal(h.clips.length, 3, 'play walking across both turns and the walking leg');
      assert.ok(h.clips.every(clip => clip.url === 'VRMA/idle_walk.vrma' && clip.options.loopMode === 2201 && clip.action.timeScale === 0.5));
      assert.deepEqual(h.positions.at(-1), { x: x < 660 ? x + 600 : x - 600, y: 50 });
      assert.ok(Math.abs(h.context.currentVrm.scene.rotation.y - 0.2) < 1e-10);
      assert.equal(h.context.isPlayingWalkSequence, false);
      assert.equal(h.context.idleSuspended, false);
      assert.ok(h.events.includes('idle-loop'));
      assert.ok(h.events.includes('schedule-idle'));
    });
  }

  for (const file of ['idle_sit.vrma', 'idle_walk.vrma']) {
    test(`${entry} does not start disabled ${file}`, async () => {
      const h = harness(file, { enabled: false });
      await (manual ? h.context.animationSelect.change() : h.context.playRandomIdle());
      assert.equal(h.clips.length, 0);
      assert.equal(h.positions.length, 0);
    });
  }
}

test('the Walk procedure itself respects its renamed toggle', async () => {
  const h = harness('idle_walk.vrma', { enabled: false });
  await h.context.runElectronWalkSequence('VRMA/idle_walk.vrma');
  assert.equal(h.clips.length, 0);
  assert.equal(h.positions.length, 0);
  assert.equal(h.context.isPlayingWalkSequence, false);
});
