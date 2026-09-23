// Pure media-playback state helpers. Keeping these independent of Electron and
// Core Audio makes transition policy deterministic and unit-testable.

export function parseMediaPlaybackOutput(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized === '1') return true;
  if (normalized === '0') return false;
  return null;
}

export class MediaPlaybackStateTracker {
  constructor({ debounceSamples = 2 } = {}) {
    this.debounceSamples = Math.max(1, Math.floor(Number(debounceSamples) || 1));
    this.reset();
  }

  reset() {
    this.stablePlaying = false;
    this.pendingPlaying = null;
    this.pendingCount = 0;
  }

  observe(isPlaying) {
    if (typeof isPlaying !== 'boolean') return null;

    if (isPlaying === this.stablePlaying) {
      this.pendingPlaying = null;
      this.pendingCount = 0;
      return null;
    }

    if (this.pendingPlaying === isPlaying) this.pendingCount += 1;
    else {
      this.pendingPlaying = isPlaying;
      this.pendingCount = 1;
    }

    if (this.pendingCount < this.debounceSamples) return null;

    const previousState = this.stablePlaying ? 'playing' : 'stopped';
    this.stablePlaying = isPlaying;
    this.pendingPlaying = null;
    this.pendingCount = 0;
    return {
      previousState,
      state: isPlaying ? 'playing' : 'stopped'
    };
  }
}
