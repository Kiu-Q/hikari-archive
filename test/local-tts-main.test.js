import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createLocalTtsService } from '../electron/local-tts-main.js';

const AUDIO_HASH = 'a'.repeat(64);
const SAMPLE_RATE = 24_000;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

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

function speechMetadata(audioUrl = `/v1/audio/${AUDIO_HASH}.wav`) {
  return {
    audio_url: audioUrl,
    duration_seconds: 1.25,
    sample_rate: SAMPLE_RATE,
    channels: 1,
    voice: 'custom_voice'
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killed = true;
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('reuses a healthy adapter and returns validated WAV audio and metadata', async () => {
  const requests = [];
  let spawnCount = 0;
  const service = createLocalTtsService({
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/health')) {
        return jsonResponse({ ready: true, voice: 'custom_voice' });
      }
      if (String(url).endsWith('/v1/speech')) return jsonResponse(speechMetadata());
      return new Response(makeWav(), { headers: { 'content-type': 'audio/wav' } });
    },
    spawn: () => { spawnCount += 1; throw new Error('should reuse adapter'); }
  });

  const result = await service.synthesize({ text: '  こんにちは。  ', speed: 1.1 });
  assert.deepEqual({
    durationSeconds: result.durationSeconds,
    sampleRate: result.sampleRate,
    channels: result.channels,
    voice: result.voice
  }, {
    durationSeconds: 1.25,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    voice: 'custom_voice'
  });
  assert.ok(result.audio instanceof Uint8Array);
  assert.deepEqual(result.audio, makeWav());
  assert.equal(spawnCount, 0);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'http://127.0.0.1:8010/health');
  assert.equal(requests[2].url, `http://127.0.0.1:8010/v1/audio/${AUDIO_HASH}.wav`);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    text: 'こんにちは。',
    speed: 1.1,
    cache: true
  });

  service.dispose();
});

test('starts and polls an absent adapter, then disposes only its owned child', async () => {
  let healthChecks = 0;
  const child = fakeChild();
  const spawnCalls = [];
  const service = createLocalTtsService({
    toolDir: '/repo/tools/companion-tts',
    pythonPath: '/custom/python',
    startupTimeoutMs: 1_000,
    pollIntervalMs: 1,
    fetch: async (url) => {
      const address = String(url);
      if (address.endsWith('/health')) {
        healthChecks += 1;
        return healthChecks === 1
          ? jsonResponse({ ready: false }, 503)
          : jsonResponse({ ready: true, voice: 'custom_voice' });
      }
      if (address.endsWith('/v1/speech')) return jsonResponse(speechMetadata());
      return new Response(makeWav());
    },
    spawn: (...args) => {
      spawnCalls.push(args);
      return child;
    }
  });

  await service.synthesize({ text: 'おはよう', speed: 1 });
  assert.equal(healthChecks, 2);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], '/custom/python');
  assert.deepEqual(spawnCalls[0][1], ['-u', 'tts.py', 'serve']);
  assert.equal(spawnCalls[0][2].cwd, '/repo/tools/companion-tts');

  service.dispose();
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('restarts the adapter for a later generation after the server goes down', async () => {
  let adapterReady = true;
  let spawned = false;
  let healthChecks = 0;
  const child = fakeChild();
  const service = createLocalTtsService({
    startupTimeoutMs: 1_000,
    pollIntervalMs: 1,
    fetch: async (url) => {
      const address = String(url);
      if (address.endsWith('/health')) {
        healthChecks += 1;
        return adapterReady
          ? jsonResponse({ ready: true, voice: 'custom_voice' })
          : jsonResponse({ ready: false }, 503);
      }
      if (address.endsWith('/v1/speech')) return jsonResponse(speechMetadata());
      return new Response(makeWav());
    },
    spawn: () => {
      spawned = true;
      adapterReady = true;
      return child;
    }
  });

  await service.synthesize({ text: '一度目', speed: 1 });
  adapterReady = false;
  await service.synthesize({ text: '二度目', speed: 1 });
  assert.equal(spawned, true);
  assert.ok(healthChecks >= 4);
  service.dispose();
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('bounds health probes separately from synthesis requests', async () => {
  let healthChecks = 0;
  let healthTimedOut = false;
  let synthesisSignal;
  const child = fakeChild();
  const service = createLocalTtsService({
    toolDir: '/repo/tools/companion-tts',
    healthTimeoutMs: 15,
    synthesisTimeoutMs: 2_000,
    startupTimeoutMs: 500,
    pollIntervalMs: 1,
    fetch: async (url, init = {}) => {
      const address = String(url);
      if (address.endsWith('/health')) {
        healthChecks += 1;
        if (healthChecks === 1) {
          return new Promise((resolve) => {
            init.signal.addEventListener('abort', () => {
              healthTimedOut = true;
              resolve(jsonResponse({ ready: false }, 503));
            }, { once: true });
          });
        }
        return jsonResponse({ ready: true, voice: 'custom_voice' });
      }
      if (address.endsWith('/v1/speech')) {
        synthesisSignal = init.signal;
        return jsonResponse(speechMetadata());
      }
      return new Response(makeWav());
    },
    spawn: () => child
  });

  await service.synthesize({ text: '短い確認', speed: 1 });
  assert.equal(healthTimedOut, true);
  assert.equal(synthesisSignal.aborted, false);
  service.dispose();
});

test('rejects audio URLs outside the constrained same-origin adapter route', async () => {
  let audioRequests = 0;
  const service = createLocalTtsService({
    fetch: async (url) => {
      const address = String(url);
      if (address.endsWith('/health')) return jsonResponse({ ready: true, voice: 'custom_voice' });
      if (address.endsWith('/v1/speech')) {
        return jsonResponse(speechMetadata(`http://127.0.0.1:8010/v1/audio/${AUDIO_HASH}.wav`));
      }
      audioRequests += 1;
      return new Response(makeWav());
    },
    spawn: () => { throw new Error('should reuse adapter'); }
  });

  await assert.rejects(
    service.synthesize({ text: 'こんにちは', speed: 1 }),
    /invalid speech metadata|unsafe audio path/i
  );
  assert.equal(audioRequests, 0);
  service.dispose();
});

test('serializes complete synthesis operations', async () => {
  let releaseFirstPost;
  let firstPostStarted;
  const firstStarted = new Promise((resolve) => { firstPostStarted = resolve; });
  const firstPostGate = new Promise((resolve) => { releaseFirstPost = resolve; });
  let speechCount = 0;
  let activeSpeechRequests = 0;
  let maximumActiveSpeechRequests = 0;
  const service = createLocalTtsService({
    fetch: async (url) => {
      const address = String(url);
      if (address.endsWith('/health')) return jsonResponse({ ready: true, voice: 'custom_voice' });
      if (address.endsWith('/v1/speech')) {
        speechCount += 1;
        const current = speechCount;
        activeSpeechRequests += 1;
        maximumActiveSpeechRequests = Math.max(maximumActiveSpeechRequests, activeSpeechRequests);
        if (current === 1) {
          firstPostStarted();
          await firstPostGate;
        }
        activeSpeechRequests -= 1;
        return jsonResponse(speechMetadata(`/v1/audio/${String(current).padStart(64, '0')}.wav`));
      }
      return new Response(makeWav());
    },
    spawn: () => { throw new Error('should reuse adapter'); }
  });

  const first = service.synthesize({ text: '一つ目', speed: 1 });
  const second = service.synthesize({ text: '二つ目', speed: 1 });
  await firstStarted;
  assert.equal(speechCount, 1);
  releaseFirstPost();
  await Promise.all([first, second]);
  assert.equal(speechCount, 2);
  assert.equal(maximumActiveSpeechRequests, 1);
  service.dispose();
});

test('disposal promptly aborts active and queued requests without stopping a reused adapter', async () => {
  let speechRequests = 0;
  const service = createLocalTtsService({
    fetch: async (url, init = {}) => {
      const address = String(url);
      if (address.endsWith('/health')) return jsonResponse({ ready: true, voice: 'custom_voice' });
      if (address.endsWith('/v1/speech')) {
        speechRequests += 1;
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return new Response(makeWav());
    },
    spawn: () => { throw new Error('should reuse adapter'); }
  });

  const active = service.synthesize({ text: '処理中', speed: 1 });
  const queued = service.synthesize({ text: '待機中', speed: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();

  const results = await Promise.allSettled([active, queued]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  assert.ok(results.every((result) => result.reason.name === 'AbortError'));
  assert.equal(speechRequests, 1);
});

test('validates text length and speed before contacting the adapter', async () => {
  let requestCount = 0;
  const service = createLocalTtsService({
    fetch: async () => { requestCount += 1; return jsonResponse({ ready: true, voice: 'custom_voice' }); },
    spawn: () => { throw new Error('not expected'); }
  });

  await assert.rejects(service.synthesize({ text: '  ', speed: 1 }), RangeError);
  await assert.rejects(service.synthesize({ text: 'hello', speed: 2.1 }), RangeError);
  await assert.rejects(service.synthesize({ text: 'x'.repeat(501), speed: 1 }), RangeError);
  assert.equal(requestCount, 0);
  service.dispose();
});
