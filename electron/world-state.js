// Pure, privacy-conscious world-state helpers shared by Electron processes.
const EMPTY_STATE = {
  revision: 0,
  updatedAt: 0,
  desktop: {
    appName: '', bundleId: '', windowTitle: '', windowId: null, windowBounds: null, contextUpdatedAt: 0, contextStale: true,
    pointer: { x: null, y: null, displayId: null, updatedAt: 0, stale: true },
    activity: { typing: false, scrolling: false, clicking: false, lastInputAt: 0, idleForMs: 0, idle: false, updatedAt: 0, stale: true },
    screen: { changeLevel: 'unknown', changeAt: 0, changeStale: true, lastSummary: '', summaryAt: 0, summaryStale: true, summaryContextKey: '', available: false, visionAvailable: false }
  },
  browser: { available: false, activeTab: null, tabs: [], updatedAt: 0 },
  audio: {
    microphone: { enabled: false, permission: 'unknown', voiceActive: false, lastSpeechAt: 0 },
    wake: { active: false, expiresAt: 0 },
    stt: { status: 'unavailable', language: '', lastAddressedAt: 0 },
    system: { available: false, captureAvailable: false, running: false, volume: null, muted: null, level: null, classification: 'unknown', confidence: 0, updatedAt: 0 }
  },
  hikari: { speaking: false, listening: false, thinking: false, dragging: false, directInteraction: false, currentBehavior: 'idle', attentionTarget: 'none', semanticReaction: null, updatedAt: 0, stale: true }
};

function clone(value) {
  return structuredClone(value);
}

export function createWorldState() {
  return clone(EMPTY_STATE);
}

export function deriveDesktopActivityState({ typingSession, scrollSession, clickSession, lastInputAt = 0 } = {}, now = Date.now()) {
  const idleForMs = lastInputAt ? Math.max(0, now - lastInputAt) : 0;
  return {
    typing: Boolean(typingSession), scrolling: Boolean(scrollSession), clicking: Boolean(clickSession),
    lastInputAt, idleForMs, idle: idleForMs >= 60_000
  };
}

function mergeObject(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeObject(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function mergeWorldStatePatch(state, patch, now = Date.now()) {
  const next = mergeObject(clone(state || EMPTY_STATE), sanitizeWorldStatePatch(patch));
  if (patch?.hikari && typeof patch.hikari === 'object' && patch.hikari.updatedAt === undefined && patch.hikari.stale === undefined) {
    next.hikari.updatedAt = now;
    next.hikari.stale = false;
  }
  next.revision = Math.max(Number(next.revision) || 0, Number(state?.revision) || 0) + 1;
  next.updatedAt = now;
  return next;
}

const RENDERER_HIKARI_FIELDS = new Set(['speaking', 'listening', 'thinking', 'dragging', 'directInteraction', 'currentBehavior', 'attentionTarget', 'semanticReaction']);

// Renderer-originated IPC is intentionally limited to Hikari's own status and
// the voice activity bit. Desktop observations remain main-process owned.
export function sanitizeRendererWorldPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const safe = {};
  if (patch.hikari && typeof patch.hikari === 'object' && !Array.isArray(patch.hikari)) {
    safe.hikari = {};
    for (const [key, value] of Object.entries(patch.hikari)) {
      if (!RENDERER_HIKARI_FIELDS.has(key)) continue;
      if (['speaking', 'listening', 'thinking', 'dragging', 'directInteraction'].includes(key) && typeof value === 'boolean') safe.hikari[key] = value;
      else if (key === 'currentBehavior' && typeof value === 'string') safe.hikari[key] = value.slice(0, 64);
      else if (key === 'attentionTarget' && ['none', 'user-pointer', 'screen-center'].includes(value)) safe.hikari[key] = value;
      else if (key === 'semanticReaction' && (value === null || typeof value === 'string')) safe.hikari[key] = typeof value === 'string' ? value.slice(0, 64) : null;
    }
    if (!Object.keys(safe.hikari).length) delete safe.hikari;
  }
  if (typeof patch.audio?.microphone?.voiceActive === 'boolean') {
    safe.audio = { microphone: { voiceActive: patch.audio.microphone.voiceActive } };
  }
  return safe;
}

const PATCH_SHAPE = EMPTY_STATE;
function sanitizeWorldStatePatch(patch, shape = PATCH_SHAPE) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !(key in shape)) continue;
    const expected = shape[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) clean[key] = sanitizeWorldStatePatch(value, expected);
      continue;
    }
    if (Array.isArray(expected)) {
      if (Array.isArray(value)) clean[key] = value.slice(0, 50).map((item) => sanitizeLooseValue(item)).filter((item) => item !== undefined);
      continue;
    }
    if (expected === null) {
      if (value === null) clean[key] = null;
      else if (typeof value === 'string') clean[key] = value.slice(0, 1000);
      else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
      else if (value && typeof value === 'object' && !Array.isArray(value)) clean[key] = sanitizeLooseValue(value);
    } else if (typeof expected === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    } else if (typeof expected === 'boolean') {
      if (typeof value === 'boolean') clean[key] = value;
    } else if (typeof expected === 'string' && typeof value === 'string') {
      clean[key] = value.slice(0, 1000);
    }
  }
  return clean;
}

function sanitizeLooseValue(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLooseValue(item, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const sanitized = sanitizeLooseValue(item, depth + 1);
      if (sanitized !== undefined) clean[key] = sanitized;
    }
    return clean;
  }
  return undefined;
}

export function expireWorldStateFields(state, now = Date.now(), { screenSummaryMaxAgeMs = 120_000, screenChangeMaxAgeMs = 120_000, pointerMaxAgeMs = 2_000, activityMaxAgeMs = 3_000, contextMaxAgeMs = 5_000 } = {}) {
  const next = clone(state || EMPTY_STATE);
  const activity = next.desktop?.activity;
  if (activity) {
    activity.idleForMs = activity.lastInputAt ? Math.max(0, now - activity.lastInputAt) : 0;
    activity.stale = !activity.updatedAt || now - activity.updatedAt > activityMaxAgeMs;
    if (activity.stale) activity.typing = activity.scrolling = activity.clicking = false;
  }
  if (next.desktop) next.desktop.contextStale = !next.desktop.contextUpdatedAt || now - next.desktop.contextUpdatedAt > contextMaxAgeMs;
  const screen = next.desktop?.screen;
  if (screen) {
    screen.changeStale = !screen.changeAt || now - screen.changeAt > screenChangeMaxAgeMs;
    if (screen.changeStale) screen.changeLevel = 'unknown';
  }
  if (screen?.summaryAt && now - screen.summaryAt > screenSummaryMaxAgeMs) {
    screen.lastSummary = '';
    screen.summaryAt = 0;
    screen.summaryStale = true;
    screen.summaryContextKey = '';
  }
  if (screen && !screen.summaryAt) screen.summaryStale = true;
  const pointer = next.desktop?.pointer;
  if (pointer && (!pointer.updatedAt || now - pointer.updatedAt > pointerMaxAgeMs)) {
    pointer.x = null; pointer.y = null; pointer.displayId = null;
    pointer.stale = true;
  }
  const systemAudio = next.audio?.system;
  if (systemAudio) systemAudio.stale = !systemAudio.updatedAt || now - systemAudio.updatedAt > 15_000;
  const hikari = next.hikari;
  if (hikari) {
    hikari.stale = !hikari.updatedAt || now - hikari.updatedAt > 60_000;
    if (hikari.stale) {
      hikari.speaking = hikari.listening = hikari.thinking = hikari.dragging = hikari.directInteraction = false;
      hikari.semanticReaction = null;
      hikari.currentBehavior = 'idle';
      hikari.attentionTarget = 'none';
    }
  }
  if (next.audio?.wake?.expiresAt && now >= next.audio.wake.expiresAt) next.audio.wake = { active: false, expiresAt: 0 };
  return next;
}

export function serializeWorldStateForAgent(state, now = Date.now()) {
  const fresh = expireWorldStateFields(state, now);
  const lines = [];
  const desktop = fresh.desktop || {};
  if (desktop.appName && !desktop.contextStale) lines.push(`Active app: ${desktop.appName}${desktop.windowTitle ? ` — ${desktop.windowTitle}` : ''}`);
  const activity = desktop.activity || {};
  if (!activity.stale && activity.idle) lines.push(`User activity: idle for ${Math.round((activity.idleForMs || 0) / 60_000)} min`);
  else if (activity.stale) lines.push('User activity: stale / unavailable');
  else if (activity.typing) lines.push('User activity: typing');
  else if (activity.scrolling) lines.push('User activity: scrolling');
  else if (activity.lastInputAt) lines.push('User activity: recently active');
  const summary = desktop.screen;
  if (summary?.changeAt && !summary.changeStale) lines.push(`Recent screen change: ${summary.changeLevel}`);
  if (summary?.lastSummary && summary.summaryAt && !summary.summaryStale && now - summary.summaryAt <= 120_000) lines.push(`Screen summary: ${summary.lastSummary}`);
  const browser = fresh.browser;
  if (browser?.available && browser.activeTab?.title) lines.push(`Browser tab: ${browser.activeTab.title}`);
  const audio = fresh.audio || {};
  if (audio.wake?.active) lines.push('Hikari wake session: active');
  if (audio.microphone?.voiceActive) lines.push('Microphone: speech currently detected');
  if (audio.system?.stale) lines.push('System audio: stale / unavailable');
  else if (audio.system?.available && audio.system.running) lines.push(`System audio: ${audio.system.classification && audio.system.classification !== 'unknown' ? audio.system.classification : 'active (content unknown)'}`);
  const hikari = fresh.hikari || {};
  const hikariState = hikari.stale ? [] : ['speaking', 'listening', 'thinking'].filter((key) => hikari[key]);
  if (hikariState.length) lines.push(`Hikari state: ${hikariState.join(', ')}`);
  if (!hikari.stale && hikari.attentionTarget !== 'none') lines.push(`Hikari attention target: ${hikari.attentionTarget}`);
  return lines.length ? `Current environment (brief, may be incomplete):\n${lines.join('\n')}` : '';
}

export const WORLD_STATE_DEFAULTS = EMPTY_STATE;
