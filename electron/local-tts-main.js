import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER_ORIGIN = 'http://127.0.0.1:8010';
const DEFAULT_STARTUP_TIMEOUT_MS = 240_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 185_000;
const DEFAULT_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const DEFAULT_PYTHON_PATH = '/opt/homebrew/bin/python3.11';
const HEALTH_PATH = '/health';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function defaultToolDir() {
  const candidates = [
    path.resolve(moduleDirectory, '../tools/companion-tts'),
    path.resolve(moduleDirectory, '../../tools/companion-tts'),
    path.resolve(moduleDirectory, '../../../tools/companion-tts')
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'tts.py'))) ?? candidates[0];
}

function abortError() {
  const error = new Error('Local TTS service was disposed');
  error.name = 'AbortError';
  return error;
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function isSuccessfulResponse(response) {
  if (typeof response?.ok === 'boolean') return response.ok;
  return Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
}

async function readBoundedBody(response, limit, signal) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error('Local TTS response exceeded the allowed size');
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await raceWithSignal(response.arrayBuffer(), signal));
    if (bytes.byteLength > limit) throw new Error('Local TTS response exceeded the allowed size');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        cancelReader();
        throw new Error('Local TTS response exceeded the allowed size');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may still have a read resolving in the background.
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
    throw new Error('Local TTS adapter returned invalid JSON');
  }
}

function validateInput(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Synthesis request must be an object');
  }
  if (typeof request.text !== 'string') {
    throw new TypeError('Synthesis text must be a string');
  }

  const text = request.text.trim();
  const textLength = Array.from(text).length;
  if (textLength < 1 || textLength > 500) {
    throw new RangeError('Synthesis text must contain 1 to 500 characters');
  }

  const speed = request.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new RangeError('Synthesis speed must be between 0.5 and 2');
  }
  return { text, speed };
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Local TTS adapter returned invalid speech metadata');
  }

  const { audio_url: audioUrl, duration_seconds: durationSeconds, sample_rate: sampleRate, channels, voice } = metadata;
  if (
    typeof audioUrl !== 'string' || !/^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(audioUrl) ||
    typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600 ||
    !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
    !Number.isInteger(channels) || channels < 1 || channels > 2 ||
    voice !== 'custom_voice'
  ) {
    throw new Error('Local TTS adapter returned invalid speech metadata');
  }

  const audioUrlObject = new URL(audioUrl, ADAPTER_ORIGIN);
  if (audioUrlObject.origin !== ADAPTER_ORIGIN || audioUrlObject.pathname !== audioUrl || audioUrlObject.search || audioUrlObject.hash) {
    throw new Error('Local TTS adapter returned an unsafe audio path');
  }

  return { audioUrl, durationSeconds, sampleRate, channels, voice };
}

function validateWav(audio, sampleRate, channels) {
  if (
    audio.byteLength < 44 ||
    String.fromCharCode(...audio.subarray(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...audio.subarray(8, 12)) !== 'WAVE'
  ) {
    throw new Error('Local TTS adapter returned invalid WAV audio');
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (view.getUint32(4, true) + 8 !== audio.byteLength) {
    throw new Error('Local TTS adapter returned invalid WAV audio');
  }

  let offset = 12;
  let formatFound = false;
  let dataFound = false;
  while (offset + 8 <= audio.byteLength) {
    const chunkName = String.fromCharCode(...audio.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > audio.byteLength) throw new Error('Local TTS adapter returned invalid WAV audio');

    if (chunkName === 'fmt ') {
      if (chunkSize < 16) throw new Error('Local TTS adapter returned invalid WAV audio');
      const wavChannels = view.getUint16(chunkStart + 2, true);
      const wavSampleRate = view.getUint32(chunkStart + 4, true);
      if (wavChannels !== channels || wavSampleRate !== sampleRate) {
        throw new Error('Local TTS metadata did not match its WAV audio');
      }
      formatFound = true;
    } else if (chunkName === 'data') {
      dataFound = true;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (offset !== audio.byteLength || !formatFound || !dataFound) {
    throw new Error('Local TTS adapter returned invalid WAV audio');
  }
}

/**
 * Create a main-process service for the loopback Japanese custom-voice adapter.
 * Optional test/runtime settings: toolDir, pythonPath, fetch (or fetchImpl),
 * spawn, healthTimeoutMs, synthesisTimeoutMs (or requestTimeoutMs),
 * startupTimeoutMs, pollIntervalMs, and maxAudioBytes.
 */
export function createLocalTtsService(options = {}) {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawn ?? nodeSpawn;
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
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  if (typeof spawnImpl !== 'function') throw new TypeError('A spawn implementation is required');

  let disposed = false;
  let startupPromise = null;
  let queueTail = Promise.resolve();
  let ownedChild = null;
  const activeControllers = new Set();
  const pendingTimers = new Set();
  let resolveDisposed;
  const disposedPromise = new Promise((resolve) => { resolveDisposed = resolve; });

  function assertActive() {
    if (disposed) throw abortError();
  }

  function raceDisposed(promise) {
    return Promise.race([
      promise,
      disposedPromise.then(() => { throw abortError(); })
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
      if (timedOut) throw new Error('Local TTS request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
    }
  }

  function childFailure() {
    if (!ownedChild) return null;
    if (ownedChild.failure || ownedChild.exited) return new Error('Local TTS adapter process exited unexpectedly');
    const exitCode = ownedChild.process.exitCode;
    if (typeof exitCode === 'number') return new Error('Local TTS adapter process exited unexpectedly');
    return null;
  }

  function spawnAdapter() {
    assertActive();
    if (ownedChild && !childFailure()) return;

    let child;
    try {
      child = spawnImpl(pythonPath, ['-u', 'tts.py', 'serve'], {
        cwd: toolDir,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      throw new Error('Unable to start the local TTS adapter');
    }
    if (!child || typeof child.once !== 'function') {
      throw new Error('Unable to start the local TTS adapter');
    }

    const record = { process: child, failure: null, exited: false };
    child.once('error', () => { record.failure = true; });
    child.once('exit', () => { record.exited = true; });
    ownedChild = record;
  }

  async function checkHealth() {
    try {
      return await withRequest(`${ADAPTER_ORIGIN}${HEALTH_PATH}`, { method: 'GET' }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) return false;
        const health = await readJson(response, signal);
        return health?.ready === true && health?.voice === 'custom_voice';
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
      if (remaining <= 0) throw new Error('Local TTS adapter did not become ready before the startup timeout');
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
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: request.text, speed: request.speed, cache: true })
      }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) throw new Error('Local TTS speech request failed');
        return validateMetadata(await readJson(response, signal));
      });

      assertActive();
      const absoluteAudioUrl = new URL(metadata.audioUrl, ADAPTER_ORIGIN).href;
      const audio = await withRequest(absoluteAudioUrl, { method: 'GET' }, async (response, signal) => {
        if (!isSuccessfulResponse(response)) throw new Error('Local TTS audio request failed');
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
    queueTail = operation.then(() => undefined, () => undefined);
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
        ownedChild.process.kill('SIGTERM');
      } catch {
        // Disposal is best-effort if the owned child has already exited.
      }
    }
  }

  return { synthesize, dispose };
}
