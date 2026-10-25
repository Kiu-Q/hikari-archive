// One Web Audio context per page: a normal user gesture unlocks it, and later
// network replies play as decoded buffers without creating new media elements.
import { prepareSpeech } from './speech-preparation.js';

export function createBrowserSpeechPlayer({
  synthesize,
  onMouth = () => {},
  onPlaying = () => {},
  onPlaybackBlocked,
  createContext = () => {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable in this browser.');
    return new Context();
  },
} = {}) {
  let context = null;
  let active = null;
  let resumeAttempt = null;
  let detachContextListener = () => {};
  const cancelled = Symbol('cancelled');

  function getContext() {
    if (!context || context.state === 'closed') {
      detachContextListener();
      context = createContext();
      const ctx = context;
      const changed = () => {
        if (active && ctx.state !== 'running' && ctx.state !== 'closed') void resume();
      };
      ctx.addEventListener('statechange', changed);
      detachContextListener = () => ctx.removeEventListener('statechange', changed);
    }
    return context;
  }

  // A previously unlocked context can often resume without another gesture.
  // Mobile browsers may leave resume() pending when activation is required,
  // so automatic recovery must be bounded and leave the gesture path usable.
  function resume() {
    const ctx = context;
    if (!ctx || ctx.state === 'closed') return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    if (resumeAttempt) return resumeAttempt;
    let timer;
    const attempt = Promise.race([
      Promise.resolve().then(() => ctx.resume()).then(() => ctx.state === 'running', () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 750); }),
    ]).finally(() => {
      clearTimeout(timer);
      if (resumeAttempt === attempt) resumeAttempt = null;
    });
    resumeAttempt = attempt;
    return attempt;
  }

  // Invoke synchronously inside pointerdown/keydown, before any network await.
  function unlock() {
    try {
      const ctx = getContext();
      if (ctx.state === 'running') return Promise.resolve(true);
      const resumed = ctx.resume();
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
      silent.connect(ctx.destination);
      silent.onended = () => silent.disconnect();
      silent.start();
      return Promise.resolve(resumed).then(() => {
        if (ctx.state !== 'running') throw new Error('Audio is still suspended.');
        return true;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function stop() {
    active?.cancel();
    active = null;
    onMouth('neutral');
  }

  async function speak(text, speed = 1, options = {}) {
    stop();
    let cancel;
    const cancellation = new Promise(resolve => { cancel = () => resolve(cancelled); });
    let promptAbort = new AbortController();
    let preparation = options.prepared;
    let source, analyser, gain, compressor, meter, watchdog;
    let removeStateListener = () => {};
    const cleanup = () => {
      promptAbort.abort();
      preparation?.cancel?.();
      removeStateListener();
      clearInterval(meter);
      clearTimeout(watchdog);
      if (source) {
        source.onended = null;
        try { source.stop(); } catch { /* Already stopped or not started. */ }
      }
      for (const node of [source, analyser, gain, compressor]) node?.disconnect();
      source = analyser = gain = compressor = null;
      onMouth('neutral');
    };
    const operation = { cancel: () => { cancel(); cleanup(); } };
    active = operation;
    const wait = promise => Promise.race([promise, cancellation]);
    try {
      preparation ??= prepareSpeech(synthesize, text, speed);
      if (!preparation || !preparation.result || typeof preparation.result.then !== 'function') {
        throw new TypeError('Prepared speech must provide a result promise');
      }
      if (preparation.cancelled) return false;
      let result;
      try {
        result = await wait(preparation.result);
      } catch (error) {
        if (preparation.cancelled || active !== operation) return false;
        throw error;
      }
      if (result === cancelled || active !== operation || preparation.cancelled || options.shouldPlay?.() === false) return false;
      if (!result?.audio || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
        throw new Error('The voice service returned invalid audio.');
      }
      const ctx = getContext();
      const bytes = result.audio instanceof ArrayBuffer ? result.audio.slice(0)
        : result.audio.buffer.slice(result.audio.byteOffset, result.audio.byteOffset + result.audio.byteLength);
      const decoded = await wait(ctx.decodeAudioData(bytes));
      if (decoded === cancelled || active !== operation) return false;

      const ensureRunning = async () => {
        if (ctx.state === 'running') return true;

        const automatic = await wait(resume());
        if (automatic === cancelled || active !== operation) return false;
        if (ctx.state === 'running') return true;
        options.onBlocked?.();

        // An interrupted page may need a fresh gesture. Any gesture can resume
        // it; normal page interactions retry without a dedicated audio button.
        const ready = new Promise(resolve => {
          const changed = () => { if (ctx.state === 'running') resolve(); };
          ctx.addEventListener('statechange', changed);
          removeStateListener = () => ctx.removeEventListener('statechange', changed);
          changed();
        });
        const retry = () => {
          if (active !== operation) return Promise.reject(new Error('Playback cancelled.'));
          return unlock();
        };
        promptAbort = new AbortController();
        const prompt = onPlaybackBlocked
          ? Promise.resolve(onPlaybackBlocked(retry, promptAbort.signal))
          : Promise.reject(new Error('Touch the page to enable audio.'));
        const resumed = await wait(Promise.race([ready, prompt]));
        if (resumed === cancelled || active !== operation) return false;
        removeStateListener();
        promptAbort.abort();
        if (ctx.state !== 'running') throw new Error('Audio is still suspended.');
        return true;
      };
      if (!await ensureRunning() || active !== operation || options.shouldPlay?.() === false) return false;

      source = ctx.createBufferSource();
      source.buffer = decoded;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain = ctx.createGain();
      source.connect(analyser);
      analyser.connect(gain);
      compressor = ctx.createDynamicsCompressor?.();
      if (compressor) {
        compressor.threshold.value = -3;
        compressor.knee.value = 0;
        compressor.ratio.value = 20;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.1;
        gain.connect(compressor);
        compressor.connect(ctx.destination);
      } else gain.connect(ctx.destination);

      const settings = await wait(Promise.resolve().then(() => options.beforePlay?.({ canBoost: Boolean(compressor) })));
      if (settings === cancelled || active !== operation) return false;
      // Animation preparation may span a background/foreground transition.
      if (!await ensureRunning() || active !== operation || options.shouldPlay?.() === false) return false;
      const targetGain = Number.isFinite(settings?.voiceGain)
        ? Math.max(0, Math.min(compressor ? 0.9 / 0.7 : 1, settings.voiceGain)) : 0.9;
      gain.gain.setValueAtTime(options.fadeIn === false ? targetGain : 0, ctx.currentTime);
      if (options.fadeIn !== false) gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.25);
      const samples = new Uint8Array(analyser.fftSize);
      const playback = new Promise((resolve, reject) => {
        source.onended = () => resolve(true);
        watchdog = setTimeout(() => reject(new Error('Japanese audio playback timed out.')),
          Math.min(600_000, (result.durationSeconds + 30) * 1000));
        try {
          source.start();
          options.onStart?.();
          onPlaying();
          meter = setInterval(() => {
            if (active !== operation || ctx.state !== 'running') return onMouth('neutral');
            analyser.getByteTimeDomainData(samples);
            const power = samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length;
            onMouth(Math.sqrt(power) > 0.025 ? 'aa' : 'neutral');
          }, 50);
        } catch (error) { reject(error); }
      });
      return (await wait(playback)) !== cancelled;
    } finally {
      cleanup();
      if (active === operation) active = null;
    }
  }

  function dispose() {
    stop();
    detachContextListener();
    if (context) void context.close().catch(() => {});
    context = null;
  }
  return { speak, stop, unlock, resume, dispose };
}
