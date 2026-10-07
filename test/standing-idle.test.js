import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, AnimationMixer, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { completeStandingIdleClip } from '../shared/standing-idle.js';
import { MusicSway } from '../electron/music-sway.js';

function model() {
    const root = new Object3D(), bones = {};
    for (const name of ['hips', 'spine', 'chest', 'leftUpperArm', 'leftUpperLeg']) {
        const bone = new Object3D(); bone.name = name; root.add(bone); bones[name] = bone;
    }
    bones.hips.position.y = 0.7;
    const rest = Object.fromEntries(Object.entries(bones).map(([name, bone]) => [name, {
        rotation: bone.quaternion.toArray(), position: bone.position.toArray(),
    }]));
    const vrm = { humanoid: { normalizedRestPose: rest, getNormalizedBoneNode: name => bones[name] } };
    const armsDown = [0, 0, Math.sin(0.6), Math.cos(0.6)];
    const standing = new AnimationClip('partial-standing', 2, [
        new QuaternionKeyframeTrack('leftUpperArm.quaternion', [0, 2], [...armsDown, ...armsDown]),
    ]);
    return { root, bones, vrm, rest, standing, armsDown };
}

test('standing restores the hips, torso and legs left tilted by a clamped animation before music sway', () => {
    const h = model(), mixer = new AnimationMixer(h.root), sway = new MusicSway();
    h.bones.spine.rotation.z = 0.4; h.bones.hips.position.x = 0.12; h.bones.leftUpperLeg.rotation.z = 0.2;
    const lean = new AnimationClip('lean', 2, [
        new QuaternionKeyframeTrack('spine.quaternion', [0, 2], [...h.bones.spine.quaternion.toArray(), ...h.bones.spine.quaternion.toArray()]),
        new VectorKeyframeTrack('hips.position', [0, 2], [0.12, 0.7, 0, 0.12, 0.7, 0]),
    ]);
    const outgoing = mixer.clipAction(lean).play(); outgoing.paused = true; mixer.update(0);
    const idle = mixer.clipAction(completeStandingIdleClip(h.standing, h.vrm)).play();
    idle.crossFadeFrom(outgoing, 0.5, true);
    for (let i = 0; i < 30; i++) mixer.update(1 / 60);
    outgoing.stop(); idle.paused = true; mixer.update(0);
    assert.ok(Math.abs(h.bones.spine.rotation.z) < 1e-6);
    assert.ok(Math.abs(h.bones.leftUpperLeg.rotation.z) < 1e-6);
    assert.ok(h.bones.hips.position.toArray().every((value, i) => Math.abs(value - [0, 0.7, 0][i]) < 1e-6));
    assert.ok(h.bones.leftUpperArm.quaternion.toArray().every((value, i) => Math.abs(value - h.armsDown[i]) < 1e-6), 'keep standing arm tracks instead of resetting to a T-pose');
    for (let now = 0; now <= 4000; now += 20) {
        sway.restore(); mixer.update(0.02);
        sway.update(h.vrm, { active: true, intervalMs: 500, beat: 8 + Math.floor(now / 500),
            lastBeatAt: Math.floor(now / 500) * 500, updatedAt: now }, { enabled: true, delta: 0.02, now });
        assert.ok(Math.abs(h.bones.spine.rotation.z - sway.angle * 0.35) < 1e-6, 'sway is centered on standing, not the previous lean');
        assert.ok(h.bones.hips.position.toArray().every((value, i) => Math.abs(value - [0, 0.7, 0][i]) < 1e-6));
    }
});

test('completing standing tracks is repeatable and does not replace authored animation tracks', () => {
    const h = model(), authored = h.standing.tracks[0];
    completeStandingIdleClip(h.standing, h.vrm);
    const length = h.standing.tracks.length;
    completeStandingIdleClip(h.standing, h.vrm);
    assert.equal(h.standing.tracks.length, length);
    assert.equal(h.standing.tracks[0], authored);
    assert.ok(h.standing.tracks.every(track => track.times.every(Number.isFinite) && track.values.every(Number.isFinite)));
});
