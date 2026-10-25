import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D } from 'three';
import { MusicSway } from '../electron/music-sway.js';

function model() {
  const bones = { spine: new Object3D(), chest: new Object3D(), head: new Object3D(), hips: new Object3D() };
  for (const bone of Object.values(bones)) bone.rotation.set(.1, .2, .3);
  return { bones, vrm: { humanoid: { getNormalizedBoneNode: name => bones[name] } } };
}
const signal = (now, intervalMs = 500) => ({ active: true, updatedAt: now,
  lastBeatAt: Math.floor(now / intervalMs) * intervalMs, intervalMs, beat: 8 + Math.floor(now / intervalMs) });
test('wider six-degree sway only affects spine and chest, restoring the original pose exactly', () => {
  const { bones, vrm } = model();
  const bases = Object.fromEntries(Object.entries(bones).map(([name, bone]) => [name, bone.quaternion.clone()]));
  const sway = new MusicSway();
  assert.equal(sway.maxAngle, 6 * Math.PI / 180);
  for (let now = 0; now < 2000; now += 16) {
    sway.restore(); sway.update(vrm, signal(now), { enabled: true, now });
    assert.ok(bones.spine.quaternion.angleTo(bases.spine) + bones.chest.quaternion.angleTo(bases.chest) <= 6 * Math.PI / 180 + .00001);
    assert.ok(bones.head.quaternion.equals(bases.head)); assert.ok(bones.hips.quaternion.equals(bases.hips));
  }
  assert.ok(bones.chest.quaternion.angleTo(bases.chest) > .01);
  sway.restore();
  for (const [name, bone] of Object.entries(bones)) assert.ok(bone.quaternion.equals(bases[name]));
});
test('sway uses four beats above 120 BPM, two above 60 BPM, and one at 60 BPM or below', () => {
  for (const interval of [1500, 1000, 750, 500, 400, 300]) {
    const { vrm } = model(), sway = new MusicSway();
    const sideDuration = interval * (interval < 500 ? 4 : interval < 1000 ? 2 : 1);
    for (let now = 0; now <= sideDuration * 2; now += 10) {
      sway.restore(); sway.update(vrm, signal(now, interval), { enabled: true, delta: .01, now });
      if (now === sideDuration / 2) assert.ok(sway.angle > 0);
      if (now === sideDuration) {
        assert.ok(Math.abs(sway.phase - Math.PI) < .00001);
        assert.ok(sway.angle < -.7 * sway.maxAngle);
      }
    }
    assert.ok(sway.angle > .7 * sway.maxAngle);
  }
});
test('uneven and missed onsets never reset the continuous swing position', () => {
  const { vrm } = model(), reference = new MusicSway(), noisy = new MusicSway();
  for (let now = 0; now <= 5000; now += 10) {
    reference.restore(); reference.update(vrm, signal(now), { enabled: true, delta: .01, now });
    reference.restore();
    const data = now === 0 ? signal(now) : { ...signal(now), beat: Math.floor(now / 310), lastBeatAt: now - 70 };
    noisy.restore(); noisy.update(vrm, data, { enabled: true, delta: .01, now });
    assert.ok(Math.abs(noisy.angle - reference.angle) < 1e-12);
  }
});
test('small tempo measurement errors do not accumulate into drift during long playback', () => {
  const { vrm } = model(), sway = new MusicSway();
  let accumulated = 0, previous = 0;
  for (let now = 0; now <= 60000; now += 10) {
    sway.restore(); sway.update(vrm, { ...signal(now, 400), intervalMs: 392 }, { enabled: true, delta: .01, now });
    accumulated += (sway.phase - previous + 2 * Math.PI) % (2 * Math.PI);
    previous = sway.phase;
  }
  assert.ok(Math.abs(accumulated - 60000 * Math.PI / (400 * 4)) < .5, 'motion should remain aligned with the actual 150-BPM beats');
});
test('tempo changes preserve phase and ease the motion rate, including the 60-BPM boundary', () => {
  const { vrm } = model(), sway = new MusicSway();
  let previousRate, previousAngle;
  for (let now = 0; now <= 9000; now += 10) {
    const interval = now < 2000 ? 500 : 1200;
    const data = now < 2000 ? signal(now) : { ...signal(now, interval),
      lastBeatAt: 2000 + Math.floor((now - 2000) / interval) * interval, beat: 12 + Math.floor((now - 2000) / interval) };
    sway.restore(); sway.update(vrm, data, { enabled: true, delta: .01, now });
    if (previousRate !== undefined) {
      assert.ok(Math.abs(sway.rate - previousRate) < .025);
      if (now > 1000) assert.ok(Math.abs(sway.angle - previousAngle) < .004);
    }
    previousRate = sway.rate; previousAngle = sway.angle;
  }
  assert.ok(Math.abs(sway.rate - Math.PI / 1.2) < .02);
  for (let now = 9010; now < 12000; now += 10) {
    sway.restore(); sway.update(vrm, { ...signal(now), active: false }, { enabled: true, delta: .01, now });
  }
  assert.ok(Math.abs(sway.angle) < .00001);
  assert.equal(sway.phase, null);
});
test('touch/reply interruption and resumption fade smoothly without losing the music clock', () => {
  const { vrm } = model(), sway = new MusicSway();
  let lastAngle = 0, heldPhase;
  for (let now = 0; now <= 6000; now += 10) {
    const blocked = now >= 2200 && now < 4000;
    sway.restore(); sway.update(vrm, signal(now), { enabled: true, blocked, delta: .01, now });
    assert.ok(Math.abs(sway.angle - lastAngle) < .005, 'an interaction must not snap the torso to neutral');
    if (now === 2200) { assert.ok(Math.abs(sway.angle) > .02); heldPhase = sway.phase; }
    if (now === 3990) {
      assert.ok(Math.abs(sway.angle) < .0001);
      assert.notEqual(sway.phase, heldPhase, 'the beat clock keeps running while waiting/speaking');
    }
    if (now === 4010) assert.ok(sway.weight < .1, 'returning from speech must fade in');
    lastAngle = sway.angle;
  }
  assert.ok(sway.weight > .99);
});
test('small jitter at the 60/120 BPM boundaries cannot flip the speed divider every beat', () => {
  for (const [interval, expected] of [[1000, 1], [500, 2]]) {
    const { vrm } = model(), sway = new MusicSway();
    for (let now = 0; now <= 8000; now += 10) {
      const beat = Math.floor(now / interval);
      const measured = now === 0 ? interval : interval + (beat % 2 ? -1 : 1);
      sway.restore(); sway.update(vrm, { ...signal(now, interval), intervalMs: measured }, { enabled: true, delta: .01, now });
      assert.equal(sway.divider, expected);
    }
  }
});
test('stale capture, an unknown tempo, disabled setting and exclusive motion cannot produce sway', () => {
  for (const [data, options] of [[signal(0), { enabled: true, now: 2000 }],
    [{ ...signal(0), intervalMs: null }, { enabled: true, now: 0 }],
    [signal(0), { enabled: false, now: 0 }], [signal(0), { enabled: true, blocked: true, now: 0 }]]) {
    const { bones, vrm } = model(), before = bones.spine.quaternion.clone(), sway = new MusicSway();
    sway.update(vrm, data, options);
    assert.equal(sway.angle, 0); assert.ok(before.equals(bones.spine.quaternion));
  }
});
