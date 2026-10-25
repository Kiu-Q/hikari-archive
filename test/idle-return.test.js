import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IdleReturnTracker } from '../electron/idle-return.js';
import { awarenessConfig } from '../electron/awareness-config.js';
import { AwarenessController, buildAwarenessPrompt } from '../electron/desktop-awareness-renderer.js';
import { formatHistoryChunk } from '../electron/speech-segments.js';

test('return requires 90 seconds quiet, fires once, and respects the five-minute cooldown', () => {
  let now = 1000;
  const tracker = new IdleReturnTracker({ ...awarenessConfig.idleReturn, now: () => now });
  now += 89999;
  assert.equal(tracker.record('typing'), null);
  now += 90000;
  assert.deepEqual(tracker.record('clicking'), { idleDurationMs: 90000, inputType: 'clicking', resumedAt: now, eventCount: 1 });
  assert.equal(tracker.record('typing'), null);
  now += 90000; assert.equal(tracker.record('scrolling'), null);
  now += 210000; assert.equal(tracker.record('typing').idleDurationMs, 210000);
  tracker.reset();
  assert.equal(tracker.record('clicking'), null, 'enabling awareness does not immediately greet');
});

test('ongoing input resets quiet time and the idle threshold cannot be less than a minute', () => {
  let now = 0;
  const tracker = new IdleReturnTracker({ minimumIdleMs: 1, now: () => now });
  for (const input of ['typing', 'clicking', 'scrolling']) {
    now += 59000; assert.equal(tracker.record(input), null);
  }
  now += 60000;
  assert.equal(tracker.record('typing').idleDurationMs, 60000);
});

test('real keyboard, click and scroll handlers emit return candidates without screen capture', async () => {
  const source = readFileSync(new URL('../electron/desktop-awareness-main.js', import.meta.url), 'utf8');
  const methods = source.slice(source.indexOf('  recordInputActivity('), source.indexOf('  scheduleContextInspection('));
  for (const [method, input] of [['recordKeyboardActivity', 'typing'], ['recordClickActivity', 'clicking'], ['recordWheelActivity', 'scrolling']]) {
    let now = 1000;
    const emitted = [];
    const context = vm.createContext({
      Date: class extends Date { static now() { return now; } },
      createId: () => 'return-event', publicContext: context => context,
      setTimeout: () => 1, clearTimeout() {},
    });
    const Service = vm.runInContext(`class Service { ${methods} }\nService`, context);
    const service = new Service();
    Object.assign(service, {
      enabled: true, config: awarenessConfig, idleReturnTracker: new IdleReturnTracker({ ...awarenessConfig.idleReturn, now: () => now }),
      getActiveContext: async () => ({ appName: 'Editor' }), isHikariContext: () => false,
      isDirectInteractionSuppressed: () => false, offerCandidate: candidate => emitted.push(candidate),
      scheduleContextInspection() {}, debug() {},
    });
    now += 90000;
    service[method]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].trigger, 'idle_return');
    assert.equal(emitted[0].activity.inputType, input);
    assert.equal(emitted[0].priority, 'important');
    assert.equal(emitted[0].visualChange, null);
    service[method]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(emitted.length, 1);
    service.enabled = false;
    now += 300000; service[method]();
    assert.equal(emitted.length, 1);
  }
});

test('welcome-back guidance uses observed input and shared speech protocol without claiming an absence', () => {
  const prompt = buildAwarenessPrompt({ trigger: 'idle_return', activity: { idleDurationMs: 90000, inputType: 'clicking' } });
  assert.match(prompt, /Quiet period before resumed input: 90s/);
  assert.match(prompt, /short, warm welcome-back greeting/);
  assert.match(prompt, /shared bilingual response/);
  assert.match(prompt, /Do not claim the user physically left/);
});

test('return candidates are analyzed once and obey the Environment Reactions opt-out', async () => {
  let calls = 0, reactions = true;
  const controller = new AwarenessController({ logger: { info() {} }, reactionsEnabled: () => reactions });
  controller.enabled = true;
  controller.analyzeCandidate = async () => { calls++; };
  const candidate = { trigger: 'idle_return', timestamp: Date.now(), priority: 'important', activity: {}, context: { appName: 'Editor' } };
  await controller.considerCandidate(candidate);
  assert.equal(calls, 1);
  reactions = false;
  await controller.considerCandidate(candidate);
  assert.equal(calls, 1);
});

test('history strips only trailing punctuation while preserving punctuation inside phrases and emoji', () => {
  assert.equal(formatHistoryChunk('早晨，老師！ 😊'), '早晨，老師😊');
  assert.equal(formatHistoryChunk('「返嚟啦！」👩🏽‍💻'), '「返嚟啦」👩🏽‍💻');
  assert.equal(formatHistoryChunk('版本 3.14。'), '版本 3.14');
  assert.equal(formatHistoryChunk('好呀！1️⃣🇭🇰'), '好呀1️⃣🇭🇰');
});
