/** Keep the scene steady while only the composer follows the visual viewport. */
export function installWebViewport(window, document) {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let width = window.innerWidth;
    let height = window.innerHeight;
    let keyboardOpen = false;
    let frame = 0;

    function editing() {
        const element = document.activeElement;
        return element && !element.readOnly && !element.disabled && (
            element.isContentEditable || element.tagName === 'TEXTAREA' ||
            (element.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(element.type))
        );
    }

    function fit() {
        frame = 0;
        const previousHeight = height;
        const previousWidth = width;
        const rotated = width !== window.innerWidth;
        width = window.innerWidth;
        // A focused field can shrink innerHeight on some browsers. Preserve
        // the pre-keyboard size so the camera and background don't zoom or jump.
        const candidateHeight = !rotated && (editing() || keyboardOpen)
            ? Math.max(height, window.innerHeight) : window.innerHeight;
        const visualHeight = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
        keyboardOpen = Boolean(viewport && viewport.scale === 1 && (editing() || keyboardOpen)
            && candidateHeight - visualHeight > 80);
        height = keyboardOpen ? candidateHeight : window.innerHeight;
        const offsetTop = keyboardOpen ? viewport.offsetTop : 0;
        const inset = keyboardOpen ? Math.max(0, height - visualHeight) : 0;
        window.hikariViewport = { width, height, offsetTop };
        root.style.setProperty('--layout-height', `${height}px`);
        root.style.setProperty('--viewport-offset-top', `${offsetTop}px`);
        root.style.setProperty('--keyboard-inset', `${inset}px`);
        root.style.setProperty('--composer-safe-bottom', keyboardOpen ? '0px' : 'env(safe-area-inset-bottom, 0px)');
        if (height !== previousHeight || width !== previousWidth) {
            window.dispatchEvent(new window.Event('hikari-viewport-resize'));
        }
    }

    function schedule() {
        if (!frame) frame = window.requestAnimationFrame(fit);
    }
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    // Capture the size synchronously, before the keyboard's first resize.
    document.addEventListener('focusin', fit);
    document.addEventListener('focusout', schedule);
    fit();
}

if (typeof window !== 'undefined' && !window.electronAPI) installWebViewport(window, document);
