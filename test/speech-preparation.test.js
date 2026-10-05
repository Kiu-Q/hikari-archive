import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSpeech } from '../shared/speech-preparation.js';

test('prepareSpeech starts synthesis synchronously and exposes its abort signal', async () => {
  let request;
  let release;
  const preparation = prepareSpeech((input, options) => {
    request = { input, signal: options.signal };
    return new Promise(resolve => { release = resolve; });
  }, 'こんにちは', 1.1);

  assert.deepEqual(request.input, { text: 'こんにちは', speed: 1.1 });
  assert.equal(request.signal.aborted, false);
  assert.equal(typeof release, 'function');
  release({ audio: new Uint8Array([1]), durationSeconds: 1 });
  assert.deepEqual(await preparation.result, { audio: new Uint8Array([1]), durationSeconds: 1 });
  assert.equal(preparation.cancelled, false);
});

test('cancelling pending preparation aborts synthesis and rejects with AbortError', async () => {
  let signal;
  const preparation = prepareSpeech((_input, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, 'hello');

  preparation.cancel();
  preparation.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(preparation.cancelled, true);
  await assert.rejects(preparation.result, { name: 'AbortError' });
});

test('an early synthesis failure remains observable after the caller starts another task', async () => {
  const failure = new Error('offline');
  const preparation = prepareSpeech(() => Promise.reject(failure), 'hello');
  await Promise.resolve();
  await assert.rejects(preparation.result, error => error === failure);
});

