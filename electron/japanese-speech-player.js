// Audio stays in the renderer; synthesis is supplied by the platform service adapter.
import { prepareSpeech } from '../shared/speech-preparation.js';

export function createJapaneseSpeechPlayer({
  synthesize,
  onMouth = () => {},
  onPlaying = () => {},
  onPlaybackBlocked,
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
    let preparation = options.prepared;
    let audio, url, context, timer, gainTimer, watchdog;
    const playbackAbort = new AbortController();
    const cleanup = () => {
      playbackAbort.abort();
      clearInterval(timer);
      clearInterval(gainTimer);
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
    const operation = { cancel: () => { cancel(); preparation?.cancel?.(); cleanup(); } };
    active = operation;
    try {
      preparation ??= prepareSpeech(synthesize, text, speed);
      if (!preparation || !preparation.result || typeof preparation.result.then !== 'function') {
        throw new TypeError('Prepared speech must provide a result promise');
      }
      if (preparation.cancelled) return false;
      let result;
      try {
        result = await Promise.race([preparation.result, cancellation]);
      } catch (error) {
        if (preparation.cancelled || active !== operation) return false;
        throw error;
      }
      if (result === cancelled || active !== operation || preparation.cancelled) return false;
      if (!result?.audio || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
        throw new Error('The voice service returned invalid audio.');
      }
      options.onTiming?.('audio_setup_started');
      url = createUrl(result.audio);
      audio = createAudio();
      audio.src = url;
      let analyser = null, voiceGain = null;
      let gainNode = null, limiterAvailable = false;
      try {
        context = createContext();
        if (context) {
          analyser = context.createAnalyser();
          analyser.fftSize = 256;
          const source = context.createMediaElementSource(audio);
          gainNode = context.createGain();
          source.connect(analyser);
          analyser.connect(gainNode);
          const compressor = context.createDynamicsCompressor?.();
          if (compressor) {
            // Catch peaks introduced by compensating for system audio ducking.
            compressor.threshold.value = -3;
            compressor.knee.value = 0;
            compressor.ratio.value = 20;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.1;
            gainNode.connect(compressor);
            compressor.connect(context.destination);
            limiterAvailable = true;
          } else {
            gainNode.connect(context.destination);
          }
          // Safari can leave resume pending until a gesture. The playback
          // prompt below resumes the same context from its tap handler.
          if (onPlaybackBlocked) void context.resume().catch(() => {});
          else await Promise.race([context.resume(), cancellation]);
          if (active !== operation) return false;
        }
      } catch {
        // Without Web Audio, the native audio element can still play the WAV.
        analyser = null;
        gainNode = null;
      }
      const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
      options.onTiming?.('audio_setup_finished');
      if (options.beforePlay) {
        options.onTiming?.('before_play_started');
        const beforePlayResult = await Promise.race([
          Promise.resolve().then(() => options.beforePlay({ canBoost: Boolean(gainNode && limiterAvailable) })),
          cancellation,
        ]);
        if (active !== operation) return false;
        voiceGain = beforePlayResult?.voiceGain;
        options.onTiming?.('before_play_finished');
      }
      const maxGain = limiterAvailable ? 0.9 / 0.7 : 1;
      const targetGain = Number.isFinite(voiceGain) ? Math.max(0, Math.min(maxGain, voiceGain)) : 0.9;
      const fadeIn = options.fadeIn !== false;
      if (gainNode) {
        const parameter = gainNode.gain;
        const now = context.currentTime;
        parameter.cancelScheduledValues?.(now);
        parameter.setValueAtTime(fadeIn ? 0 : targetGain, now);
        if (fadeIn) parameter.linearRampToValueAtTime(targetGain, now + 0.25);
      } else {
        // HTMLAudioElement volume tops out at 1, so play at the requested 90%
        // voice level when Web Audio is unavailable.
        const fallbackGain = Math.min(1, targetGain);
        audio.volume = fadeIn ? 0 : fallbackGain;
        if (fadeIn) {
          const startedAt = Date.now();
          gainTimer = setInterval(() => {
            if (active !== operation || !audio) return clearInterval(gainTimer);
            const progress = Math.min(1, (Date.now() - startedAt) / 250);
            audio.volume = fallbackGain * progress;
            if (progress >= 1) clearInterval(gainTimer);
          }, 16);
        }
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
        const retry = () => {
          if (active !== operation || !audio) return Promise.reject(new Error('Playback cancelled.'));
          // Call both APIs synchronously in the user's click handler.
          const resumed = context?.resume();
          const played = audio.play();
          return Promise.all([resumed, played]);
        };
        const prompt = async () => {
          options.onTiming?.('playback_blocked');
          if (!onPlaybackBlocked) throw new Error('Tap to enable audio playback.');
          await onPlaybackBlocked(retry, playbackAbort.signal);
        };
        options.onTiming?.('playback_requested');
        if (onPlaybackBlocked && context?.state === 'suspended') {
          prompt().catch(reject);
        } else {
          try {
            Promise.resolve(audio.play()).catch(error => {
              if (error?.name === 'NotAllowedError' && onPlaybackBlocked) prompt().catch(reject);
              else reject(error);
            });
          } catch (error) {
            if (error?.name === 'NotAllowedError' && onPlaybackBlocked) prompt().catch(reject);
            else reject(error);
          }
        }
      });
      return (await Promise.race([playback, cancellation])) !== cancelled;
    } finally {
      cleanup();
      if (active === operation) active = null;
    }
  }

  return { speak, stop };
}
