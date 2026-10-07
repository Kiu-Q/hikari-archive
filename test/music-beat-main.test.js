import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MusicBeatService } from '../electron/music-beat-main.js';

function harness(options = {}) {
  const children = [], signals = [], statuses = [], launches = [];
  let time = 0;
  const spawn = (_path, args) => {
    launches.push(args);
    const child = new EventEmitter();
    for (const name of ['stdout', 'stderr', 'stdin']) {
      child[name] = new EventEmitter(); child[name].setEncoding = () => {};
    }
    child.stdin.write = () => {}; child.stdin.end = () => {};
    child.kill = () => { queueMicrotask(() => child.emit('close')); };
    children.push(child); return child;
  };
  const service = new MusicBeatService({ executable: '/helper', spawn, available: () => true,
    excludePids: () => [123,456], now: () => time, onSignal: value => signals.push(value), onStatus: value => statuses.push(value), ...options });
  return { service, children, signals, statuses, launches,
    frame: (frame, child = children.at(-1)) => child.stdout.emit('data', JSON.stringify(frame) + '\n'),
    time: value => { time = value; } };
}

test('one local capture starts once, parses split JSON, and releases the signal on stop', async () => {
  const h = harness();
  const pending = h.service.start(); assert.equal(h.service.start(), pending);
  assert.deepEqual(h.launches[0], ['123','456']);
  h.children[0].stdout.emit('data', '{"type":"rea');
  h.children[0].stdout.emit('data', 'dy"}\n');
  assert.equal((await pending).state, 'listening');
  h.frame({ type: 'frame', level: .1, bass: .08 });
  assert.equal(h.signals.at(-1).beat, 1);
  h.service.stop(); assert.equal(h.signals.at(-1).active, false);
  h.frame({ type: 'frame', level: .1, bass: .08 }, h.children[0]);
  assert.equal(h.signals.at(-1).active, false);
});
test('denied capture returns an actionable error and can be retried', async () => {
  const h = harness();
  const pending = h.service.start();
  h.frame({ type: 'error', stage: 'tap', status: 1 });
  assert.equal((await pending).state, 'error');
  assert.match(h.service.status.reason, /System Audio Recording/);
  const retry = h.service.start(); h.frame({ type: 'ready' });
  assert.equal((await retry).state, 'listening'); h.service.stop();
});
test('rapid stop/start and late callbacks cannot disable the replacement capture', async () => {
  const h = harness();
  const first = h.service.start(), old = h.children[0];
  h.service.stop(); const second = h.service.start();
  assert.equal((await first).state, 'off');
  old.emit('close'); h.frame({ type: 'error', stage: 'tap' }, old);
  h.frame({ type: 'ready' }); assert.equal((await second).state, 'listening');
  assert.equal(h.service.child, h.children[1]); h.service.stop();
});
test('capture that never becomes ready times out without keeping a child alive', async () => {
  const h = harness({ startupTimeoutMs: 5 });
  assert.equal((await h.service.start()).state, 'error');
  assert.equal(h.service.child, null);
});
test('silent capture offers permission guidance without disabling paused music', async () => {
  const h = harness({ silentTimeoutMs: 100, mediaPlaying: async () => true });
  const start = h.service.start(); h.frame({ type: 'ready' }); await start;
  h.frame({ type: 'frame', level: 0, bass: 0 }); h.time(101);
  h.frame({ type: 'frame', level: 0, bass: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.status.state, 'listening'); assert.ok(h.service.child);
  assert.match(h.service.status.warning, /permission/);
  h.frame({ type: 'frame', level: .1, bass: .08 });
  assert.equal(h.service.status.warning, undefined);
  h.service.stop();
});
