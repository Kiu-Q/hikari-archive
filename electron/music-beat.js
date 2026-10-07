// Local bass-onset detection. Only energy scalars arrive from the native tap.
export class MusicBeatDetector {
  constructor() { this.reset(); }
  reset() {
    this.average = 0; this.previousBass = 0; this.lastFrameAt = null;
    this.lastBeatAt = null; this.beat = 0; this.intervals = [];
    this.rawIntervals = []; this.intervalMs = null; this.targetIntervalMs = null; this.lastAudibleAt = null;
  }
  learnTempo(interval) {
    if (interval < 300 || interval > 4500) return;
    this.rawIntervals.push(interval); this.rawIntervals = this.rawIntervals.slice(-3);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const rawMedian = median(this.rawIntervals);
    // Repeated, consistent intervals can establish a new tempo. A single missed
    // beat is instead folded back into the current tempo, not counted as a slowdown.
    const changedTempo = this.intervalMs !== null && this.rawIntervals.length === 3 &&
      this.rawIntervals.every(value => Math.abs(value / rawMedian - 1) < .08) &&
      Math.abs(rawMedian / this.intervalMs - 1) > .12 && rawMedian <= 1500;
    if (changedTempo) this.intervals = [rawMedian, rawMedian, rawMedian];
    else if (this.intervalMs !== null) {
      const beats = Math.round(interval / this.intervalMs);
      if (beats >= 2 && beats <= 3 && Math.abs(interval / beats / this.intervalMs - 1) < .12) interval /= beats;
    }
    if (interval > 1500) return;
    this.intervals.push(interval); this.intervals = this.intervals.slice(-9);
    // Wait for three intervals before moving; ignore small measurement jitter.
    if (this.intervals.length < 3) return;
    const centre = median(this.intervals);
    const inliers = this.intervals.filter(value => Math.abs(value / centre - 1) < .12);
    const target = inliers.reduce((sum, value) => sum + value, 0) / inliers.length;
    if (this.intervalMs === null) this.intervalMs = this.targetIntervalMs = target;
    else {
      if (Math.abs(target / this.targetIntervalMs - 1) > .03) this.targetIntervalMs = target;
      this.intervalMs += (this.targetIntervalMs - this.intervalMs) * .2;
      // Finish an established change, rather than stopping just above 60 BPM.
      if (Math.abs(this.intervalMs / this.targetIntervalMs - 1) < .005) this.intervalMs = this.targetIntervalMs;
    }
  }
  update(frame, now = Date.now()) {
    const level = Math.max(0, Math.min(1, Number(frame.level) || 0));
    const bass = Math.max(0, Math.min(1, Number(frame.bass) || 0));
    const delta = this.lastFrameAt === null ? 40 : Math.max(1, Math.min(200, now - this.lastFrameAt));
    if (this.lastFrameAt !== null && now - this.lastFrameAt > 1500) this.reset();
    if (level >= .002) {
      // Keep learned tempo across short quiet passages and track changes.
      if (this.lastAudibleAt !== null && now - this.lastAudibleAt > 8000) this.reset();
      this.lastAudibleAt = now;
    }
    const onset = bass > Math.max(0.004, this.average * 1.5) &&
      bass > this.previousBass * 1.12 && (this.lastBeatAt === null || now - this.lastBeatAt >= 240);
    if (onset) {
      if (this.lastBeatAt !== null) {
        this.learnTempo(now - this.lastBeatAt);
      }
      this.lastBeatAt = now; this.beat++;
    }
    this.average += (bass - this.average) * (1 - Math.exp(-delta / 1400));
    this.previousBass = bass; this.lastFrameAt = now;
    return { level, beat: this.beat, lastBeatAt: this.lastBeatAt, intervalMs: this.intervalMs,
      active: this.lastAudibleAt !== null && now - this.lastAudibleAt < 4000, updatedAt: now };
  }
}
