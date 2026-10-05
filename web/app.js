/**
 * Hikari Web App
 *
 * The Electron renderer is the canonical application runtime. Loading it
 * here keeps the browser build in sync with the desktop build while the web
 * page supplies its own responsive shell and asset base.
 */
import '../electron/app.js';

// Electron keeps the messaging panel hidden until its floating history
// control is used. In a browser, keep the composer available immediately;
// the history toggle controls only history; the composer stays available.
if (!window.electronAPI) {
    const showWebComposer = () => {
        const panel = document.getElementById('lipSyncPanel');
        if (panel) panel.style.display = 'flex';
    };
    const expressionSelect = document.getElementById('expressionSelect');
    if (expressionSelect) {
        expressionSelect.addEventListener('change', () => {
            if (window.applyFacialExpression) window.applyFacialExpression(expressionSelect.value);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showWebComposer, { once: true });
    } else {
        showWebComposer();
    }
}

// Browser controls never carry the gateway secret or desktop permissions.
import { createServices } from '../shared/services.js';
const webServices = createServices();
const connectionBar = document.getElementById('connectionBar');
const connectionStatus = document.getElementById('connectionStatus');
const retryConnection = document.getElementById('retryConnection');
let checkingConnection = false;
let connectionWasAvailable = null;
let connectionNoticeTimer;
function updateConnectionNotice(available) {
    if (available && connectionWasAvailable === true) return;
    clearTimeout(connectionNoticeTimer);
    connectionBar.classList.remove('is-dismissed');
    connectionBar.removeAttribute('aria-hidden');
    connectionWasAvailable = available;
    if (available) {
        connectionNoticeTimer = setTimeout(() => {
            connectionBar.classList.add('is-dismissed');
            connectionBar.setAttribute('aria-hidden', 'true');
        }, 4000);
    }
}
async function refreshConnection() {
    if (checkingConnection) return;
    checkingConnection = true;
    try {
        const health = await webServices.getHealth();
        const available = health.openclaw?.configured && health.openclaw?.reachable;
        connectionStatus.textContent = available
            ? 'Connected to your computer'
            : health.openclaw?.configured ? 'OpenClaw is offline on your computer' : 'Set up OpenClaw on your computer';
        retryConnection.hidden = available;
        updateConnectionNotice(Boolean(available));
    } catch {
        connectionStatus.textContent = 'Computer unavailable · Check its connection and Tailscale';
        retryConnection.hidden = false;
        updateConnectionNotice(false);
    } finally {
        checkingConnection = false;
    }
}
retryConnection.addEventListener('click', refreshConnection);
window.addEventListener('online', refreshConnection);
const resumeExistingAudio = () => {
    const pending = window.hikariResumeAudio?.();
    pending?.catch?.(() => {});
};
window.addEventListener('pageshow', resumeExistingAudio);
window.addEventListener('focus', resumeExistingAudio);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        void refreshConnection();
        resumeExistingAudio();
    }
});
void refreshConnection();
setInterval(() => { if (!document.hidden) void refreshConnection(); }, 30000);

// Retry the existing audio, rather than requesting another synthesis. The
// player supplies a cancellation signal so stopping speech removes the prompt.
window.hikariPlaybackPrompt = (retry, signal) => new Promise((resolve, reject) => {
    const button = document.getElementById('enableAudio');
    const cleanup = () => {
        button.hidden = true;
        button.removeEventListener('click', play);
        signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Playback cancelled', 'AbortError')); };
    const play = () => {
        button.disabled = true;
        // retry() must run immediately inside this gesture.
        let pending;
        try { pending = retry(); } catch (error) { pending = Promise.reject(error); }
        Promise.resolve(pending).then(() => { cleanup(); resolve(); }, () => {
            button.disabled = false;
            button.textContent = 'Audio blocked · Tap to retry';
        });
    };
    if (signal.aborted) return abort();
    button.textContent = 'Tap to play Hikari’s voice';
    button.disabled = false;
    button.hidden = false;
    button.addEventListener('click', play);
    signal.addEventListener('abort', abort, { once: true });
});

// Keep the composer above the software keyboard on browsers exposing its
// visual viewport, without changing the desktop layout.
function fitKeyboard() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--visible-height', `${viewport.height}px`);
}
window.visualViewport?.addEventListener('resize', fitKeyboard);
window.visualViewport?.addEventListener('scroll', fitKeyboard);


// Unlock audio during ordinary interaction, before waiting for the network.
// Touch pointerup is included because mobile browsers differ in which event
// grants transient activation. Subsequent replies reuse the same context.
for (const eventName of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    document.addEventListener(eventName, () => {
        window.hikariUnlockAudio?.().catch(() => {});
    }, { capture: true, passive: true });
}
const backgroundUrl = `${import.meta.env.VITE_ASSET_BASE_URL || '/'}loading.gif`;
document.documentElement.style.setProperty('--hikari-background-image', `url(${JSON.stringify(backgroundUrl)})`);
fitKeyboard();
