import assert from 'node:assert/strict';
import test from 'node:test';

import { createServices } from '../shared/services.js';
import { createRemoteTtsService, validateRemoteTtsUrl } from '../electron/remote-tts-main.js';

const SAMPLE_RATE = 24_000;

function makeWav({ sampleRate = SAMPLE_RATE, channels = 1 } = {}) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 2, true);
  view.setInt16(44, 0, true);
  return bytes;
}

function wavResponse(audio = makeWav(), headers = {}) {
  return new Response(audio, {
    headers: {
      'content-type': 'audio/wav',
      'x-audio-duration': '1.25',
      'x-audio-sample-rate': String(SAMPLE_RATE),
      'x-audio-channels': '1',
      ...headers
    }
  });
}

test('browser chat posts only the app payload to the same-origin API and returns Response', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const response = new Response(JSON.stringify({ choices: [] }), { status: 200 });
  const services = createServices({
    electronAPI: undefined,
    fetchImpl: async (...args) => { calls.push(args); return response; }
  });

  assert.deepEqual(services.capabilities, {
    electron: false,
    browser: true,
    chat: true,
    tts: true,
    health: true,
    nativeTts: false,
    windowControl: false,
    desktopAwareness: false,
    nativeSpeechRecognition: false,
    microphoneCapture: typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
  });
  const result = await services.chat({ messages: [{ role: 'user', content: 'hello' }], model: 'openclaw/default' }, {
    gatewayUrl: 'https://must-not-leak.example', token: 'browser-secret', signal
  });
  assert.equal(result, response);
  assert.equal(calls[0][0], '/api/chat');
  assert.deepEqual({ ...calls[0][1], signal: undefined }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], model: 'openclaw/default' }),
    signal: undefined
  });
  assert.equal(calls[0][1].signal.aborted, false);
});

test('Electron chat keeps caller gateway, token, and abort signal configurable', async () => {
  const calls = [];
  const api = { setWindowPosition() {}, tts: { synthesize: async () => null } };
  const response = new Response('{}', { status: 503 });
  const services = createServices({
    electronAPI: api,
    fetchImpl: async (...args) => { calls.push(args); return response; }
  });
  const signal = new AbortController().signal;
  const actual = await services.chat({ messages: [], model: 'openclaw/default' }, {
    gatewayUrl: 'ws://127.0.0.1:18789', token: 'desktop-token', signal
  });

  assert.equal(actual, response);
  assert.equal(calls[0][0], 'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer desktop-token');
  assert.equal(calls[0][1].signal.aborted, false);
  assert.equal(services.capabilities.electron, true);
  assert.equal(services.capabilities.nativeTts, true);
  assert.equal(services.capabilities.windowControl, true);
});

test('browser TTS validates the WAV and returns audio metadata', async () => {
  const calls = [];
  const services = createServices({
    electronAPI: null,
    fetchImpl: async (...args) => { calls.push(args); return wavResponse(); }
  });

  const result = await services.synthesize({ text: '  こんにちは  ', speed: 1.1 });
  assert.deepEqual(result, {
    audio: makeWav(), durationSeconds: 1.25, sampleRate: SAMPLE_RATE, channels: 1, voice: 'custom_voice'
  });
  assert.equal(calls[0][0], '/api/tts');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: 'こんにちは', speed: 1.1 });
  assert.equal(calls[0][1].headers.Accept, 'audio/wav');
});

test('Electron TTS uses its native adapter and normalizes the result shape', async () => {
  const nativeCalls = [];
  const services = createServices({
    electronAPI: { tts: { synthesize: async (input) => {
      nativeCalls.push(input);
      return { audio: makeWav(), durationSeconds: 1.25, sampleRate: SAMPLE_RATE, channels: 1 };
    } } },
    fetchImpl: async () => { throw new Error('native path should not fetch'); }
  });

  const result = await services.synthesize({ text: ' hello ', speed: 1 });
  assert.deepEqual(nativeCalls, [{ text: 'hello', speed: 1 }]);
  assert.equal(result.voice, 'custom_voice');
  assert.deepEqual(result.audio, makeWav());
});

test('TTS rejects malformed metadata, mismatched WAV data, and oversized responses', async () => {
  const badMetadata = createServices({
    electronAPI: null,
    fetchImpl: async () => wavResponse(makeWav(), { 'x-audio-sample-rate': '999999' })
  });
  await assert.rejects(badMetadata.synthesize({ text: 'hello', speed: 1 }), { code: 'INVALID_TTS_METADATA' });

  const mismatchedWav = createServices({
    electronAPI: null,
    fetchImpl: async () => wavResponse(makeWav({ sampleRate: 22_050 }))
  });
  await assert.rejects(mismatchedWav.synthesize({ text: 'hello', speed: 1 }), { code: 'TTS_METADATA_MISMATCH' });

  const oversized = createServices({
    electronAPI: null,
    fetchImpl: async () => wavResponse(new Uint8Array(32 * 1024 * 1024 + 1))
  });
  await assert.rejects(oversized.synthesize({ text: 'hello', speed: 1 }), { code: 'RESPONSE_TOO_LARGE' });
});

test('browser service validates synthesis inputs before making a request', async () => {
  let requestCount = 0;
  const services = createServices({
    electronAPI: null,
    fetchImpl: async () => { requestCount += 1; return wavResponse(); }
  });
  await assert.rejects(services.synthesize({ text: '   ', speed: 1 }), RangeError);
  await assert.rejects(services.synthesize({ text: 'hello', speed: 2.1 }), RangeError);
  await assert.rejects(services.synthesize({ text: 'x'.repeat(501), speed: 1 }), RangeError);
  assert.equal(requestCount, 0);
});

test('health check reads same-origin JSON and returns parsed service state', async () => {
  const calls = [];
  const health = { ok: true, openclaw: { configured: true, reachable: true }, tts: { configured: true, reachable: true } };
  const services = createServices({
    electronAPI: null,
    fetchImpl: async (...args) => { calls.push(args); return Response.json(health); }
  });
  assert.deepEqual(await services.getHealth(), health);
  assert.equal(calls[0][0], '/api/health');
  assert.equal(calls[0][1].method, 'GET');
});

test('HTTP errors include status and bounded diagnostic metadata', async () => {
  const services = createServices({
    electronAPI: null,
    fetchImpl: async () => new Response('x'.repeat(10_000), { status: 502, statusText: 'Bad Gateway' })
  });
  await assert.rejects(services.getHealth(), (error) => {
    assert.equal(error.code, 'HEALTH_HTTP_ERROR');
    assert.equal(error.status, 502);
    assert.equal(error.statusText, 'Bad Gateway');
    assert.ok(error.bodySnippet.length <= 1_024);
    assert.match(error.message, /truncated/);
    return true;
  });
});

test('remote TTS accepts loopback HTTP only and shares the browser transport', async () => {
  assert.equal(validateRemoteTtsUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(validateRemoteTtsUrl('http://127.0.0.2:4567'), 'http://127.0.0.2:4567');
  assert.throws(() => validateRemoteTtsUrl('https://localhost:3000'), /loopback address/);
  assert.throws(() => validateRemoteTtsUrl('http://example.com:3000'), /loopback address/);
  assert.throws(() => validateRemoteTtsUrl('http://arbitrary.localhost:3000'), /loopback address/);

  const calls = [];
  const service = createRemoteTtsService({
    url: 'http://127.0.0.1:4567',
    fetch: async (...args) => { calls.push(args); return wavResponse(); },
    timeoutMs: 100
  });
  const result = await service.synthesize({ text: 'hello', speed: 1 });
  assert.equal(calls[0][0], 'http://127.0.0.1:4567/api/tts');
  assert.equal(result.voice, 'custom_voice');
  service.dispose();
  await assert.rejects(service.synthesize({ text: 'hello', speed: 1 }), { code: 'SERVICE_DISPOSED' });
});

test('disposing the remote TTS service aborts an in-flight request', async () => {
  let observedSignal;
  const service = createRemoteTtsService({
    url: 'http://localhost:8012',
    fetch: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
    timeoutMs: 60_000
  });
  const pending = service.synthesize({ text: 'hello', speed: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();
  await assert.rejects(pending, { code: 'SERVICE_DISPOSED' });
  assert.equal(observedSignal.aborted, true);
});
