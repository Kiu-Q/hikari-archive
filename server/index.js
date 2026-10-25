import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { createLocalTtsService } from '../electron/local-tts-main.js';

const OPENCLAW_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const TTS_HEALTH_URL = 'http://127.0.0.1:8010/health';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_CHAT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TTS_BODY_BYTES = 16 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 24_000;
const MAX_TOTAL_MESSAGE_CHARS = 100_000;
const DEFAULT_CHAT_TIMEOUT_MS = 180_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function acceptsGzip(value = '') {
  const encodings = new Map(value.split(',').map(part => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return [name, quality ? Number(quality.trim().slice(2)) : 1];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.vrma', 'application/octet-stream'],
  ['.vrm', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseAllowedOrigins(options) {
  const supplied = options.allowedOrigins ?? options.publicOrigin ?? process.env.HIKARI_PUBLIC_ORIGIN ?? process.env.HIKARI_ALLOWED_ORIGINS;
  const origins = new Set();
  if (Array.isArray(supplied)) {
    for (const entry of supplied) addOrigin(entry, origins);
  } else if (typeof supplied === 'string' && supplied.trim()) {
    for (const entry of supplied.split(',')) addOrigin(entry, origins);
  }

  // The built-in local UI and Vite web development origin are explicit entries.
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8081', 'http://127.0.0.1:8081']) {
    origins.add(origin);
  }
  return origins;
}

function addOrigin(value, origins) {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const url = new URL(value.trim());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value.trim().replace(/\/$/, '')) {
      origins.add(url.origin);
    }
  } catch {
    // Ignore malformed entries. An invalid allowlist entry never grants access.
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}

function errorBody(message) {
  return { error: { message } };
}

async function readRequestBody(request, limit) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    const error = new Error('Request body is too large');
    error.statusCode = 413;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > limit) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedResponse(response, limit) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('Upstream response is too large');

  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error('Upstream response is too large');
    return bytes;
  }

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
        throw new Error('Upstream response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled reader may still be closing. */ }
  }
  return Buffer.concat(chunks, total);
}

async function readOpenClawToken(homeDir) {
  try {
    const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    const details = await stat(configPath);
    if (!details.isFile() || details.size > 1024 * 1024) return null;
    const contents = await readFile(configPath, 'utf8');
    const config = JSON.parse(contents);
    const token = config?.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getToken(options) {
  if (Object.hasOwn(options, 'token')) {
    return Promise.resolve(typeof options.token === 'string' && options.token.trim() ? options.token.trim() : null);
  }
  const envToken = process.env.HIKARI_OPENCLAW_TOKEN;
  if (typeof envToken === 'string' && envToken.trim()) return Promise.resolve(envToken.trim());
  return readOpenClawToken(options.homeDir ?? os.homedir());
}

function validateChatRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.messages)) {
    throw new TypeError('Chat request must include a messages array');
  }
  const { messages } = value;
  if (messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw new RangeError(`Chat requests must contain 1 to ${MAX_MESSAGES} messages`);
  }

  let totalChars = 0;
  let imageCount = 0;
  const normalizedMessages = messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('Each chat message must be an object');
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      throw new TypeError('Chat message role is invalid');
    }
    const validateText = (text) => {
      if (typeof text !== 'string' || text.length < 1 || text.length > MAX_MESSAGE_CHARS) {
        throw new RangeError('Chat message content is invalid');
      }
      totalChars += text.length;
      return text;
    };
    let content;
    if (typeof message.content === 'string') content = validateText(message.content);
    else if (message.role === 'user' && Array.isArray(message.content) && message.content.length === 2) {
      const [text, image] = message.content;
      if (text?.type !== 'text' || image?.type !== 'image_url' || ++imageCount > 1) {
        throw new TypeError('Chat accepts one attached image with user text');
      }
      const dataUrl = image.image_url?.url;
      if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 23
          || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
        throw new TypeError('Chat image must be a JPEG data URL smaller than 2 MB');
      }
      const encoded = dataUrl.slice(23);
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 4 || bytes.toString('base64') !== encoded
          || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
          || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        throw new TypeError('Chat image must contain valid JPEG data');
      }
      content = [{ type: 'text', text: validateText(text.text) }, { type: 'image_url', image_url: { url: dataUrl } }];
    } else throw new TypeError('Chat message content is invalid');
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) throw new RangeError('Chat request is too large');
    return { role: message.role, content };
  });
  return normalizedMessages;
}

function validateTtsRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('TTS request must be an object');
  if (typeof value.text !== 'string') throw new TypeError('TTS text must be a string');
  const text = value.text.trim();
  const textLength = Array.from(text).length;
  if (textLength < 1 || textLength > 500) throw new RangeError('TTS text must contain 1 to 500 characters');
  const speed = value.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new RangeError('TTS speed must be between 0.5 and 2');
  }
  return { text, speed };
}

function checkOrigin(request, allowedOrigins) {
  const originHeader = request.headers.origin;
  if (originHeader === undefined) {
    if (String(request.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
    const host = request.headers.host ?? '';
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return false; }
    return isLoopbackAddress(request.socket.remoteAddress) && isLoopbackHost(hostname);
  }

  if (typeof originHeader !== 'string' || !allowedOrigins.has(originHeader)) return false;
  // An exact allowlist match is the trust boundary. In particular, Vite and
  // Tailscale Serve may rewrite Host while preserving the browser's Origin.
  // Forwarded headers are never consulted.
  return true;
}

function checkHost(request, allowedOrigins) {
  const header = request.headers.host;
  if (typeof header !== 'string' || !header) return false;
  let parsed;
  try { parsed = new URL(`http://${header}`); } catch { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  if (isLoopbackHost(parsed.hostname)) return true;
  for (const allowedOrigin of allowedOrigins) {
    try {
      if (new URL(allowedOrigin).hostname.toLowerCase() === parsed.hostname.toLowerCase()) return true;
    } catch {
      // Invalid values are filtered while the allowlist is built.
    }
  }
  return false;
}

function probeTcp(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function probeTts(fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TTS_HEALTH_URL, { method: 'GET', signal: controller.signal });
    if (!response.ok) return false;
    const health = JSON.parse((await readBoundedResponse(response, 64 * 1024)).toString('utf8'));
    return health?.ready === true && health?.voice === 'custom_voice';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveStaticFile(root, pathname) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); } catch { return null; }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null;
  const segments = decodedPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return null;

  const requestedPath = path.resolve(root, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
  if (requestedPath !== root && !requestedPath.startsWith(`${root}${path.sep}`)) return null;

  let candidate = requestedPath;
  try {
    let details = await stat(candidate);
    if (details.isDirectory()) {
      candidate = path.join(candidate, 'index.html');
      details = await stat(candidate);
    }
    if (!details.isFile()) return null;
    const actualPath = await realpath(candidate);
    if (actualPath !== root && !actualPath.startsWith(`${root}${path.sep}`)) return null;
    return { path: actualPath, details };
  } catch {
    if (path.extname(decodedPath)) return null;
      const indexPath = path.join(root, 'index.html');
      try {
        const details = await stat(indexPath);
        if (!details.isFile()) return null;
        const actualPath = await realpath(indexPath);
        if (actualPath !== root && !actualPath.startsWith(`${root}${path.sep}`)) return null;
        return { path: actualPath, details };
    } catch {
      return null;
    }
  }
}

function mimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function validateTtsResult(result) {
  if (!result || !(result.audio instanceof Uint8Array) || result.audio.byteLength < 44 || result.audio.byteLength > 32 * 1024 * 1024) {
    throw new Error('Local TTS returned invalid audio');
  }
  if (
    typeof result.durationSeconds !== 'number' || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > 600 ||
    !Number.isInteger(result.sampleRate) || result.sampleRate < 8_000 || result.sampleRate > 192_000 ||
    !Number.isInteger(result.channels) || result.channels < 1 || result.channels > 2
  ) {
    throw new Error('Local TTS returned invalid audio metadata');
  }
  return result;
}

/**
 * Create a dependency-free local HTTP server for Hikari's web client.
 * Options include host, port, webRoot, token, homeDir, fetch/fetchImpl,
 * ttsService, allowedOrigins/publicOrigin, and timeout/concurrency limits.
 */
export function createHikariServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const webRoot = path.resolve(options.webRoot ?? path.join(process.cwd(), 'dist-web'));
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const tokenPromise = getToken(options);
  const createdTtsService = !options.ttsService;
  const ttsService = options.ttsService ?? (options.createTtsService ?? createLocalTtsService)(options.ttsOptions ?? {});
  if (!ttsService || typeof ttsService.synthesize !== 'function') throw new TypeError('A TTS service with synthesize() is required');

  const allowedOrigins = parseAllowedOrigins(options);
  const chatTimeoutMs = options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const maxConcurrentChats = options.maxConcurrentChats ?? 4;
  const maxTtsRequests = options.maxTtsRequests ?? 3;
  let activeChats = 0;
  let activeTtsRequests = 0;
  let isClosing = false;
  const cachedRoot = realpath(webRoot).catch(() => webRoot);

  for (const [name, value] of Object.entries({ chatTimeoutMs, healthTimeoutMs, closeTimeoutMs, maxConcurrentChats, maxTtsRequests })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  }

  async function handleHealth(response) {
    const token = await tokenPromise;
    const [openclawReachable, ttsReachable] = await Promise.all([
      (options.probeOpenClaw ?? (() => probeTcp(18789, healthTimeoutMs)))(),
      (options.probeTts ?? (() => probeTts(fetchImpl, healthTimeoutMs)))()
    ]);
    sendJson(response, 200, {
      ok: !isClosing,
      openclaw: { configured: Boolean(token), reachable: Boolean(openclawReachable) },
      tts: { configured: true, reachable: Boolean(ttsReachable) }
    });
  }

  async function handleChat(request, response) {
    if (activeChats >= maxConcurrentChats) {
      sendJson(response, 503, errorBody('Chat service is busy'));
      return;
    }
    activeChats += 1;
    let upstreamController;
    let timer;
    try {
      const body = await readRequestBody(request, MAX_CHAT_BODY_BYTES);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('Request body must be JSON'), { statusCode: 400 }); }
      const messages = validateChatRequest(parsed);
      const token = await tokenPromise;
      if (!token) {
        sendJson(response, 503, errorBody('OpenClaw is not configured'));
        return;
      }

      upstreamController = new AbortController();
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        upstreamController.abort();
      }, chatTimeoutMs);
      const abortUpstream = () => upstreamController?.abort();
      request.once('aborted', abortUpstream);
      response.once('close', abortUpstream);

      try {
        const upstream = await fetchImpl(OPENCLAW_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ model: 'openclaw/default', messages }),
          signal: upstreamController.signal
        });

        let upstreamBody;
        try {
          upstreamBody = await readBoundedResponse(upstream, MAX_UPSTREAM_BODY_BYTES);
        } catch {
          if (!response.destroyed) sendJson(response, timedOut ? 504 : 502, errorBody(timedOut ? 'OpenClaw request timed out' : 'OpenClaw returned an invalid response'));
          return;
        }
        if (response.destroyed || response.writableEnded) return;
        if (!upstream.ok) {
          const safeStatus = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
          sendJson(response, safeStatus, errorBody('OpenClaw request failed'));
          return;
        }

        let value;
        try { value = JSON.parse(upstreamBody.toString('utf8')); } catch {
          sendJson(response, 502, errorBody('OpenClaw returned invalid JSON'));
          return;
        }
        sendJson(response, 200, value);
      } catch {
        if (timedOut) sendJson(response, 504, errorBody('OpenClaw request timed out'));
        else if (!response.destroyed) sendJson(response, 502, errorBody('OpenClaw is unavailable'));
      } finally {
        request.removeListener('aborted', abortUpstream);
        response.removeListener('close', abortUpstream);
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : (error instanceof TypeError || error instanceof RangeError ? 400 : 400);
        sendJson(response, status, errorBody(error?.message ?? 'Invalid request'));
      }
    } finally {
      clearTimeout(timer);
      upstreamController?.abort();
      activeChats -= 1;
    }
  }

  async function handleTts(request, response) {
    if (activeTtsRequests >= maxTtsRequests) {
      sendJson(response, 503, errorBody('TTS service is busy'));
      return;
    }
    activeTtsRequests += 1;
    try {
      const body = await readRequestBody(request, MAX_TTS_BODY_BYTES);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('Request body must be JSON'), { statusCode: 400 }); }
      const synthesisRequest = validateTtsRequest(parsed);
      const result = validateTtsResult(await ttsService.synthesize(synthesisRequest));
      if (response.destroyed) return;
      const audio = Buffer.from(result.audio.buffer, result.audio.byteOffset, result.audio.byteLength);
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': audio.byteLength,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-audio-duration': String(result.durationSeconds),
        'x-audio-sample-rate': String(result.sampleRate),
        'x-audio-channels': String(result.channels)
      });
      response.end(audio);
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : (error instanceof TypeError || error instanceof RangeError ? 400 : 502);
        sendJson(response, status, errorBody(status === 400 ? error.message : 'Local TTS request failed'));
      }
    } finally {
      activeTtsRequests -= 1;
    }
  }

  async function handleStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, errorBody('Method not allowed'), { allow: 'GET, HEAD' });
      return;
    }
    const root = await cachedRoot;
    const file = await resolveStaticFile(root, pathname);
    if (!file) {
      sendJson(response, 404, errorBody('Not found'));
      return;
    }
    const headers = {
      'content-type': mimeType(file.path),
      'content-length': file.details.size,
      etag: `W/\"${file.details.size.toString(16)}-${Math.trunc(file.details.mtimeMs).toString(16)}\"`,
      'last-modified': file.details.mtime.toUTCString(),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache'
    };
    const compressible = file.details.size >= 1024 && /\.(?:vrm|vrma|js|css|html|json|svg)$/i.test(file.path);
    const compressed = compressible && acceptsGzip(request.headers['accept-encoding']);
    if (compressible) headers.vary = 'Accept-Encoding';
    if (compressed) {
      headers['content-encoding'] = 'gzip';
      // Three.js uses this uncompressed length for download progress even when
      // the browser transparently decodes the much smaller transfer.
      headers['x-file-size'] = file.details.size;
      headers.etag = headers.etag.replace(/"$/, '-gzip"');
      delete headers['content-length'];
    }
    const etag = headers.etag;
    const ifNoneMatch = request.headers['if-none-match'];
    const matchesEtag = typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').map((value) => value.trim()).includes(etag);
    const ifModifiedSince = request.headers['if-modified-since'];
    const modifiedSince = typeof ifModifiedSince === 'string' ? Date.parse(ifModifiedSince) : NaN;
    const notModified = matchesEtag || (ifNoneMatch === undefined && Number.isFinite(modifiedSince) && file.details.mtimeMs <= modifiedSince + 999);
    if (notModified) {
      delete headers['content-length'];
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else {
      try {
        if (compressed) await pipeline(createReadStream(file.path), createGzip(), response);
        else await pipeline(createReadStream(file.path), response);
      } catch {
        if (!response.headersSent && !response.destroyed) sendJson(response, 404, errorBody('Not found'));
        else if (!response.destroyed) response.destroy();
      }
    }
  }

  async function handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://hikari.local');
      const pathname = url.pathname;
      response.setHeader('x-content-type-options', 'nosniff');
      if (!checkHost(request, allowedOrigins)) {
        sendJson(response, 403, errorBody('Host is not allowed'));
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/health' && request.method === 'GET') {
          await handleHealth(response);
          return;
        }
        if (pathname === '/api/chat' || pathname === '/api/tts') {
          const origin = request.headers.origin;
          const allowed = checkOrigin(request, allowedOrigins);
          if (!allowed) {
            sendJson(response, 403, errorBody('Origin is not allowed'));
            return;
          }
          if (origin) response.setHeader('access-control-allow-origin', origin);
          response.setHeader('vary', 'Origin');

          if (request.method === 'OPTIONS') {
            response.writeHead(204, {
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'content-type',
              'access-control-max-age': '600',
              ...(request.headers['access-control-request-private-network'] === 'true'
                ? { 'access-control-allow-private-network': 'true' }
                : {})
            });
            response.end();
            return;
          }
          if (request.method !== 'POST') {
            sendJson(response, 405, errorBody('Method not allowed'), { allow: 'POST, OPTIONS' });
            return;
          }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
            sendJson(response, 415, errorBody('Content-Type must be application/json'));
            return;
          }
          if (pathname === '/api/chat') await handleChat(request, response);
          else await handleTts(request, response);
          return;
        }
        sendJson(response, 404, errorBody('Not found'));
        return;
      }

      await handleStatic(request, response, pathname);
    } catch {
      if (!response.destroyed && !response.writableEnded) sendJson(response, 500, errorBody('Internal server error'));
    }
  }

  const server = createServer((request, response) => { void handle(request, response); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  async function listen() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return server.address();
  }

  async function close() {
    if (isClosing) return;
    isClosing = true;
    if (createdTtsService) ttsService.dispose?.();
    if (!server.listening) return;

    const closePromise = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    let closeTimer;
    await Promise.race([
      closePromise,
      new Promise((resolve) => {
        closeTimer = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, closeTimeoutMs);
      })
    ]);
    clearTimeout(closeTimer);
  }

  return { server, listen, close, host, port, webRoot, ttsService };
}

const modulePath = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === modulePath;

if (isDirectExecution) {
  const app = createHikariServer();
  app.listen().then((address) => {
    const displayHost = address.address.includes(':') ? `[${address.address}]` : address.address;
    process.stdout.write(`Hikari web server listening at http://${displayHost}:${address.port}\n`);
    if (!process.env.HIKARI_PUBLIC_ORIGIN) {
      process.stdout.write('Set HIKARI_PUBLIC_ORIGIN to the exact HTTPS origin used by Tailscale Serve.\n');
    }
  }).catch((error) => {
    process.stderr.write(`Unable to start Hikari web server: ${error.message}\n`);
    process.exitCode = 1;
  });

  const shutdown = () => { void app.close().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
