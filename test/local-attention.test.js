import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAttentionController, localMotionAllowed } from '../electron/local-attention.js';
import { WorldStateStore } from '../electron/world-state-store.js';

function fixture() {
  let time = 1000;
  const now = () => time;
  const controller = new LocalAttentionController({ now });
  const store = new WorldStateStore({ now });
  return { controller, store, advance: ms => { time += ms; }, now,
    read: options => controller.update(store.getSnapshot(), options) };
}
test('cursor decays without an IPC update; stale coordinates never remain latched', () => {
  const f = fixture();
  f.store.applyPatch({ desktop: { pointer: { x: 30, y: 50, updatedAt: f.now(), stale: false } } });
  assert.equal(f.read().attention, 'cursor');
  f.advance(2100); assert.equal(f.read().attention, 'neutral');
});
test('typing settles toward screen, then returns to neutral on stop or expiry', () => {
  const f = fixture();
  f.store.applyPatch({ desktop: { activity: { typing: true, updatedAt: f.now() } } });
  assert.equal(f.read().attention, 'neutral');
  f.advance(300); assert.equal(f.read().attention, 'screen');
  f.advance(500); f.store.applyPatch({ desktop: { activity: { typing: false } } });
  assert.equal(f.read().attention, 'neutral');
  f.store.applyPatch({ desktop: { activity: { typing: true, updatedAt: f.now() } } });
  f.read(); f.advance(300); assert.equal(f.read().attention, 'screen');
  f.advance(3100); assert.equal(f.read().attention, 'neutral');
});
test('speaking wins over thinking and typing, while dragging has exclusive ownership', () => {
  const f = fixture();
  f.store.applyPatch({ hikari: { speaking: true, thinking: true } });
  assert.equal(f.read().attention, 'user');
  f.advance(500); f.store.applyPatch({ hikari: { speaking: false } });
  assert.equal(f.read().attention, 'thinking');
  f.store.applyPatch({ hikari: { dragging: true } });
  assert.equal(f.read().behavior, 'dragging');
});
test('window changes give one brief shift; heartbeat metadata does not retrigger', () => {
  const f = fixture();
  f.store.applyPatch({ desktop: { appName: 'A', contextUpdatedAt: f.now() } }); f.read();
  f.store.applyPatch({ desktop: { appName: 'B' } }); assert.equal(f.read().attention, 'screen');
  f.advance(1500); assert.equal(f.read().attention, 'neutral');
  f.store.applyPatch({ desktop: { contextUpdatedAt: f.now() } }); assert.equal(f.read().attention, 'neutral');
});
test('screen changes expire and cooldown prevents repeated shifts', () => {
  const f = fixture(); f.read();
  f.store.applyPatch({ desktop: { screen: { changeAt: f.now(), changeLevel: 'major', changeStale: false } } });
  assert.equal(f.read().attention, 'screen');
  f.advance(1500); f.store.applyPatch({ desktop: { screen: { changeAt: f.now() } } });
  assert.equal(f.read().attention, 'neutral');
});
test('idle ages locally and active input leaves relaxed idle', () => {
  const f = fixture(); f.store.applyPatch({ desktop: { activity: { lastInputAt: f.now() } } });
  f.advance(60001); assert.equal(f.read().behavior, 'calm_idle');
  f.advance(240000); assert.equal(f.read().behavior, 'deep_idle');
  f.store.applyPatch({ desktop: { pointer: { x: 1, y: 1, updatedAt: f.now(), stale: false }, activity: { lastInputAt: f.now() } } });
  assert.equal(f.read().attention, 'cursor');
});
test('desktop cursor opt-out preserves local canvas tracking with its own expiry', () => {
  const f = fixture();
  f.store.applyPatch({ desktop: { pointer: { x: 1, y: 1, updatedAt: f.now(), stale: false } } });
  assert.equal(f.read({ cursorEnabled: false }).attention, 'neutral');
  assert.equal(f.read({ cursorEnabled: false, localPointer: { x: 10, y: 20, updatedAt: f.now(), local: true } }).attention, 'cursor');
});
test('all scripted, transition, drag and direct owners suppress local motion', () => {
  assert.equal(localMotionAllowed(), true);
  for (const owner of ['scripted', 'transitioning', 'dragging', 'direct']) assert.equal(localMotionAllowed({ [owner]: true }), false);
  assert.equal(localMotionAllowed({ scripted: false }), true);
});
