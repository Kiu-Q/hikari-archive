import { createHttpTtsClient } from '../shared/services.js';

const DEFAULT_TIMEOUT_MS = 450_000;

function isLoopbackAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

export function validateRemoteTtsUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_048) {
    throw new TypeError('Remote TTS requires a configured loopback URL');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new TypeError('Remote TTS URL must be a valid loopback HTTP URL', { cause });
  }
  if (
    url.protocol !== 'http:' ||
    url.username || url.password || url.search || url.hash ||
    !isLoopbackAddress(url.hostname)
  ) {
    throw new TypeError('Remote TTS URL must use HTTP on a loopback address');
  }
  return url.toString().replace(/\/+$/, '');
}

export function createRemoteTtsService({
  url,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) {
    throw new RangeError('Remote TTS timeout must be between 1 and 900000 milliseconds');
  }
  const baseUrl = validateRemoteTtsUrl(url);
  const client = createHttpTtsClient({
    fetchImpl,
    endpoint: `${baseUrl}/api/tts`,
    timeoutMs
  });

  return {
    synthesize(input, options) {
      return client.synthesize(input, options);
    },
    dispose() {
      client.dispose();
    }
  };
}
