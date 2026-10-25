import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Group, Object3D, Vector3 } from 'three';
import { VRMSpringBoneJoint, VRMSpringBoneManager } from '@pixiv/three-vrm';
import { configureHairCollisions } from '../shared/hair-collisions.js';

const buffer = readFileSync(new URL('../electron/assets/VRM/sample.vrm', import.meta.url));
const model = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());

// Use the shipped model's actual skeleton and spring settings without decoding textures.
function rig() {
    const nodes = model.nodes.map(data => {
        const node = new Object3D(); node.name = data.name || '';
        if (data.translation) node.position.fromArray(data.translation);
        if (data.rotation) node.quaternion.fromArray(data.rotation);
        if (data.scale) node.scale.fromArray(data.scale);
        return node;
    });
    model.nodes.forEach((data, i) => data.children?.forEach(child => nodes[i].add(nodes[child])));
    const scene = new Group();
    model.scenes[model.scene || 0].nodes.forEach(node => scene.add(nodes[node]));
    scene.updateMatrixWorld(true);
    const humanBones = Object.fromEntries(model.extensions.VRM.humanoid.humanBones.map(item => [item.bone, nodes[item.node]]));
    const manager = new VRMSpringBoneManager();
    for (const group of model.extensions.VRM.secondaryAnimation.boneGroups) {
        const colliderGroups = [];
        for (const root of group.bones) nodes[root].traverse(node => {
            manager.addJoint(new VRMSpringBoneJoint(node, node.children[0] || null, {
                stiffness: group.stiffiness, hitRadius: group.hitRadius,
                dragForce: group.dragForce, gravityPower: group.gravityPower,
                gravityDir: new Vector3(group.gravityDir.x, group.gravityDir.y, group.gravityDir.z),
            }, colliderGroups));
        });
    }
    manager.setInitState();
    return { scene, springBoneManager: manager, humanoid: { getRawBoneNode: name => humanBones[name] }, humanBones };
}

test('Hikari gets animated body colliders on long hair only, without changing authored spring settings', () => {
    const vrm = rig(), manager = vrm.springBoneManager;
    const originalSettings = [...manager.joints].map(joint => ({ ...joint.settings }));
    const report = configureHairCollisions(vrm);
    assert.deepEqual(report, { hairJoints: 144, bodyColliders: 11 });
    let i = 0;
    for (const joint of manager.joints) {
        assert.deepEqual(joint.settings, originalSettings[i++]);
        assert.equal(joint.colliderGroups.length, /Ha_(Back|Side)/i.test(joint.bone.name) ? 1 : 0);
    }
    for (const collider of manager.colliders) {
        assert.ok(collider.parent, 'attach to a body bone, not the scene');
        assert.ok(collider.shape.radius > 0);
    }
    assert.equal(configureHairCollisions(vrm), report);
    assert.equal(manager.colliders.length, 11);
});

test('animated arm colliders follow the body and hair stays finite after a long frame gap', () => {
    const vrm = rig(); configureHairCollisions(vrm);
    const manager = vrm.springBoneManager;
    const collider = manager.colliders.find(item => item.name.endsWith('left upper arm'));
    manager.update(1 / 60);
    const before = collider.shape.tail.clone().applyMatrix4(collider.colliderMatrix);
    vrm.humanBones.leftUpperArm.rotation.z = 0.8;
    vrm.humanBones.neck.rotation.x = 0.65;
    manager.update(5);
    assert.ok(collider.parent === vrm.humanBones.leftUpperArm);
    assert.notDeepEqual(collider.colliderMatrix.elements, new Object3D().matrix.elements);
    assert.ok(collider.shape.tail.clone().applyMatrix4(collider.colliderMatrix).distanceTo(before) > 0.05);
    for (const joint of manager.joints) {
        assert.ok(joint.bone.quaternion.toArray().every(Number.isFinite));
        assert.ok(Math.abs(joint.bone.quaternion.length() - 1) < 1e-6);
    }
});

test('authored colliders and other spring rigs are preserved', () => {
    const vrm = rig();
    const existing = { colliders: [new Object3D()] };
    for (const joint of vrm.springBoneManager.joints) joint.colliderGroups = [existing];
    assert.equal(configureHairCollisions(vrm), null);
    for (const joint of vrm.springBoneManager.joints) assert.deepEqual(joint.colliderGroups, [existing]);
    assert.equal(configureHairCollisions({ scene: new Group() }), null);
});
