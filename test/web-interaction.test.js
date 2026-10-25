import assert from 'node:assert/strict';
import test from 'node:test';

import { attachWebTouchInteraction } from '../shared/web-interaction.js';

class FakeCanvas extends EventTarget {
  captures = new Set();

  setPointerCapture(pointerId) {
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.captures.delete(pointerId);
  }

  pointer(type, values = {}) {
    const event = new Event(type);
    Object.assign(event, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 0,
      clientY: 0,
      ...values
    });
    this.dispatchEvent(event);
  }
}

function makeHarness() {
  const canvas = new FakeCanvas();
  const calls = { look: [], touch: [], end: 0 };
  const interaction = attachWebTouchInteraction({
    element: canvas,
    onLook: (...args) => calls.look.push(args),
    onTouch: (...args) => calls.touch.push(args),
    onEnd: () => { calls.end += 1; }
  });
  return { canvas, calls, interaction };
}

test('single touch drag updates gaze, taps once, captures pointer, and ends outside canvas', () => {
  const { canvas, calls } = makeHarness();
  canvas.pointer('pointerdown', { clientX: 20, clientY: 30 });
  assert.equal(canvas.hasPointerCapture(1), true);
  canvas.pointer('pointermove', { clientX: 25, clientY: 45 });
  // Pointer capture retargets the outside release back to this canvas.
  canvas.pointer('pointerup', { clientX: 250, clientY: 450 });
  canvas.pointer('lostpointercapture');

  assert.deepEqual(calls.look, [[20, 30, true], [25, 45, true]]);
  assert.deepEqual(calls.touch, [[20, 30]]);
  assert.equal(calls.end, 1);
  assert.equal(canvas.hasPointerCapture(1), false);
});

test('mouse events and a secondary-only pointer do not start a touch gesture', () => {
  const { canvas, calls } = makeHarness();
  canvas.pointer('pointerdown', { pointerType: 'mouse', clientX: 1, clientY: 2 });
  canvas.pointer('pointermove', { pointerType: 'mouse', clientX: 3, clientY: 4 });
  canvas.pointer('pointerup', { pointerType: 'mouse' });
  canvas.pointer('pointerdown', { pointerId: 2, isPrimary: false, clientX: 5, clientY: 6 });
  canvas.pointer('pointermove', { pointerId: 2, isPrimary: false, clientX: 7, clientY: 8 });
  canvas.pointer('pointerup', { pointerId: 2, isPrimary: false });

  assert.deepEqual(calls, { look: [], touch: [], end: 0 });
  assert.equal(canvas.captures.size, 0);
});

test('second finger ends gaze and suppresses all input until every pointer is lifted', () => {
  const { canvas, calls } = makeHarness();
  canvas.pointer('pointerdown', { pointerId: 11, clientX: 10, clientY: 20 });
  canvas.pointer('pointerdown', { pointerId: 12, isPrimary: false, clientX: 30, clientY: 40 });
  canvas.pointer('pointermove', { pointerId: 11, clientX: 15, clientY: 25 });
  canvas.pointer('pointerup', { pointerId: 12, isPrimary: false });
  canvas.pointer('pointermove', { pointerId: 11, clientX: 16, clientY: 26 });
  assert.equal(calls.end, 1);
  assert.deepEqual(calls.touch, [[10, 20]]);
  assert.deepEqual(calls.look, [[10, 20, true]]);

  canvas.pointer('pointerup', { pointerId: 11 });
  canvas.pointer('pointerdown', { pointerId: 13, clientX: 50, clientY: 60 });
  assert.deepEqual(calls.look, [[10, 20, true], [50, 60, true]]);
  assert.deepEqual(calls.touch, [[10, 20], [50, 60]]);
  assert.equal(calls.end, 1);
});

test('pointercancel and unexpected lost capture end an active gesture once', () => {
  const { canvas, calls } = makeHarness();
  canvas.pointer('pointerdown', { pointerId: 21 });
  canvas.pointer('pointercancel', { pointerId: 21 });
  canvas.pointer('lostpointercapture', { pointerId: 21 });
  canvas.pointer('pointerdown', { pointerId: 22, pointerType: 'pen', clientX: 9, clientY: 4 });
  canvas.pointer('lostpointercapture', { pointerId: 22, pointerType: 'pen' });

  assert.equal(calls.end, 2);
  assert.deepEqual(calls.touch, [[0, 0], [9, 4]]);
});

test('dispose removes listeners, releases capture, and resets an active gesture', () => {
  const { canvas, calls, interaction } = makeHarness();
  canvas.pointer('pointerdown', { pointerId: 31 });
  interaction.dispose();
  interaction.dispose();
  canvas.pointer('pointermove', { pointerId: 31, clientX: 99, clientY: 99 });
  canvas.pointer('pointerup', { pointerId: 31 });
  canvas.pointer('pointerdown', { pointerId: 32, clientX: 1, clientY: 2 });

  assert.equal(calls.end, 1);
  assert.deepEqual(calls.look, [[0, 0, true]]);
  assert.deepEqual(calls.touch, [[0, 0]]);
  assert.equal(canvas.captures.size, 0);
});


test('a finger can enter the model after touching the background, reacting only once', () => {
  const canvas = new FakeCanvas();
  let hits = 0, probes = 0;
  attachWebTouchInteraction({
    element: canvas,
    onLook() {}, onEnd() {},
    onTouch(x) { probes++; if (x < 50) return false; hits++; return true; }
  });
  canvas.pointer('pointerdown', { clientX: 10 });
  canvas.pointer('pointermove', { clientX: 30 });
  canvas.pointer('pointermove', { clientX: 70 });
  canvas.pointer('pointermove', { clientX: 80 });
  assert.equal(hits, 1);
  assert.equal(probes, 3);
});
