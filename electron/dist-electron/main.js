import { desktopCapturer, systemPreferences, shell, app, screen, nativeImage, ipcMain, BrowserWindow } from "electron";
import path$1 from "path";
import { fileURLToPath as fileURLToPath$1 } from "url";
import { existsSync as existsSync$1 } from "fs";
import { execFile as execFile$1, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const awarenessConfig = {
  enabledByDefault: false,
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
    minimumAgentAnalysisIntervalMs: 6e3,
    candidateMaxAgeMs: 1e4
  },
  reaction: {
    normalSpeechCooldownMs: 3e4,
    importantSpeechCooldownMs: 15e3,
    normalBudgetCount: 4,
    normalBudgetWindowMs: 10 * 60 * 1e3
  },
  dedupe: {
    sameContextReactionCooldownMs: 12e4
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
function parseMediaPlaybackOutput(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "1") return true;
  if (normalized === "0") return false;
  return null;
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
const PRIORITY_RANK = { low: 0, normal: 1, important: 2 };
const PIXEL_CHANGE_DELTA = 24;
const MACOS_SCREEN_CAPTURE_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MACOS_ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const execFile = promisify(execFile$1);
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
    captureSourcesProvider,
    mediaPlaybackProvider
  } = {}) {
    this.config = config;
    this.emitCandidate = typeof emitCandidate === "function" ? emitCandidate : () => {
    };
    this.getHikariBounds = typeof getHikariBounds === "function" ? getHikariBounds : () => null;
    this.activeWindowProvider = activeWindowProvider || null;
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
    this.refreshScreenCaptureStatus();
    await this.initializeActiveWindowProvider();
    await this.initializeInputMonitoring();
    await this.initializeContextAndBaseline();
    this.initializeMediaPlaybackMonitoring();
    this.debug("STATUS", "desktop awareness enabled", this.getStatus());
    return this.getStatus();
  }
  stop() {
    for (const session of [this.typingSession, this.scrollSession, this.clickSession]) {
      if (session?.timer) clearTimeout(session.timer);
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
          const { stdout } = await execFile(helperPath, args, { encoding: "utf8" });
          return JSON.parse(stdout);
        };
        this.status.activeWindowAvailable = true;
        return;
      }
      const { activeWindow } = await import("./index-D7v8WbNU.js");
      this.activeWindowProvider = () => activeWindow({
        accessibilityPermission: false,
        // Without Screen Recording permission get-windows can still provide the
        // owning application; it simply omits the protected window title.
        screenRecordingPermission: this.status.screenCaptureAvailable
      });
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
    if (process.platform !== "darwin") {
      this.status.mediaPlaybackAvailable = false;
      this.status.errors.mediaPlayback = "System audio activity detection is currently available on macOS only.";
      return;
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
        return;
      }
      this.mediaPlaybackProvider = async () => {
        const { stdout } = await execFile(helperPath, [], {
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
    void this.pollMediaPlayback();
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
    return context?.processId === process.pid;
  }
  isDirectInteractionSuppressed(now = Date.now()) {
    return now - this.lastDirectInteractionAt < this.config.hikariInteraction.suppressionMs;
  }
  recordKeyboardActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.debug("RAW", "keyboard activity");
    this.scheduleContextInspection();
    if (!this.typingSession) this.typingSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.typingSession.lastAt = now;
    this.typingSession.count += 1;
    if (this.typingSession.timer) clearTimeout(this.typingSession.timer);
    this.typingSession.timer = setTimeout(() => this.endTypingSession(), this.config.activity.typingPauseMs);
  }
  endTypingSession() {
    const session = this.typingSession;
    this.typingSession = null;
    if (!session || session.count < this.config.activity.minimumTypingKeys) {
      this.debug("SESSION", "typing session rejected: too few keys", session?.count || 0);
      return;
    }
    const activity = {
      durationMs: Math.max(0, session.lastAt - session.startedAt),
      eventCount: session.count
    };
    this.debug("SESSION", "typing session ended", activity);
    this.queueObservation("typing_session_end", activity);
  }
  recordWheelActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.debug("RAW", "wheel activity");
    this.scheduleContextInspection();
    if (!this.scrollSession) this.scrollSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.scrollSession.lastAt = now;
    this.scrollSession.count += 1;
    if (this.scrollSession.timer) clearTimeout(this.scrollSession.timer);
    this.scrollSession.timer = setTimeout(() => this.endScrollSession(), this.config.activity.scrollPauseMs);
  }
  endScrollSession() {
    const session = this.scrollSession;
    this.scrollSession = null;
    if (!session || session.count < this.config.activity.minimumWheelEvents) {
      this.debug("SESSION", "scroll session rejected: too few wheel events", session?.count || 0);
      return;
    }
    const activity = {
      durationMs: Math.max(0, session.lastAt - session.startedAt),
      eventCount: session.count
    };
    this.debug("SESSION", "scroll session ended", activity);
    this.queueObservation("scroll_session_end", activity);
  }
  recordClickActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.debug("RAW", "mouse click activity");
    this.scheduleContextInspection();
    if (!this.clickSession) this.clickSession = { startedAt: now, lastAt: now, count: 0, timer: null };
    this.clickSession.lastAt = now;
    this.clickSession.count += 1;
    if (this.clickSession.timer) clearTimeout(this.clickSession.timer);
    this.clickSession.timer = setTimeout(() => this.endClickSession(), this.config.activity.clickObservationDelayMs);
  }
  endClickSession() {
    const session = this.clickSession;
    this.clickSession = null;
    if (!session) return;
    const activity = {
      durationMs: Math.max(0, session.lastAt - session.startedAt),
      eventCount: session.count
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
    let priority = trigger === "scroll_session_end" ? "low" : "normal";
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
function validateWav(audio, sampleRate, channels) {
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
        validateWav(bytes, metadata.sampleRate, metadata.channels);
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
const __filename$1 = fileURLToPath$1(import.meta.url);
const __dirname$1 = path$1.dirname(__filename$1);
const isDev = process.env.NODE_ENV === "development" || !existsSync$1(path$1.join(__dirname$1, "../dist/index.html"));
let mainWindow = null;
let awarenessService = null;
let localTtsService = null;
function getLocalTtsService() {
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
function isMainRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function createAwarenessService() {
  if (awarenessService) return awarenessService;
  awarenessService = new DesktopAwarenessService({
    getHikariBounds: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
    emitCandidate: (candidate) => {
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
  if (isDev) {
    mainWindow.loadURL("http://localhost:5174/electron/index.html");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path$1.join(__dirname$1, "../dist/index.html"));
  }
  mainWindow.once("closed", () => {
    awarenessService?.stop();
    localTtsService?.dispose();
    localTtsService = null;
    mainWindow = null;
  });
}
ipcMain.handle("tts:synthesize", async (event, input) => {
  if (!isMainRenderer(event)) throw new TypeError("Invalid voice request");
  return getLocalTtsService().synthesize(input);
});
ipcMain.handle("get-window-position", () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});
ipcMain.handle("set-window-position", (event, x, y) => {
  if (!mainWindow) return false;
  mainWindow.setPosition(Math.round(x), Math.round(y));
  return true;
});
ipcMain.handle("get-window-bounds", () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});
ipcMain.handle("set-window-bounds", (event, x, y, width, height) => {
  if (!mainWindow) return false;
  mainWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(200, Math.round(width)),
    height: Math.max(300, Math.round(height))
  });
  return true;
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
ipcMain.handle("awareness:request-snapshot", (event, candidateId) => {
  if (!isMainRenderer(event) || typeof candidateId !== "string" || !candidateId.trim()) {
    throw new TypeError("Invalid desktop-awareness snapshot request");
  }
  return createAwarenessService().requestSnapshot(candidateId);
});
ipcMain.on("awareness:direct-interaction", (event) => {
  if (isMainRenderer(event)) createAwarenessService().noteDirectInteraction();
});
app.whenReady().then(() => {
  createAwarenessService();
  createWindow();
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
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("before-quit", () => {
  awarenessService?.stop();
  localTtsService?.dispose();
});
