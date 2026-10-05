const PRIORITY = { idle: 0, calm_idle: 0, deep_idle: 0, cursor: 1, screen: 2, typing: 2, semantic: 3, thinking: 4, listening: 5, speaking: 6, direct: 7, dragging: 8 };

export function chooseCharacterBehavior(state = {}, now = Date.now(), config = {}) {
  const hikari = state.hikari || {};
  const activity = state.desktop?.activity || {};
  const options = [
    ['dragging', hikari.dragging], ['direct', hikari.directInteraction], ['speaking', hikari.speaking],
    ['listening', hikari.listening || state.audio?.wake?.active], ['thinking', hikari.thinking],
    ['semantic', Boolean(hikari.semanticReaction)], ['typing', activity.typing],
    ['screen', Boolean(state.screenAttention)],
    ['cursor', state.desktop?.pointer?.stale !== true && Number.isFinite(state.desktop?.pointer?.x) && Number.isFinite(state.desktop?.pointer?.y) && now - (state.desktop?.pointer?.updatedAt || 0) < (config.pointerAgeMs ?? 2000)],
    [activity.idleForMs >= (config.deepIdleMs ?? 300_000) ? 'deep_idle' : activity.idleForMs >= (config.calmIdleMs ?? 60_000) ? 'calm_idle' : 'idle', true]
  ];
  return options.filter(([, active]) => active).map(([behavior]) => behavior).sort((a, b) => PRIORITY[b] - PRIORITY[a])[0] || 'idle';
}

export class CharacterBehaviorController {
  constructor({ applyBehavior = () => {}, minHoldMs = 500, typingHoldMs = 800, now = () => Date.now(), ...config } = {}) {
    this.applyBehavior = applyBehavior;
    this.minHoldMs = minHoldMs;
    this.typingHoldMs = typingHoldMs;
    this.now = now;
    this.config = config;
    this.current = 'idle';
    this.changedAt = 0;
  }

  update(state) {
    const now = this.now();
    const typing = Boolean(state.desktop?.activity?.typing);
    if (typing && !this.typingStartedAt) this.typingStartedAt = now || 1;
    if (!typing) this.typingStartedAt = 0;
    const typingActive = typing && now - this.typingStartedAt >= this.typingHoldMs;
    const behaviorState = typingActive ? state : {
      ...state,
      desktop: { ...state.desktop, activity: { ...state.desktop?.activity, typing: false } }
    };
    const next = chooseCharacterBehavior(behaviorState, now, this.config);
    if (next === this.current) return this.current;
    if (PRIORITY[next] < PRIORITY[this.current] && now - this.changedAt < this.minHoldMs) return this.current;
    this.current = next;
    this.changedAt = now;
    this.applyBehavior(next, state);
    return next;
  }
}
