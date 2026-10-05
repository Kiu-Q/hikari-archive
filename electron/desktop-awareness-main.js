import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, desktopCapturer, nativeImage, screen, shell, systemPreferences } from 'electron';
import { activeWindowOptions } from './active-window-options.js';
import { awarenessConfig } from './awareness-config.js';
import { MediaPlaybackStateTracker, parseMediaPlaybackOutput } from './media-playback-state.js';
import { deriveDesktopActivityState } from './world-state.js';
import { IdleReturnTracker } from './idle-return.js';

const PRIORITY_RANK = { low: 0, normal: 1, important: 2 };
const PIXEL_CHANGE_DELTA = 24;
const MACOS_SCREEN_CAPTURE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const MACOS_ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const BACKGROUND_WINDOW_EXCLUSIONS = new Set([
  'com.apple.notificationcenterui',
  'com.apple.WindowManager',
  'com.apple.dock',
  'com.apple.controlcenter',
  'com.apple.systemuiserver'
]);
const execFile = promisify(execFileCallback);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
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

export function normalizeActiveWindow(activeWindow) {
  if (!activeWindow?.owner) return null;

  const windowId = Number(activeWindow.id);
  return {
    appName: normalizeText(activeWindow.owner.name) || 'Unknown application',
    bundleId: normalizeText(activeWindow.owner.bundleId),
    windowTitle: normalizeText(activeWindow.title),
    windowId: Number.isFinite(windowId) ? windowId : null,
    processId: Number.isFinite(Number(activeWindow.owner.processId))
      ? Number(activeWindow.owner.processId)
      : null,
    bounds: cloneBounds(activeWindow.bounds)
  };
}

export function enrichWindowTitleFromSource(context, exactSource) {
  if (!context || normalizeText(context.windowTitle) || !exactSource) return context;
  const windowTitle = normalizeText(exactSource.name);
  return windowTitle ? { ...context, windowTitle } : context;
}

export function getContextKey(context) {
  if (!context) return '';
  const owner = context.bundleId || context.appName || 'unknown';
  const windowIdentity = context.windowId ?? (context.windowTitle || 'unknown');
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
  const match = /^window:(\d+):/.exec(sourceId || '');
  return match ? Number(match[1]) : null;
}

function imageSize(image) {
  const size = image?.getSize?.();
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function resizeExact(image, width, height) {
  if (!image || image.isEmpty()) return null;
  return image.resize({ width, height, quality: 'good' });
}

function isMasked(x, y, mask) {
  return Boolean(
    mask &&
    x >= mask.x &&
    y >= mask.y &&
    x < mask.x + mask.width &&
    y < mask.y + mask.height
  );
}

export function compareCapturedImages(previous, current, config = awarenessConfig.screen) {
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
  let level = 'none';
  if (ratio >= config.majorChangeThreshold) level = 'major';
  else if (ratio >= config.significantChangeThreshold) level = 'significant';
  else if (ratio >= config.minorChangeThreshold) level = 'minor';

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

export class DesktopAwarenessService {
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
    this.emitCandidate = typeof emitCandidate === 'function' ? emitCandidate : () => {};
    this.getHikariBounds = typeof getHikariBounds === 'function' ? getHikariBounds : () => null;
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
    this.comparisonHistory = new Map();
    this.snapshots = new Map();
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
      screenCaptureStatus: process.platform === 'darwin' ? 'unknown' : 'granted',
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
    if (detail === undefined) console.info(`[AWARENESS ${stage}] ${message}`);
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
    // A greeting only needs coarse, transient context. In particular, do not
    // capture a screenshot or initialize global input monitoring here.
    const activeWindowPromise = (async () => {
      if (!this.activeWindowProvider) await this.initializeActiveWindowProvider();
      const context = await this.getActiveContext();
      let foreground = context && !this.isHikariContext(context)
        ? context
        : this.currentContext;
      if (!foreground && this.openWindowsProvider) {
        // The companion's own always-on-top window often has focus at startup.
        // The OS returns open windows front-to-back, so the first ordinary
        // window behind it is useful greeting context without capturing it.
        const windows = await this.openWindowsProvider();
        foreground = (Array.isArray(windows) ? windows : [])
          .map(normalizeActiveWindow)
          .find((window) => window &&
            !this.isHikariContext(window) &&
            !BACKGROUND_WINDOW_EXCLUSIONS.has(window.bundleId)) || null;
      }
      return publicContext(foreground);
    })().catch((error) => {
      this.debug('GREETING', 'foreground context unavailable', error?.message || error);
      return null;
    });

    const mediaPromise = (async () => {
      if (!this.ensureMediaPlaybackProvider()) return null;
      const isPlaying = await this.mediaPlaybackProvider();
      return typeof isPlaying === 'boolean'
        ? (isPlaying ? 'playing' : 'stopped')
        : null;
    })().catch((error) => {
      this.debug('GREETING', 'media context unavailable', error?.message || error);
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
    this.debug('STATUS', 'desktop awareness enabled', this.getStatus());
    return this.getStatus();
  }

  stop() {
    for (const session of [this.typingSession, this.scrollSession, this.clickSession]) {
      if (session?.timer) clearTimeout(session.timer);
    }
    if (this.inputHook) {
      this.inputHook.removeListener('keydown', this.handleKeydown);
      this.inputHook.removeListener('mousedown', this.handleMousedown);
      this.inputHook.removeListener('wheel', this.handleWheel);
      try {
        this.inputHook.stop();
      } catch (error) {
        this.debug('STATUS', 'input hook stop failed', error?.message || error);
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
    this.debug('STATUS', 'desktop awareness disabled');
  }

  noteDirectInteraction() {
    this.lastDirectInteractionAt = Date.now();
    this.pendingCandidate = null;
    if (this.pendingCandidateTimer) clearTimeout(this.pendingCandidateTimer);
    this.pendingCandidateTimer = null;
    this.debug('POLICY', 'direct Hikari interaction suppression started');
  }

  refreshScreenCaptureStatus() {
    if (process.platform !== 'darwin') {
      this.status.screenCaptureAvailable = true;
      this.status.screenCaptureStatus = 'granted';
      delete this.status.errors.screenCapture;
      return;
    }

    try {
      const permission = systemPreferences.getMediaAccessStatus('screen');
      this.status.screenCaptureStatus = permission;
      this.status.screenCaptureAvailable = permission === 'granted';
      if (this.status.screenCaptureAvailable) delete this.status.errors.screenCapture;
      else this.status.errors.screenCapture = permission;
    } catch (error) {
      this.status.screenCaptureAvailable = false;
      this.status.screenCaptureStatus = 'unknown';
      this.status.errors.screenCapture = error?.message || String(error);
    }
  }

  refreshInputMonitoringStatus() {
    if (this.inputHook) {
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
      return true;
    }
    if (process.platform !== 'darwin') return this.status.inputMonitoringAvailable;

    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    this.status.inputMonitoringAvailable = false;
    this.status.errors.inputMonitoring = trusted
      ? 'Keyboard monitor is not running.'
      : 'Accessibility permission is denied.';
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

    if (process.platform === 'darwin' && !this.status.screenCaptureAvailable) {
      // A user-initiated source probe gives a newly installed/coherent app
      // identity one opportunity to enter macOS's screen-capture path before
      // we send the user to Settings. Keep the request deliberately tiny and
      // discard the returned sources immediately: this is not a capture
      // session and no image is retained or returned to the renderer.
      probeAttempted = true;
      try {
        await this.captureSourcesProvider({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false
        });
        delete this.status.errors.screenCaptureProbe;
      } catch (error) {
        this.status.errors.screenCaptureProbe = error?.message || String(error);
        this.debug('SCREEN', 'permission probe failed', this.status.errors.screenCaptureProbe);
      }
      this.refreshScreenCaptureStatus();
    }

    if (process.platform === 'darwin' && !this.status.screenCaptureAvailable) {
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
      permissionKind: 'screen',
      probeAttempted,
      requiresUserAction: process.platform === 'darwin' && !this.status.screenCaptureAvailable,
      error: openError
    };
  }

  async requestInputMonitoringPermission() {
    let settingsOpened = false;
    let promptAttempted = false;
    let openError = null;

    if (process.platform === 'darwin' && !this.inputHook) {
      promptAttempted = true;
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      if (trusted) await this.initializeInputMonitoring();
    }

    if (process.platform === 'darwin' && !this.status.inputMonitoringAvailable) {
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
      permissionKind: 'inputMonitoring',
      promptAttempted,
      requiresUserAction: process.platform === 'darwin' && !this.status.inputMonitoringAvailable,
      error: openError
    };
  }

  async initializeActiveWindowProvider() {
    if (this.activeWindowProvider) {
      this.status.activeWindowAvailable = true;
      return;
    }

    try {
      if (process.platform === 'darwin' && app.isPackaged) {
        // get-windows shells out to its bundled macOS helper. child_process
        // cannot execute through an app.asar path, so use the helper copy that
        // Forge places in app.asar.unpacked.
        const helperPath = path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'get-windows',
          'main'
        );
        this.activeWindowProvider = async () => {
          // Keep the helper in owner-only mode even after Electron itself has
          // Screen Recording permission. In packaged macOS builds the helper
          // has a separate TCC identity and its screen-recording branch can
          // exit nonzero; Electron's desktopCapturer remains the screenshot
          // authority for awareness.
          const args = ['--no-accessibility-permission', '--no-screen-recording-permission'];
          const { stdout } = await execFile(helperPath, args, { encoding: 'utf8' });
          return JSON.parse(stdout);
        };
        this.openWindowsProvider = async () => {
          const args = [
            '--no-accessibility-permission',
            '--no-screen-recording-permission',
            '--open-windows-list'
          ];
          const { stdout } = await execFile(helperPath, args, { encoding: 'utf8' });
          return JSON.parse(stdout);
        };
        this.status.activeWindowAvailable = true;
        return;
      }

      const { activeWindow, openWindows } = await import('get-windows');
      this.activeWindowProvider = () => activeWindow(activeWindowOptions);
      this.openWindowsProvider = () => openWindows(activeWindowOptions);
      this.status.activeWindowAvailable = true;
    } catch (error) {
      this.status.activeWindowAvailable = false;
      this.status.errors.activeWindow = error?.message || String(error);
      this.debug('STATUS', 'active-window support unavailable', this.status.errors.activeWindow);
    }
  }

  async initializeInputMonitoring() {
    if (this.inputHook) {
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
      return;
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      this.status.inputMonitoringAvailable = false;
      this.status.errors.inputMonitoring = 'Accessibility permission is denied.';
      return;
    }

    try {
      const { uIOhook } = await import('uiohook-napi');
      this.inputHook = uIOhook;
      uIOhook.on('keydown', this.handleKeydown);
      uIOhook.on('mousedown', this.handleMousedown);
      uIOhook.on('wheel', this.handleWheel);
      uIOhook.start();
      this.status.inputMonitoringAvailable = true;
      delete this.status.errors.inputMonitoring;
    } catch (error) {
      if (this.inputHook) {
        this.inputHook.removeListener('keydown', this.handleKeydown);
        this.inputHook.removeListener('mousedown', this.handleMousedown);
        this.inputHook.removeListener('wheel', this.handleWheel);
      }
      this.inputHook = null;
      this.status.inputMonitoringAvailable = false;
      this.status.errors.inputMonitoring = error?.message || String(error);
      this.debug('STATUS', 'global input monitoring unavailable', this.status.errors.inputMonitoring);
    }
  }

  initializeMediaPlaybackMonitoring() {
    if (!this.ensureMediaPlaybackProvider()) return;
    void this.pollMediaPlayback();
  }

  ensureMediaPlaybackProvider() {
    if (process.platform !== 'darwin') {
      this.status.mediaPlaybackAvailable = false;
      this.status.errors.mediaPlayback = 'System audio activity detection is currently available on macOS only.';
      return false;
    }

    if (!this.mediaPlaybackProvider) {
      const candidates = app.isPackaged
        ? [path.join(process.resourcesPath, 'media-state', 'media-state')]
        : [
            path.join(app.getAppPath(), 'tools', 'media-state', 'media-state'),
            path.resolve(process.cwd(), 'tools', 'media-state', 'media-state')
          ];
      const helperPath = candidates.find((candidate) => existsSync(candidate));
      if (!helperPath) {
        this.status.mediaPlaybackAvailable = false;
        this.status.errors.mediaPlayback = 'Media-state helper is missing. Run npm run build.';
        return false;
      }

      this.mediaPlaybackProvider = async () => {
        const { stdout } = await execFile(helperPath, [], {
          encoding: 'utf8',
          timeout: Math.max(1000, this.config.media.pollIntervalMs)
        });
        const isPlaying = parseMediaPlaybackOutput(stdout);
        if (isPlaying === null) throw new Error('Media-state helper returned an invalid result.');
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
      this.status.mediaPlaybackAvailable = typeof isPlaying === 'boolean';
      if (!this.status.mediaPlaybackAvailable) throw new Error('Media playback state was unavailable.');
      delete this.status.errors.mediaPlayback;

      const transition = this.mediaPlaybackTracker.observe(isPlaying);
      if (transition) await this.handleMediaPlaybackTransition(transition);
    } catch (error) {
      this.status.mediaPlaybackAvailable = false;
      this.status.errors.mediaPlayback = error?.message || String(error);
      this.debug('MEDIA', 'playback-state query failed', this.status.errors.mediaPlayback);
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

    const started = transition.state === 'playing';
    const candidate = {
      id: createId(),
      timestamp: Date.now(),
      trigger: started ? 'media_playback_started' : 'media_playback_stopped',
      activity: {},
      media: {
        ...transition,
        source: 'system_audio_output'
      },
      context: publicContext(context),
      visualChange: null,
      priority: started ? 'important' : 'low'
    };
    this.debug('MEDIA', `${transition.previousState} -> ${transition.state}`);
    this.offerCandidate(candidate, null);
  }

  async initializeContextAndBaseline() {
    const context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) return;
    const capture = await this.captureContext(context);
    const resolvedContext = capture?.context || context;
    this.currentContext = resolvedContext;
    if (capture?.comparison) this.rememberComparison(resolvedContext, capture.comparison);
    this.debug('CONTEXT', `${resolvedContext.appName} / ${resolvedContext.windowTitle || '(untitled window)'}`);
  }

  isHikariContext(context) {
    return context?.processId === process.pid || context?.bundleId === 'com.electron.hikari';
  }

  isDirectInteractionSuppressed(now = Date.now()) {
    return now - this.lastDirectInteractionAt < this.config.hikariInteraction.suppressionMs;
  }

  recordInputActivity(inputType, now) {
    this.lastInputAt = now;
    const activity = this.idleReturnTracker.record(inputType, now);
    if (activity) {
      void this.observeIdleReturn(activity).catch(error => this.debug('IDLE', 'return context unavailable', error?.message || error));
    }
  }

  async observeIdleReturn(activity) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    const context = await this.getActiveContext();
    if (!this.enabled || this.isHikariContext(context)) return;
    this.offerCandidate({
      id: createId(), timestamp: activity.resumedAt, trigger: 'idle_return',
      activity, context: publicContext(context || this.currentContext),
      visualChange: null, priority: 'important'
    }, null);
  }

  recordKeyboardActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity('typing', now);
    this.debug('RAW', 'keyboard activity');
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
      this.debug('SESSION', 'typing session rejected: too few keys', session?.count || 0);
      return;
    }

    const activity = {
      durationMs: Math.max(0, session.lastAt - session.startedAt),
      eventCount: session.count
    };
    this.debug('SESSION', 'typing session ended', activity);
    this.queueObservation('typing_session_end', activity);
  }

  recordWheelActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity('scrolling', now);
    this.debug('RAW', 'wheel activity');
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
      this.debug('SESSION', 'scroll session rejected: too few wheel events', session?.count || 0);
      return;
    }

    const activity = {
      durationMs: Math.max(0, session.lastAt - session.startedAt),
      eventCount: session.count
    };
    this.debug('SESSION', 'scroll session ended', activity);
    this.queueObservation('scroll_session_end', activity);
  }

  recordClickActivity() {
    if (!this.enabled) return;
    const now = Date.now();
    this.recordInputActivity('clicking', now);
    this.debug('RAW', 'mouse click activity');
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
    this.debug('SESSION', 'click activity settled', activity);
    this.queueObservation('click_caused_screen_change', activity);
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
    const trigger = appChanged ? 'application_changed' : 'window_changed';

    this.debug('CONTEXT', `${resolvedContext.appName} / ${resolvedContext.windowTitle || '(untitled window)'}`);
    this.offerCandidate({
      id: createId(),
      timestamp: Date.now(),
      trigger,
      activity: appChanged
        ? { fromApp: previous?.appName || null, toApp: resolvedContext.appName }
        : { fromWindow: previous?.windowTitle || null, toWindow: resolvedContext.windowTitle },
      context: publicContext(resolvedContext),
      visualChange: null,
      priority: 'normal'
    }, capture?.semantic);
  }

  queueObservation(trigger, activity) {
    this.observationChain = this.observationChain
      .catch((error) => this.debug('ERROR', 'previous observation failed', error?.message || error))
      .then(() => this.observeSession(trigger, activity));
  }

  async observeSession(trigger, activity) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) {
      this.debug('POLICY', `${trigger} dropped: direct interaction or awareness disabled`);
      return;
    }

    const context = await this.getActiveContext();
    if (!context || this.isHikariContext(context)) return;

    if (!sameContext(context, this.currentContext)) {
      this.scheduleContextInspection();
      this.debug('POLICY', `${trigger} deferred: context is changing`);
      return;
    }

    const capture = await this.captureContext(context);
    const resolvedContext = capture?.context || context;
    this.currentContext = resolvedContext;
    if (!capture?.comparison) {
      if (!this.status.screenCaptureAvailable && trigger !== 'click_caused_screen_change') {
        const priority = trigger === 'scroll_session_end' ? 'low' : 'normal';
        this.debug('SCREEN', `${trigger} continuing without screenshot permission`);
        this.offerCandidate({
          id: createId(),
          timestamp: Date.now(),
          trigger,
          activity,
          context: publicContext(resolvedContext),
          visualChange: null,
          priority
        }, null);
      } else {
        this.debug('SCREEN', `${trigger} rejected: screenshot unavailable`);
      }
      return;
    }

    const key = getContextKey(resolvedContext);
    const previous = this.comparisonHistory.get(key);
    this.rememberComparison(resolvedContext, capture.comparison);
    if (!previous) {
      this.debug('SCREEN', `${trigger} established comparison baseline`);
      return;
    }

    const difference = compareCapturedImages(previous, capture.comparison, this.config.screen);
    if (!difference) return;
    this.debug('SCREEN', `change: ${(difference.ratio * 100).toFixed(1)}%`, difference.level);

    const minimumRatio = trigger === 'typing_session_end'
      ? this.config.screen.typingChangeThreshold
      : trigger === 'scroll_session_end'
        ? this.config.screen.minorChangeThreshold
        : this.config.screen.significantChangeThreshold;
    if (difference.ratio < minimumRatio) {
      this.debug('CANDIDATE', `${trigger} rejected: visual change below threshold`);
      return;
    }

    // Tiny scrolls stay context-only. A clearly substantial viewport change is
    // a useful content-awareness event even though the model must not infer
    // what changed from the diff alone; reserve important for major changes.
    let priority = trigger === 'scroll_session_end'
      ? difference.ratio >= this.config.screen.significantChangeThreshold ? 'normal' : 'low'
      : 'normal';
    if (difference.ratio >= this.config.screen.majorChangeThreshold) priority = 'important';
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
      this.debug('CONTEXT', 'active-window query failed', this.status.errors.activeWindow);
      return null;
    }
  }

  async captureContext(context) {
    this.refreshScreenCaptureStatus();
    if (!this.status.screenCaptureAvailable) return null;

    const semanticWidth = this.config.screen.semanticSnapshotWidth;
    const aspectRatio = context.bounds?.width && context.bounds?.height
      ? context.bounds.width / context.bounds.height
      : 16 / 9;
    const semanticHeight = Math.max(1, Math.round(semanticWidth / aspectRatio));

    try {
      const windowSources = await this.captureSourcesProvider({
        types: ['window'],
        thumbnailSize: { width: semanticWidth, height: semanticHeight },
        fetchWindowIcons: false
      });
      const exactSource = context.windowId == null
        ? null
        : windowSources.find((source) => sourceWindowId(source.id) === context.windowId);
      const enrichedContext = exactSource
        ? enrichWindowTitleFromSource(context, exactSource)
        : context;
      const titleSource = windowSources.find((source) => (
        context.windowTitle && normalizeText(source.name) === context.windowTitle
      ));
      const source = exactSource || titleSource;
      if (source?.thumbnail && !source.thumbnail.isEmpty()) {
        const prepared = this.prepareCapture(source.thumbnail, null);
        return prepared ? { ...prepared, context: enrichedContext } : null;
      }

      const display = context.bounds ? screen.getDisplayMatching(context.bounds) : screen.getPrimaryDisplay();
      const displaySources = await this.captureSourcesProvider({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(1, Math.round(display.size.width * Math.min(1, semanticWidth / display.size.width))),
          height: Math.max(1, Math.round(display.size.height * Math.min(1, semanticWidth / display.size.width)))
        },
        fetchWindowIcons: false
      });
      const displaySource = displaySources.find((sourceItem) => String(sourceItem.display_id) === String(display.id))
        || displaySources[0];
      if (!displaySource?.thumbnail || displaySource.thumbnail.isEmpty()) return null;
      const prepared = this.prepareCapture(displaySource.thumbnail, this.getDisplayMask(display, displaySource.thumbnail));
      return prepared ? { ...prepared, context: enrichedContext } : null;
    } catch (error) {
      this.status.screenCaptureAvailable = false;
      this.status.errors.screenCapture = error?.message || String(error);
      this.debug('SCREEN', 'capture failed', this.status.errors.screenCapture);
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
    const comparisonMask = semanticMask && sourceSize
      ? {
          x: Math.floor(semanticMask.x * this.config.screen.comparisonWidth / sourceSize.width),
          y: Math.floor(semanticMask.y * this.config.screen.comparisonHeight / sourceSize.height),
          width: Math.ceil(semanticMask.width * this.config.screen.comparisonWidth / sourceSize.width),
          height: Math.ceil(semanticMask.height * this.config.screen.comparisonHeight / sourceSize.height)
        }
      : null;

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
    return incomingRank > currentRank || (incomingRank === currentRank && incoming.timestamp >= current.timestamp);
  }

  emitNow(candidate) {
    if (!this.enabled) return;
    this.lastCandidateAt = Date.now();
    this.debug('CANDIDATE', 'accepted', candidate);
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
      mimeType: 'image/jpeg',
      width: size.width,
      height: size.height,
      dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`
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

export function createMaskedNativeImage(image, mask) {
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
