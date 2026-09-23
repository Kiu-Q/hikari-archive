import assert from 'node:assert/strict';
import test from 'node:test';

import { awarenessConfig } from '../electron/awareness-config.js';
import { MediaPlaybackStateTracker, parseMediaPlaybackOutput } from '../electron/media-playback-state.js';
import {
  AwarenessController,
  awarenessDedupeKey,
  buildAwarenessPrompt,
  isExpectedAwarenessAbort,
  parseAwarenessResponse
} from '../electron/desktop-awareness-renderer.js';

test('awareness activity tuning catches short typing bursts without lowering scroll thresholds', () => {
  assert.equal(awarenessConfig.activity.minimumTypingKeys, 3);
  assert.equal(awarenessConfig.activity.typingPauseMs, 1500);
  assert.equal(awarenessConfig.screen.typingChangeThreshold, 0);
  assert.equal(awarenessConfig.activity.minimumWheelEvents, 3);
  assert.equal(awarenessConfig.activity.scrollPauseMs, 800);
});

test('awareness reaction tuning allows modestly more timely normal reactions', () => {
  assert.equal(awarenessConfig.observation.minimumAgentAnalysisIntervalMs, 6000);
  assert.equal(awarenessConfig.reaction.normalSpeechCooldownMs, 30000);
  assert.equal(awarenessConfig.reaction.normalBudgetCount, 4);
});

let desktopAwarenessMain;
let desktopAwarenessMainImportError;
try {
  desktopAwarenessMain = await import('../electron/desktop-awareness-main.js');
} catch (error) {
  desktopAwarenessMainImportError = error;
}

test('parseAwarenessResponse accepts an explicit silent decision', () => {
  assert.deepEqual(parseAwarenessResponse('{"react":false}'), { react: false });
});

test('parseAwarenessResponse accepts a reaction and trims its text', () => {
  assert.deepEqual(
    parseAwarenessResponse('{"react":true,"text":"  Looks familiar.  ","animation":{"file":"wave.vrma"}}'),
    {
      react: true,
      text: 'Looks familiar.',
      text_ja: '',
      animation: { file: 'wave.vrma' },
      expression: null
    }
  );
});

test('parseAwarenessResponse accepts JSON wrapped in a markdown fence', () => {
  assert.deepEqual(
    parseAwarenessResponse('```json\n{"react":false}\n```'),
    { react: false }
  );
});

test('parseAwarenessResponse rejects malformed or incomplete decisions', () => {
  assert.equal(parseAwarenessResponse('not json'), null);
  assert.equal(parseAwarenessResponse('{"react":true}'), null);
  assert.equal(parseAwarenessResponse('{"react":"false","text":"Nope"}'), null);
});

test('expected awareness AbortErrors are distinguishable from real request failures', () => {
  assert.equal(isExpectedAwarenessAbort({ name: 'AbortError' }, 'awareness'), true);
  assert.equal(isExpectedAwarenessAbort({ name: 'TypeError' }, 'awareness'), false);
  assert.equal(isExpectedAwarenessAbort({ name: 'AbortError' }, undefined), false);
});

test('awarenessDedupeKey normalizes app identity and window-title noise', () => {
  const first = awarenessDedupeKey({
    trigger: 'typing_session_end',
    context: {
      bundleId: 'com.example.editor',
      appName: 'Editor',
      windowTitle: '  app.js   —   build 123  '
    }
  });
  const equivalent = awarenessDedupeKey({
    trigger: 'typing_session_end',
    context: {
      bundleId: 'com.example.editor',
      windowTitle: 'APP.JS — BUILD 987'
    }
  });

  assert.equal(first, 'typing_session_end|com.example.editor|app.js — build #');
  assert.equal(equivalent, first);
});

test('buildAwarenessPrompt carries transient desktop context and an explicit silence contract', () => {
  const prompt = buildAwarenessPrompt({
    trigger: 'typing_session_end',
    activity: { durationMs: 34_200, eventCount: 72 },
    context: { appName: 'Visual Studio Code', windowTitle: 'app.js — hikari-archive' },
    visualChange: { ratio: 0.16, level: 'significant' }
  }, [{ reactionText: 'Back to that bug again?' }]);

  assert.match(prompt, /Desktop awareness event:/);
  assert.match(prompt, /passively noticed this action/);
  assert.match(prompt, /Visual Studio Code/);
  assert.match(prompt, /app\.js — hikari-archive/);
  assert.match(prompt, /Recent proactive Hikari reactions:[\s\S]*Back to that bug again\?/);
  assert.match(prompt, /Prefer silence/);
  assert.match(prompt, /\{"react":false\}/);
  assert.match(prompt, /Return only one JSON object/);
});

test('buildAwarenessPrompt gives substantial typing a brief supportive reaction boundary', () => {
  const prompt = buildAwarenessPrompt({
    trigger: 'typing_session_end',
    activity: { durationMs: 8_400, eventCount: 12 },
    context: { appName: 'Visual Studio Code', windowTitle: 'notes.md — hikari-archive' },
    visualChange: { ratio: 0, level: 'none' }
  });

  assert.match(prompt, /meaningful typing (?:session|burst)/i);
  assert.match(prompt, /brief[\s\S]*(?:supportive|contextual)|(?:supportive|contextual)[\s\S]*brief/i);
  assert.match(prompt, /do not claim[\s\S]*(?:typed|what was typed)|do not infer[\s\S]*(?:typed|what was typed)/i);
});

test('buildAwarenessPrompt describes media state and source without inventing track metadata', () => {
  const prompt = buildAwarenessPrompt({
    trigger: 'media_playback_started',
    media: { state: 'playing', previousState: 'stopped', source: 'system_audio_output' },
    context: { appName: 'Safari', windowTitle: 'Video page' }
  });

  assert.match(prompt, /Media playback state: playing/);
  assert.match(prompt, /Media playback source: system_audio_output/);
  assert.match(prompt, /media playback/);
  assert.match(prompt, /Do not claim or guess the track, title, or content/);
});

test('parseMediaPlaybackOutput accepts only trimmed binary status values', () => {
  assert.equal(parseMediaPlaybackOutput(' 1\n'), true);
  assert.equal(parseMediaPlaybackOutput('0  '), false);
  for (const value of ['', '2', '01', 'playing', null, undefined, 1]) {
    assert.equal(parseMediaPlaybackOutput(value), null);
  }
});

test('MediaPlaybackStateTracker debounces transitions and ignores stable samples', () => {
  const tracker = new MediaPlaybackStateTracker();

  assert.equal(tracker.observe(false), null);
  assert.equal(tracker.observe(false), null);
  assert.equal(tracker.observe(true), null);
  assert.deepEqual(tracker.observe(true), { previousState: 'stopped', state: 'playing' });
  assert.equal(tracker.observe(true), null);
  assert.equal(tracker.observe(false), null);
  assert.deepEqual(tracker.observe(false), { previousState: 'playing', state: 'stopped' });
});

test('MediaPlaybackStateTracker resets its baseline and supports a custom debounce', () => {
  const tracker = new MediaPlaybackStateTracker({ debounceSamples: 3 });

  assert.equal(tracker.observe(false), null);
  assert.equal(tracker.observe(true), null);
  assert.equal(tracker.observe(true), null);
  assert.deepEqual(tracker.observe(true), { previousState: 'stopped', state: 'playing' });

  tracker.reset();
  assert.equal(tracker.observe(false), null);
  assert.equal(tracker.observe(true), null);
  assert.equal(tracker.observe(true), null);
  assert.deepEqual(tracker.observe(true), { previousState: 'stopped', state: 'playing' });
  assert.equal(tracker.observe(false), null);
  assert.equal(tracker.observe(false), null);
  assert.deepEqual(tracker.observe(false), { previousState: 'playing', state: 'stopped' });
});

test('normalizeActiveWindow returns stable, normalized context', { skip: !desktopAwarenessMain }, () => {
  assert.deepEqual(
    desktopAwarenessMain.normalizeActiveWindow({
      id: '42',
      title: '  Notes  ',
      owner: { name: '  TextEdit ', bundleId: ' com.apple.TextEdit ', processId: '99' },
      bounds: { x: '1', y: 2, width: 800, height: 600 }
    }),
    {
      appName: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
      windowTitle: 'Notes',
      windowId: 42,
      processId: 99,
      bounds: { x: 1, y: 2, width: 800, height: 600 }
    }
  );
});

test('enrichWindowTitleFromSource fills only a missing active-window title', { skip: !desktopAwarenessMain }, () => {
  const context = {
    appName: 'Editor',
    bundleId: 'com.example.editor',
    windowTitle: '',
    windowId: 42
  };
  assert.deepEqual(
    desktopAwarenessMain.enrichWindowTitleFromSource(context, { name: 'app.js' }),
    { ...context, windowTitle: 'app.js' }
  );
  assert.equal(
    desktopAwarenessMain.enrichWindowTitleFromSource({ ...context, windowTitle: 'existing' }, { name: 'ignored' }).windowTitle,
    'existing'
  );
});

test('getContextKey prefers bundle identity and falls back to title', { skip: !desktopAwarenessMain }, () => {
  assert.equal(
    desktopAwarenessMain.getContextKey({ bundleId: 'com.example.editor', appName: 'Editor', windowId: 7 }),
    'com.example.editor:7'
  );
  assert.equal(
    desktopAwarenessMain.getContextKey({ appName: 'Editor', windowTitle: 'app.js' }),
    'Editor:app.js'
  );
});

if (desktopAwarenessMainImportError) {
  test('desktop-awareness-main pure exports are skipped under plain Node', { skip: true }, () => {
    assert.fail(desktopAwarenessMainImportError);
  });
}

function withAwarenessDom(callback) {
  const previousDocument = globalThis.document;
  const previousLocalStorage = globalThis.localStorage;
  const statusElement = { textContent: '', title: '' };
  const permissionButton = { hidden: true, disabled: false, textContent: '', title: '' };
  const inputPermissionButton = { hidden: true, disabled: false, textContent: '', title: '' };
  const toggle = {
    checked: false,
    disabled: false,
    addEventListener() {}
  };
  const values = new Map();

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
    getElementById(id) {
      if (id === 'desktopAwarenessStatus') return statusElement;
      if (id === 'desktopAwarenessToggle') return toggle;
      if (id === 'desktopAwarenessScreenPermission') return permissionButton;
      if (id === 'desktopAwarenessInputPermission') return inputPermissionButton;
      return null;
    }
    }
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
    }
  });

  const restore = () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  };

  try {
    const result = callback({ statusElement, toggle, permissionButton, inputPermissionButton, values });
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test('renderStatus exposes Screen Recording denial as a limited state', () => {
  withAwarenessDom(({ statusElement }) => {
    const controller = new AwarenessController({});

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: false,
      errors: { screenCapture: 'denied' }
    });

    assert.equal(statusElement.textContent, 'On (limited)');
    assert.equal(statusElement.title, 'screenCapture: denied');
  });
});

test('renderStatus reports full readiness only when Screen Recording is available', () => {
  withAwarenessDom(({ statusElement }) => {
    const controller = new AwarenessController({});

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      errors: {}
    });

    assert.equal(statusElement.textContent, 'On');
    assert.equal(statusElement.title, 'Desktop awareness is active');
  });
});

test('renderStatus exposes a Screen Recording recovery action when permission is missing', () => {
  withAwarenessDom(({ permissionButton }) => {
    const controller = new AwarenessController({});

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: false,
      screenCaptureStatus: 'denied',
      errors: { screenCapture: 'denied' }
    });

    assert.equal(permissionButton.hidden, false);
    assert.equal(permissionButton.textContent, 'Open Screen Recording Settings');
    assert.match(permissionButton.title, /exact Hikari\/Electron app/);

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      screenCaptureStatus: 'granted',
      errors: {}
    });
    assert.equal(permissionButton.hidden, true);
  });
});

test('renderStatus exposes a Keyboard Monitoring recovery action when permission is missing', () => {
  withAwarenessDom(({ inputPermissionButton }) => {
    const controller = new AwarenessController({});

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: false,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      inputMonitoringStatus: 'denied',
      errors: { inputMonitoring: 'denied' }
    });

    assert.equal(inputPermissionButton.hidden, false);
    assert.equal(inputPermissionButton.textContent, 'Open Keyboard Monitoring Settings');
    assert.match(inputPermissionButton.title, /exact Hikari\/Electron app/);

    controller.renderStatus({
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      errors: {}
    });
    assert.equal(inputPermissionButton.hidden, true);
  });
});

test('requestScreenCapturePermission opens settings and exposes a refresh action', async () => {
  await withAwarenessDom(async ({ permissionButton }) => {
    const calls = [];
    const status = {
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: false,
      screenCaptureStatus: 'denied',
      settingsOpened: true,
      permissionKind: 'screen',
      errors: { screenCapture: 'denied' }
    };
    const controller = new AwarenessController({
      logger: { info() {}, error() {} },
      api: {
        async requestScreenCapturePermission() {
          calls.push(true);
          return status;
        }
      }
    });

    assert.deepEqual(await controller.requestScreenCapturePermission(), status);
    assert.deepEqual(calls, [true]);
    assert.equal(permissionButton.disabled, false);
    assert.equal(permissionButton.hidden, false);
    assert.equal(permissionButton.textContent, 'Refresh Screen Recording Status');
  });
});

test('requestInputMonitoringPermission opens settings and exposes a refresh action', async () => {
  await withAwarenessDom(async ({ inputPermissionButton }) => {
    const calls = [];
    const status = {
      enabled: true,
      inputMonitoringAvailable: false,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      settingsOpened: true,
      permissionKind: 'inputMonitoring',
      errors: { inputMonitoring: 'denied' }
    };
    const controller = new AwarenessController({
      logger: { info() {}, error() {} },
      api: {
        async requestInputMonitoringPermission() {
          calls.push(true);
          return status;
        }
      }
    });

    assert.deepEqual(await controller.requestInputMonitoringPermission(), status);
    assert.deepEqual(calls, [true]);
    assert.equal(inputPermissionButton.disabled, false);
    assert.equal(inputPermissionButton.hidden, false);
    assert.equal(inputPermissionButton.textContent, 'Refresh Keyboard Monitoring Status');
  });
});

test('refreshStatus hides the recovery action after Screen Recording is granted', async () => {
  await withAwarenessDom(({ permissionButton }) => {
    const granted = {
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: true,
      screenCaptureStatus: 'granted',
      errors: {}
    };
    const controller = new AwarenessController({
      logger: { info() {}, error() {} },
      api: {
        async refreshStatus() {
          return granted;
        }
      }
    });

    permissionButton.hidden = false;
    return controller.refreshStatus().then((status) => {
      assert.deepEqual(status, granted);
      assert.equal(permissionButton.hidden, true);
    });
  });
});

test('enabling awareness preserves a permission-limited status in the renderer', async () => {
  await withAwarenessDom(async ({ statusElement, toggle, values }) => {
    const calls = [];
    const status = {
      enabled: true,
      inputMonitoringAvailable: true,
      activeWindowAvailable: true,
      screenCaptureAvailable: false,
      errors: { screenCapture: 'denied' }
    };
    const controller = new AwarenessController({
      logger: { info() {}, error() {} },
      api: {
        async setEnabled(enabled) {
          calls.push(enabled);
          return status;
        }
      }
    });

    assert.deepEqual(await controller.setEnabled(true), status);
    assert.deepEqual(calls, [true]);
    assert.equal(values.get('desktop_awareness_enabled'), 'true');
    assert.equal(toggle.checked, true);
    assert.equal(statusElement.textContent, 'On (limited)');
    assert.equal(statusElement.title, 'screenCapture: denied');
  });
});
