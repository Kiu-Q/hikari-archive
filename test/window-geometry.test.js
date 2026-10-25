import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fitWindowToWorkArea, constrainWindow, keepWindowOnScreen } from '../electron/window-geometry.js';

const area = { x: 0, y: 25, width: 1440, height: 835 };
function contained(bounds, workArea = area) {
  assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
}

test('dragging clamps every edge using the entire window, including hidden panel space', () => {
  for (const size of [{ width: 300, height: 450 }, { width: 600, height: 800 }]) {
    for (const x of [-10000, 100, 10000]) {
      for (const y of [-10000, 100, 10000]) {
        const fitted = fitWindowToWorkArea({ x, y, ...size }, area);
        contained(fitted);
        assert.equal(fitted.width, size.width);
        assert.equal(fitted.height, size.height);
      }
    }
  }
});

test('large zoom fits proportionally inside the work area without covering Dock or menu bar', () => {
  const fitted = fitWindowToWorkArea({ x: -50, y: -50, width: 1500, height: 2250 }, area);
  contained(fitted);
  assert.equal(fitted.height, area.height);
  assert.ok(Math.abs(fitted.width / fitted.height - 2 / 3) < 0.002);
});

test('secondary displays can have negative coordinates and different work areas', () => {
  const secondary = { x: -1920, y: -1055, width: 1920, height: 1030 };
  const fitted = fitWindowToWorkArea({ x: -3000, y: 200, width: 300, height: 450 }, secondary);
  contained(fitted, secondary);
  assert.deepEqual(fitted, { x: -1920, y: -475, width: 300, height: 450 });
});

test('invalid dimensions and non-finite coordinates are rejected', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => fitWindowToWorkArea({ x: bad, y: 0, width: 600, height: 900 }, area), TypeError);
  }
  assert.throws(() => fitWindowToWorkArea({ x: 0, y: 0, width: 0, height: 900 }, area), TypeError);
});

test('native moves, resizes and display changes stay constrained without recursive mutations', () => {
  const window = new EventEmitter(), screen = new EventEmitter();
  let bounds = { x: -100, y: -100, width: 600, height: 900 }, mutations = 0;
  let workArea = { ...area };
  window.isDestroyed = () => false;
  window.getBounds = () => ({ ...bounds });
  window.setBounds = value => { bounds = { ...value }; mutations++; window.emit('move'); window.emit('resize'); };
  screen.getDisplayMatching = () => ({ workArea });
  keepWindowOnScreen(window, screen);
  contained(bounds);
  assert.equal(mutations, 1);
  const result = constrainWindow(window, screen, { ...bounds, x: 5000, y: 5000 });
  contained(result);
  assert.deepEqual(result, bounds);
  assert.equal(mutations, 2);
  bounds.x = -500; window.emit('move'); contained(bounds);
  bounds.height = 2000; window.emit('resize'); contained(bounds);
  workArea = { x: -1280, y: 25, width: 1280, height: 700 };
  screen.emit('display-removed'); contained(bounds, workArea);
  window.emit('closed');
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
});
