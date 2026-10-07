import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { createHikariServer } from '../server/index.js';

const CHAT_REPLY = {
  id: 'chatcmpl-test',
  choices: [{ message: { role: 'assistant', content: 'こんにちは' } }]
};

function makeWav() {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 2, true);
  view.setInt16(44, 0, true);
  return bytes;
}

function makeTtsService(implementation = async () => ({
  audio: makeWav(),
  durationSeconds: 1.25,
  sampleRate: 24_000,
  channels: 1,
  voice: 'custom_voice'
})) {
  return { synthesize: implementation };
}

async function startServer(t, options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hikari-server-test-'));
  const webRoot = path.join(tempDir, 'dist-web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Hikari</title>');
  const serverOptions = {
    host: '127.0.0.1',
    port: 0,
    webRoot,
    token: 'server-test-token',
    ttsService: makeTtsService(),
    probeOpenClaw: async () => true,
    probeTts: async () => false,
    ...options
  };
  if (options.omitToken) delete serverOptions.token;
  delete serverOptions.omitToken;
  const app = createHikariServer(serverOptions);
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, tempDir, webRoot };
}

async function postJson(baseUrl, pathname, value, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value)
  });
}

test('health reports reachability without running synthesis and static root serves the web app', async (t) => {
  let synthesisCalls = 0;
  let tcpProbeCalls = 0;
  let ttsProbeCalls = 0;
  const { baseUrl, webRoot } = await startServer(t, {
    ttsService: makeTtsService(async () => {
      synthesisCalls += 1;
      return { audio: makeWav(), durationSeconds: 1, sampleRate: 24_000, channels: 1 };
    }),
    probeOpenClaw: async () => { tcpProbeCalls += 1; return true; },
    probeTts: async () => { ttsProbeCalls += 1; return false; }
  });

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    openclaw: { configured: true, reachable: true },
    tts: { configured: true, reachable: false }
  });
  assert.equal(synthesisCalls, 0);
  assert.equal(tcpProbeCalls, 1);
  assert.equal(ttsProbeCalls, 1);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hikari/);

  await writeFile(path.join(webRoot, 'app.js'), 'window.hikari = true;');
  const appSource = await fetch(`${baseUrl}/app.js`);
  assert.equal(appSource.status, 200);
  assert.equal(appSource.headers.get('cache-control'), 'no-cache');
  const etag = appSource.headers.get('etag');
  assert.ok(etag);
  const cachedAppSource = await fetch(`${baseUrl}/app.js`, { headers: { 'if-none-match': etag } });
  assert.equal(cachedAppSource.status, 304);
});

test('chat strips browser credentials and overrides, then injects the local gateway token', async (t) => {
  let forwarded;
  let forwardedUrl;
  const { baseUrl } = await startServer(t, {
    fetch: async (url, init) => {
      forwardedUrl = String(url);
      forwarded = init;
      return Response.json(CHAT_REPLY);
    }
  });

  const response = await postJson(baseUrl, '/api/chat', {
    token: 'browser-must-not-be-used',
    model: 'attacker/model',
    stream: true,
    messages: [
      { role: 'system', content: 'Use Cantonese.', extra: 'discard this' },
      { role: 'user', content: 'Hello' }
    ]
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), CHAT_REPLY);
  assert.equal(forwardedUrl, 'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(forwarded.headers.authorization, 'Bearer server-test-token');
  assert.equal(forwarded.headers.authorization.includes('browser-must-not-be-used'), false);
  assert.deepEqual(JSON.parse(forwarded.body), {
    model: 'openclaw/default',
    messages: [
      { role: 'system', content: 'Use Cantonese.' },
      { role: 'user', content: 'Hello' }
    ]
  });
});

test('chat allows only exact configured origins and tolerates proxy Host rewriting', async (t) => {
  let upstreamCalls = 0;
  const { baseUrl } = await startServer(t, {
    allowedOrigins: ['https://hikari.tailnet.example'],
    fetch: async () => {
      upstreamCalls += 1;
      return Response.json(CHAT_REPLY);
    }
  });
  const request = { messages: [{ role: 'user', content: 'Hi' }] };

  const rejected = await postJson(baseUrl, '/api/chat', request, {
    origin: 'https://evil.example',
    'x-forwarded-host': 'hikari.tailnet.example'
  });
  assert.equal(rejected.status, 403);
  assert.equal(upstreamCalls, 0);

  const accepted = await postJson(baseUrl, '/api/chat', request, {
    origin: 'https://hikari.tailnet.example'
  });
  assert.equal(accepted.status, 200);
  assert.equal(upstreamCalls, 1);

  const viteDev = await postJson(baseUrl, '/api/chat', request, { origin: 'http://localhost:8081' });
  assert.equal(viteDev.status, 200);
  assert.equal(upstreamCalls, 2);
});

test('phone image messages forward a single bounded JPEG and discard extra client fields', async (t) => {
  let forwarded;
  const { baseUrl } = await startServer(t, { fetch: async (_url, init) => { forwarded = JSON.parse(init.body); return Response.json(CHAT_REPLY); } });
  const content = [{ type: 'text', text: 'Describe this photo', extra: 'ignored' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==', detail: 'ignored' } }];
  const response = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'user', content }] });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.messages, [{ role: 'user', content: [
    { type: 'text', text: 'Describe this photo' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }
  ] }]);
});

test('image chat rejects external URLs, corrupt JPEGs, excessive images and role abuse before forwarding', async (t) => {
  let calls = 0;
  const { baseUrl } = await startServer(t, { fetch: async () => { calls++; return Response.json(CHAT_REPLY); } });
  const content = url => [{ type: 'text', text: 'Photo' }, { type: 'image_url', image_url: { url } }];
  const valid = content('data:image/jpeg;base64,/9j/2Q==');
  for (const messages of [
    [{ role: 'user', content: content('https://private.example/photo.jpg') }],
    [{ role: 'user', content: content('data:image/jpeg;base64,YWJjZA==') }],
    [{ role: 'user', content: content('data:image/png;base64,/9j/2Q==') }],
    [{ role: 'assistant', content: valid }],
    [{ role: 'system', content: valid }],
    [{ role: 'user', content: valid }, { role: 'user', content: valid }],
    [{ role: 'user', content: content('data:image/jpeg;base64,' + 'A'.repeat(2_800_000)) }],
    [{ role: 'user', content: [{ type: 'text', text: '' }, valid[1]] }]
  ]) {
    const response = await postJson(baseUrl, '/api/chat', { messages });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('chat rejects malformed messages and returns a sanitized upstream failure', async (t) => {
  let calls = 0;
  const { baseUrl } = await startServer(t, {
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'do not expose this provider detail' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const invalid = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);

  const failure = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(failure.status, 401);
  assert.deepEqual(await failure.json(), { error: { message: 'OpenClaw request failed' } });
});

test('chat returns a gateway error when its fixed loopback upstream fails', async (t) => {
  const { baseUrl } = await startServer(t, { fetch: async () => { throw new Error('private provider detail'); } });
  const response = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { message: 'OpenClaw is unavailable' } });
});

test('TTS returns WAV bytes and timing metadata headers', async (t) => {
  let synthesisInput;
  const audio = makeWav();
  const { baseUrl } = await startServer(t, {
    ttsService: makeTtsService(async (input) => {
      synthesisInput = input;
      return { audio, durationSeconds: 1.25, sampleRate: 24_000, channels: 1, voice: 'custom_voice' };
    })
  });
  const response = await postJson(baseUrl, '/api/tts', { text: '  おはよう  ' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('x-audio-duration'), '1.25');
  assert.equal(response.headers.get('x-audio-sample-rate'), '24000');
  assert.equal(response.headers.get('x-audio-channels'), '1');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
  assert.deepEqual(synthesisInput, { text: 'おはよう', speed: 1 });
});

test('TTS bounds queued synthesis requests and rejects excess work', async (t) => {
  const gates = [];
  let calls = 0;
  const { baseUrl } = await startServer(t, {
    maxTtsRequests: 2,
    ttsService: makeTtsService(() => {
      calls += 1;
      return new Promise((resolve) => gates.push(() => resolve({
        audio: makeWav(), durationSeconds: 1, sampleRate: 24_000, channels: 1
      })));
    })
  });

  const body = { text: 'こんにちは' };
  const first = postJson(baseUrl, '/api/tts', body);
  const second = postJson(baseUrl, '/api/tts', body);
  for (let attempt = 0; attempt < 30 && calls < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  const excess = await postJson(baseUrl, '/api/tts', body);
  assert.equal(excess.status, 503);
  assert.deepEqual(await excess.json(), { error: { message: 'TTS service is busy' } });

  gates.splice(0).forEach((release) => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('avatar delivery compresses losslessly with correct progress, encoding negotiation and cache variants', async t => {
  const { baseUrl, webRoot } = await startServer(t);
  const avatar = Buffer.alloc(64 * 1024, 42);
  await writeFile(path.join(webRoot, 'phone.vrm'), avatar);
  function get(headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/phone.vrm`, { headers, method }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
        response.once('error', reject);
      });
      request.once('error', reject); request.end();
    });
  }
  const encoded = await get({ 'accept-encoding': 'gzip' });
  assert.equal(encoded.headers['content-encoding'], 'gzip');
  assert.equal(encoded.headers['x-file-size'], String(avatar.length));
  assert.equal(encoded.headers.vary, 'Accept-Encoding');
  assert.ok(encoded.bytes.length < avatar.length / 10);
  assert.deepEqual(gunzipSync(encoded.bytes), avatar);
  const plain = await get({ 'accept-encoding': 'gzip;q=0, *;q=1' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.bytes, avatar);
  assert.notEqual(plain.headers.etag, encoded.headers.etag);
  const cached = await get({ 'accept-encoding': 'gzip', 'if-none-match': encoded.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes.length, 0);
  const head = await get({ 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.bytes.length, 0);
});

test('static serving blocks traversal, hidden files, and symlinks outside dist-web', async (t) => {
  const { baseUrl, tempDir, webRoot } = await startServer(t);
  await writeFile(path.join(tempDir, 'secret.txt'), 'secret contents');
  await symlink(path.join(tempDir, 'secret.txt'), path.join(webRoot, 'secret-link.txt'));

  const traversal = await fetch(`${baseUrl}/%2e%2e/secret.txt`);
  assert.equal(traversal.status, 404);
  const hidden = await fetch(`${baseUrl}/.env`);
  assert.equal(hidden.status, 404);
  const linked = await fetch(`${baseUrl}/secret-link.txt`);
  assert.equal(linked.status, 404);

  const serverUrl = new URL(baseUrl);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: serverUrl.hostname,
      port: Number(serverUrl.port),
      path: '/',
      headers: { host: 'attacker.example' }
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(badHostStatus, 403);
});

test('loads the gateway token from the local OpenClaw config without echoing it', async (t) => {
  const previousToken = process.env.HIKARI_OPENCLAW_TOKEN;
  delete process.env.HIKARI_OPENCLAW_TOKEN;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'hikari-openclaw-config-'));
  await mkdir(path.join(homeDir, '.openclaw'), { recursive: true });
  await writeFile(path.join(homeDir, '.openclaw', 'openclaw.json'), JSON.stringify({ gateway: { auth: { token: 'private-config-token' } } }));
  try {
    let authorization;
    const { baseUrl } = await startServer(t, {
      homeDir,
      omitToken: true,
      fetch: async (_url, init) => {
        authorization = init.headers.authorization;
        return Response.json(CHAT_REPLY);
      }
    });
    const response = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(response.status, 200);
    assert.equal(authorization, 'Bearer private-config-token');
  } finally {
    if (previousToken === undefined) delete process.env.HIKARI_OPENCLAW_TOKEN;
    else process.env.HIKARI_OPENCLAW_TOKEN = previousToken;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('chat timeout also covers an upstream body that stalls after headers', async (t) => {
  const { baseUrl } = await startServer(t, {
    chatTimeoutMs: 20,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      }
    }), { headers: { 'content-type': 'application/json' } })
  });
  const response = await postJson(baseUrl, '/api/chat', { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /timed out/);
});
