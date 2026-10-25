import assert from 'node:assert/strict';
import test from 'node:test';

import { ReplyVolumeService } from '../electron/reply-volume-main.js';

function fakeVolumeHelper({ mediaPlaying = true, deviceId = 88, scalar = 0.4 } = {}) {
  const calls = [];
  let current = { deviceId, scalar };
  const execute = async (_helperPath, args) => {
    calls.push([...args]);
    if (args.length === 0) return { stdout: mediaPlaying ? '1' : '0' };
    if (args[0] === 'volume-get') {
      return { stdout: `${current.deviceId} ${current.scalar}` };
    }
    if (args[0] === 'volume-ramp') {
      current = { deviceId: Number(args[1]), scalar: Number(args[2]) };
      return { stdout: '' };
    }
    throw new Error(`Unexpected helper command: ${args[0]}`);
  };
  return {
    calls,
    execute,
    get current() { return { ...current }; },
    set current(value) { current = { ...value }; }
  };
}

test('uses 90% voice level with no media and does not write system volume', async () => {
  const helper = fakeVolumeHelper({ mediaPlaying: false });
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: helper.execute });

  const session = await service.begin();
  await service.end(session.sessionId);

  assert.equal(session.voiceGain, 0.9);
  assert.equal(session.mediaDucked, false);
  assert.deepEqual(helper.calls, [[]]);
  assert.deepEqual(helper.current, { deviceId: 88, scalar: 0.4 });
});

test('lowers voice during media without changing system volume when gain cannot be boosted', async () => {
  const helper = fakeVolumeHelper();
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: helper.execute });

  const session = await service.begin({ canBoost: false });
  await service.end(session.sessionId);

  assert.equal(session.voiceGain, 0.45);
  assert.equal(session.mediaDucked, false);
  assert.equal(helper.calls.some(([command]) => command === 'volume-get' || command === 'volume-ramp'), false);
  assert.deepEqual(helper.current, { deviceId: 88, scalar: 0.4 });
});

test('ducks media to 70%, lowers voice to 45%, and smoothly restores media', async () => {
  const helper = fakeVolumeHelper();
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: helper.execute });

  const session = await service.begin();
  assert.ok(Math.abs(session.voiceGain - (0.45 / 0.7)) < 1e-12);
  assert.equal(session.mediaDucked, true);
  assert.deepEqual(helper.current, { deviceId: 88, scalar: 0.27999999999999997 });

  await service.end(session.sessionId);

  assert.deepEqual(helper.calls.filter(([command]) => command === 'volume-ramp'), [
    ['volume-ramp', '88', '0.27999999999999997', '350'],
    ['volume-ramp', '88', '0.4', '350']
  ]);
  assert.deepEqual(helper.current, { deviceId: 88, scalar: 0.4 });
});

test('preserves a user volume change and a newly selected output device', async (t) => {
  for (const change of [
    { label: 'volume change', value: { deviceId: 88, scalar: 0.31 } },
    { label: 'device change', value: { deviceId: 99, scalar: 0.2 } }
  ]) {
    await t.test(change.label, async () => {
      const helper = fakeVolumeHelper();
      const service = new ReplyVolumeService({ helperPath: '/helper', execute: helper.execute });

      const session = await service.begin();
      helper.current = change.value;
      await service.end(session.sessionId);

      assert.equal(helper.calls.filter(([command]) => command === 'volume-ramp').length, 1);
      assert.deepEqual(helper.current, change.value);
    });
  }
});

test('retains quieter voice and clears duck state when helper ramp fails', async () => {
  const helper = fakeVolumeHelper();
  const execute = async (...args) => {
    if (args[1][0] === 'volume-ramp') throw new Error('helper unavailable');
    return helper.execute(...args);
  };
  const service = new ReplyVolumeService({ helperPath: '/helper', execute });

  const session = await service.begin();

  assert.equal(session.voiceGain, 0.45);
  assert.equal(session.mediaDucked, false);
  assert.equal(service.active?.sessionId, session.sessionId);
  assert.equal(service.active?.duck, null);
  await service.end(session.sessionId);
  assert.equal(service.active, null);
});

test('media stopped before the next reply restores the normal voice level', async () => {
  let playing = true;
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: async () => ({ stdout: playing ? '1' : '0' }) });
  const first = await service.begin({ canBoost: false });
  assert.equal(first.voiceGain, 0.45);
  await service.end(first.sessionId);
  playing = false;
  const next = await service.begin({ canBoost: false });
  assert.equal(next.voiceGain, 0.9);
  await service.end(next.sessionId);
});

test('unavailable media detection preserves normal voice without a stuck session', async () => {
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: async () => { throw new Error('Unavailable'); } });
  const session = await service.begin();
  assert.equal(session.voiceGain, 0.9);
  await service.end(session.sessionId);
  assert.equal(service.active, null);
});

test('voice output excluded by the media detector does not lower its own volume', async () => {
  const helper = fakeVolumeHelper({ mediaPlaying: true });
  const service = new ReplyVolumeService({ helperPath: '/helper', execute: helper.execute, mediaPlaying: async () => false });
  const session = await service.begin();
  assert.equal(session.voiceGain, 0.9);
  assert.deepEqual(helper.calls, []);
  await service.end(session.sessionId);
});
