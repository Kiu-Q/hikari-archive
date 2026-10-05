const MAX_TEXT_LENGTH = 500;
const MAX_ERROR_BYTES = 1_024;
const MAX_HEALTH_BYTES = 64 * 1_024;
const MAX_AUDIO_BYTES = 32 * 1_024 * 1_024;
const HTTP_TTS_TIMEOUT_MS = 450_000;
const CHAT_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 8_000;

function validateSynthesisInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Synthesis request must be an object');
  }
  if (typeof input.text !== 'string') {
    throw new TypeError('Synthesis text must be a string');
  }

  const text = input.text.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Synthesis text must contain 1 to ${MAX_TEXT_LENGTH} characters`);
  }
  if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) {
    throw new RangeError('Synthesis speed must be between 0.5 and 2');
  }
  return { text, speed: input.speed };
}

function serviceError(message, { code, status, statusText, bodySnippet, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  if (code) error.code = code;
  if (status !== undefined) error.status = status;
  if (statusText) error.statusText = String(statusText).slice(0, 128);
  if (bodySnippet) error.bodySnippet = bodySnippet.slice(0, MAX_ERROR_BYTES);
  return error;
}

async function readBoundedBytes(response, limit) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw serviceError('Response exceeded the allowed size', { code: 'RESPONSE_TOO_LARGE' });
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
          await reader.cancel().catch(() => {});
          throw serviceError('Response exceeded the allowed size', { code: 'RESPONSE_TOO_LARGE' });
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

  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) {
      throw serviceError('Response exceeded the allowed size', { code: 'RESPONSE_TOO_LARGE' });
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
    if (error?.code === 'RESPONSE_TOO_LARGE') return '[error response truncated]';
    return '';
  }
}

async function throwForResponse(response, context) {
  const bodySnippet = await readErrorSnippet(response);
  const status = Number.isInteger(response.status) ? response.status : undefined;
  const message = `${context} request failed${status === undefined ? '' : ` (HTTP ${status})`}`
    + (bodySnippet ? `: ${bodySnippet}` : '');
  throw serviceError(message, {
    code: `${context.toUpperCase()}_HTTP_ERROR`,
    status,
    statusText: response.statusText,
    bodySnippet
  });
}

function validateSpeechMetadata(durationSeconds, sampleRate, channels) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) {
    throw serviceError('TTS service returned invalid audio duration', { code: 'INVALID_TTS_METADATA' });
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw serviceError('TTS service returned invalid sample rate', { code: 'INVALID_TTS_METADATA' });
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw serviceError('TTS service returned invalid channel count', { code: 'INVALID_TTS_METADATA' });
  }
}

function validateWav(audio, sampleRate, channels) {
  const fail = () => { throw serviceError('TTS service returned invalid WAV audio', { code: 'INVALID_TTS_AUDIO' }); };
  if (audio.byteLength < 44) fail();
  const ascii = (offset, count) => String.fromCharCode(...audio.subarray(offset, offset + count));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') fail();

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
    if (chunkName === 'fmt ') {
      if (chunkSize < 16) fail();
      if (view.getUint16(chunkStart + 2, true) !== channels || view.getUint32(chunkStart + 4, true) !== sampleRate) {
        throw serviceError('TTS metadata does not match its WAV audio', { code: 'TTS_METADATA_MISMATCH' });
      }
      formatFound = true;
    }
    if (chunkName === 'data') dataFound = true;
    offset = chunkEnd + (chunkSize % 2);
  }
  if (offset !== audio.byteLength || !formatFound || !dataFound) fail();
}

function normalizeAudioBuffer(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value);
  }
  throw serviceError('TTS service returned invalid audio data', { code: 'INVALID_TTS_AUDIO' });
}

function normalizeNativeTtsResult(result) {
  if (!result || typeof result !== 'object') {
    throw serviceError('Electron TTS returned invalid speech metadata', { code: 'INVALID_TTS_METADATA' });
  }
  const audio = normalizeAudioBuffer(result.audio);
  const { durationSeconds, sampleRate, channels } = result;
  validateSpeechMetadata(durationSeconds, sampleRate, channels);
  if (result.voice !== undefined && result.voice !== 'custom_voice') {
    throw serviceError('Electron TTS returned an unsupported voice', { code: 'INVALID_TTS_METADATA' });
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw serviceError('TTS audio exceeded the allowed size', { code: 'RESPONSE_TOO_LARGE' });
  }
  validateWav(audio, sampleRate, channels);
  return { audio, durationSeconds, sampleRate, channels, voice: 'custom_voice' };
}

function makeRequestController(signal, timeoutMs, activeControllers) {
  const controller = new AbortController();
  activeControllers.add(controller);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });

  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(serviceError('TTS request timed out', { code: 'TTS_TIMEOUT' })), timeoutMs)
    : null;
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
      activeControllers.delete(controller);
    }
  };
}

/**
 * Create the HTTP transport used by browser TTS and Electron's remote TTS
 * adapter. `endpoint` may be relative for a same-origin browser request.
 */
export function createHttpTtsClient({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/tts',
  timeoutMs = HTTP_TTS_TIMEOUT_MS,
  maxAudioBytes = MAX_AUDIO_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const activeControllers = new Set();
  let disposed = false;

  return {
    async synthesize(input, { signal } = {}) {
      if (disposed) throw serviceError('TTS client is disposed', { code: 'SERVICE_DISPOSED' });
      const request = validateSynthesisInput(input);
      const requestController = makeRequestController(signal, timeoutMs, activeControllers);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
          body: JSON.stringify(request),
          signal: requestController.signal
        });
        if (!response.ok) await throwForResponse(response, 'TTS');

        const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType && contentType !== 'audio/wav' && contentType !== 'audio/x-wav' && contentType !== 'application/octet-stream') {
          throw serviceError('TTS service returned a non-WAV response', { code: 'INVALID_TTS_AUDIO' });
        }

        const durationSeconds = Number(response.headers?.get?.('x-audio-duration'));
        const sampleRate = Number(response.headers?.get?.('x-audio-sample-rate'));
        const channels = Number(response.headers?.get?.('x-audio-channels'));
        validateSpeechMetadata(durationSeconds, sampleRate, channels);

        const audio = await readBoundedBytes(response, maxAudioBytes);
        validateWav(audio, sampleRate, channels);
        return { audio, durationSeconds, sampleRate, channels, voice: 'custom_voice' };
      } finally {
        requestController.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of activeControllers) controller.abort(serviceError('TTS client is disposed', { code: 'SERVICE_DISPOSED' }));
    }
  };
}

function isNativeTtsAvailable(electronAPI) {
  return typeof electronAPI?.tts?.synthesize === 'function';
}

function normalizeGatewayUrl(gatewayUrl) {
  if (typeof gatewayUrl !== 'string' || gatewayUrl.trim().length === 0 || gatewayUrl.length > 2_048) {
    throw new TypeError('Electron chat requires a configured gatewayUrl');
  }
  const rawUrl = gatewayUrl.trim().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  let url;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw serviceError('Invalid OpenClaw gateway URL', { code: 'INVALID_GATEWAY_URL', cause });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw serviceError('Invalid OpenClaw gateway URL', { code: 'INVALID_GATEWAY_URL' });
  }
  let base = url.toString().replace(/\/+$/, '');
  if (base.endsWith('/v1/chat/completions')) return base;
  return `${base}/v1/chat/completions`;
}

function requireResponse(response, context) {
  if (!response || typeof response.ok !== 'boolean') {
    throw serviceError(`${context} fetch returned an invalid response`, { code: 'INVALID_RESPONSE' });
  }
  return response;
}

/** Create the portable app service boundary for Electron and browser clients. */
export function createServices({
  electronAPI = globalThis.window?.electronAPI,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const isElectron = Boolean(electronAPI);
  const hasNativeTts = isNativeTtsAvailable(electronAPI);
  const httpTts = createHttpTtsClient({ fetchImpl, endpoint: '/api/tts' });
  const chatControllers = new Set();
  const healthControllers = new Set();

  const capabilities = Object.freeze({
    electron: isElectron,
    browser: !isElectron,
    chat: true,
    tts: true,
    health: !isElectron,
    nativeTts: hasNativeTts,
    windowControl: typeof electronAPI?.setWindowPosition === 'function'
      || typeof electronAPI?.setWindowBounds === 'function',
    desktopAwareness: typeof electronAPI?.awareness?.getStatus === 'function',
    nativeSpeechRecognition: typeof electronAPI?.voice?.transcribe === 'function',
    microphoneCapture: typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
  });

  return {
    capabilities,
    async synthesize(input, options = {}) {
      const request = validateSynthesisInput(input);
      if (hasNativeTts) {
        const result = await electronAPI.tts.synthesize(request);
        return normalizeNativeTtsResult(result);
      }
      return httpTts.synthesize(request, options);
    },
    async chat({ messages, model } = {}, { gatewayUrl, token, signal } = {}) {
      if (!Array.isArray(messages)) throw new TypeError('Chat messages must be an array');
      const body = { messages };
      if (model !== undefined) body.model = model;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      let url = '/api/chat';

      if (isElectron) {
        url = normalizeGatewayUrl(gatewayUrl);
        if (typeof token === 'string' && token.length > 0) headers.Authorization = `Bearer ${token}`;
      }

      const requestController = makeRequestController(signal, CHAT_TIMEOUT_MS, chatControllers);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: requestController.signal
        });
        return requireResponse(response, 'Chat');
      } finally {
        requestController.dispose();
      }
    },
    async getHealth({ signal } = {}) {
      if (isElectron) {
        throw serviceError('Health checks are available in the browser client', { code: 'UNSUPPORTED_CAPABILITY' });
      }
      const requestController = makeRequestController(signal, HEALTH_TIMEOUT_MS, healthControllers);
      try {
        const response = requireResponse(await fetchImpl('/api/health', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: requestController.signal
        }), 'Health');
        if (!response.ok) await throwForResponse(response, 'Health');
        const bytes = await readBoundedBytes(response, MAX_HEALTH_BYTES);
        try {
          const data = JSON.parse(new TextDecoder().decode(bytes));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Health response must be an object');
          return data;
        } catch (cause) {
          throw serviceError('Health service returned invalid JSON', { code: 'INVALID_HEALTH_RESPONSE', cause });
        }
      } finally {
        requestController.dispose();
      }
    },
    dispose() {
      httpTts.dispose();
      const disposedError = serviceError('Service client is disposed', { code: 'SERVICE_DISPOSED' });
      for (const controller of [...chatControllers, ...healthControllers]) controller.abort(disposedError);
    }
  };
}
