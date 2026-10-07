import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { completeStandingIdleClip } from '../shared/standing-idle.js';
import { readFileSync } from 'node:fs';
import { AnimationClip, AnimationMixer, NumberKeyframeTrack, Object3D } from 'three';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
function harness({ dragEnabled = true } = {}) {
  const face = new Object3D(); face.angry = 0;
  const values = new Map();
  const context = vm.createContext({
    currentVrm: { expressionManager: { setValue(name, value) {
      values.set(name, value); if (name === 'angry') face.angry = value;
    } } },
    dragExpressionHeld: false, activeFacialExpression: null, blinkSystemEnabled: true,
    currentAction: null, isWindowDragging: false, actionPausedForWindowDrag: null,
    idleClips: new WeakSet(), idleExpressionClips: new WeakSet(), lipSyncSystem: { isTalking: () => false },
    window: { electronAPI: {}, isAnimationEnabled: () => dragEnabled, dispatchEvent() {} },
    logger: { info() {} }, updateHikariState() {}, Event, setTimeout,
  });
  const expressionStart = source.indexOf('    function resetExpressionToNeutral()');
  vm.runInContext(source.slice(expressionStart, source.indexOf('    // RANDOM IDLE SYSTEM', expressionStart)), context);
  const dragStart = source.indexOf('    function setWindowDragging(');
  vm.runInContext(source.slice(dragStart, source.indexOf('    function waitForActionEnd(', dragStart)), context);
  return { context, face, values };
}

test('dragging holds the touch shy expression through release and facial animation tracks until speech', () => {
  const { context, face, values } = harness();
  const mixer = new AnimationMixer(face);
  mixer.clipAction(new AnimationClip('hang-and-idle-face', 1,
    [new NumberKeyframeTrack('.angry', [0, 1], [0, .5])])).play();
  context.setWindowDragging(true);
  assert.equal(context.activeFacialExpression, 'shy');
  assert.equal(face.angry, 1);
  assert.equal(values.get('blink'), 0);
  for (let frame = 0; frame < 120; frame++) {
    if (frame === 30) context.setWindowDragging(false);
    mixer.update(1 / 60);
    assert.ok(face.angry < 1, 'the animation can overwrite the face');
    context.updateDragExpression();
    context.resetExpressionToNeutral(); // Late idle/previous-reply cleanup.
    assert.equal(face.angry, 1);
    assert.equal(context.activeFacialExpression, 'shy');
    assert.equal(context.blinkSystemEnabled, false);
  }
  assert.equal(context.isWindowDragging, false);
  context.releaseDragExpression();
  assert.equal(context.dragExpressionHeld, false);
  assert.equal(face.angry, 0);
  context.applyFacialExpression('surprised');
  context.updateDragExpression();
  assert.equal(values.get('relaxed'), 1, 'the speaking reply can take over the expression');
  assert.equal(context.activeFacialExpression, 'surprised');
  context.resetExpressionToNeutral();
  assert.equal(context.activeFacialExpression, null);
  assert.equal(context.blinkSystemEnabled, true);
});

test('a disabled drag reaction keeps dragging functional without a shy-expression hold', () => {
  const { context, face } = harness({ dragEnabled: false });
  context.setWindowDragging(true);
  assert.equal(context.isWindowDragging, true);
  assert.equal(context.dragExpressionHeld, false);
  assert.equal(face.angry, 0);
  context.setWindowDragging(false);
  assert.equal(context.isWindowDragging, false);
});

test('idle loops and gestures clear stale emotions after every mixer frame without clearing blink, mouth or gaze', () => {
  for (const loop of [true, false]) {
    const { context, face, values } = harness();
    const mixer = new AnimationMixer(face);
    const clip = new AnimationClip(loop ? 'idle_loop' : 'idle_look', 1,
      [new NumberKeyframeTrack('.angry', [0, 1], [.6, .9])]);
    context.currentAction = mixer.clipAction(clip).play();
    (loop ? context.idleClips : context.idleExpressionClips).add(clip);
    context.applyFacialExpression('shy');
    for (const name of ['blink', 'aa', 'lookRight']) values.set(name, .4);
    for (let frame = 0; frame < 120; frame++) {
      mixer.update(1 / 60);
      assert.ok(face.angry > 0, 'idle facial tracks reapply the emotional weight');
      context.updateIdleExpression();
      assert.equal(face.angry, 0);
      assert.equal(context.activeFacialExpression, null);
      assert.equal(context.blinkSystemEnabled, true);
      for (const name of ['blink', 'aa', 'lookRight']) assert.equal(values.get(name), .4);
    }
  }
});

test('idle face cleanup preserves speech, pending reactions, held dragging and non-idle expressions', () => {
  for (const owner of ['speech', 'pending', 'held-drag', 'dragging', 'scripted']) {
    const { context, face } = harness();
    const clip = {};
    context.currentAction = { getClip: () => clip };
    if (owner !== 'scripted') context.idleExpressionClips.add(clip);
    context.applyFacialExpression('shy');
    if (owner === 'speech') context.lipSyncSystem.isTalking = () => true;
    if (owner === 'pending') context.window.isAgentInteractionPending = () => true;
    if (owner === 'held-drag') context.dragExpressionHeld = true;
    if (owner === 'dragging') context.isWindowDragging = true;
    context.updateIdleExpression();
    assert.equal(face.angry, 1, owner);
    assert.equal(context.activeFacialExpression, 'shy', owner);
  }
});

test('returning to idle clears emotions immediately on both a new loop and a reused loop', async () => {
  const { context, face } = harness();
  const mixer = new AnimationMixer(face);
  const clip = new AnimationClip('idle_loop', 1, [new NumberKeyframeTrack('.angry', [0, 1], [.7, .7])]);
  Object.assign(context, {
    currentMixer: mixer, loader: { loadAsync: async () => ({ userData: { vrmAnimations: [{}] } }) },
    getVRMAUrl: value => value, createVRMAnimationClip: () => clip, completeStandingIdleClip, statusDiv: {},
    THREE: { LoopRepeat: 2201 }, updateMusicIdleLoop() {}, getMusicMotionOptions: () => ({}),
    blendToAnimation: async value => { context.currentAction = mixer.clipAction(value).play(); mixer.update(0); },
  });
  const begin = source.indexOf('    async function loadIdleLoop(');
  vm.runInContext(source.slice(begin, source.indexOf('    async function loadVRMA(', begin)), context);
  context.applyFacialExpression('shy');
  assert.equal(await context.loadIdleLoop(), true);
  assert.equal(context.idleExpressionClips.has(clip), true);
  assert.equal(face.angry, 0);
  const action = context.currentAction;
  context.applyFacialExpression('shy');
  assert.equal(await context.loadIdleLoop(), true);
  assert.equal(context.currentAction, action);
  assert.equal(face.angry, 0);

  context.applyFacialExpression('shy');
  assert.equal(await context.loadIdleLoop({}), false, 'stale completion cannot clear a newer expression');
  assert.equal(face.angry, 1);
});

test('random or selected idle clips are registered for neutral expression cleanup', async () => {
  const { context, face } = harness();
  const clip = new AnimationClip('gesture', 1, []);
  Object.assign(context, {
    THREE: { LoopRepeat: 2201 }, CONFIG: { T_OFFSET: .5, TRANSITION_TIME: .5 },
    performance: { now: () => 0 }, getVRMAFileName: url => url.split('/').pop(),
    loader: { loadAsync: async () => ({ userData: { vrmAnimations: [{}] } }) },
    createVRMAnimationClip: () => clip,
    blendToAnimation: async value => { context.currentAction = { getClip: () => value }; },
    setTimeout() {},
  });
  const begin = source.indexOf('    async function startSmoothTransition(');
  vm.runInContext(source.slice(begin, source.indexOf('    // Load and convert the clip', begin)), context);
  context.applyFacialExpression('shy');
  await context.startSmoothTransition('VRMA/idle_look.vrma');
  assert.equal(context.idleExpressionClips.has(clip), true);
  context.updateIdleExpression();
  assert.equal(face.angry, 0);
});
