// Install gesture handling before the renderer initializes or downloads assets.
// Every reply and the startup gesture share this one Web Audio context.
let context;
export function getBrowserAudioContext() {
    if (!context || context.state === 'closed') {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('Web Audio is unavailable in this browser.');
        context = new Context();
    }
    return context;
}
window.hikariCreateAudioContext = getBrowserAudioContext;

function unlockAudio() {
    if (window.hikariUnlockAudio) return window.hikariUnlockAudio();
    try {
        const ctx = getBrowserAudioContext();
        const resumed = ctx.resume(); // Remain inside the original gesture.
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
        silent.connect(ctx.destination);
        silent.onended = () => silent.disconnect();
        silent.start();
        return Promise.resolve(resumed);
    } catch (error) { return Promise.reject(error); }
}
for (const eventName of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    document.addEventListener(eventName, () => { void unlockAudio().catch(() => {}); }, { capture: true, passive: true });
}

// This can autoplay on browsers that already allow it. Fresh mobile pages
// retain the same context for the first ordinary tap rather than an extra button.
try { void getBrowserAudioContext().resume().catch(() => {}); } catch { /* Text chat remains available. */ }

window.hikariPlaybackPrompt = (retry, signal) => new Promise((resolve, reject) => {
    let retrying = false;
    const events = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
    const cleanup = () => {
        for (const event of events) document.removeEventListener(event, play, true);
        signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Playback cancelled', 'AbortError')); };
    const play = () => {
        if (retrying) return;
        retrying = true;
        let pending;
        try { pending = retry(); } catch (error) { pending = Promise.reject(error); }
        Promise.resolve(pending).then(() => { cleanup(); resolve(); }, () => { retrying = false; });
    };
    if (signal.aborted) return abort();
    for (const event of events) document.addEventListener(event, play, { capture: true, passive: true });
    signal.addEventListener('abort', abort, { once: true });
});
