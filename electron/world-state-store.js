import { createWorldState, expireWorldStateFields, mergeWorldStatePatch, serializeWorldStateForAgent } from './world-state.js';

export class WorldStateStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.state = createWorldState();
    this.listeners = new Set();
  }

  getSnapshot() { return expireWorldStateFields(this.state, this.now()); }

  applyPatch(patch) {
    this.state = mergeWorldStatePatch(this.state, patch, this.now());
    for (const listener of this.listeners) {
      try { listener(this.getSnapshot()); } catch { /* One consumer cannot block the remaining subscribers. */ }
    }
    return this.getSnapshot();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('WorldStateStore listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  serializeForAgent() { return serializeWorldStateForAgent(this.state, this.now()); }
}
