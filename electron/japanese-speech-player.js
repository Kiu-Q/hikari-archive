// Audio stays in the renderer; networking and process startup stay behind IPC.
export function createJapaneseSpeechPlayer({
  synthesize,
  onMouth = () => {},
  onPlaying = () => {},
  createAudio = () => new Audio(),
  createUrl = bytes => URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })),
  revokeUrl = url => URL.revokeObjectURL(url),
  createContext = () => {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Context ? new Context() : null;
  },
} = {}) {
  let active = null;
  const cancelled = Symbol('cancelled');

  function stop() {
    active?.cancel();
    active = null;
    onMouth('neutral');
  }

  async function speak(text, speed = 1, options = {}) {
    stop();
    let cancel;
    const cancellation = new Promise(resolve => { cancel = () => resolve(cancelled); });
    let audio, url, context, timer, watchdog;
    const cleanup = () => {
      clearInterval(timer);
      clearTimeout(watchdog);
      if (audio) {
        audio.onended = audio.onerror = audio.onplaying = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio = null;
      }
      if (url) { revokeUrl(url); url = null; }
      if (context) { void context.close().catch(() => {}); context = null; }
      onMouth('neutral');
    };
    const operation = { cancel: () => { cancel(); cleanup(); } };
    active = operation;
    try {
      const result = await Promise.race([Promise.resolve().then(() => synthesize({ text, speed })), cancellation]);
      if (result === cancelled || active !== operation) return false;
      if (!result?.audio || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
        throw new Error('The voice service returned invalid audio.');
      }
      url = createUrl(result.audio);
      audio = createAudio();
      audio.src = url;
      let analyser = null;
      try {
        context = createContext();
        if (context) {
          analyser = context.createAnalyser();
          analyser.fftSize = 256;
          const source = context.createMediaElementSource(audio);
          source.connect(analyser);
          analyser.connect(context.destination);
          await Promise.race([context.resume(), cancellation]);
          if (active !== operation) return false;
        }
      } catch {
        // Without Web Audio, the native audio element can still play the WAV.
        analyser = null;
      }
      const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
      if (options.beforePlay) {
        await Promise.race([Promise.resolve().then(options.beforePlay), cancellation]);
        if (active !== operation) return false;
      }
      let presented = false;
      const playback = new Promise((resolve, reject) => {
        audio.onended = () => resolve(true);
        audio.onerror = () => reject(new Error('Japanese audio playback failed.'));
        audio.onplaying = () => {
          if (!presented) {
            presented = true;
            try { options.onStart?.(); } catch (error) { reject(error); return; }
          }
          onPlaying();
          clearInterval(timer);
          timer = setInterval(() => {
            if (active !== operation || !audio || audio.paused) return onMouth('neutral');
            if (!analyser) return onMouth('aa');
            analyser.getByteTimeDomainData(samples);
            const power = samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length;
            onMouth(Math.sqrt(power) > 0.025 ? 'aa' : 'neutral');
          }, 50);
        };
        watchdog = setTimeout(() => reject(new Error('Japanese audio playback timed out.')),
          Math.min(600_000, (result.durationSeconds + 30) * 1000));
        try { Promise.resolve(audio.play()).catch(reject); } catch (error) { reject(error); }
      });
      return (await Promise.race([playback, cancellation])) !== cancelled;
    } finally {
      cleanup();
      if (active === operation) active = null;
    }
  }

  return { speak, stop };
}
