function makeAbortError() {
  const error = new Error('Speech preparation cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Start speech synthesis immediately and return a cancellable result handle. */
export function prepareSpeech(synthesize, text, speed = 1) {
  if (typeof synthesize !== 'function') throw new TypeError('A speech synthesis function is required');

  const controller = new AbortController();
  let cancelled = false;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A caller may start synthesis before awaiting an animation. Keep failures
  // observed until the eventual player consumes `result`.
  result.catch(() => {});

  let synthesis;
  try {
    synthesis = synthesize({ text, speed }, { signal: controller.signal });
  } catch (error) {
    synthesis = Promise.reject(error);
  }

  const onAbort = () => {
    if (settled) return;
    settled = true;
    controller.signal.removeEventListener('abort', onAbort);
    rejectResult(controller.signal.reason ?? makeAbortError());
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  Promise.resolve(synthesis).then(
    value => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      resolveResult(value);
    },
    error => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      rejectResult(error);
    }
  );

  return {
    result,
    signal: controller.signal,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (!controller.signal.aborted) controller.abort(makeAbortError());
    },
    get cancelled() { return cancelled; }
  };
}

/** Split already-formatted reply lines into the speech units requested by the agent prompt. */
export function splitSpeechSegments(text) {
  return String(text ?? '')
    .split(/\r?\n+/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

/** Start each line's synthesis immediately so playback can begin with the first ready line. */
export function prepareSpeechSegments(synthesize, text, speed = 1) {
  return splitSpeechSegments(text).map(segment => prepareSpeech(synthesize, segment, speed));
}

export function cancelSpeechPreparations(preparations) {
  const items = Array.isArray(preparations) ? preparations : [preparations];
  for (const preparation of items) preparation?.cancel?.();
}
