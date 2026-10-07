import assert from 'node:assert/strict';
import test from 'node:test';
import { setupMusicSwaySettings } from '../electron/music-sway-settings.js';

function harness(saved = 'false') {
  const elements = new Map(['musicSwayToggle','musicSwayStatus','musicSwayPermission'].map(id => [id, {
    checked: false, hidden: true, textContent: '', listeners: {},
    addEventListener(name, cb) { this.listeners[name] = cb; }, removeEventListener(name) { delete this.listeners[name]; }
  }]));
  const calls = [], signals = [], enabledChanges = [], storage = new Map([['music_sway_enabled', saved]]);
  let onSignal, onStatus;
  const dispose = setupMusicSwaySettings({
    api: { setEnabled: async enabled => { calls.push(enabled); return { state: enabled ? 'listening' : 'off' }; },
      onSignal: cb => { onSignal = cb; return () => {}; }, onStatus: cb => { onStatus = cb; return () => {}; }, openPermissionSettings: async () => calls.push('permission') },
    document: { getElementById: id => elements.get(id) }, storage: { getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value) }, onSignal: value => signals.push(value),
    onEnabledChange: enabled => enabledChanges.push(enabled),
  });
  return { elements, calls, signals, enabledChanges, storage, dispose, frame: value => onSignal(value), status: value => onStatus(value) };
}
test('music capture is opt-in and saved settings resume it on the next launch', async () => {
  const off = harness(); assert.deepEqual(off.calls, []);
  const on = harness('true'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(on.calls, [true]);
  assert.deepEqual(on.enabledChanges, [true], 'restore the longer idle spacing on startup');
  assert.equal(on.elements.get('musicSwayToggle').checked, true);
  on.frame({ active: true, intervalMs: 500 });
  assert.match(on.elements.get('musicSwayStatus').textContent, /120 BPM/);
  on.dispose(); off.dispose();
});
test('permission failure clears the toggle, exposes recovery, and off drops late beats', async () => {
  const h = harness('true'); await new Promise(resolve => setImmediate(resolve));
  h.status({ state: 'error', reason: 'Allow system audio' });
  assert.equal(h.elements.get('musicSwayToggle').checked, false);
  assert.equal(h.storage.get('music_sway_enabled'), 'false');
  assert.equal(h.elements.get('musicSwayPermission').hidden, false);
  assert.equal(h.signals.at(-1), null);
  assert.deepEqual(h.enabledChanges, [true, false], 'restore normal idle spacing if capture fails');
  h.frame({ active: true, intervalMs: 500 }); assert.equal(h.signals.at(-1), null);
  h.elements.get('musicSwayPermission').listeners.click();
  assert.equal(h.calls.at(-1), 'permission'); h.dispose();
});

test('a silent capture warning stays visible while keeping capture enabled for music to resume', async () => {
  const h = harness('true'); await new Promise(resolve => setImmediate(resolve));
  h.status({ state: 'listening', warning: 'Check audio access if music is playing' });
  h.frame({ active: false });
  assert.equal(h.elements.get('musicSwayToggle').checked, true);
  assert.equal(h.elements.get('musicSwayStatus').textContent, 'Check audio access if music is playing');
  assert.equal(h.elements.get('musicSwayPermission').hidden, false);
  h.status({ state: 'listening' }); h.frame({ active: true, intervalMs: 500 });
  assert.match(h.elements.get('musicSwayStatus').textContent, /120 BPM/);
  assert.equal(h.elements.get('musicSwayPermission').hidden, true);
  h.dispose();
});
