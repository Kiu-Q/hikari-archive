import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldState, deriveDesktopActivityState, expireWorldStateFields, mergeWorldStatePatch, sanitizeRendererWorldPatch, serializeWorldStateForAgent } from '../electron/world-state.js';
import { WorldStateStore } from '../electron/world-state-store.js';
import { chooseCharacterBehavior, CharacterBehaviorController } from '../electron/character-behavior.js';

test('world state patches merge without dropping unrelated fields and advance revision', () => {
  const state = createWorldState();
  const next = mergeWorldStatePatch(state, { desktop: { appName: 'Code', activity: { typing: true } } }, 10);
  assert.equal(next.revision, 1);
  assert.equal(next.updatedAt, 10);
  assert.equal(next.desktop.appName, 'Code');
  assert.equal(next.desktop.activity.typing, true);
  assert.equal(next.browser.available, false);
});

test('stale summaries and pointer values are omitted from agent context', () => {
  const state = mergeWorldStatePatch(createWorldState(), { desktop: { appName: 'Code', screen: { lastSummary: 'stale text', summaryAt: 1, available: true }, pointer: { x: 10, y: 20, updatedAt: 1 } } }, 1);
  const fresh = expireWorldStateFields(state, 200_000);
  assert.equal(fresh.desktop.screen.lastSummary, '');
  assert.equal(fresh.desktop.pointer.x, null);
  assert.equal(serializeWorldStateForAgent(state, 200_000).includes('stale text'), false);
});

test('agent context includes a fresh text summary but never exact pointer coordinates', () => {
  const state = mergeWorldStatePatch(createWorldState(), { desktop: {
    appName: 'Visual Studio Code', windowTitle: 'app.js — hikari', contextUpdatedAt: 1000,
    activity: { updatedAt: 1000, lastInputAt: 1000 },
    pointer: { x: 820, y: 440, updatedAt: 1000 },
    screen: { lastSummary: 'Active window: Visual Studio Code — app.js; a typing session was observed.', summaryAt: 1000, summaryStale: false, available: false, visionAvailable: false }
  } }, 1000);
  const serialized = serializeWorldStateForAgent(state, 1100);
  assert.match(serialized, /Visual Studio Code/);
  assert.match(serialized, /a typing session was observed/);
  assert.doesNotMatch(serialized, /820|440/);
});

test('store publishes renderer mirror updates to subscribers', () => {
  const store = new WorldStateStore({ now: () => 12 });
  let observed;
  const unsubscribe = store.subscribe((state) => { observed = state; });
  store.applyPatch({ hikari: { speaking: true } });
  unsubscribe();
  assert.equal(observed.hikari.speaking, true);
  assert.equal(store.getSnapshot().updatedAt, 12);
});

test('renderer patch validation allows only typed Hikari and microphone fields', () => {
  assert.deepEqual(sanitizeRendererWorldPatch({
    hikari: { speaking: true, currentBehavior: 'speaking', attentionTarget: 'user-pointer', appName: 'forbidden', thinking: 'false' },
    desktop: { appName: 'forbidden' }, audio: { microphone: { voiceActive: false, permission: 'granted' } }
  }), { hikari: { speaking: true, currentBehavior: 'speaking', attentionTarget: 'user-pointer' }, audio: { microphone: { voiceActive: false } } });
  const next = mergeWorldStatePatch(createWorldState(), { desktop: { appName: 4, unknown: 'ignored' }, hikari: { speaking: 'false' } }, 10);
  assert.equal(next.desktop.appName, '');
  assert.equal(next.desktop.unknown, undefined);
  assert.equal(next.hikari.speaking, false);
});

test('world state marks activity, context, audio, Hikari, and pointer stale by age', () => {
  const state = mergeWorldStatePatch(createWorldState(), {
    desktop: {
      appName: 'Code', contextUpdatedAt: 1,
      activity: { typing: true, lastInputAt: 1, updatedAt: 1 },
      pointer: { x: 20, y: 30, updatedAt: 1 },
      screen: { changeLevel: 'major', changeAt: 1 }
    },
    audio: { system: { available: true, running: true, updatedAt: 1 } },
    hikari: { speaking: true }
  }, 1);
  const stale = expireWorldStateFields(state, 200_000);
  assert.equal(stale.desktop.contextStale, true);
  assert.equal(stale.desktop.activity.typing, false);
  assert.equal(stale.desktop.activity.stale, true);
  assert.equal(stale.desktop.pointer.x, null);
  assert.equal(stale.desktop.screen.changeLevel, 'unknown');
  assert.equal(stale.audio.system.stale, true);
  assert.equal(stale.hikari.speaking, false);
});

test('store snapshots and subscriber values cannot mutate its internal state', () => {
  let now = 9;
  const store = new WorldStateStore({ now: () => now });
  const unsubscribe = store.subscribe((state) => { state.hikari.speaking = false; });
  store.applyPatch({ hikari: { speaking: true } });
  unsubscribe();
  const snapshot = store.getSnapshot();
  snapshot.hikari.speaking = false;
  assert.equal(store.getSnapshot().hikari.speaking, true);
  now = 70_010;
  assert.equal(store.getSnapshot().hikari.stale, true);
  assert.equal(store.getSnapshot().hikari.speaking, false);
});

test('aggregated activity includes typing and measured idle time', () => {
  assert.deepEqual(deriveDesktopActivityState({ typingSession: {}, lastInputAt: 10 }, 2000), {
    typing: true, scrolling: false, clicking: false, lastInputAt: 10, idleForMs: 1990, idle: false
  });
  assert.equal(deriveDesktopActivityState({ lastInputAt: 1 }, 60_001).idle, true);
});

test('behavior arbitration favors direct interaction over passive state', () => {
  assert.equal(chooseCharacterBehavior({ hikari: { dragging: true, speaking: true }, desktop: { activity: { typing: true } } }), 'dragging');
  assert.equal(chooseCharacterBehavior({ hikari: { speaking: true, listening: true } }), 'speaking');
});

test('behavior controller applies a minimum hold before downgrading', () => {
  let now = 0; const applied = [];
  const controller = new CharacterBehaviorController({ now: () => now, minHoldMs: 500, applyBehavior: (value) => applied.push(value) });
  controller.update({ hikari: { speaking: true } });
  now = 100; assert.equal(controller.update({ desktop: { activity: { typing: true } } }), 'speaking');
  now = 1000; assert.equal(controller.update({ desktop: { activity: { typing: true } } }), 'typing');
  assert.deepEqual(applied, ['speaking', 'typing']);
});
