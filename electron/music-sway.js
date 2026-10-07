import { Quaternion, Vector3 } from 'three';

function hasFreshTempo(signal, now) {
  const interval = signal?.intervalMs;
  return signal?.active && now - signal.updatedAt >= 0 && now - signal.updatedAt < 500 &&
    Number.isFinite(signal.lastBeatAt) && Number.isFinite(interval) && interval >= 300 && interval <= 1500 &&
    now - signal.lastBeatAt < Math.max(4500, interval * 4);
}

// An additive layer restored before each mixer tick, so it never changes clips.
export class MusicSway {
  constructor({ maxAngle = 6 * Math.PI / 180 } = {}) {
    this.maxAngle = maxAngle; this.angle = 0; this.layers = [];
    this.phase = null; this.rate = null; this.phasePull = 0; this.lastBeatAt = null; this.weight = 0;
    this.divider = null; this.pendingDivider = null; this.dividerVotes = 0;
    this.axis = new Vector3(0, 0, 1); this.offset = new Quaternion();
  }
  restore() {
    for (const { bone, base } of this.layers) bone.quaternion.copy(base);
    this.layers = [];
  }
  shouldPauseIdle(signal, { enabled = false, blocked = false, now = Date.now() } = {}) {
    return this.idlePlaybackScale(signal, { enabled, blocked, now }) === 0;
  }
  idlePlaybackScale(signal, { enabled = false, blocked = false, now = Date.now() } = {}) {
    if (enabled && !blocked && hasFreshTempo(signal, now)) return 0;
    // Ramp idle movement back in while sway eases out, including interactions.
    return this.weight >= .999 ? 0 : 1 - this.weight;
  }
  update(vrm, signal, { enabled = false, blocked = false, delta = 1 / 60, now = Date.now() } = {}) {
    if (!vrm) {
      this.angle = 0; this.phase = null; this.rate = null; this.phasePull = 0; this.lastBeatAt = null; this.weight = 0;
      this.divider = null; this.pendingDivider = null; this.dividerVotes = 0; return;
    }
    const dt = Math.min(Math.max(delta, 0), .05);
    const interval = signal?.intervalMs;
    const fresh = enabled && hasFreshTempo(signal, now);
    const wantedWeight = fresh && !blocked ? 1 : 0;
    this.weight += (wantedWeight - this.weight) * (1 - Math.exp(-dt / (wantedWeight ? .35 : .2)));
    if (this.weight < .0001) this.weight = 0;
    let target = 0;
    if (fresh) {
      // Fast music uses four beats per side; medium music uses two.
      const desiredDivider = interval < 500 ? 4 : interval < 1000 ? 2 : 1;
      if (this.divider === null) this.divider = desiredDivider;
      if (signal.lastBeatAt !== this.lastBeatAt) {
        if (desiredDivider === this.divider) { this.pendingDivider = null; this.dividerVotes = 0; }
        else {
          this.dividerVotes = this.pendingDivider === desiredDivider ? this.dividerVotes + 1 : 1;
          this.pendingDivider = desiredDivider;
          if (this.dividerVotes >= 3) { this.divider = desiredDivider; this.pendingDivider = null; this.dividerVotes = 0; }
        }
      }
      const beatsPerSwing = this.divider;
      const rate = Math.PI * 1000 / (interval * beatsPerSwing);
      if (this.phase === null) {
        this.phase = Math.PI * ((signal.beat % (2 * beatsPerSwing)) + (now - signal.lastBeatAt) / interval) / beatsPerSwing;
        this.rate = rate; this.phasePull = 0; this.lastBeatAt = signal.lastBeatAt;
      } else {
        // Keep position continuous even when detections are uneven or tempo changes.
        this.rate += (rate - this.rate) * (1 - Math.exp(-dt / .75));
        this.phase = (this.phase + (this.rate + this.phasePull) * dt) % (Math.PI * 2);
        this.phasePull *= Math.exp(-dt / .75);
        if (signal.lastBeatAt !== this.lastBeatAt) {
          const gap = signal.lastBeatAt - this.lastBeatAt, beats = Math.round(gap / interval);
          // Gently keep time with credible beats over long playback. Extra
          // onsets cannot reset position or abruptly reverse the body.
          if (beats >= 1 && beats <= 3 && Math.abs(gap / beats / interval - 1) < .12) {
            const step = Math.PI / beatsPerSwing;
            const atBeat = this.phase - this.rate * (now - signal.lastBeatAt) / 1000;
            const error = Math.round(atBeat / step) * step - atBeat;
            this.phasePull = Math.max(-rate * .04, Math.min(rate * .04, error * .25));
          }
          this.lastBeatAt = signal.lastBeatAt;
        }
      }
      if (!blocked) target = Math.cos(this.phase) * this.maxAngle * this.weight;
    }
    this.angle += (target - this.angle) * (1 - Math.exp(-dt * (wantedWeight ? 10 : 4)));
    if (!fresh && this.weight === 0 && Math.abs(this.angle) < .00001) {
      this.phase = null; this.rate = null; this.phasePull = 0; this.lastBeatAt = null;
      this.divider = null; this.pendingDivider = null; this.dividerVotes = 0;
    }
    if (Math.abs(this.angle) < 0.00001) return;
    const spine = vrm.humanoid?.getNormalizedBoneNode?.('spine');
    const chest = vrm.humanoid?.getNormalizedBoneNode?.('chest') || vrm.humanoid?.getNormalizedBoneNode?.('upperChest');
    for (const [bone, weight] of [[spine, chest ? .35 : 1], [chest, spine ? .65 : 1]]) {
      if (!bone) continue;
      this.layers.push({ bone, base: bone.quaternion.clone() });
      this.offset.setFromAxisAngle(this.axis, this.angle * weight);
      bone.quaternion.multiply(this.offset);
    }
  }
}
