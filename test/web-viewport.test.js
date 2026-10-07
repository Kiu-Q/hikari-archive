import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebViewport } from '../web/viewport.js';

function harness() {
    const styles = new Map();
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    const window = Object.assign(new EventTarget(), {
        innerWidth: 390, innerHeight: 844, visualViewport: viewport, Event,
        requestAnimationFrame(callback) { callback(); return 0; },
    });
    const document = Object.assign(new EventTarget(), {
        activeElement: null,
        documentElement: { style: { setProperty(name, value) { styles.set(name, value); } } },
    });
    installWebViewport(window, document);
    return { window, document, viewport, styles,
        focus() { document.activeElement = { tagName: 'INPUT', type: 'text' }; document.dispatchEvent(new Event('focusin')); },
        resize(height, offsetTop = 0) { viewport.height = height; viewport.offsetTop = offsetTop; viewport.dispatchEvent(new Event('resize')); },
    };
}

test('iPhone keyboard panning is compensated while only the composer is lifted', () => {
    const h = harness();
    h.focus(); h.resize(500, 160);
    assert.equal(h.window.hikariViewport.height, 844);
    assert.equal(h.styles.get('--viewport-offset-top'), '160px');
    assert.equal(h.styles.get('--keyboard-inset'), '344px');
    assert.equal(h.styles.get('--composer-safe-bottom'), '0px');
    // Safari may dismiss the keyboard without blurring the input.
    h.resize(844);
    assert.equal(h.styles.get('--keyboard-inset'), '0px');
    assert.equal(h.styles.get('--viewport-offset-top'), '0px');
});

test('a browser shrinking innerHeight keeps the camera stable until the keyboard finishes closing', () => {
    const h = harness();
    h.focus(); h.window.innerHeight = 500; h.resize(500);
    assert.equal(h.window.hikariViewport.height, 844);
    h.document.activeElement = null; h.document.dispatchEvent(new Event('focusout'));
    assert.equal(h.window.hikariViewport.height, 844);
    assert.equal(h.styles.get('--keyboard-inset'), '344px');
    h.window.innerHeight = 844; h.resize(844);
    assert.equal(h.styles.get('--keyboard-inset'), '0px');
    h.window.innerWidth = 844; h.window.innerHeight = 390; h.resize(390);
    assert.equal(h.window.hikariViewport.height, 390);
});

test('browser zoom and address-bar changes do not masquerade as a keyboard', () => {
    const h = harness();
    h.resize(700, 50);
    assert.equal(h.styles.get('--keyboard-inset'), '0px');
    assert.equal(h.styles.get('--viewport-offset-top'), '0px');
    h.focus(); h.viewport.scale = 2; h.resize(422, 100);
    assert.equal(h.styles.get('--keyboard-inset'), '0px');
    assert.equal(h.window.hikariViewport.height, 844);
});
