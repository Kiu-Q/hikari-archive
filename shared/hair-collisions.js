import { Vector3 } from 'three';
import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule,
    VRMSpringBoneColliderShapeSphere } from '@pixiv/three-vrm';

const configured = new WeakMap();
const HAIR_BONE = /Ha_(?:Back|Side)/i;

/** Supply the body collisions missing from Hikari's exported long-hair rig. */
export function configureHairCollisions(vrm) {
    if (configured.has(vrm)) return configured.get(vrm);
    const manager = vrm.springBoneManager;
    const bone = name => vrm.humanoid?.getRawBoneNode(name);
    const head = bone('head'), neck = bone('neck'), hips = bone('hips');
    if (!manager || !head || !neck || !hips) return null;
    const hair = [...manager.joints].filter(joint => {
        if (!HAIR_BONE.test(joint.bone.name)) return false;
        let parent = joint.bone;
        while (parent && parent !== head) parent = parent.parent;
        // Preserve collision data authored in other exports of this model.
        return parent === head && !joint.colliderGroups.some(group => group.colliders.length);
    });
    if (!hair.length) return null;

    vrm.scene.updateMatrixWorld(true);
    const point = node => node.getWorldPosition(new Vector3());
    // The profile is in metres for this rig; derive its scale from the skeleton.
    const scale = point(head).distanceTo(point(hips)) / 0.709;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const colliders = [];
    function capsule(name, from, to, radius, start = 0, end = 1) {
        if (!from || !to) return;
        const a = point(from), b = point(to);
        const offset = from.worldToLocal(a.clone().lerp(b, start));
        const tail = from.worldToLocal(a.clone().lerp(b, end));
        const collider = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeCapsule({
            offset, tail, radius: radius * scale,
        }));
        collider.name = `Hikari hair collision: ${name}`;
        from.add(collider);
        colliders.push(collider);
    }
    const headCenter = point(head).add(point(head).sub(point(neck)).multiplyScalar(0.95));
    const skull = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({
        offset: head.worldToLocal(headCenter), radius: 0.085 * scale,
    }));
    skull.name = 'Hikari hair collision: head';
    head.add(skull);
    colliders.push(skull);
    capsule('neck', neck, head, 0.035);
    capsule('abdomen', hips, bone('spine'), 0.08, 0.55, 1);
    capsule('torso', bone('spine'), bone('upperChest') || bone('chest'), 0.085);
    capsule('upper torso', bone('upperChest') || bone('chest'), neck, 0.09, 0, 0.7);
    for (const side of ['left', 'right']) {
        capsule(`${side} shoulder`, bone(`${side}Shoulder`), bone(`${side}UpperArm`), 0.045);
        capsule(`${side} upper arm`, bone(`${side}UpperArm`), bone(`${side}LowerArm`), 0.04);
        capsule(`${side} forearm`, bone(`${side}LowerArm`), bone(`${side}Hand`), 0.032);
    }
    const group = { name: 'Hikari hair body collisions', colliders };
    for (const joint of hair) {
        // The VRM loader shares this array across a whole spring group, which
        // also includes the bangs. Give each long-hair joint its own array.
        joint.colliderGroups = [...joint.colliderGroups, group];
        // Refresh the manager's cached dependency order so animated colliders
        // have current world matrices before it solves the hair joints.
        manager.addJoint(joint);
    }
    manager.reset();
    // Bound large browser frame gaps and substep the spring solver. Keep the
    // humanoid, expressions and other VRM components on their normal frame update.
    const update = manager.update;
    manager.update = function(delta) {
        if (!(delta > 0)) return update.call(this, 0);
        const elapsed = Math.min(delta, 0.1);
        const steps = Math.ceil(elapsed / (1 / 60));
        for (let i = 0; i < steps; i++) update.call(this, elapsed / steps);
    };
    const report = { hairJoints: hair.length, bodyColliders: colliders.length };
    configured.set(vrm, report);
    return report;
}
