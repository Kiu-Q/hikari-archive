import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('    async function prepareSpeakingAnimation('), source.indexOf('    async function loadVRMA('));
function harness() {
  const listeners = new Set(), actions = [], timers = [];
  const context = vm.createContext({
    currentVrm: {}, currentAction: null, speakingAnimationEndCleanup: null,
    currentMixer: {
      addEventListener: (_name, handler) => listeners.add(handler),
      removeEventListener: (_name, handler) => listeners.delete(handler),
      update() {},
      clipAction(clip) {
        const action = { clip, setLoop(mode) { this.loop = mode; }, setEffectiveWeight() {},
          setEffectiveTimeScale() {}, reset() {}, play() {}, stop() {}, crossFadeFrom() {} };
        actions.push(action); return action;
      },
    },
    window: { electronAPI: {} }, THREE: { LoopOnce: 2200, LoopRepeat: 2201 },
    CONFIG: { T_OFFSET: 0.5, TRANSITION_TIME: 0.5 }, isWindowDragging: false,
    loader: { loadAsync: async url => ({ userData: { vrmAnimations: [url] } }) },
    createVRMAnimationClip: data => ({ name: data }), getVRMAUrl: name => name,
    idleClips: new WeakSet(), restoreReactiveHead() {}, performance: { now: () => 0 },
    statusDiv: {}, logger: { info() {}, warn() {}, error() {} },
    setTimeout: callback => { timers.push(callback); },
  });
  vm.runInContext(functions, context);
  return { context, actions, listeners,
    finish(action) { for (const handler of [...listeners]) handler({ action }); },
    async start() { const start = await vm.runInContext("prepareSpeakingAnimation('wave.vrma')", context); start(); await Promise.resolve(); return actions.at(-1); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a during-reply animation returns to the repeating idle loop on its own finished event', async () => {
  const h = harness(), action = await h.start();
  assert.equal(action.loop, 2200);
  h.finish({}); // unrelated clip completion must not restore idle
  await flush();
  assert.equal(h.actions.length, 1);
  h.finish(action);
  await flush();
  assert.equal(h.actions.at(-1).clip.name, 'idle_loop.vrma');
  assert.equal(h.actions.at(-1).loop, 2201);
  assert.equal(h.actions.at(-1).clampWhenFinished, false);
  assert.equal(h.listeners.size, 0);
});

test('superseding a during-reply animation removes its completion handler', async () => {
  const h = harness(), old = await h.start();
  await vm.runInContext("blendToAnimation({name: 'new-animation'}, THREE.LoopOnce)", h.context);
  assert.equal(h.listeners.size, 0);
  h.finish(old);
  await flush();
  assert.equal(h.actions.at(-1).clip.name, 'new-animation');
});

test('an idle load started by clip completion cannot replace a newer animation or drag pose', async () => {
  for (const dragging of [false, true]) {
    const h = harness(), action = await h.start();
    let resolveIdle;
    h.context.loader.loadAsync = () => new Promise(resolve => { resolveIdle = resolve; });
    h.finish(action);
    if (dragging) h.context.isWindowDragging = true;
    else await vm.runInContext("blendToAnimation({name: 'new-animation'}, THREE.LoopOnce)", h.context);
    resolveIdle({ userData: { vrmAnimations: ['idle_loop.vrma'] } });
    await flush();
    assert.equal(h.actions.at(-1).clip.name, dragging ? 'wave.vrma' : 'new-animation');
  }
});
