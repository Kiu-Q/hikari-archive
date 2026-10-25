// Deterministic local resolver. No network, expressions, or animation requests.
import { CharacterBehaviorController } from './character-behavior.js';
export const ATTENTION_CONFIG = Object.freeze({
  tickMs: 100, pointerAgeMs: 2000, screenHoldMs: 1400, screenCooldownMs: 2500,
  typingHoldMs: 250, minHoldMs: 450, smoothing: 5, maxDelta: 0.05,
  maxHeadYaw: 0.10, maxHeadPitch: 0.06, thinkingTilt: 0.055,
  speakingNod: 0.018, idlePitch: 0.025, defaultEyeDegrees: 20, maxEyeDegrees: 45, calmIdleMs: 60000, deepIdleMs: 300000
});
export function localMotionAllowed({ scripted = false, transitioning = false, dragging = false, direct = false } = {}) {
  return !(scripted || transitioning || dragging || direct);
}
export class LocalAttentionController {
  constructor({ config = {}, now = () => Date.now() } = {}) {
    this.config = { ...ATTENTION_CONFIG, ...config }; this.now = now;
    this.resolver = new CharacterBehaviorController({ now, ...this.config });
    this.contextKey = null; this.screenAt = 0; this.screenUntil = 0; this.lastShift = -Infinity;
    this.output = { behavior: 'idle', attention: 'neutral' };
  }
  update(state, { cursorEnabled = true, localPointer = null } = {}) {
    const now = this.now(), desktop = state.desktop || {};
    const key = JSON.stringify([desktop.appName, desktop.windowId, desktop.windowTitle]);
    const changed = this.contextKey !== null && key !== this.contextKey && !desktop.contextStale;
    const screen = desktop.screen || {};
    const screenChanged = screen.changeAt > this.screenAt && !screen.changeStale &&
      !['unknown', 'none'].includes(screen.changeLevel) && now - screen.changeAt < this.config.screenHoldMs;
    this.contextKey = key; this.screenAt = Math.max(this.screenAt, screen.changeAt || 0);
    if ((changed || screenChanged) && now - this.lastShift >= this.config.screenCooldownMs) {
      this.screenUntil = now + this.config.screenHoldMs; this.lastShift = now;
    }
    let pointer = cursorEnabled ? desktop.pointer : null;
    if (!pointer || pointer.stale || now - pointer.updatedAt >= this.config.pointerAgeMs) pointer = localPointer;
    if (!pointer || now - pointer.updatedAt >= this.config.pointerAgeMs) pointer = {};
    const behavior = this.resolver.update({ ...state, screenAttention: now < this.screenUntil,
      desktop: { ...desktop, pointer } });
    const attention = ({ cursor: 'cursor', typing: 'screen', screen: 'screen',
      thinking: 'thinking', speaking: 'user', listening: 'user' })[behavior] || 'neutral';
    this.output = { behavior, attention, pointer };
    return this.output;
  }
}
