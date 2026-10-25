import { QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';

/** Restore unkeyed body transforms instead of inheriting the last gesture. */
export function completeStandingIdleClip(clip, vrm) {
    const rest = vrm?.humanoid?.normalizedRestPose;
    if (!clip?.tracks || !rest) return clip;
    const names = new Set(clip.tracks.map(track => track.name));
    const duration = Math.max(clip.duration, 0.001);
    for (const [name, pose] of Object.entries(rest)) {
        const bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (!bone) continue;
        for (const [property, values, Track] of [
            ['quaternion', pose.rotation, QuaternionKeyframeTrack],
            ['position', pose.position, VectorKeyframeTrack],
        ]) {
            if (!values || names.has(`${bone.name}.${property}`) || names.has(`${bone.uuid}.${property}`)) continue;
            clip.tracks.push(new Track(`${bone.name || bone.uuid}.${property}`, [0, duration], [...values, ...values]));
        }
    }
    return clip;
}
