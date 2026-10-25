import assert from 'node:assert/strict';
import test from 'node:test';
import { MusicBeatDetector } from '../electron/music-beat.js';

test('bass pulses produce alternating beats and learn the actual music tempo', () => {
  const detector = new MusicBeatDetector();
  let signal;
  for (let now = 0; now <= 5000; now += 20) signal = detector.update({ level: .08, bass: now % 500 < 80 ? .08 : .001 }, now);
  assert.equal(signal.beat, 11);
  assert.equal(signal.intervalMs, 500);
});
test('silence and sustained tones produce no repeated invented beats', () => {
  const detector = new MusicBeatDetector();
  for (let now = 0; now < 3000; now += 40) assert.equal(detector.update({ level: 0, bass: 0 }, now).beat, 0);
  let signal;
  for (let now = 3000; now < 8000; now += 40) signal = detector.update({ level: .1, bass: .05 }, now);
  assert.equal(signal.beat, 1);
  assert.equal(signal.intervalMs, null);
});
test('treble alone cannot trigger bass beats and long gaps reset learned tempo', () => {
  const detector = new MusicBeatDetector();
  let signal;
  for (let now = 0; now <= 2000; now += 40) signal = detector.update({ level: .1, bass: .001 }, now);
  assert.equal(signal.beat, 0);
  detector.update({ level: .1, bass: .08 }, 2040);
  signal = detector.update({ level: .1, bass: .08 }, 5000);
  assert.equal(signal.beat, 1);
  assert.equal(signal.intervalMs, null);
});

function pulses(onsets, end = onsets.at(-1)) {
  const detector = new MusicBeatDetector(), signals = [];
  for (let now = 0; now <= end; now += 10) {
    signals.push(detector.update({ level: .05, bass: onsets.some(time => now >= time && now < time + 40) ? .08 : .001 }, now));
  }
  return signals;
}
test('tempo stays steady through jitter, an extra onset and a missed beat', () => {
  const onsets = [0, 500, 1000, 1500, 2000, 2500, 2850, 3000, 3520, 4000, 4490, 5000,
    6000, 6510, 7000, 7500, 8000, 8500, 9000];
  for (const signal of pulses(onsets).filter(signal => signal.updatedAt >= 1500)) {
    assert.ok(Math.abs(signal.intervalMs - 500) < 15, `unstable interval ${signal.intervalMs}`);
  }
});
test('consistent faster and slower tempos replace the old estimate gradually', () => {
  for (const nextInterval of [400, 1000]) {
    const onsets = Array.from({ length: 11 }, (_, i) => i * 500);
    for (let i = 1; i <= 25; i++) onsets.push(5000 + i * nextInterval);
    const signals = pulses(onsets);
    assert.ok(Math.abs(signals.at(-1).intervalMs / nextInterval - 1) <= .03);
    if (nextInterval === 1000) assert.equal(signals.at(-1).intervalMs, 1000, 'a confirmed 60 BPM tempo must finish converging');
    let previous = 500;
    for (const signal of signals.filter(signal => signal.updatedAt >= 5000)) {
      assert.ok(Math.abs(signal.intervalMs / previous - 1) <= .21, 'tempo must not jump immediately');
      previous = signal.intervalMs;
    }
  }
});
test('several seconds of silence retain activity and tempo, while a long stop resets the next song', () => {
  const detector = new MusicBeatDetector();
  for (let now = 0; now <= 2000; now += 20) detector.update({ level: .05, bass: now % 500 < 40 ? .08 : .001 }, now);
  for (let now = 2020; now <= 5000; now += 20) assert.equal(detector.update({ level: 0, bass: 0 }, now).active, true);
  assert.equal(detector.update({ level: .05, bass: .08 }, 5020).intervalMs, 500);
  let quiet;
  for (let now = 5040; now <= 13500; now += 20) {
    quiet = detector.update({ level: 0, bass: 0 }, now);
    if (now >= 9020) assert.equal(quiet.active, false);
  }
  const resumed = detector.update({ level: .05, bass: .08 }, 13520);
  assert.equal(resumed.intervalMs, null);
});
test('jitter around 60 BPM does not keep switching the half-speed boundary', () => {
  const onsets = [0, 1000, 2000, 3000, 4000];
  for (let i = 1; i <= 20; i++) onsets.push(4000 + i * 1000 + (i % 2 ? 20 : 0));
  for (const signal of pulses(onsets).filter(signal => signal.updatedAt >= 3000)) assert.equal(signal.intervalMs, 1000);
});
