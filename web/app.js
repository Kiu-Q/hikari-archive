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
// the panel still collapses naturally on small screens when the user opens
// settings or the history view.
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
