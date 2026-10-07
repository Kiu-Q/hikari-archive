import { desktopCapturer, systemPreferences, shell, app, screen, nativeImage, ipcMain, session, BrowserWindow, powerMonitor } from "electron";
import path$1 from "path";
import { fileURLToPath as fileURLToPath$1 } from "url";
import { existsSync as existsSync$1 } from "fs";
import { execFile as execFile$2, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const activeWindowOptions = Object.freeze({
  accessibilityPermission: false,
  // get-windows' native helper has its own macOS TCC identity. Keep it from
  // requesting Screen Recording; Electron's desktopCapturer owns that access.
  screenRecordingPermission: false
});
const awarenessConfig = {
  enabledByDefault: false,
  idleReturn: {
    minimumIdleMs: 90 * 1e3,
    greetingCooldownMs: 5 * 60 * 1e3
  },
  activity: {
    // Short, deliberate bursts should still produce an observation while the
    // pause keeps every individual key from becoming its own candidate.
    typingPauseMs: 1500,
    minimumTypingKeys: 3,
    scrollPauseMs: 800,
    minimumWheelEvents: 3,
    clickObservationDelayMs: 500
  },
  media: {
    // Core Audio is sampled instead of captured. Requiring two consecutive
    // samples filters short notification sounds while still noticing playback
    // within a few seconds.
    pollIntervalMs: 2e3,
    debounceSamples: 2
  },
  screen: {
    comparisonWidth: 320,
    comparisonHeight: 180,
    minorChangeThreshold: 0.03,
    significantChangeThreshold: 0.08,
    majorChangeThreshold: 0.25,
    // Keyboard activity is already a strong signal. Do not require a large
    // pixel diff as well: a few characters often change far below 3% of a
    // full editor window.
    typingChangeThreshold: 0,
    // Allow an active-window transition to settle before taking a comparison
    // snapshot. Semantic snapshots can remain larger than diff thumbnails.
    stableWindowDebounceMs: 300,
    semanticSnapshotWidth: 1120,
    semanticSnapshotJpegQuality: 72
  },
  observation: {
    minimumCandidateIntervalMs: 4e3,
    minimumAgentAnalysisIntervalMs: 4e3,
    candidateMaxAgeMs: 1e4
  },
  reaction: {
    normalSpeechCooldownMs: 2e4,
    importantSpeechCooldownMs: 15e3,
    normalBudgetCount: 6,
    normalBudgetWindowMs: 10 * 60 * 1e3
  },
  dedupe: {
    sameContextReactionCooldownMs: 9e4
  },
  hikariInteraction: {
    suppressionMs: 1500
  },
  memory: {
    recentCandidateLimit: 20,
    recentReactionLimit: 10
  },
  debug: true
};
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 1920;
function captureError(code, message) {
  return Object.assign(new Error(message), { code });
}
function createScreenCaptureService({ getSources, getDisplay, getPermissionStatus = () => "granted", platform = process.platform, now = () => Date.now(), captureTimeoutMs = 15e3 }) {
  let capturing = false;
  return {
    async capture() {
      if (capturing) throw captureError("CAPTURE_BUSY", "A screenshot is already being captured.");
      capturing = true;
      try {
        if (platform === "darwin" && getPermissionStatus() !== "granted") {
          throw captureError("SCREEN_PERMISSION_REQUIRED", "Allow Screen Recording for Hikari in macOS Settings, then capture again.");
        }
        const display = getDisplay();
        if (!display?.size?.width || !display?.size?.height) throw captureError("CAPTURE_UNAVAILABLE", "The current display is unavailable.");
        const scale = Math.min(1, MAX_DIMENSION / Math.max(display.size.width, display.size.height));
        let captureTimer;
        let sources;
        try {
          sources = await Promise.race([
            getSources({
              types: ["screen"],
              fetchWindowIcons: false,
              thumbnailSize: { width: Math.max(1, Math.round(display.size.width * scale)), height: Math.max(1, Math.round(display.size.height * scale)) }
            }),
            new Promise((_, reject) => {
              captureTimer = setTimeout(() => reject(captureError("CAPTURE_TIMEOUT", "Screen capture timed out. Check Screen Recording permission and try again.")), captureTimeoutMs);
            })
          ]);
        } finally {
          clearTimeout(captureTimer);
        }
        const source = sources.find((item) => String(item.display_id) === String(display.id));
        let image = source?.thumbnail;
        if (!image || image.isEmpty()) throw captureError("CAPTURE_UNAVAILABLE", "No screenshot was returned for the current display.");
        let size = image.getSize();
        if (Math.max(size.width, size.height) > MAX_DIMENSION) {
          const ratio = MAX_DIMENSION / Math.max(size.width, size.height);
          image = image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio), quality: "good" });
        }
        let jpeg;
        for (const quality of [80, 65, 50]) {
          jpeg = image.toJPEG(quality);
          if (jpeg.length <= MAX_SCREENSHOT_BYTES) break;
        }
        if (!jpeg?.length || jpeg.length > MAX_SCREENSHOT_BYTES) throw captureError("SCREENSHOT_TOO_LARGE", "The screenshot is too large. Try capturing a smaller display.");
        size = image.getSize();
        const thumbnail = image.resize({ width: Math.min(320, size.width), quality: "good" }).toJPEG(65);
        return {
          mimeType: "image/jpeg",
          width: size.width,
          height: size.height,
          capturedAt: now(),
          dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          thumbnailDataUrl: `data:image/jpeg;base64,${thumbnail.toString("base64")}`
        };
      } finally {
        capturing = false;
      }
    }
  };
}
function parseMediaPlaybackOutput(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "1") return true;
  if (normalized === "0") return false;
  return null;
}
function parseSystemAudioOutput(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").trim());
    if (parsed?.available !== true) return { available: false, running: false, volume: null, muted: null };
    const volume = parsed.volume == null ? null : Number(parsed.volume);
    return {
      available: true,
      running: Boolean(parsed.running),
      volume: Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : null,
      muted: typeof parsed.muted === "boolean" ? parsed.muted : null,
      deviceId: Number.isSafeInteger(parsed.deviceId) && parsed.deviceId > 0 ? parsed.deviceId : null
    };
  } catch {
    return null;
  }
}
class MediaPlaybackStateTracker {
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
    if (typeof isPlaying !== "boolean") return null;
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
    const previousState = this.stablePlaying ? "playing" : "stopped";
    this.stablePlaying = isPlaying;
    this.pendingPlaying = null;
    this.pendingCount = 0;
    return {
      previousState,
      state: isPlaying ? "playing" : "stopped"
    };
  }
}
const EMPTY_STATE = {
  revision: 0,
  updatedAt: 0,
  desktop: {
    appName: "",
    bundleId: "",
    windowTitle: "",
    windowId: null,
    windowBounds: null,
    contextUpdatedAt: 0,
    contextStale: true,
    pointer: { x: null, y: null, displayId: null, updatedAt: 0, stale: true },
    activity: { typing: false, scrolling: false, clicking: false, lastInputAt: 0, idleForMs: 0, idle: false, updatedAt: 0, stale: true },
    screen: { changeLevel: "unknown", changeAt: 0, changeStale: true, lastSummary: "", summaryAt: 0, summaryStale: true, summaryContextKey: "", available: false, visionAvailable: false }
  },
  browser: { available: false, activeTab: null, tabs: [], updatedAt: 0 },
  audio: {
    microphone: { enabled: false, permission: "unknown", voiceActive: false, lastSpeechAt: 0 },
    wake: { active: false, expiresAt: 0 },
    stt: { status: "unavailable", language: "", lastAddressedAt: 0 },
    system: { available: false, captureAvailable: false, running: false, volume: null, muted: null, level: null, classification: "unknown", confidence: 0, updatedAt: 0 }
  },
  hikari: { speaking: false, listening: false, thinking: false, dragging: false, directInteraction: false, currentBehavior: "idle", attentionTarget: "none", semanticReaction: null, updatedAt: 0, stale: true }
};
function clone(value) {
  return structuredClone(value);
}
function createWorldState() {
  return clone(EMPTY_STATE);
}
function deriveDesktopActivityState({ typingSession, scrollSession, clickSession, lastInputAt = 0 } = {}, now = Date.now()) {
  const idleForMs = lastInputAt ? Math.max(0, now - lastInputAt) : 0;
  return {
    typing: Boolean(typingSession),
    scrolling: Boolean(scrollSession),
    clicking: Boolean(clickSession),
    lastInputAt,
    idleForMs,
    idle: idleForMs >= 6e4
  };
}
function mergeObject(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return target;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      mergeObject(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
function mergeWorldStatePatch(state, patch, now = Date.now()) {
  const next = mergeObject(clone(state || EMPTY_STATE), sanitizeWorldStatePatch(patch));
  if (patch?.hikari && typeof patch.hikari === "object" && patch.hikari.updatedAt === void 0 && patch.hikari.stale === void 0) {
    next.hikari.updatedAt = now;
    next.hikari.stale = false;
  }
  next.revision = Math.max(Number(next.revision) || 0, Number(state?.revision) || 0) + 1;
  next.updatedAt = now;
  return next;
}
const RENDERER_HIKARI_FIELDS = /* @__PURE__ */ new Set(["speaking", "listening", "thinking", "dragging", "directInteraction", "currentBehavior", "attentionTarget", "semanticReaction"]);
function sanitizeRendererWorldPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const safe = {};
  if (patch.hikari && typeof patch.hikari === "object" && !Array.isArray(patch.hikari)) {
    safe.hikari = {};
    for (const [key, value] of Object.entries(patch.hikari)) {
      if (!RENDERER_HIKARI_FIELDS.has(key)) continue;
      if (["speaking", "listening", "thinking", "dragging", "directInteraction"].includes(key) && typeof value === "boolean") safe.hikari[key] = value;
      else if (key === "currentBehavior" && typeof value === "string") safe.hikari[key] = value.slice(0, 64);
      else if (key === "attentionTarget" && ["none", "user-pointer", "screen-center"].includes(value)) safe.hikari[key] = value;
      else if (key === "semanticReaction" && (value === null || typeof value === "string")) safe.hikari[key] = typeof value === "string" ? value.slice(0, 64) : null;
    }
    if (!Object.keys(safe.hikari).length) delete safe.hikari;
  }
  if (typeof patch.audio?.microphone?.voiceActive === "boolean") {
    safe.audio = { microphone: { voiceActive: patch.audio.microphone.voiceActive } };
  }
  return safe;
}
const PATCH_SHAPE = EMPTY_STATE;
function sanitizeWorldStatePatch(patch, shape = PATCH_SHAPE) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || !(key in shape)) continue;
    const expected = shape[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (value && typeof value === "object" && !Array.isArray(value)) clean[key] = sanitizeWorldStatePatch(value, expected);
      continue;
    }
    if (Array.isArray(expected)) {
      if (Array.isArray(value)) clean[key] = value.slice(0, 50).map((item) => sanitizeLooseValue(item)).filter((item) => item !== void 0);
      continue;
    }
    if (expected === null) {
      if (value === null) clean[key] = null;
      else if (typeof value === "string") clean[key] = value.slice(0, 1e3);
      else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
      else if (value && typeof value === "object" && !Array.isArray(value)) clean[key] = sanitizeLooseValue(value);
    } else if (typeof expected === "number") {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    } else if (typeof expected === "boolean") {
      if (typeof value === "boolean") clean[key] = value;
    } else if (typeof expected === "string" && typeof value === "string") {
      clean[key] = value.slice(0, 1e3);
    }
  }
  return clean;
}
function sanitizeLooseValue(value, depth = 0) {
  if (depth > 4) return void 0;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  if (typeof value === "string") return value.slice(0, 1e3);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLooseValue(item, depth + 1)).filter((item) => item !== void 0);
  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      const sanitized = sanitizeLooseValue(item, depth + 1);
      if (sanitized !== void 0) clean[key] = sanitized;
    }
    return clean;
  }
  return void 0;
}
function expireWorldStateFields(state, now = Date.now(), { screenSummaryMaxAgeMs = 12e4, screenChangeMaxAgeMs = 12e4, pointerMaxAgeMs = 2e3, activityMaxAgeMs = 3e3, contextMaxAgeMs = 5e3 } = {}) {
  const next = clone(state || EMPTY_STATE);
  const activity = next.desktop?.activity;
  if (activity) {
    activity.idleForMs = activity.lastInputAt ? Math.max(0, now - activity.lastInputAt) : 0;
    activity.stale = !activity.updatedAt || now - activity.updatedAt > activityMaxAgeMs;
    if (activity.stale) activity.typing = activity.scrolling = activity.clicking = false;
  }
  if (next.desktop) next.desktop.contextStale = !next.desktop.contextUpdatedAt || now - next.desktop.contextUpdatedAt > contextMaxAgeMs;
  const screen2 = next.desktop?.screen;
  if (screen2) {
    screen2.changeStale = !screen2.changeAt || now - screen2.changeAt > screenChangeMaxAgeMs;
    if (screen2.changeStale) screen2.changeLevel = "unknown";
  }
  if (screen2?.summaryAt && now - screen2.summaryAt > screenSummaryMaxAgeMs) {
    screen2.lastSummary = "";
    screen2.summaryAt = 0;
    screen2.summaryStale = true;
    screen2.summaryContextKey = "";
  }
  if (screen2 && !screen2.summaryAt) screen2.summaryStale = true;
  const pointer = next.desktop?.pointer;
  if (pointer && (!pointer.updatedAt || now - pointer.updatedAt > pointerMaxAgeMs)) {
    pointer.x = null;
    pointer.y = null;
    pointer.displayId = null;
    pointer.stale = true;
  }
  const systemAudio = next.audio?.system;
  if (systemAudio) systemAudio.stale = !systemAudio.updatedAt || now - systemAudio.updatedAt > 15e3;
  const hikari = next.hikari;
  if (hikari) {
    hikari.stale = !hikari.updatedAt || now - hikari.updatedAt > 6e4;
    if (hikari.stale) {
      hikari.speaking = hikari.listening = hikari.thinking = hikari.dragging = hikari.directInteraction = false;
      hikari.semanticReaction = null;
      hikari.currentBehavior = "idle";
      hikari.attentionTarget = "none";
    }
  }
  if (next.audio?.wake?.expiresAt && now >= next.audio.wake.expiresAt) next.audio.wake = { active: false, expiresAt: 0 };
  return next;
}
class IdleReturnTracker {
  constructor({ minimumIdleMs = 9e4, greetingCooldownMs = 3e5, now = () => Date.now() } = {}) {
    this.minimumIdleMs = Math.max(6e4, minimumIdleMs);
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
const PRIORITY_RANK = { low: 0, normal: 1, important: 2 };
const PIXEL_CHANGE_DELTA = 24;
const MACOS_SCREEN_CAPTURE_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MACOS_ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const BACKGROUND_WINDOW_EXCLUSIONS = /* @__PURE__ */ new Set([
  "com.apple.notificationcenterui",
  "com.apple.WindowManager",
  "com.apple.dock",
  "com.apple.controlcenter",
  "com.apple.systemuiserver"
]);
const execFile$1 = promisify(execFile$2);
function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function cloneBounds(bounds) {
  if (!bounds) return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}
function normalizeActiveWindow(activeWindow) {
  if (!activeWindow?.owner) return null;
  const windowId = Number(activeWindow.id);
  return {
    appName: normalizeText(activeWindow.owner.name) || "Unknown application",
    bundleId: normalizeText(activeWindow.owner.bundleId),
    windowTitle: normalizeText(activeWindow.title),
    windowId: Number.isFinite(windowId) ? windowId : null,
    processId: Number.isFinite(Number(activeWindow.owner.processId)) ? Number(activeWindow.owner.processId) : null,
    bounds: cloneBounds(activeWindow.bounds)
  };
}
function enrichWindowTitleFromSource(context, exactSource) {
  if (!context || normalizeText(context.windowTitle) || !exactSource) return context;
  const windowTitle = normalizeText(exactSource.name);
  return windowTitle ? { ...context, windowTitle } : context;
}
function getContextKey(context) {
  if (!context) return "";
  const owner = context.bundleId || context.appName || "unknown";
  const windowIdentity = context.windowId ?? (context.windowTitle || "unknown");
  return `${owner}:${windowIdentity}`;
}
function sameContext(left, right) {
  return Boolean(left && right && getContextKey(left) === getContextKey(right));
}
function publicContext(context) {
  if (!context) return null;
  return {
    appName: context.appName,
    bundleId: context.bundleId,
    windowTitle: context.windowTitle
  };
}
function sourceWindowId(sourceId) {
  const match = /^window:(\d+):/.exec(sourceId || "");
  return match ? Number(match[1]) : null;
}
function imageSize(image) {
  const size = image?.getSize?.();
  return size && size.width > 0 && size.height > 0 ? size : null;
}
function resizeExact(image, width, height) {
  if (!image || image.isEmpty()) return null;
  return image.resize({ width, height, quality: "good" });
}
function isMasked(x, y, mask) {
  return Boolean(
    mask && x >= mask.x && y >= mask.y && x < mask.x + mask.width && y < mask.y + mask.height
  );
}
function compareCapturedImages(previous, current, config = awarenessConfig.screen) {
  const previousSize = imageSize(previous?.image);
  const currentSize = imageSize(current?.image);
  if (!previousSize || !currentSize || previousSize.width !== currentSize.width || previousSize.height !== currentSize.height) {
    return null;
  }
  const previousBitmap = previous.image.getBitmap();
  const currentBitmap = current.image.getBitmap();
  if (previousBitmap.length !== currentBitmap.length) return null;
  const width = currentSize.width;
  const height = currentSize.height;
  const step = 2;
  let changed = 0;
  let compared = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (isMasked(x, y, previous.mask) || isMasked(x, y, current.mask)) continue;
      const offset = (y * width + x) * 4;
      const blueDelta = Math.abs(previousBitmap[offset] - currentBitmap[offset]);
      const greenDelta = Math.abs(previousBitmap[offset + 1] - currentBitmap[offset + 1]);
      const redDelta = Math.abs(previousBitmap[offset + 2] - currentBitmap[offset + 2]);
      if (Math.max(redDelta, greenDelta, blueDelta) >= PIXEL_CHANGE_DELTA) changed += 1;
      compared += 1;
    }
  }
  if (compared === 0) return null;
  const ratio = changed / compared;
  let level = "none";
  if (ratio >= config.majorChangeThreshold) level = "major";
  else if (ratio >= config.significantChangeThreshold) level = "significant";
  else if (ratio >= config.minorChangeThreshold) level = "minor";
  return {
    ratio,
    level,
    significant: ratio >= config.significantChangeThreshold
  };
}
function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `awareness-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
class DesktopAwarenessService {
  constructor({
    emitCandidate,
    getHikariBounds,
    config = awarenessConfig,
    activeWindowProvider,
    openWindowsProvider,
    captureSourcesProvider,
    mediaPlaybackProvider
  } = {}) {
    this.config = config;
    this.emitCandidate = typeof emitCandidate === "function" ? emitCandidate : () => {
    };
    this.getHikariBounds = typeof getHikariBounds === "function" ? getHikariBounds : () => null;
    this.activeWindowProvider = activeWindowProvider || null;
    this.openWindowsProvider = openWindowsProvider || null;
    this.captureSourcesProvider = captureSourcesProvider || ((options) => desktopCapturer.getSources(options));
    this.mediaPlaybackProvider = mediaPlaybackProvider || null;
    this.mediaPlaybackTracker = new MediaPlaybackStateTracker({
      debounceSamples: this.config.media?.debounceSamples
    });
    this.enabled = false;
    this.inputHook = null;
    this.currentContext = null;
    this.pendingContext = null;
    this.comparisonHistory = /* @__PURE__ */ new Map();
    this.snapshots = /* @__PURE__ */ new Map();
    this.lastDirectInteractionAt = 0;
    this.lastCandidateAt = 0;
    this.pendingCandidate = null;
    this.observationChain = Promise.resolve();
    this.typingSession = null;
    this.scrollSession = null;
    this.clickSession = null;
    this.contextTimer = null;
    this.contextSettleTimer = null;
    this.pendingCandidateTimer = null;
    this.mediaPlaybackTimer = null;
    this.mediaPlaybackPollRunning = false;
    this.lastInputAt = 0;
    this.idleReturnTracker = new IdleReturnTracker(this.config.idleReturn);
    this.status = {
      enabled: false,
      inputMonitoringAvailable: false,
      screenCaptureAvailable: false,
      screenCaptureStatus: process.platform === "darwin" ? "unknown" : "granted",
      activeWindowAvailable: false,
      mediaPlaybackAvailable: false,
      errors: {}
    };
    this.handleKeydown = () => this.recordKeyboardActivity();
    this.handleMousedown = () => this.recordClickActivity();
    this.handleWheel = () => this.recordWheelActivity();
  }
  debug(stage, message, detail) {
    if (!this.config.debug) return;
    if (detail === void 0) console.info(`[AWARENESS ${stage}] ${message}`);
    else console.info(`[AWARENESS ${stage}] ${message}`, detail);
  }
  getStatus() {
    return {
      ...this.status,
      errors: { ...this.status.errors }
    };
  }
  getActivityState(now = Date.now()) {
    return deriveDesktopActivityState(this, now);
  }
  async getGreetingContext() {
    const activeWindowPromise = (async () => {
      if (!this.activeWindowProvider) await this.initializeActiveWindowProvider();
      const context = await this.getActiveContext();
      let foreground = context && !this.isHikariContext(context) ? context : this.currentContext;
      if (!foreground && this.openWindowsProvider) {
        const windows = await this.openWindowsProvider();
        foreground = (Array.isArray(windows) ? windows : []).map(normalizeActiveWindow).find((window) => window && !this.isHikariContext(window) && !BACKGROUND_WINDOW_EXCLUSIONS.has(window.bundleId)) || null;
      }
      return publicContext(foreground);
    })().catch((error) => {
      this.debug("GREETING", "foreground context unavailable", error?.message || error);
      return null;
    });
    const mediaPromise = (async () => {
      if (!this.ensureMediaPlaybackProvider()) return null;
      const isPlaying = await this.mediaPlaybackProvider();
      return typeof isPlaying === "boolean" ? isPlaying ? "playing" : "stopped" : null;
    })().catch((error) => {
      this.debug("GREETING", "media context unavailable", error?.message || error);
      return null;
    });
    const [activeWindow, mediaPlaybackState] = await Promise.all([
      activeWindowPromise,
      mediaPromise
    ]);
    return { activeWindow, mediaPlaybackState };
  }
  async setEnabled(enabled) {
    if (enabled) await this.start();
    else this.stop();
    return this.getStatus();
  }
  async start() {
    if (this.enabled) return this.getStatus();
    this.enabled = true;
    this.status.enabled = true;
    this.status.errors = {};
    this.idleReturnTracker.reset();
    this.refreshScreenCaptureStatus();
    await this.initializeActiveWindowProvider();
    await this.initializeInputMonitoring();
    await this.initializeContextAndBaseline();
    this.initializeMediaPlaybackMonitoring();
    this.debug("STATUS", "desktop awareness enabled", this.getStatus());
    return this.getStatus();
  }
  stop() {
    for (const session2 of [this.typingSession, this.scrollSession, this.clickSession]) {
      if (session2?.timer) clearTimeout(session2.timer);
    }
    if (this.inputHook) {
      this.inputHook.removeListener("keydown", this.handleKeydown);
      this.inputHook.removeListener("mousedown", this.handleMousedown);
      this.inputHook.removeListener("wheel", this.handleWheel);
      try {
        this.inputHook.stop();
      } catch (error) {
        this.debug("STATUS", "input hook stop failed", error?.message || error);
      }
    }
    this.enabled = false;
    this.status.enabled = false;
    this.inputHook = null;
    this.currentContext = null;
    this.pendingContext = null;
    this.typingSession = null;
    this.scrollSession = null;
    this.clickSession = null;
    this.pendingCandidate = null;
    this.mediaPlaybackTracker.reset();
    this.mediaPlaybackPollRunning = false;
    this.comparisonHistory.clear();
    for (const id of this.snapshots.keys()) this.deleteSnapshot(id);
    for (const timer of [this.contextTimer, this.contextSettleTimer, this.pendingCandidateTimer, this.mediaPlaybackTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.contextTimer = null;
    this.contextSettleTimer = null;
    this.pendingCandidateTimer = null;
    this.mediaPlaybackTimer = null;
    this.debug("STATUS", "desktop awareness disabled");
  }
  noteDirectInteraction() {
    this.lastDirectInteractionAt = Date.now();
    this.pendingCandidate = null;
    if (this.pendingCandidateTimer) clearTimeout(this.pendingCandidateTimer);
    this.pendingCandidateTimer = null;
    this.debug("POLICY", "direct Hikari interaction suppression started");
  }
  refreshScreenCaptureStatus() {
    if (process.platform !== "darwin") {
      this.status.screenCaptureAvailable = true;
      this.status.screenCaptureStatus = "granted";
      delete this.status.errors.screenCapture;
      return;
    }
    try {
      const permission = systemPreferences.getMediaAccessStatus("screen");
      this.status.screenCaptureStatus = permission;
      this.status.screenCaptureAvailable = permission === "granted";
      if (this.status.screenCaptureAvailable) delete this.status.errors.screenCapture;
      else this.status.errors.screenCapture = permission;
    } catch (error) {
      this.status.screenCaptureAvailable = false;
      this.status.screenCaptureStatus = "unknown";
      this.status.errors.screenCapture = error?.message || String(error);
    }
  }
  refreshInputMonitoringStatus() {
    if (this.inputHook) {
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
      return true;
    }
    if (process.platform !== "darwin") return this.status.inputMonitoringAvailable;
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    this.status.inputMonitoringAvailable = false;
    this.status.errors.inputMonitoring = trusted ? "Keyboard monitor is not running." : "Accessibility permission is denied.";
    return trusted;
  }
  async refreshPermissionStatus() {
    this.refreshScreenCaptureStatus();
    const trusted = this.refreshInputMonitoringStatus();
    if (this.enabled && trusted && !this.inputHook) await this.initializeInputMonitoring();
    return this.getStatus();
  }
  /**
   * macOS does not expose an Electron API that can grant Screen Recording
   * permission. The supported flow is to open Apple's Privacy pane and let
   * the user grant access, then refresh the status when they return.
   */
  async requestScreenCapturePermission() {
    this.refreshScreenCaptureStatus();
    let settingsOpened = false;
    let openError = null;
    let probeAttempted = false;
    if (process.platform === "darwin" && !this.status.screenCaptureAvailable) {
      probeAttempted = true;
      try {
        await this.captureSourcesProvider({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false
        });
        delete this.status.errors.screenCaptureProbe;
      } catch (error) {
        this.status.errors.screenCaptureProbe = error?.message || String(error);
        this.debug("SCREEN", "permission probe failed", this.status.errors.screenCaptureProbe);
      }
      this.refreshScreenCaptureStatus();
    }
    if (process.platform === "darwin" && !this.status.screenCaptureAvailable) {
      try {
        await shell.openExternal(MACOS_SCREEN_CAPTURE_SETTINGS_URL);
        settingsOpened = true;
      } catch (error) {
        openError = error?.message || String(error);
        this.status.errors.screenCaptureSettings = openError;
      }
    }
    this.refreshScreenCaptureStatus();
    return {
      ...this.getStatus(),
      settingsOpened,
      permissionKind: "screen",
      probeAttempted,
      requiresUserAction: process.platform === "darwin" && !this.status.screenCaptureAvailable,
      error: openError
    };
  }
  async requestInputMonitoringPermission() {
    let settingsOpened = false;
    let promptAttempted = false;
    let openError = null;
    if (process.platform === "darwin" && !this.inputHook) {
      promptAttempted = true;
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      if (trusted) await this.initializeInputMonitoring();
    }
    if (process.platform === "darwin" && !this.status.inputMonitoringAvailable) {
      try {
        await shell.openExternal(MACOS_ACCESSIBILITY_SETTINGS_URL);
        settingsOpened = true;
      } catch (error) {
        openError = error?.message || String(error);
        this.status.errors.inputMonitoringSettings = openError;
      }
    }
    this.refreshInputMonitoringStatus();
    return {
      ...this.getStatus(),
      settingsOpened,
      permissionKind: "inputMonitoring",
      promptAttempted,
      requiresUserAction: process.platform === "darwin" && !this.status.inputMonitoringAvailable,
      error: openError
    };
  }
  async initializeActiveWindowProvider() {
    if (this.activeWindowProvider) {
      this.status.activeWindowAvailable = true;
      return;
    }
    try {
      if (process.platform === "darwin" && app.isPackaged) {
        const helperPath = path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "get-windows",
          "main"
        );
        this.activeWindowProvider = async () => {
          const args = ["--no-accessibility-permission", "--no-screen-recording-permission"];
          const { stdout } = await execFile$1(helperPath, args, { encoding: "utf8" });
          return JSON.parse(stdout);
        };
        this.openWindowsProvider = async () => {
          const args = [
            "--no-accessibility-permission",
            "--no-screen-recording-permission",
            "--open-windows-list"
          ];
          const { stdout } = await execFile$1(helperPath, args, { encoding: "utf8" });
          return JSON.parse(stdout);
        };
        this.status.activeWindowAvailable = true;
        return;
      }
      const { activeWindow, openWindows } = await import("./index-D7v8WbNU.js");
      this.activeWindowProvider = () => activeWindow(activeWindowOptions);
      this.openWindowsProvider = () => openWindows(activeWindowOptions);
      this.status.activeWindowAvailable = true;
    } catch (error) {
      this.status.activeWindowAvailable = false;
      this.status.errors.activeWindow = error?.message || String(error);
      this.debug("STATUS", "active-window support unavailable", this.status.errors.activeWindow);
    }
  }
  async initializeInputMonitoring() {
    if (this.inputHook) {
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
      return;
    }
    if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
      this.status.inputMonitoringAvailable = false;
      this.status.errors.inputMonitoring = "Accessibility permission is denied.";
      return;
    }
    try {
      const { uIOhook } = await import("./index-C5658-X_.js").then((n) => n.i);
      this.inputHook = uIOhook;
      uIOhook.on("keydown", this.handleKeydown);
      uIOhook.on("mousedown", this.handleMousedown);
      uIOhook.on("wheel", this.handleWheel);
      uIOhook.start();
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
    } catch (error) {
      if (this.inputHook) {
        this.inputHook.removeListener("keydown", this.handleKeydown);
        this.inputHook.removeListener("mousedown", this.handleMousedown);
        this.inputHook.removeListener("wheel", this.handleWheel);
      }
      this.inputHook = null;
      this.status.inputMonitoringAvailable = false;
      this.status.errors.inputMonitoring = error?.message || String(error);
      this.debug("STATUS", "global input monitoring unavailable", this.status.errors.inputMonitoring);
    }
  }
  initializeMediaPlaybackMonitoring() {
    if (!this.ensureMediaPlaybackProvider()) return;
    void this.pollMediaPlayback();
  }
  ensureMediaPlaybackProvider() {
    if (process.platform !== "darwin") {
      this.status.mediaPlaybackAvailable = false;
      this.status.errors.mediaPlayback = "System audio activity detection is currently available on macOS only.";
      return false;
    }
    if (!this.mediaPlaybackProvider) {
      const candidates = app.isPackaged ? [path.join(process.resourcesPath, "media-state", "media-state")] : [
        path.join(app.getAppPath(), "tools", "media-state", "media-state"),
        path.resolve(process.cwd(), "tools", "media-state", "media-state")
      ];
      const helperPath = candidates.find((candidate) => existsSync(candidate));
      if (!helperPath) {
        this.status.mediaPlaybackAvailable = false;
        this.status.errors.mediaPlayback = "Media-state helper is missing. Run npm run build.";
        return false;
      }
      this.mediaPlaybackProvider = async () => {
        const { stdout } = await execFile$1(helperPath, [], {
          encoding: "utf8",
          timeout: Math.max(1e3, this.config.media.pollIntervalMs)
        });
        const isPlaying = parseMediaPlaybackOutput(stdout);
        if (isPlaying === null) throw new Error("Media-state helper returned an invalid result.");
        return isPlaying;
      };
    }
    this.status.mediaPlaybackAvailable = true;
    delete this.status.errors.mediaPlayback;
    return true;
  }
  async pollMediaPlayback() {
    if (!this.enabled || !this.mediaPlaybackProvider || this.mediaPlaybackPollRunning) return;
    this.mediaPlaybackPollRunning = true;
    try {
      const isPlaying = await this.mediaPlaybackProvider();
      if (!this.enabled) return;
      this.status.mediaPlaybackAvailable = typeof isPlaying === "boolean";
      if (!this.status.mediaPlaybackAvailable) throw new Error("Media playback state was unavailable.");
      delete this.status.errors.mediaPlayback;
      const transition = this.mediaPlaybackTracker.observe(isPlaying);
      if (transition) await this.handleMediaPlaybackTransition(transition);
    } catch (error) {
      this.status.mediaPlaybackAvailable = false;
      this.status.errors.mediaPlayback = error?.message || String(error);
      this.debug("MEDIA", "playback-state query failed", this.status.errors.mediaPlayback);
    } finally {
      this.mediaPlaybackPollRunning = false;
      if (this.enabled) {
        this.mediaPlaybackTimer = setTimeout(
          () => this.pollMediaPlayback(),
          this.config.media.pollIntervalMs
        );
      }
    }
  }
  async handleMediaPlaybackTransition(transition) {
    let context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) context = this.currentContext;
    const started = transition.state === "playing";
    const candidate = {
      id: createId(),
      timestamp: Date.now(),
      trigger: started ? "media_playback_started" : "media_playback_stopped",
      activity: {},
      media: {
        ...transition,
        source: "system_audio_output"
      },
      context: publicContext(context),
      visualChange: null,
      priority: started ? "important" : "low"
    };
    this.debug("MEDIA", `${transition.previousState} -> ${transition.state}`);
    this.offerCandidate(candidate, null);
  }
  async initializeContextAndBaseline() {
    const context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) return;
    const capture = await this.captureContext(context);
    const resolvedContext = capture?.context || context;
    this.currentContext = resolvedContext;
    if (capture?.comparison) this.rememberComparison(resolvedContext, capture.comparison);
    this.debug("CONTEXT", `${resolvedContext.appName} / ${resolvedContext.windowTitle || "(untitled window)"}`);
  }
  isHikariContext(context) {
    return context?.processId === process.pid || context?.bundleId === "com.electron.hikari";
  }
  isDirectInteractionSuppressed(now = Date.now()) {
    return now - this.lastDirectInteractionAt < this.config.hikariInteraction.suppressionMs;
  }
  recordInputActivity(inputType, now) {
    this.lastInputAt = now;
    const activity = this.idleReturnTracker.record(inputType, now);
    if (activity) {
      void this.observeIdleReturn(activity).catch((error) => this.debug("IDLE", "return context unavailable", error?.message || error));
    }
  }
  async observeIdleReturn(activity) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    const context = await this.getActiveContext();
    if (!this.enabled || this.isHikariContext(context)) return;
    this.offerCandidate({
      id: createId(),
      timestamp: activity.resumedAt,
      trigger: "idle_return",
      activity,
      context: publicContext(context || this.currentContext),
      visualChange: null,
      priority: "important"
    }, null);
  }
  recordKeyboardActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity("typing", now);
    this.debug("RAW", "keyboard activity");
    this.scheduleContextInspection();
    if (!this.typingSession) this.typingSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.typingSession.lastAt = now;
    this.typingSession.count += 1;
    if (this.typingSession.timer) clearTimeout(this.typingSession.timer);
    this.typingSession.timer = setTimeout(() => this.endTypingSession(), this.config.activity.typingPauseMs);
  }
  endTypingSession() {
    const session2 = this.typingSession;
    this.typingSession = null;
    if (!session2 || session2.count < this.config.activity.minimumTypingKeys) {
      this.debug("SESSION", "typing session rejected: too few keys", session2?.count || 0);
      return;
    }
    const activity = {
      durationMs: Math.max(0, session2.lastAt - session2.startedAt),
      eventCount: session2.count
    };
    this.debug("SESSION", "typing session ended", activity);
    this.queueObservation("typing_session_end", activity);
  }
  recordWheelActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity("scrolling", now);
    this.debug("RAW", "wheel activity");
    this.scheduleContextInspection();
    if (!this.scrollSession) this.scrollSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.scrollSession.lastAt = now;
    this.scrollSession.count += 1;
    if (this.scrollSession.timer) clearTimeout(this.scrollSession.timer);
    this.scrollSession.timer = setTimeout(() => this.endScrollSession(), this.config.activity.scrollPauseMs);
  }
  endScrollSession() {
    const session2 = this.scrollSession;
    this.scrollSession = null;
    if (!session2 || session2.count < this.config.activity.minimumWheelEvents) {
      this.debug("SESSION", "scroll session rejected: too few wheel events", session2?.count || 0);
      return;
    }
    const activity = {
      durationMs: Math.max(0, session2.lastAt - session2.startedAt),
      eventCount: session2.count
    };
    this.debug("SESSION", "scroll session ended", activity);
    this.queueObservation("scroll_session_end", activity);
  }
  recordClickActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity("clicking", now);
    this.debug("RAW", "mouse click activity");
    this.scheduleContextInspection();
    if (!this.clickSession) this.clickSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.clickSession.lastAt = now;
    this.clickSession.count += 1;
    if (this.clickSession.timer) clearTimeout(this.clickSession.timer);
    this.clickSession.timer = setTimeout(() => this.endClickSession(), this.config.activity.clickObservationDelayMs);
  }
  endClickSession() {
    const session2 = this.clickSession;
    this.clickSession = null;
    if (!session2) return;
    const activity = {
      durationMs: Math.max(0, session2.lastAt - session2.startedAt),
      eventCount: session2.count
    };
    this.debug("SESSION", "click activity settled", activity);
    this.queueObservation("click_caused_screen_change", activity);
  }
  scheduleContextInspection() {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(
      () => this.inspectPossibleContextChange(),
      this.config.screen.stableWindowDebounceMs
    );
  }
  async inspectPossibleContextChange() {
    this.contextTimer = null;
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    const observed = await this.getActiveContext();
    if (!observed || this.isHikariContext(observed) || sameContext(observed, this.currentContext)) return;
    this.pendingContext = observed;
    if (this.contextSettleTimer) clearTimeout(this.contextSettleTimer);
    this.contextSettleTimer = setTimeout(
      () => this.commitStableContextChange(),
      this.config.screen.stableWindowDebounceMs
    );
  }
  async commitStableContextChange() {
    this.contextSettleTimer = null;
    if (!this.enabled || !this.pendingContext || this.isDirectInteractionSuppressed()) return;
    const confirmed = await this.getActiveContext();
    if (!confirmed || this.isHikariContext(confirmed) || !sameContext(confirmed, this.pendingContext)) return;
    const previous = this.currentContext;
    this.pendingContext = null;
    const capture = await this.captureContext(confirmed);
    const resolvedContext = capture?.context || confirmed;
    this.currentContext = resolvedContext;
    if (capture?.comparison) this.rememberComparison(resolvedContext, capture.comparison);
    const appChanged = Boolean(previous && (previous.bundleId || previous.appName) !== (resolvedContext.bundleId || resolvedContext.appName));
    const trigger = appChanged ? "application_changed" : "window_changed";
    this.debug("CONTEXT", `${resolvedContext.appName} / ${resolvedContext.windowTitle || "(untitled window)"}`);
    this.offerCandidate({
      id: createId(),
      timestamp: Date.now(),
      trigger,
      activity: appChanged ? { fromApp: previous?.appName || null, toApp: resolvedContext.appName } : { fromWindow: previous?.windowTitle || null, toWindow: resolvedContext.windowTitle },
      context: publicContext(resolvedContext),
      visualChange: null,
      priority: "normal"
    }, capture?.semantic);
  }
  queueObservation(trigger, activity) {
    this.observationChain = this.observationChain.catch((error) => this.debug("ERROR", "previous observation failed", error?.message || error)).then(() => this.observeSession(trigger, activity));
  }
  async observeSession(trigger, activity) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) {
      this.debug("POLICY", `${trigger} dropped: direct interaction or awareness disabled`);
      return;
    }
    const context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) return;
    if (!sameContext(context, this.currentContext)) {
      this.scheduleContextInspection();
      this.debug("POLICY", `${trigger} deferred: context is changing`);
      return;
    }
    const capture = await this.captureContext(context);
    const resolvedContext = capture?.context || context;
    this.currentContext = resolvedContext;
    if (!capture?.comparison) {
      if (!this.status.screenCaptureAvailable && trigger !== "click_caused_screen_change") {
        const priority2 = trigger === "scroll_session_end" ? "low" : "normal";
        this.debug("SCREEN", `${trigger} continuing without screenshot permission`);
        this.offerCandidate({
          id: createId(),
          timestamp: Date.now(),
          trigger,
          activity,
          context: publicContext(resolvedContext),
          visualChange: null,
          priority: priority2
        }, null);
      } else {
        this.debug("SCREEN", `${trigger} rejected: screenshot unavailable`);
      }
      return;
    }
    const key = getContextKey(resolvedContext);
    const previous = this.comparisonHistory.get(key);
    this.rememberComparison(resolvedContext, capture.comparison);
    if (!previous) {
      this.debug("SCREEN", `${trigger} established comparison baseline`);
      return;
    }
    const difference = compareCapturedImages(previous, capture.comparison, this.config.screen);
    if (!difference) return;
    this.debug("SCREEN", `change: ${(difference.ratio * 100).toFixed(1)}%`, difference.level);
    const minimumRatio = trigger === "typing_session_end" ? this.config.screen.typingChangeThreshold : trigger === "scroll_session_end" ? this.config.screen.minorChangeThreshold : this.config.screen.significantChangeThreshold;
    if (difference.ratio < minimumRatio) {
      this.debug("CANDIDATE", `${trigger} rejected: visual change below threshold`);
      return;
    }
    let priority = trigger === "scroll_session_end" ? difference.ratio >= this.config.screen.significantChangeThreshold ? "normal" : "low" : "normal";
    if (difference.ratio >= this.config.screen.majorChangeThreshold) priority = "important";
    const candidate = {
      id: createId(),
      timestamp: Date.now(),
      trigger,
      activity,
      context: publicContext(resolvedContext),
      visualChange: {
        ratio: difference.ratio,
        level: difference.level
      },
      priority
    };
    this.offerCandidate(candidate, capture.semantic);
  }
  async getActiveContext() {
    if (!this.activeWindowProvider) return null;
    try {
      const active = await this.activeWindowProvider();
      const context = normalizeActiveWindow(active);
      this.status.activeWindowAvailable = Boolean(context);
      if (context) delete this.status.errors.activeWindow;
      return context;
    } catch (error) {
      this.status.activeWindowAvailable = false;
      this.status.errors.activeWindow = error?.message || String(error);
      this.debug("CONTEXT", "active-window query failed", this.status.errors.activeWindow);
      return null;
    }
  }
  async captureContext(context) {
    this.refreshScreenCaptureStatus();
    if (!this.status.screenCaptureAvailable) return null;
    const semanticWidth = this.config.screen.semanticSnapshotWidth;
    const aspectRatio = context.bounds?.width && context.bounds?.height ? context.bounds.width / context.bounds.height : 16 / 9;
    const semanticHeight = Math.max(1, Math.round(semanticWidth / aspectRatio));
    try {
      const windowSources = await this.captureSourcesProvider({
        types: ["window"],
        thumbnailSize: { width: semanticWidth, height: semanticHeight },
        fetchWindowIcons: false
      });
      const exactSource = context.windowId == null ? null : windowSources.find((source2) => sourceWindowId(source2.id) === context.windowId);
      const enrichedContext = exactSource ? enrichWindowTitleFromSource(context, exactSource) : context;
      const titleSource = windowSources.find((source2) => context.windowTitle && normalizeText(source2.name) === context.windowTitle);
      const source = exactSource || titleSource;
      if (source?.thumbnail && !source.thumbnail.isEmpty()) {
        const prepared2 = this.prepareCapture(source.thumbnail, null);
        return prepared2 ? { ...prepared2, context: enrichedContext } : null;
      }
      const display = context.bounds ? screen.getDisplayMatching(context.bounds) : screen.getPrimaryDisplay();
      const displaySources = await this.captureSourcesProvider({
        types: ["screen"],
        thumbnailSize: {
          width: Math.max(1, Math.round(display.size.width * Math.min(1, semanticWidth / display.size.width))),
          height: Math.max(1, Math.round(display.size.height * Math.min(1, semanticWidth / display.size.width)))
        },
        fetchWindowIcons: false
      });
      const displaySource = displaySources.find((sourceItem) => String(sourceItem.display_id) === String(display.id)) || displaySources[0];
      if (!displaySource?.thumbnail || displaySource.thumbnail.isEmpty()) return null;
      const prepared = this.prepareCapture(displaySource.thumbnail, this.getDisplayMask(display, displaySource.thumbnail));
      return prepared ? { ...prepared, context: enrichedContext } : null;
    } catch (error) {
      this.status.screenCaptureAvailable = false;
      this.status.errors.screenCapture = error?.message || String(error);
      this.debug("SCREEN", "capture failed", this.status.errors.screenCapture);
      return null;
    }
  }
  prepareCapture(semanticImage, semanticMask) {
    const comparisonImage = resizeExact(
      semanticImage,
      this.config.screen.comparisonWidth,
      this.config.screen.comparisonHeight
    );
    if (!comparisonImage) return null;
    const sourceSize = imageSize(semanticImage);
    const comparisonMask = semanticMask && sourceSize ? {
      x: Math.floor(semanticMask.x * this.config.screen.comparisonWidth / sourceSize.width),
      y: Math.floor(semanticMask.y * this.config.screen.comparisonHeight / sourceSize.height),
      width: Math.ceil(semanticMask.width * this.config.screen.comparisonWidth / sourceSize.width),
      height: Math.ceil(semanticMask.height * this.config.screen.comparisonHeight / sourceSize.height)
    } : null;
    return {
      comparison: { image: comparisonImage, mask: comparisonMask },
      semantic: semanticMask ? createMaskedNativeImage(semanticImage, semanticMask) : semanticImage
    };
  }
  getDisplayMask(display, capturedImage) {
    const hikariBounds = cloneBounds(this.getHikariBounds());
    const capturedSize = imageSize(capturedImage);
    if (!hikariBounds || !capturedSize || !display?.bounds) return null;
    const relativeX = hikariBounds.x - display.bounds.x;
    const relativeY = hikariBounds.y - display.bounds.y;
    return {
      x: Math.floor(relativeX * capturedSize.width / display.bounds.width),
      y: Math.floor(relativeY * capturedSize.height / display.bounds.height),
      width: Math.ceil(hikariBounds.width * capturedSize.width / display.bounds.width),
      height: Math.ceil(hikariBounds.height * capturedSize.height / display.bounds.height)
    };
  }
  rememberComparison(context, capture) {
    const key = getContextKey(context);
    this.comparisonHistory.delete(key);
    this.comparisonHistory.set(key, capture);
    while (this.comparisonHistory.size > this.config.memory.recentCandidateLimit) {
      this.comparisonHistory.delete(this.comparisonHistory.keys().next().value);
    }
  }
  offerCandidate(candidate, semanticImage) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    this.pruneSnapshots();
    if (semanticImage && !semanticImage.isEmpty()) {
      const expiresAt = candidate.timestamp + this.config.observation.candidateMaxAgeMs;
      this.snapshots.set(candidate.id, {
        image: semanticImage,
        expiresAt,
        timer: setTimeout(() => this.deleteSnapshot(candidate.id), Math.max(0, expiresAt - Date.now()))
      });
    }
    const now = Date.now();
    const intervalRemaining = this.config.observation.minimumCandidateIntervalMs - (now - this.lastCandidateAt);
    if (intervalRemaining <= 0) {
      let candidateToEmit = candidate;
      if (this.pendingCandidate) {
        if (this.shouldReplaceCandidate(this.pendingCandidate, candidate)) {
          this.deleteSnapshot(this.pendingCandidate.id);
        } else {
          candidateToEmit = this.pendingCandidate;
          this.deleteSnapshot(candidate.id);
        }
        this.pendingCandidate = null;
        if (this.pendingCandidateTimer) clearTimeout(this.pendingCandidateTimer);
        this.pendingCandidateTimer = null;
      }
      this.emitNow(candidateToEmit);
      return;
    }
    if (!this.pendingCandidate || this.shouldReplaceCandidate(this.pendingCandidate, candidate)) {
      if (this.pendingCandidate) this.deleteSnapshot(this.pendingCandidate.id);
      this.pendingCandidate = candidate;
    } else {
      this.deleteSnapshot(candidate.id);
    }
    if (!this.pendingCandidateTimer) {
      this.pendingCandidateTimer = setTimeout(() => {
        this.pendingCandidateTimer = null;
        const pending = this.pendingCandidate;
        this.pendingCandidate = null;
        if (pending && Date.now() - pending.timestamp <= this.config.observation.candidateMaxAgeMs) {
          this.emitNow(pending);
        }
      }, intervalRemaining);
    }
  }
  shouldReplaceCandidate(current, incoming) {
    const currentRank = PRIORITY_RANK[current.priority] ?? 0;
    const incomingRank = PRIORITY_RANK[incoming.priority] ?? 0;
    return incomingRank > currentRank || incomingRank === currentRank && incoming.timestamp >= current.timestamp;
  }
  emitNow(candidate) {
    if (!this.enabled) return;
    this.lastCandidateAt = Date.now();
    this.debug("CANDIDATE", "accepted", candidate);
    this.emitCandidate(candidate);
  }
  async captureScreen() {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return null;
    let context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) context = this.currentContext;
    if (!this.enabled || this.isDirectInteractionSuppressed() || !context || this.isHikariContext(context)) return null;
    let timeout;
    let capture;
    try {
      capture = await Promise.race([
        this.captureContext(context),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(null), 15e3);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!this.enabled || this.isDirectInteractionSuppressed() || !capture?.semantic) return null;
    let image = capture.semantic;
    let size = imageSize(image);
    if (!size) return null;
    if (Math.max(size.width, size.height) > 1920) {
      const ratio = 1920 / Math.max(size.width, size.height);
      image = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: "good" });
      size = imageSize(image);
    }
    let jpeg;
    for (const quality of [this.config.screen.semanticSnapshotJpegQuality || 72, 50, 35]) {
      jpeg = image.toJPEG(quality);
      if (jpeg.length <= MAX_SCREENSHOT_BYTES) break;
    }
    if (!jpeg?.length || jpeg.length > MAX_SCREENSHOT_BYTES || !size) return null;
    return {
      mimeType: "image/jpeg",
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
      context: publicContext(capture.context || context),
      dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`
    };
  }
  requestSnapshot(candidateId) {
    this.pruneSnapshots();
    const snapshot = this.snapshots.get(candidateId);
    if (!snapshot) return null;
    this.deleteSnapshot(candidateId);
    const size = imageSize(snapshot.image);
    if (!size) return null;
    const quality = this.config.screen.semanticSnapshotJpegQuality || 72;
    const jpeg = snapshot.image.toJPEG(quality);
    return {
      candidateId,
      mimeType: "image/jpeg",
      width: size.width,
      height: size.height,
      dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`
    };
  }
  pruneSnapshots() {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.deleteSnapshot(id);
    }
    while (this.snapshots.size > this.config.memory.recentCandidateLimit) {
      this.deleteSnapshot(this.snapshots.keys().next().value);
    }
  }
  deleteSnapshot(candidateId) {
    const snapshot = this.snapshots.get(candidateId);
    if (snapshot?.timer) clearTimeout(snapshot.timer);
    this.snapshots.delete(candidateId);
  }
}
function createMaskedNativeImage(image, mask) {
  const size = imageSize(image);
  if (!size || !mask) return image;
  const bitmap = Buffer.from(image.getBitmap());
  for (let y = Math.max(0, mask.y); y < Math.min(size.height, mask.y + mask.height); y += 1) {
    for (let x = Math.max(0, mask.x); x < Math.min(size.width, mask.x + mask.width); x += 1) {
      const offset = (y * size.width + x) * 4;
      bitmap[offset] = 0;
      bitmap[offset + 1] = 0;
      bitmap[offset + 2] = 0;
      bitmap[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
}
const ADAPTER_ORIGIN = "http://127.0.0.1:8010";
const DEFAULT_STARTUP_TIMEOUT_MS = 24e4;
const DEFAULT_HEALTH_TIMEOUT_MS = 3e3;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 185e3;
const DEFAULT_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const DEFAULT_PYTHON_PATH = "/opt/homebrew/bin/python3.11";
const HEALTH_PATH = "/health";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
function defaultToolDir() {
  const candidates = [
    path.resolve(moduleDirectory, "../tools/companion-tts"),
    path.resolve(moduleDirectory, "../../tools/companion-tts"),
    path.resolve(moduleDirectory, "../../../tools/companion-tts")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "tts.py"))) ?? candidates[0];
}
function abortError() {
  const error = new Error("Local TTS service was disposed");
  error.name = "AbortError";
  return error;
}
function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
function isSuccessfulResponse(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  return Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
}
async function readBoundedBody(response, limit, signal) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error("Local TTS response exceeded the allowed size");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await raceWithSignal(response.arrayBuffer(), signal));
    if (bytes.byteLength > limit) throw new Error("Local TTS response exceeded the allowed size");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => {
    });
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        cancelReader();
        throw new Error("Local TTS response exceeded the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
    }
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
async function readJson(response, signal) {
  const bytes = await readBoundedBody(response, 64 * 1024, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Local TTS adapter returned invalid JSON");
  }
}
function validateInput(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("Synthesis request must be an object");
  }
  if (typeof request.text !== "string") {
    throw new TypeError("Synthesis text must be a string");
  }
  const text = request.text.trim();
  const textLength = Array.from(text).length;
  if (textLength < 1 || textLength > 500) {
    throw new RangeError("Synthesis text must contain 1 to 500 characters");
  }
  const speed = request.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new RangeError("Synthesis speed must be between 0.5 and 2");
  }
  return { text, speed };
}
function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Local TTS adapter returned invalid speech metadata");
  }
  const { audio_url: audioUrl, duration_seconds: durationSeconds, sample_rate: sampleRate, channels, voice } = metadata;
  if (typeof audioUrl !== "string" || !/^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(audioUrl) || typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600 || !Number.isInteger(sampleRate) || sampleRate < 8e3 || sampleRate > 192e3 || !Number.isInteger(channels) || channels < 1 || channels > 2 || voice !== "custom_voice") {
    throw new Error("Local TTS adapter returned invalid speech metadata");
  }
  const audioUrlObject = new URL(audioUrl, ADAPTER_ORIGIN);
  if (audioUrlObject.origin !== ADAPTER_ORIGIN || audioUrlObject.pathname !== audioUrl || audioUrlObject.search || audioUrlObject.hash) {
    throw new Error("Local TTS adapter returned an unsafe audio path");
  }
  return { audioUrl, durationSeconds, sampleRate, channels, voice };
}
function validateWav$1(audio, sampleRate, channels) {
  if (audio.byteLength < 44 || String.fromCharCode(...audio.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...audio.subarray(8, 12)) !== "WAVE") {
    throw new Error("Local TTS adapter returned invalid WAV audio");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (view.getUint32(4, true) + 8 !== audio.byteLength) {
    throw new Error("Local TTS adapter returned invalid WAV audio");
  }
  let offset = 12;
  let formatFound = false;
  let dataFound = false;
  while (offset + 8 <= audio.byteLength) {
    const chunkName = String.fromCharCode(...audio.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > audio.byteLength) throw new Error("Local TTS adapter returned invalid WAV audio");
    if (chunkName === "fmt ") {
      if (chunkSize < 16) throw new Error("Local TTS adapter returned invalid WAV audio");
      const wavChannels = view.getUint16(chunkStart + 2, true);
      const wavSampleRate = view.getUint32(chunkStart + 4, true);
      if (wavChannels !== channels || wavSampleRate !== sampleRate) {
        throw new Error("Local TTS metadata did not match its WAV audio");
      }
      formatFound = true;
    } else if (chunkName === "data") {
      dataFound = true;
    }
    offset = chunkEnd + chunkSize % 2;
  }
  if (offset !== audio.byteLength || !formatFound || !dataFound) {
    throw new Error("Local TTS adapter returned invalid WAV audio");
  }
}
function createLocalTtsService(options = {}) {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawn ?? spawn;
  const toolDir = options.toolDir ?? defaultToolDir();
  const pythonPath = options.pythonPath ?? process.env.HIKARI_TTS_PYTHON ?? DEFAULT_PYTHON_PATH;
  const requestTimeoutMs = options.synthesisTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  for (const [name, value] of Object.entries({ requestTimeoutMs, healthTimeoutMs, startupTimeoutMs, pollIntervalMs, maxAudioBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof spawnImpl !== "function") throw new TypeError("A spawn implementation is required");
  let disposed = false;
  let startupPromise = null;
  let queueTail = Promise.resolve();
  let ownedChild = null;
  const activeControllers = /* @__PURE__ */ new Set();
  const pendingTimers = /* @__PURE__ */ new Set();
  let resolveDisposed;
  const disposedPromise = new Promise((resolve) => {
    resolveDisposed = resolve;
  });
  function assertActive() {
    if (disposed) throw abortError();
  }
  function raceDisposed(promise) {
    return Promise.race([
      promise,
      disposedPromise.then(() => {
        throw abortError();
      })
    ]);
  }
  async function withRequest(url, init, consumer, timeoutMs = requestTimeoutMs) {
    assertActive();
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await raceWithSignal(fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
      assertActive();
      return await raceWithSignal(consumer(response, controller.signal), controller.signal);
    } catch (error) {
      if (disposed) throw abortError();
      if (timedOut) throw new Error("Local TTS request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
    }
  }
  function childFailure() {
    if (!ownedChild) return null;
    if (ownedChild.failure || ownedChild.exited) return new Error("Local TTS adapter process exited unexpectedly");
    const exitCode = ownedChild.process.exitCode;
    if (typeof exitCode === "number") return new Error("Local TTS adapter process exited unexpectedly");
    return null;
  }
  function spawnAdapter() {
    assertActive();
    if (ownedChild && !childFailure()) return;
    let child;
    try {
      child = spawnImpl(pythonPath, ["-u", "tts.py", "serve"], {
        cwd: toolDir,
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      throw new Error("Unable to start the local TTS adapter");
    }
    if (!child || typeof child.once !== "function") {
      throw new Error("Unable to start the local TTS adapter");
    }
    const record = { process: child, failure: null, exited: false };
    child.once("error", () => {
      record.failure = true;
    });
    child.once("exit", () => {
      record.exited = true;
    });
    ownedChild = record;
  }
  async function checkHealth() {
    try {
      return await withRequest(`${ADAPTER_ORIGIN}${HEALTH_PATH}`, { method: "GET" }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) return false;
        const health = await readJson(response, signal);
        return health?.ready === true && health?.voice === "custom_voice";
      }, healthTimeoutMs);
    } catch (error) {
      if (disposed) throw abortError();
      return false;
    }
  }
  function waitForPoll(ms) {
    assertActive();
    let timer;
    const delay = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      pendingTimers.add(timer);
    });
    return raceDisposed(delay).finally(() => {
      clearTimeout(timer);
      pendingTimers.delete(timer);
    });
  }
  async function pollUntilReady(deadline) {
    while (true) {
      assertActive();
      const failure = childFailure();
      if (failure) throw failure;
      if (await checkHealth()) return;
      assertActive();
      const childError = childFailure();
      if (childError) throw childError;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Local TTS adapter did not become ready before the startup timeout");
      await waitForPoll(Math.min(pollIntervalMs, remaining));
    }
  }
  async function startOrReuseAdapter(healthAlreadyChecked = false) {
    assertActive();
    const deadline = Date.now() + startupTimeoutMs;
    if (!healthAlreadyChecked && await checkHealth()) return;
    assertActive();
    spawnAdapter();
    await pollUntilReady(deadline);
  }
  async function ensureAdapterReady() {
    if (startupPromise) {
      await startupPromise;
      assertActive();
      if (await checkHealth()) return;
      startupPromise = null;
    }
    if (!startupPromise) {
      const hadPriorStartup = startupPromise === null && ownedChild !== null;
      startupPromise = startOrReuseAdapter(hadPriorStartup).catch((error) => {
        startupPromise = null;
        throw error;
      });
    }
    return startupPromise;
  }
  async function synthesizeNow(request) {
    assertActive();
    await ensureAdapterReady();
    assertActive();
    const failure = childFailure();
    if (failure) throw failure;
    try {
      const metadata = await withRequest(`${ADAPTER_ORIGIN}/v1/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: request.text, speed: request.speed, cache: true })
      }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) throw new Error("Local TTS speech request failed");
        return validateMetadata(await readJson(response, signal));
      });
      assertActive();
      const absoluteAudioUrl = new URL(metadata.audioUrl, ADAPTER_ORIGIN).href;
      const audio = await withRequest(absoluteAudioUrl, { method: "GET" }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) throw new Error("Local TTS audio request failed");
        const bytes = await readBoundedBody(response, maxAudioBytes, signal);
        validateWav$1(bytes, metadata.sampleRate, metadata.channels);
        return bytes;
      });
      return {
        audio,
        durationSeconds: metadata.durationSeconds,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        voice: metadata.voice
      };
    } catch (error) {
      if (!disposed) startupPromise = null;
      throw error;
    }
  }
  function synthesize(request) {
    let normalized;
    try {
      assertActive();
      normalized = validateInput(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = queueTail.then(() => {
      assertActive();
      return synthesizeNow(normalized);
    });
    queueTail = operation.then(() => void 0, () => void 0);
    return raceDisposed(operation);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    resolveDisposed();
    for (const controller of activeControllers) controller.abort();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    if (ownedChild && !ownedChild.exited && !ownedChild.failure && ownedChild.process.exitCode == null) {
      try {
        ownedChild.process.kill("SIGTERM");
      } catch {
      }
    }
  }
  return { synthesize, dispose };
}
const MAX_TEXT_LENGTH = 500;
const MAX_ERROR_BYTES = 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const HTTP_TTS_TIMEOUT_MS = 45e4;
function validateSynthesisInput(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Synthesis request must be an object");
  }
  if (typeof input.text !== "string") {
    throw new TypeError("Synthesis text must be a string");
  }
  const text = input.text.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Synthesis text must contain 1 to ${MAX_TEXT_LENGTH} characters`);
  }
  if (typeof input.speed !== "number" || !Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) {
    throw new RangeError("Synthesis speed must be between 0.5 and 2");
  }
  return { text, speed: input.speed };
}
function serviceError(message, { code, status, statusText, bodySnippet, cause } = {}) {
  const error = new Error(message, cause === void 0 ? void 0 : { cause });
  if (code) error.code = code;
  if (status !== void 0) error.status = status;
  if (statusText) error.statusText = String(statusText).slice(0, 128);
  if (bodySnippet) error.bodySnippet = bodySnippet.slice(0, MAX_ERROR_BYTES);
  return error;
}
async function readBoundedBytes(response, limit) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw serviceError("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {
          });
          throw serviceError("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  if (typeof response.arrayBuffer === "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) {
      throw serviceError("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
    }
    return new Uint8Array(buffer);
  }
  return new Uint8Array();
}
async function readErrorSnippet(response) {
  try {
    const bytes = await readBoundedBytes(response, MAX_ERROR_BYTES);
    return new TextDecoder().decode(bytes).slice(0, MAX_ERROR_BYTES).trim();
  } catch (error) {
    if (error?.code === "RESPONSE_TOO_LARGE") return "[error response truncated]";
    return "";
  }
}
async function throwForResponse(response, context) {
  const bodySnippet = await readErrorSnippet(response);
  const status = Number.isInteger(response.status) ? response.status : void 0;
  const message = `${context} request failed${status === void 0 ? "" : ` (HTTP ${status})`}` + (bodySnippet ? `: ${bodySnippet}` : "");
  throw serviceError(message, {
    code: `${context.toUpperCase()}_HTTP_ERROR`,
    status,
    statusText: response.statusText,
    bodySnippet
  });
}
function validateSpeechMetadata(durationSeconds, sampleRate, channels) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) {
    throw serviceError("TTS service returned invalid audio duration", { code: "INVALID_TTS_METADATA" });
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8e3 || sampleRate > 192e3) {
    throw serviceError("TTS service returned invalid sample rate", { code: "INVALID_TTS_METADATA" });
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw serviceError("TTS service returned invalid channel count", { code: "INVALID_TTS_METADATA" });
  }
}
function validateWav(audio, sampleRate, channels) {
  const fail = () => {
    throw serviceError("TTS service returned invalid WAV audio", { code: "INVALID_TTS_AUDIO" });
  };
  if (audio.byteLength < 44) fail();
  const ascii = (offset2, count) => String.fromCharCode(...audio.subarray(offset2, offset2 + count));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") fail();
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (view.getUint32(4, true) + 8 !== audio.byteLength) fail();
  let offset = 12;
  let formatFound = false;
  let dataFound = false;
  while (offset + 8 <= audio.byteLength) {
    const chunkName = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > audio.byteLength) fail();
    if (chunkName === "fmt ") {
      if (chunkSize < 16) fail();
      if (view.getUint16(chunkStart + 2, true) !== channels || view.getUint32(chunkStart + 4, true) !== sampleRate) {
        throw serviceError("TTS metadata does not match its WAV audio", { code: "TTS_METADATA_MISMATCH" });
      }
      formatFound = true;
    }
    if (chunkName === "data") dataFound = true;
    offset = chunkEnd + chunkSize % 2;
  }
  if (offset !== audio.byteLength || !formatFound || !dataFound) fail();
}
function makeRequestController(signal, timeoutMs, activeControllers) {
  const controller = new AbortController();
  activeControllers.add(controller);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(serviceError("TTS request timed out", { code: "TTS_TIMEOUT" })), timeoutMs) : null;
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      activeControllers.delete(controller);
    }
  };
}
function createHttpTtsClient({
  fetchImpl = globalThis.fetch,
  endpoint = "/api/tts",
  timeoutMs = HTTP_TTS_TIMEOUT_MS,
  maxAudioBytes = MAX_AUDIO_BYTES
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const activeControllers = /* @__PURE__ */ new Set();
  let disposed = false;
  return {
    async synthesize(input, { signal } = {}) {
      if (disposed) throw serviceError("TTS client is disposed", { code: "SERVICE_DISPOSED" });
      const request = validateSynthesisInput(input);
      const requestController = makeRequestController(signal, timeoutMs, activeControllers);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/wav" },
          body: JSON.stringify(request),
          signal: requestController.signal
        });
        if (!response.ok) await throwForResponse(response, "TTS");
        const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (contentType && contentType !== "audio/wav" && contentType !== "audio/x-wav" && contentType !== "application/octet-stream") {
          throw serviceError("TTS service returned a non-WAV response", { code: "INVALID_TTS_AUDIO" });
        }
        const durationSeconds = Number(response.headers?.get?.("x-audio-duration"));
        const sampleRate = Number(response.headers?.get?.("x-audio-sample-rate"));
        const channels = Number(response.headers?.get?.("x-audio-channels"));
        validateSpeechMetadata(durationSeconds, sampleRate, channels);
        const audio = await readBoundedBytes(response, maxAudioBytes);
        validateWav(audio, sampleRate, channels);
        return { audio, durationSeconds, sampleRate, channels, voice: "custom_voice" };
      } finally {
        requestController.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of activeControllers) controller.abort(serviceError("TTS client is disposed", { code: "SERVICE_DISPOSED" }));
    }
  };
}
const DEFAULT_TIMEOUT_MS = 45e4;
function isLoopbackAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255));
}
function validateRemoteTtsUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2048) {
    throw new TypeError("Remote TTS requires a configured loopback URL");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new TypeError("Remote TTS URL must be a valid loopback HTTP URL", { cause });
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !isLoopbackAddress(url.hostname)) {
    throw new TypeError("Remote TTS URL must use HTTP on a loopback address");
  }
  return url.toString().replace(/\/+$/, "");
}
function createRemoteTtsService({
  url,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 9e5) {
    throw new RangeError("Remote TTS timeout must be between 1 and 900000 milliseconds");
  }
  const baseUrl = validateRemoteTtsUrl(url);
  const client = createHttpTtsClient({
    fetchImpl,
    endpoint: `${baseUrl}/api/tts`,
    timeoutMs
  });
  return {
    synthesize(input, options) {
      return client.synthesize(input, options);
    },
    dispose() {
      client.dispose();
    }
  };
}
const execFile = promisify(execFile$2);
function parseOutputVolume(value) {
  const match = /^(\d+)\s+((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  const deviceId = Number(match[1]);
  const scalar = Number(match[2]);
  return Number.isSafeInteger(deviceId) && deviceId > 0 && Number.isFinite(scalar) && scalar >= 0 && scalar <= 1 ? { deviceId, scalar } : null;
}
class ReplyVolumeService {
  constructor({ helperPath, execute = execFile, fadeMs = 350, mediaPlaying } = {}) {
    this.helperPath = helperPath;
    this.execute = execute;
    this.fadeMs = fadeMs;
    this.mediaPlaying = mediaPlaying || (async () => String(await this.call([])).trim() === "1");
    this.active = null;
    this.nextSessionId = 1;
    this.chain = Promise.resolve();
  }
  serialize(operation) {
    const result = this.chain.catch(() => {
    }).then(operation);
    this.chain = result.catch(() => {
    });
    return result;
  }
  async call(args) {
    const result = await this.execute(this.helperPath, args, {
      encoding: "utf8",
      timeout: 3e3
    });
    return result?.stdout ?? "";
  }
  async readVolume() {
    return parseOutputVolume(await this.call(["volume-get"]));
  }
  async ramp(deviceId, scalar) {
    await this.call([
      "volume-ramp",
      String(deviceId),
      String(Math.max(0, Math.min(1, scalar))),
      String(this.fadeMs)
    ]);
  }
  begin({ canBoost = true } = {}) {
    return this.serialize(async () => {
      if (this.active) await this.restoreActive();
      const sessionId = String(this.nextSessionId++);
      const fallback = { sessionId, voiceGain: 0.9, mediaDucked: false };
      this.active = { sessionId, duck: null };
      if (!this.helperPath) return fallback;
      try {
        const mediaPlaying = await this.mediaPlaying();
        if (!mediaPlaying) return fallback;
        fallback.voiceGain = 0.45;
        if (!canBoost) return fallback;
        const volume = await this.readVolume();
        if (!volume || volume.scalar <= 0.01) return fallback;
        const targetScalar = volume.scalar * 0.7;
        const duck = { ...volume, targetScalar };
        this.active.duck = duck;
        await this.ramp(volume.deviceId, targetScalar);
        return { sessionId, voiceGain: 0.45 / 0.7, mediaDucked: true };
      } catch {
        await this.restoreActive({ allowPartialRamp: true });
        this.active = { sessionId, duck: null };
        return fallback;
      }
    });
  }
  end(sessionId) {
    return this.serialize(async () => {
      if (!this.active || this.active.sessionId !== sessionId) return;
      await this.restoreActive();
    });
  }
  restore() {
    return this.serialize(() => this.restoreActive());
  }
  async restoreActive({ allowPartialRamp = false } = {}) {
    const active = this.active;
    this.active = null;
    if (!active?.duck) return;
    try {
      const current = await this.readVolume();
      if (!current || current.deviceId !== active.duck.deviceId) return;
      const atTarget = Math.abs(current.scalar - active.duck.targetScalar) <= 5e-3;
      const betweenRampEndpoints = current.scalar >= Math.min(
        active.duck.targetScalar,
        active.duck.scalar
      ) - 5e-3 && current.scalar <= Math.max(
        active.duck.targetScalar,
        active.duck.scalar
      ) + 5e-3;
      if (!atTarget && !(allowPartialRamp && betweenRampEndpoints)) return;
      await this.ramp(active.duck.deviceId, active.duck.scalar);
    } catch {
    }
  }
}
class SpeechToTextService {
  constructor({ executable = "", spawn: spawn$1 = spawn, platform = process.platform, locale = process.env.HIKARI_STT_LOCALE || "", timeoutMs = 45e3 } = {}) {
    this.executable = executable;
    this.spawn = spawn$1;
    this.platform = platform;
    this.locale = locale;
    this.timeoutMs = timeoutMs;
    this.running = false;
  }
  getStatus() {
    const available = this.platform === "darwin" && Boolean(this.executable && existsSync(this.executable));
    return { available, status: available ? "ready" : "unavailable", language: this.locale || "system", backend: "apple-speech-on-device", reason: available ? "" : "native_speech_helper_missing" };
  }
  async transcribe(samples) {
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason);
    if (this.running) throw new Error("transcription_busy");
    if (!(samples instanceof Float32Array) || samples.length < 1600 || samples.length > 16e5) throw new TypeError("Expected 0.1 to 100 seconds of 16 kHz mono audio");
    this.running = true;
    const wav = encodeFloat32Wav(samples, 16e3);
    try {
      return await new Promise((resolve, reject) => {
        const args = this.locale ? ["--locale", this.locale] : [];
        const child = this.spawn(this.executable, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("transcription_timeout"));
        }, this.timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.length > 65536) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.slice(0, 4096);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          let result;
          try {
            result = JSON.parse(stdout);
          } catch {
            result = null;
          }
          if (code !== 0 || !result || result.error) reject(new Error(result?.error || stderr.trim() || `speech_exit_${code}`));
          else resolve(String(result.text || "").trim());
        });
        child.stdin.end(wav);
      });
    } finally {
      this.running = false;
      wav.fill(0);
      samples.fill(0);
    }
  }
}
function encodeFloat32Wav(samples, sampleRate = 16e3) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buffer;
}
function fitWindowToWorkArea(bounds, workArea) {
  if (![
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    workArea.x,
    workArea.y,
    workArea.width,
    workArea.height
  ].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || workArea.width <= 0 || workArea.height <= 0) {
    throw new TypeError("Invalid window bounds");
  }
  const ratio = Math.min(1, workArea.width / bounds.width, workArea.height / bounds.height);
  const width = Math.max(1, Math.floor(bounds.width * ratio));
  const height = Math.max(1, Math.floor(bounds.height * ratio));
  return {
    x: Math.max(workArea.x, Math.min(Math.round(bounds.x), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(bounds.y), workArea.y + workArea.height - height)),
    width,
    height
  };
}
function constrainWindow(window, screen2, requested = window.getBounds()) {
  const display = screen2.getDisplayMatching(requested);
  const fitted = fitWindowToWorkArea(requested, display.workArea);
  const current = window.getBounds();
  if (Object.keys(fitted).some((key) => fitted[key] !== current[key])) window.setBounds(fitted);
  return window.getBounds();
}
function keepWindowOnScreen(window, screen2) {
  let adjusting = false;
  const enforce = () => {
    if (adjusting || window.isDestroyed()) return;
    adjusting = true;
    try {
      constrainWindow(window, screen2);
    } finally {
      adjusting = false;
    }
  };
  window.on("move", enforce);
  window.on("resize", enforce);
  screen2.on("display-metrics-changed", enforce);
  screen2.on("display-removed", enforce);
  window.once("closed", () => {
    screen2.removeListener("display-metrics-changed", enforce);
    screen2.removeListener("display-removed", enforce);
  });
  enforce();
}
class MusicBeatDetector {
  constructor() {
    this.reset();
  }
  reset() {
    this.average = 0;
    this.previousBass = 0;
    this.lastFrameAt = null;
    this.lastBeatAt = null;
    this.beat = 0;
    this.intervals = [];
    this.rawIntervals = [];
    this.intervalMs = null;
    this.targetIntervalMs = null;
    this.lastAudibleAt = null;
  }
  learnTempo(interval) {
    if (interval < 300 || interval > 4500) return;
    this.rawIntervals.push(interval);
    this.rawIntervals = this.rawIntervals.slice(-3);
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const rawMedian = median(this.rawIntervals);
    const changedTempo = this.intervalMs !== null && this.rawIntervals.length === 3 && this.rawIntervals.every((value) => Math.abs(value / rawMedian - 1) < 0.08) && Math.abs(rawMedian / this.intervalMs - 1) > 0.12 && rawMedian <= 1500;
    if (changedTempo) this.intervals = [rawMedian, rawMedian, rawMedian];
    else if (this.intervalMs !== null) {
      const beats = Math.round(interval / this.intervalMs);
      if (beats >= 2 && beats <= 3 && Math.abs(interval / beats / this.intervalMs - 1) < 0.12) interval /= beats;
    }
    if (interval > 1500) return;
    this.intervals.push(interval);
    this.intervals = this.intervals.slice(-9);
    if (this.intervals.length < 3) return;
    const centre = median(this.intervals);
    const inliers = this.intervals.filter((value) => Math.abs(value / centre - 1) < 0.12);
    const target = inliers.reduce((sum, value) => sum + value, 0) / inliers.length;
    if (this.intervalMs === null) this.intervalMs = this.targetIntervalMs = target;
    else {
      if (Math.abs(target / this.targetIntervalMs - 1) > 0.03) this.targetIntervalMs = target;
      this.intervalMs += (this.targetIntervalMs - this.intervalMs) * 0.2;
      if (Math.abs(this.intervalMs / this.targetIntervalMs - 1) < 5e-3) this.intervalMs = this.targetIntervalMs;
    }
  }
  update(frame, now = Date.now()) {
    const level = Math.max(0, Math.min(1, Number(frame.level) || 0));
    const bass = Math.max(0, Math.min(1, Number(frame.bass) || 0));
    const delta = this.lastFrameAt === null ? 40 : Math.max(1, Math.min(200, now - this.lastFrameAt));
    if (this.lastFrameAt !== null && now - this.lastFrameAt > 1500) this.reset();
    if (level >= 2e-3) {
      if (this.lastAudibleAt !== null && now - this.lastAudibleAt > 8e3) this.reset();
      this.lastAudibleAt = now;
    }
    const onset = bass > Math.max(4e-3, this.average * 1.5) && bass > this.previousBass * 1.12 && (this.lastBeatAt === null || now - this.lastBeatAt >= 240);
    if (onset) {
      if (this.lastBeatAt !== null) {
        this.learnTempo(now - this.lastBeatAt);
      }
      this.lastBeatAt = now;
      this.beat++;
    }
    this.average += (bass - this.average) * (1 - Math.exp(-delta / 1400));
    this.previousBass = bass;
    this.lastFrameAt = now;
    return {
      level,
      beat: this.beat,
      lastBeatAt: this.lastBeatAt,
      intervalMs: this.intervalMs,
      active: this.lastAudibleAt !== null && now - this.lastAudibleAt < 4e3,
      updatedAt: now
    };
  }
}
class MusicBeatService {
  constructor({
    executable,
    spawn: spawn$1 = spawn,
    available = () => process.platform === "darwin" && existsSync(executable),
    excludePids = () => [process.pid],
    onSignal = () => {
    },
    onStatus = () => {
    },
    now = () => Date.now(),
    mediaPlaying = async () => false,
    startupTimeoutMs = 3e4,
    silentTimeoutMs = 15e3
  } = {}) {
    Object.assign(this, { executable, spawn: spawn$1, available, excludePids, onSignal, onStatus, now, mediaPlaying, startupTimeoutMs, silentTimeoutMs });
    this.detector = new MusicBeatDetector();
    this.child = null;
    this.status = { state: "off" };
    this.starting = null;
  }
  setStatus(status) {
    this.status = status;
    this.onStatus(status);
    return status;
  }
  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(this.status);
    if (!this.available()) return Promise.resolve(this.setStatus({ state: "error", reason: "Music sway requires macOS 14.2 or later and the native helper." }));
    this.detector.reset();
    this.setStatus({ state: "starting" });
    let child;
    try {
      child = this.spawn(this.executable, this.excludePids().map(String), { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return Promise.resolve(this.setStatus({ state: "error", reason: "Could not start music analysis." }));
    }
    this.child = child;
    let buffer = "", ready = false, audible = false, quietSince = null, checking = false;
    const pending = new Promise((resolve) => {
      const settle = (status) => {
        clearTimeout(this.startupTimer);
        resolve(status);
      };
      this.settleStart = settle;
      this.startupTimer = setTimeout(() => {
        if (this.child !== child) return;
        this.stop({ state: "error", reason: "System audio access is needed. Allow Hikari in macOS System Audio Recording settings, then try again." });
      }, this.startupTimeoutMs);
      const fail = (reason) => {
        if (this.child !== child) return;
        this.stop({ state: "error", reason });
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => {
      });
      child.stderr.on("data", () => {
      });
      child.stdout.on("data", (chunk) => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 65536) {
          fail("Music analysis returned invalid data.");
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0 && this.child === child) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame.type === "error") {
            fail(frame.stage === "unsupported" ? "Music sway requires macOS 14.2 or later." : "System audio capture could not start. Allow Hikari in System Audio Recording settings, then try again.");
          } else if (frame.type === "ready") {
            ready = true;
            settle(this.setStatus({ state: "listening" }));
          } else if (frame.type === "frame" && ready && Number.isFinite(frame.level) && Number.isFinite(frame.bass)) {
            const signal = this.detector.update(frame, this.now());
            if (signal.active && this.status.warning) this.setStatus({ state: "listening" });
            this.onSignal(signal);
            audible ||= signal.active;
            if (signal.active) quietSince = null;
            else quietSince ??= this.now();
            if (!audible && quietSince !== null && this.now() - quietSince >= this.silentTimeoutMs && !checking) {
              checking = true;
              Promise.resolve().then(() => this.mediaPlaying()).then((playing) => {
                if (this.child === child && !audible && playing) this.setStatus({
                  state: "listening",
                  warning: "No audio captured. If music is playing, check Hikari’s System Audio Recording permission."
                });
              }).catch(() => {
              }).finally(() => {
                checking = false;
                quietSince = this.now();
              });
            }
          }
        }
      });
      child.once("error", () => fail("Could not start music analysis."));
      child.once("close", () => fail("Music analysis stopped. Toggle Music beat sway to try again."));
      this.exclusionTimer = setInterval(() => {
        if (this.child === child && !child.stdin.destroyed) child.stdin.write(JSON.stringify(this.excludePids()) + "\n");
      }, 1e3);
    }).finally(() => {
      if (this.starting === pending) {
        this.starting = null;
        this.settleStart = null;
      }
    });
    this.starting = pending;
    return pending;
  }
  stop(status = { state: "off" }) {
    clearTimeout(this.startupTimer);
    clearInterval(this.exclusionTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      timer.unref?.();
      child.once("close", () => clearTimeout(timer));
    }
    this.detector.reset();
    this.onSignal({ active: false, level: 0, beat: 0, lastBeatAt: null, intervalMs: null, updatedAt: this.now() });
    this.setStatus(status);
    this.settleStart?.(status);
    this.starting = null;
    this.settleStart = null;
    return status;
  }
}
const __filename$1 = fileURLToPath$1(import.meta.url);
const __dirname$1 = path$1.dirname(__filename$1);
const isDev = process.env.NODE_ENV === "development" || !existsSync$1(path$1.join(__dirname$1, "../dist/index.html"));
let mainWindow = null;
let awarenessService = null;
let localTtsService = null;
let replyVolumeService = null;
let restoringVolumeForQuit = false;
let worldState = createWorldState();
let pointerPoll = null;
let contextPoll = null;
let audioPoll = null;
let activityPoll = null;
let sttService = null;
let musicBeatService = null;
let voiceListeningEnabled = false;
let lastPointer = null;
let lastDesktopContextKey = "";
const manualScreenCapture = createScreenCaptureService({
  getSources: (options) => desktopCapturer.getSources(options),
  getDisplay: () => mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()) : null,
  getPermissionStatus: () => systemPreferences.getMediaAccessStatus("screen")
});
function publishWorldPatch(patch) {
  worldState = mergeWorldStatePatch(worldState, patch);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("world-state:patch", patch);
  }
}
async function pollDesktopContext() {
  const service = awarenessService;
  if (!service) return;
  if (!service.activeWindowProvider) await service.initializeActiveWindowProvider();
  service.refreshScreenCaptureStatus();
  let context = await service.getActiveContext().catch(() => null);
  if (context && service.isHikariContext(context)) {
    const windows = await service.openWindowsProvider?.().catch(() => null);
    context = (Array.isArray(windows) ? windows : []).map((window) => ({
      appName: window?.owner?.name || "",
      bundleId: window?.owner?.bundleId || "",
      windowTitle: window?.title || "",
      windowId: Number.isFinite(Number(window?.id)) ? Number(window.id) : null,
      bounds: window?.bounds || null,
      processId: Number(window?.owner?.processId) || null
    })).find((window) => window.appName && !service.isHikariContext(window)) || null;
  }
  const contextKey = context ? `${context.bundleId || context.appName || "unknown"}:${context.windowId ?? context.windowTitle ?? "unknown"}` : "";
  const contextChanged = Boolean(lastDesktopContextKey && contextKey && contextKey !== lastDesktopContextKey);
  lastDesktopContextKey = contextKey || lastDesktopContextKey;
  const observedAt = Date.now();
  publishWorldPatch({ desktop: {
    appName: context?.appName || "",
    bundleId: context?.bundleId || "",
    windowTitle: context?.windowTitle || "",
    windowId: context?.windowId ?? null,
    windowBounds: context?.bounds || null,
    contextUpdatedAt: observedAt,
    contextStale: !context,
    screen: contextChanged ? { available: Boolean(service.getStatus().screenCaptureAvailable), visionAvailable: Boolean(service.getStatus().screenCaptureAvailable), changeLevel: "unknown", changeAt: 0, changeStale: true, lastSummary: "", summaryAt: 0, summaryStale: true, summaryContextKey: "" } : { available: Boolean(service.getStatus().screenCaptureAvailable), visionAvailable: Boolean(service.getStatus().screenCaptureAvailable) }
  }, browser: { available: false } });
}
function pollActivityState() {
  if (!awarenessService) return;
  const idleForMs = Math.max(0, (Number(powerMonitor.getSystemIdleTime()) || 0) * 1e3);
  publishWorldPatch({ desktop: { activity: { ...awarenessService.getActivityState(), idleForMs, idle: idleForMs >= 6e4, updatedAt: Date.now(), stale: false } } });
}
async function pollSystemAudio(service) {
  if (process.platform !== "darwin" || !service.ensureMediaPlaybackProvider()) {
    publishWorldPatch({ audio: { system: { available: false, updatedAt: Date.now() } } });
    return;
  }
  try {
    const [rawAudioState, output] = await Promise.all([
      getReplyVolumeService().call(["audio-state"]).catch(() => ""),
      getReplyVolumeService().readVolume().catch(() => null)
    ]);
    const audioState = parseSystemAudioOutput(rawAudioState);
    publishWorldPatch({ audio: { system: {
      available: audioState?.available ?? false,
      stale: false,
      captureAvailable: musicBeatService?.status.state === "listening",
      running: audioState?.running ?? false,
      volume: audioState?.volume ?? output?.scalar ?? null,
      muted: audioState?.muted ?? null,
      level: null,
      classification: "unknown",
      confidence: 0,
      updatedAt: Date.now()
    } } });
  } catch {
    publishWorldPatch({ audio: { system: { available: false, updatedAt: Date.now() } } });
  }
}
function startWorldStatePolling() {
  if (pointerPoll || contextPoll || activityPoll) return;
  void pollDesktopContext();
  pollActivityState();
  void pollSystemAudio(awarenessService);
  contextPoll = setInterval(() => void pollDesktopContext(), 1500);
  activityPoll = setInterval(pollActivityState, 500);
  audioPoll = setInterval(() => void pollSystemAudio(awarenessService), 5e3);
  pointerPoll = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    const moved = !lastPointer || Math.abs(point.x - lastPointer.x) >= 4 || Math.abs(point.y - lastPointer.y) >= 4;
    if (!moved) return;
    lastPointer = point;
    const display = screen.getDisplayNearestPoint(point);
    publishWorldPatch({ desktop: { pointer: { ...point, displayId: display?.id ?? null, updatedAt: Date.now(), stale: false } } });
  }, 100);
}
function stopWorldStatePolling() {
  clearInterval(pointerPoll);
  clearInterval(contextPoll);
  clearInterval(activityPoll);
  clearInterval(audioPoll);
  pointerPoll = null;
  contextPoll = null;
  activityPoll = null;
  audioPoll = null;
}
function getSttService() {
  if (!sttService) {
    const candidates = app.isPackaged ? [path$1.join(process.resourcesPath, "voice-stt", "voice-stt")] : [
      path$1.join(app.getAppPath(), "tools", "voice-stt", "voice-stt"),
      path$1.resolve(__dirname$1, "../../tools/voice-stt/voice-stt"),
      path$1.resolve(__dirname$1, "../tools/voice-stt/voice-stt")
    ];
    sttService = new SpeechToTextService({ executable: process.env.HIKARI_SPEECH_HELPER || candidates.find((candidate) => existsSync$1(candidate)) || candidates[0] });
  }
  return sttService;
}
function getReplyVolumeService() {
  if (!replyVolumeService) {
    const candidates = app.isPackaged ? [path$1.join(process.resourcesPath, "media-state", "media-state")] : [
      path$1.join(app.getAppPath(), "tools", "media-state", "media-state"),
      path$1.resolve(__dirname$1, "../tools/media-state/media-state")
    ];
    replyVolumeService = new ReplyVolumeService({
      helperPath: candidates.find((candidate) => existsSync$1(candidate)),
      // The voice player's own AudioContext opens the output device before
      // playback. Exclude Hikari's processes so it cannot count as media.
      mediaPlaying: async () => String(await replyVolumeService.call([
        "playing-except",
        String(process.pid),
        ...app.getAppMetrics().map((metric) => String(metric.pid))
      ])).trim() === "1"
    });
  }
  return replyVolumeService;
}
function getLocalTtsService() {
  if (!localTtsService && process.env.HIKARI_SERVICE_URL) {
    localTtsService = createRemoteTtsService({ url: process.env.HIKARI_SERVICE_URL });
  }
  if (!localTtsService) {
    const candidates = app.isPackaged ? [path$1.join(process.resourcesPath, "companion-tts")] : [
      path$1.join(app.getAppPath(), "tools/companion-tts"),
      path$1.resolve(__dirname$1, "../tools/companion-tts"),
      path$1.resolve(__dirname$1, "../../tools/companion-tts")
    ];
    const toolDir = process.env.HIKARI_TTS_TOOL_DIR || candidates.find(
      (directory) => existsSync$1(path$1.join(directory, "tts.py"))
    ) || candidates[0];
    localTtsService = createLocalTtsService({ toolDir });
  }
  return localTtsService;
}
function getMusicBeatService() {
  if (!musicBeatService) {
    const candidates = app.isPackaged ? [path$1.join(process.resourcesPath, "music-beat", "music-beat")] : [path$1.join(app.getAppPath(), "tools/music-beat/music-beat"), path$1.resolve(__dirname$1, "../tools/music-beat/music-beat")];
    const send = (channel, value) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, value);
    };
    musicBeatService = new MusicBeatService({
      executable: candidates.find((candidate) => existsSync$1(candidate)) || candidates[0],
      excludePids: () => [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)],
      mediaPlaying: () => getReplyVolumeService().mediaPlaying(),
      onSignal: (value) => send("music-beat:signal", value),
      onStatus: (value) => send("music-beat:status", value)
    });
  }
  return musicBeatService;
}
function isMainRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function createAwarenessService() {
  if (awarenessService) return awarenessService;
  awarenessService = new DesktopAwarenessService({
    getHikariBounds: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
    emitCandidate: (candidate) => {
      const context = candidate.context || {};
      const contextKey = `${context.bundleId || context.appName || "unknown"}:${candidate.windowId ?? context.windowId ?? context.windowTitle ?? "unknown"}`;
      const appWindow = [context.appName, context.windowTitle].filter(Boolean).join(" — ");
      const observedAt = candidate.timestamp || Date.now();
      const idleForMs = Math.max(0, (Number(powerMonitor.getSystemIdleTime()) || 0) * 1e3);
      const activityLabel = candidate.trigger === "typing_session_end" ? "a typing session was observed" : candidate.trigger === "scroll_session_end" ? "a scrolling session was observed" : "desktop activity changed";
      const patch = { desktop: {
        appName: context.appName || "",
        bundleId: context.bundleId || "",
        windowTitle: context.windowTitle || "",
        windowId: context.windowId ?? candidate.windowId ?? null,
        contextUpdatedAt: observedAt,
        contextStale: !context.appName,
        activity: {
          ...awarenessService?.getActivityState?.() || {},
          idleForMs,
          idle: idleForMs >= 6e4,
          updatedAt: observedAt,
          stale: false
        },
        screen: {
          available: Boolean(awarenessService?.getStatus().screenCaptureAvailable),
          visionAvailable: Boolean(awarenessService?.getStatus().screenCaptureAvailable)
        }
      } };
      if (candidate.visualChange || ["application_changed", "window_changed", "typing_session_end", "scroll_session_end", "click_caused_screen_change"].includes(candidate.trigger)) {
        patch.desktop.screen = {
          ...patch.desktop.screen,
          changeLevel: candidate.visualChange?.level || "unknown",
          changeAt: observedAt,
          changeStale: false,
          lastSummary: appWindow ? `Active window: ${appWindow}; ${activityLabel}. Window content was not interpreted.` : `${activityLabel}. Window content was not interpreted.`,
          summaryAt: observedAt,
          summaryStale: false,
          summaryContextKey: contextKey
        };
      }
      if (candidate.media?.state === "playing" || candidate.media?.state === "stopped") {
        patch.audio = { system: { available: true, running: candidate.media.state === "playing", updatedAt: observedAt, stale: false } };
      }
      publishWorldPatch(patch);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("awareness:candidate", candidate);
      }
    }
  });
  return awarenessService;
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 900,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: {
      preload: existsSync$1(path$1.join(__dirname$1, "preload.js")) ? path$1.join(__dirname$1, "preload.js") : path$1.resolve(__dirname$1, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  keepWindowOnScreen(mainWindow, screen);
  if (isDev) {
    mainWindow.loadURL("http://localhost:5174/electron/index.html");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path$1.join(__dirname$1, "../dist/index.html"));
  }
  mainWindow.once("closed", () => {
    musicBeatService?.stop();
    awarenessService?.stop();
    stopWorldStatePolling();
    voiceListeningEnabled = false;
    void replyVolumeService?.restore();
    localTtsService?.dispose();
    localTtsService = null;
    mainWindow = null;
  });
}
ipcMain.handle("tts:synthesize", async (event, input) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid voice request");
  return getLocalTtsService().synthesize(input);
});
ipcMain.handle("music-beat:set-enabled", (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== "boolean") throw new TypeError("Invalid music analysis request");
  const service = getMusicBeatService();
  return enabled ? service.start() : service.stop();
});
ipcMain.handle("music-beat:open-permission", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid music permission request");
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture");
});
ipcMain.handle("world-state:get", (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid world-state request");
  return expireWorldStateFields(worldState);
});
ipcMain.handle("voice:set-enabled", (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== "boolean") throw new TypeError("Invalid voice request");
  voiceListeningEnabled = enabled;
  const permission = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "unknown";
  const stt = getSttService().getStatus();
  publishWorldPatch({ audio: { microphone: { enabled, permission }, stt: { status: stt.status, language: "auto" } } });
  return { enabled, permission, stt };
});
ipcMain.handle("voice:transcribe", async (event, input) => {
  if (!isMainRenderer(event) || !voiceListeningEnabled) throw new TypeError("Voice listening is disabled");
  if (!(input instanceof Float32Array)) throw new TypeError("Invalid voice audio segment");
  return getSttService().transcribe(new Float32Array(input));
});
ipcMain.handle("world-state:renderer-patch", (event, patch) => {
  if (!isMainRenderer(event) || !patch || typeof patch !== "object") throw new TypeError("Invalid world-state update");
  const safePatch = sanitizeRendererWorldPatch(patch);
  if (!Object.keys(safePatch).length) throw new TypeError("Invalid world-state update");
  publishWorldPatch(safePatch);
});
ipcMain.handle("audio:begin-reply", async (event, options) => {
  if (!isMainRenderer(event) || typeof options?.canBoost !== "boolean") {
    throw new TypeError("Invalid reply-audio request");
  }
  return getReplyVolumeService().begin(options);
});
ipcMain.handle("audio:end-reply", async (event, sessionId) => {
  if (!isMainRenderer(event) || typeof sessionId !== "string") {
    throw new TypeError("Invalid reply-audio request");
  }
  await getReplyVolumeService().end(sessionId);
});
ipcMain.handle("get-window-position", () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});
ipcMain.handle("set-window-position", (event, x, y) => {
  if (!mainWindow) return false;
  if (!isMainRenderer(event) || ![x, y].every(Number.isFinite)) throw new TypeError("Invalid window position");
  return constrainWindow(mainWindow, screen, { ...mainWindow.getBounds(), x: Math.round(x), y: Math.round(y) });
});
ipcMain.handle("get-window-bounds", () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});
ipcMain.handle("set-window-bounds", (event, x, y, width, height) => {
  if (!mainWindow) return false;
  if (!isMainRenderer(event) || ![x, y, width, height].every(Number.isFinite)) throw new TypeError("Invalid window bounds");
  return constrainWindow(mainWindow, screen, {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(200, Math.round(width)),
    height: Math.max(300, Math.round(height))
  });
});
ipcMain.handle("set-ignore-mouse-events", (event, ignore, forward) => {
  if (!mainWindow) return false;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: forward !== false });
  return true;
});
ipcMain.handle("awareness:set-enabled", async (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== "boolean") {
    throw new TypeError("Invalid desktop-awareness request");
  }
  return createAwarenessService().setEnabled(enabled);
});
ipcMain.handle("awareness:get-status", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness request");
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});
ipcMain.handle("awareness:get-greeting-context", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness request");
  return createAwarenessService().getGreetingContext();
});
ipcMain.handle("awareness:refresh-status", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness request");
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});
ipcMain.handle("awareness:request-screen-capture", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness request");
  return createAwarenessService().requestScreenCapturePermission();
});
ipcMain.handle("awareness:request-input-monitoring", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness request");
  return createAwarenessService().requestInputMonitoringPermission();
});
ipcMain.handle("screen:capture", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid screenshot request");
  try {
    return { ok: true, attachment: await manualScreenCapture.capture() };
  } catch (error) {
    return { ok: false, error: { code: error.code || "CAPTURE_FAILED", message: error.message || "Screenshot capture failed." } };
  }
});
ipcMain.handle("awareness:request-snapshot", (event, candidateId) => {
  if (!isMainRenderer(event) || typeof candidateId !== "string" || !candidateId.trim()) {
    throw new TypeError("Invalid desktop-awareness snapshot request");
  }
  return createAwarenessService().requestSnapshot(candidateId);
});
ipcMain.handle("awareness:capture-screen", async (event) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid desktop-awareness capture request");
  return createAwarenessService().captureScreen();
});
ipcMain.on("awareness:direct-interaction", (event) => {
  if (isMainRenderer(event)) createAwarenessService().noteDirectInteraction();
});
app.whenReady().then(() => {
  createAwarenessService();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const audioOnly = permission === "media" && details?.mediaTypes?.includes("audio") && !details?.mediaTypes?.includes("video");
    callback(Boolean(audioOnly && voiceListeningEnabled));
  });
  createWindow();
  startWorldStatePolling();
  if (awarenessConfig.enabledByDefault) {
    awarenessService.start();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  awarenessService?.stop();
  stopWorldStatePolling();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("before-quit", (event) => {
  musicBeatService?.stop();
  if (replyVolumeService?.active && !restoringVolumeForQuit) {
    event.preventDefault();
    restoringVolumeForQuit = true;
    void replyVolumeService.restore().finally(() => {
      replyVolumeService = null;
      app.quit();
    });
    return;
  }
  awarenessService?.stop();
  localTtsService?.dispose();
});
