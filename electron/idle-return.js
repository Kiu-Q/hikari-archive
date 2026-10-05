/** Detect one return to deliberate input after a quiet period, without screenshots. */
export class IdleReturnTracker {
  constructor({ minimumIdleMs = 90000, greetingCooldownMs = 300000, now = () => Date.now() } = {}) {
    this.minimumIdleMs = Math.max(60000, minimumIdleMs);
    this.greetingCooldownMs = greetingCooldownMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.lastInputAt = this.now();
    this.lastReturnAt = -Infinity;
  }

  record(inputType, timestamp = this.now()) {
    const idleDurationMs = Math.max(0, timestamp - this.lastInputAt);
    this.lastInputAt = timestamp;
    if (idleDurationMs < this.minimumIdleMs || timestamp - this.lastReturnAt < this.greetingCooldownMs) return null;
    this.lastReturnAt = timestamp;
    return { idleDurationMs, inputType, resumedAt: timestamp, eventCount: 1 };
  }
}
