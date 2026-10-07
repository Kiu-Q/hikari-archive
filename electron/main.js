import { app, BrowserWindow, desktopCapturer, ipcMain, powerMonitor, screen, session, shell, systemPreferences } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { DesktopAwarenessService } from './desktop-awareness-main.js';
import { awarenessConfig } from './awareness-config.js';
import { createLocalTtsService } from './local-tts-main.js';
import { createRemoteTtsService } from './remote-tts-main.js';
import { ReplyVolumeService } from './reply-volume-main.js';
import { createWorldState, expireWorldStateFields, mergeWorldStatePatch, sanitizeRendererWorldPatch } from './world-state.js';
import { SpeechToTextService } from './speech-to-text-main.js';
import { parseSystemAudioOutput } from './media-playback-state.js';
import { createScreenCaptureService } from './screen-capture-main.js';
import { constrainWindow, keepWindowOnScreen } from './window-geometry.js';
import { MusicBeatService } from './music-beat-main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if we're in development mode
const isDev = process.env.NODE_ENV === 'development' || 
              !existsSync(path.join(__dirname, '../dist/index.html'));

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
let lastDesktopContextKey = '';
const manualScreenCapture = createScreenCaptureService({
  getSources: options => desktopCapturer.getSources(options),
  getDisplay: () => mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()) : null,
  getPermissionStatus: () => systemPreferences.getMediaAccessStatus('screen')
});

function publishWorldPatch(patch) {
  worldState = mergeWorldStatePatch(worldState, patch);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('world-state:patch', patch);
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
      appName: window?.owner?.name || '', bundleId: window?.owner?.bundleId || '', windowTitle: window?.title || '',
      windowId: Number.isFinite(Number(window?.id)) ? Number(window.id) : null,
      bounds: window?.bounds || null, processId: Number(window?.owner?.processId) || null
    })).find((window) => window.appName && !service.isHikariContext(window)) || null;
  }
  const contextKey = context ? `${context.bundleId || context.appName || 'unknown'}:${context.windowId ?? context.windowTitle ?? 'unknown'}` : '';
  const contextChanged = Boolean(lastDesktopContextKey && contextKey && contextKey !== lastDesktopContextKey);
  lastDesktopContextKey = contextKey || lastDesktopContextKey;
  const observedAt = Date.now();
  publishWorldPatch({ desktop: {
    appName: context?.appName || '', bundleId: context?.bundleId || '',
    windowTitle: context?.windowTitle || '', windowId: context?.windowId ?? null,
    windowBounds: context?.bounds || null, contextUpdatedAt: observedAt, contextStale: !context,
    screen: contextChanged
      ? { available: Boolean(service.getStatus().screenCaptureAvailable), visionAvailable: Boolean(service.getStatus().screenCaptureAvailable), changeLevel: 'unknown', changeAt: 0, changeStale: true, lastSummary: '', summaryAt: 0, summaryStale: true, summaryContextKey: '' }
      : { available: Boolean(service.getStatus().screenCaptureAvailable), visionAvailable: Boolean(service.getStatus().screenCaptureAvailable) }
  }, browser: { available: false } });
}

function pollActivityState() {
  if (!awarenessService) return;
  const idleForMs = Math.max(0, (Number(powerMonitor.getSystemIdleTime()) || 0) * 1000);
  publishWorldPatch({ desktop: { activity: { ...awarenessService.getActivityState(), idleForMs, idle: idleForMs >= 60_000, updatedAt: Date.now(), stale: false } } });
}

async function pollSystemAudio(service) {
  if (process.platform !== 'darwin' || !service.ensureMediaPlaybackProvider()) {
    publishWorldPatch({ audio: { system: { available: false, updatedAt: Date.now() } } });
    return;
  }
  try {
    const [rawAudioState, output] = await Promise.all([
      getReplyVolumeService().call(['audio-state']).catch(() => ''),
      getReplyVolumeService().readVolume().catch(() => null)
    ]);
    const audioState = parseSystemAudioOutput(rawAudioState);
    publishWorldPatch({ audio: { system: {
      available: audioState?.available ?? false,
      stale: false,
      captureAvailable: musicBeatService?.status.state === 'listening',
      running: audioState?.running ?? false,
      volume: audioState?.volume ?? output?.scalar ?? null,
      muted: audioState?.muted ?? null,
      level: null, classification: 'unknown', confidence: 0, updatedAt: Date.now()
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
  audioPoll = setInterval(() => void pollSystemAudio(awarenessService), 5000);
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
  clearInterval(pointerPoll); clearInterval(contextPoll); clearInterval(activityPoll); clearInterval(audioPoll); pointerPoll = null; contextPoll = null; activityPoll = null; audioPoll = null;
}

function getSttService() {
  if (!sttService) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'voice-stt', 'voice-stt')]
      : [
          path.join(app.getAppPath(), 'tools', 'voice-stt', 'voice-stt'),
          path.resolve(__dirname, '../../tools/voice-stt/voice-stt'),
          path.resolve(__dirname, '../tools/voice-stt/voice-stt')
        ];
    sttService = new SpeechToTextService({ executable: process.env.HIKARI_SPEECH_HELPER || candidates.find((candidate) => existsSync(candidate)) || candidates[0] });
  }
  return sttService;
}

function getReplyVolumeService() {
  if (!replyVolumeService) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'media-state', 'media-state')]
      : [
          path.join(app.getAppPath(), 'tools', 'media-state', 'media-state'),
          path.resolve(__dirname, '../tools/media-state/media-state')
        ];
    replyVolumeService = new ReplyVolumeService({
      helperPath: candidates.find((candidate) => existsSync(candidate)),
      // The voice player's own AudioContext opens the output device before
      // playback. Exclude Hikari's processes so it cannot count as media.
      mediaPlaying: async () => String(await replyVolumeService.call([
        'playing-except', String(process.pid),
        ...app.getAppMetrics().map(metric => String(metric.pid))
      ])).trim() === '1'
    });
  }
  return replyVolumeService;
}

function getLocalTtsService() {
  if (!localTtsService && process.env.HIKARI_SERVICE_URL) {
    localTtsService = createRemoteTtsService({ url: process.env.HIKARI_SERVICE_URL });
  }
  if (!localTtsService) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'companion-tts')]
      : [path.join(app.getAppPath(), 'tools/companion-tts'),
         path.resolve(__dirname, '../tools/companion-tts'),
         path.resolve(__dirname, '../../tools/companion-tts')];
    const toolDir = process.env.HIKARI_TTS_TOOL_DIR || candidates.find(
      directory => existsSync(path.join(directory, 'tts.py'))
    ) || candidates[0];
    localTtsService = createLocalTtsService({ toolDir });
  }
  return localTtsService;
}

function getMusicBeatService() {
  if (!musicBeatService) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'music-beat', 'music-beat')]
      : [path.join(app.getAppPath(), 'tools/music-beat/music-beat'), path.resolve(__dirname, '../tools/music-beat/music-beat')];
    const send = (channel, value) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, value);
    };
    musicBeatService = new MusicBeatService({
      executable: candidates.find(candidate => existsSync(candidate)) || candidates[0],
      excludePids: () => [process.pid, ...app.getAppMetrics().map(metric => metric.pid)],
      mediaPlaying: () => getReplyVolumeService().mediaPlaying(),
      onSignal: value => send('music-beat:signal', value),
      onStatus: value => send('music-beat:status', value),
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
    getHikariBounds: () => (
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null
    ),
    emitCandidate: (candidate) => {
      const context = candidate.context || {};
      const contextKey = `${context.bundleId || context.appName || 'unknown'}:${candidate.windowId ?? context.windowId ?? context.windowTitle ?? 'unknown'}`;
      const appWindow = [context.appName, context.windowTitle].filter(Boolean).join(' — ');
      const observedAt = candidate.timestamp || Date.now();
      const idleForMs = Math.max(0, (Number(powerMonitor.getSystemIdleTime()) || 0) * 1000);
      const activityLabel = candidate.trigger === 'typing_session_end'
        ? 'a typing session was observed'
        : candidate.trigger === 'scroll_session_end' ? 'a scrolling session was observed' : 'desktop activity changed';
      const patch = { desktop: {
        appName: context.appName || '', bundleId: context.bundleId || '', windowTitle: context.windowTitle || '',
        windowId: context.windowId ?? candidate.windowId ?? null, contextUpdatedAt: observedAt, contextStale: !context.appName,
        activity: {
          ...(awarenessService?.getActivityState?.() || {}),
          idleForMs,
          idle: idleForMs >= 60_000,
          updatedAt: observedAt,
          stale: false
        },
        screen: {
          available: Boolean(awarenessService?.getStatus().screenCaptureAvailable),
          visionAvailable: Boolean(awarenessService?.getStatus().screenCaptureAvailable)
        }
      } };
      if (candidate.visualChange || ['application_changed', 'window_changed', 'typing_session_end', 'scroll_session_end', 'click_caused_screen_change'].includes(candidate.trigger)) {
        patch.desktop.screen = {
          ...patch.desktop.screen,
          changeLevel: candidate.visualChange?.level || 'unknown',
          changeAt: observedAt,
          changeStale: false,
          lastSummary: appWindow ? `Active window: ${appWindow}; ${activityLabel}. Window content was not interpreted.` : `${activityLabel}. Window content was not interpreted.`,
          summaryAt: observedAt,
          summaryStale: false,
          summaryContextKey: contextKey
        };
      }
      if (candidate.media?.state === 'playing' || candidate.media?.state === 'stopped') {
        patch.audio = { system: { available: true, running: candidate.media.state === 'playing', updatedAt: observedAt, stale: false } };
      }
      publishWorldPatch(patch);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('awareness:candidate', candidate);
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
      preload: existsSync(path.join(__dirname, 'preload.js'))
        ? path.join(__dirname, 'preload.js')
        : path.resolve(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  keepWindowOnScreen(mainWindow, screen);

  // Load the app
  if (isDev) {
    // In development, load from Vite dev server
    mainWindow.loadURL('http://localhost:5174/electron/index.html');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, load from built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('closed', () => {
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

// IPC handlers for window positioning
ipcMain.handle('tts:synthesize', async (event, input) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid voice request');
  return getLocalTtsService().synthesize(input);
});

ipcMain.handle('music-beat:set-enabled', (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== 'boolean') throw new TypeError('Invalid music analysis request');
  const service = getMusicBeatService();
  return enabled ? service.start() : service.stop();
});

ipcMain.handle('music-beat:open-permission', async event => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid music permission request');
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture');
});

ipcMain.handle('world-state:get', (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid world-state request');
  return expireWorldStateFields(worldState);
});

ipcMain.handle('voice:set-enabled', (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== 'boolean') throw new TypeError('Invalid voice request');
  voiceListeningEnabled = enabled;
  const permission = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown';
  const stt = getSttService().getStatus();
  publishWorldPatch({ audio: { microphone: { enabled, permission }, stt: { status: stt.status, language: 'auto' } } });
  return { enabled, permission, stt };
});

ipcMain.handle('voice:transcribe', async (event, input) => {
  if (!isMainRenderer(event) || !voiceListeningEnabled) throw new TypeError('Voice listening is disabled');
  if (!(input instanceof Float32Array)) throw new TypeError('Invalid voice audio segment');
  return getSttService().transcribe(new Float32Array(input));
});

ipcMain.handle('world-state:renderer-patch', (event, patch) => {
  if (!isMainRenderer(event) || !patch || typeof patch !== 'object') throw new TypeError('Invalid world-state update');
  // Renderer may update only Hikari's local interaction state and the speech
  // activity bit; desktop observations remain owned by this process.
  const safePatch = sanitizeRendererWorldPatch(patch);
  if (!Object.keys(safePatch).length) throw new TypeError('Invalid world-state update');
  publishWorldPatch(safePatch);
});

ipcMain.handle('audio:begin-reply', async (event, options) => {
  if (!isMainRenderer(event) || typeof options?.canBoost !== 'boolean') {
    throw new TypeError('Invalid reply-audio request');
  }
  return getReplyVolumeService().begin(options);
});

ipcMain.handle('audio:end-reply', async (event, sessionId) => {
  if (!isMainRenderer(event) || typeof sessionId !== 'string') {
    throw new TypeError('Invalid reply-audio request');
  }
  await getReplyVolumeService().end(sessionId);
});

ipcMain.handle('get-window-position', () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});

ipcMain.handle('set-window-position', (event, x, y) => {
  if (!mainWindow) return false;
  if (!isMainRenderer(event) || ![x, y].every(Number.isFinite)) throw new TypeError('Invalid window position');
  return constrainWindow(mainWindow, screen, { ...mainWindow.getBounds(), x: Math.round(x), y: Math.round(y) });
});

ipcMain.handle('get-window-bounds', () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});

ipcMain.handle('set-window-bounds', (event, x, y, width, height) => {
  if (!mainWindow) return false;
  if (!isMainRenderer(event) || ![x, y, width, height].every(Number.isFinite)) throw new TypeError('Invalid window bounds');
  return constrainWindow(mainWindow, screen, {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(200, Math.round(width)),
    height: Math.max(300, Math.round(height))
  });
});

// IPC handler for dynamic click-through (transparent areas let clicks pass through)
ipcMain.handle('set-ignore-mouse-events', (event, ignore, forward) => {
  if (!mainWindow) return false;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: forward !== false });
  return true;
});

ipcMain.handle('awareness:set-enabled', async (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== 'boolean') {
    throw new TypeError('Invalid desktop-awareness request');
  }
  return createAwarenessService().setEnabled(enabled);
});

ipcMain.handle('awareness:get-status', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});

ipcMain.handle('awareness:get-greeting-context', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  return createAwarenessService().getGreetingContext();
});

ipcMain.handle('awareness:refresh-status', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});

ipcMain.handle('awareness:request-screen-capture', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  return createAwarenessService().requestScreenCapturePermission();
});

ipcMain.handle('awareness:request-input-monitoring', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  return createAwarenessService().requestInputMonitoringPermission();
});

ipcMain.handle('screen:capture', async event => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid screenshot request');
  try { return { ok: true, attachment: await manualScreenCapture.capture() }; }
  catch (error) { return { ok: false, error: { code: error.code || 'CAPTURE_FAILED', message: error.message || 'Screenshot capture failed.' } }; }
});

ipcMain.handle('awareness:request-snapshot', (event, candidateId) => {
  if (!isMainRenderer(event) || typeof candidateId !== 'string' || !candidateId.trim()) {
    throw new TypeError('Invalid desktop-awareness snapshot request');
  }
  return createAwarenessService().requestSnapshot(candidateId);
});

ipcMain.handle('awareness:capture-screen', async event => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness capture request');
  return createAwarenessService().captureScreen();
});

ipcMain.on('awareness:direct-interaction', (event) => {
  if (isMainRenderer(event)) createAwarenessService().noteDirectInteraction();
});

// App lifecycle
app.whenReady().then(() => {
  createAwarenessService();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const audioOnly = permission === 'media' && details?.mediaTypes?.includes('audio') && !details?.mediaTypes?.includes('video');
    callback(Boolean(audioOnly && voiceListeningEnabled));
  });
  createWindow();
  startWorldStatePolling();

  if (awarenessConfig.enabledByDefault) {
    awarenessService.start();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  awarenessService?.stop();
  stopWorldStatePolling();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
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
