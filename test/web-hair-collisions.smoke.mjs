// npm run build:web && env -u ELECTRON_RUN_AS_NODE /usr/local/bin/node node_modules/electron/cli.js test/web-hair-collisions.smoke.mjs
// Load the real web build without an Electron preload. Test-only instrumentation
// in a temporary bundle lets us inspect the loaded model and its physical rig.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHikariServer } from '../server/index.js';

const profile = mkdtempSync(path.join(os.tmpdir(), 'hikari-web-hair-'));
app.setPath('userData', path.join(profile, 'profile'));
const webRoot = path.join(profile, 'web');
cpSync(path.resolve('dist-web'), webRoot, { recursive: true });
const bundle = path.join(webRoot, 'app.js');
const original = readFileSync(bundle, 'utf8');
const instrumented = original.replace(/\w+\.info\("vrm","VRM loaded:",(\w+)\)/,
    (match, vrm) => `(globalThis.__hairTestVrm=${vrm},${match})`);
assert.notEqual(instrumented, original, 'The temporary test bundle must expose the loaded model');
writeFileSync(bundle, instrumented);
const errors = [];
const server = createHikariServer({ port: 0, webRoot, token: 'test-only',
    probeOpenClaw: async () => true, probeTts: async () => false,
    fetch: async () => Response.json({ choices: [{ message: { content: '{"reply":false}' } }] }),
});
let window;
const timeout = setTimeout(() => { console.error('WEB_HAIR_COLLISIONS_TIMEOUT'); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function run() {
try {
    console.log('WEB_HAIR_COLLISIONS_START');
    await app.whenReady();
    const address = await server.listen();
    window = new BrowserWindow({ show: false, width: 1000, height: 900, useContentSize: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.webContents.setAudioMuted(true);
    window.webContents.on('console-message', event => {
        if (event.level === 'error' && /Uncaught|Initialization error|failed to load animation/i.test(event.message)) errors.push(event.message);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}`);
    window.showInactive();
    console.log('WEB_HAIR_COLLISIONS_PAGE_LOADED');
    await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 35000;
        const timer = setInterval(() => {
            if (window.sendAgentMessage && !document.getElementById('loadingGif') && window.__hairTestVrm) {
                clearInterval(timer); resolve();
            } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(document.getElementById('status').textContent)); }
        }, 50);
    })`);
    const configuration = await evaluate(`(() => {
        const vrm = __hairTestVrm, manager = vrm.springBoneManager;
        window.__hairTestJoints = [...manager.joints].filter(joint => /Ha_(Back|Side)/i.test(joint.bone.name));
        window.__hairTestGroups = __hairTestJoints.map(joint => joint.colliderGroups);
        window.__hairTestColliders = manager.colliders.filter(collider => collider.name.startsWith('Hikari hair collision:'));
        document.querySelectorAll('input[id^="anim-"]').forEach(input => {
            input.checked = input.id === 'anim-idle_loop'; input.dispatchEvent(new Event('change'));
        });
        for (const id of ['desktopCursorGazeToggle', 'environmentReactionsToggle']) {
            const input = document.getElementById(id);
            if (input) { input.checked = false; input.dispatchEvent(new Event('change')); }
        }
        return { desktopPreload: !!window.electronAPI, hair: __hairTestJoints.length,
            colliders: __hairTestColliders.length, assigned: __hairTestJoints.every(joint => joint.colliderGroups.length === 1) };
    })()`);
    assert.deepEqual(configuration, { desktopPreload: false, hair: 144, colliders: 11, assigned: true });
    await evaluate(`(() => {
        window.__hairTestMeasure = () => {
            const vrm = __hairTestVrm;
            vrm.scene.updateMatrixWorld(true);
            let deepest = 0, total = 0, intersections = 0;
            for (const joint of __hairTestJoints) {
                const tail = joint.initialLocalChildPosition.clone();
                joint.bone.localToWorld(tail);
                const normal = tail.clone();
                let penetration = 0;
                for (const collider of __hairTestColliders) {
                    const distance = collider.shape.calculateCollision(collider.colliderMatrix, tail, 0, normal);
                    penetration = Math.max(penetration, -distance);
                }
                deepest = Math.max(deepest, penetration); total += penetration;
                if (penetration > 0.002) intersections++;
            }
            return { deepest, total, intersections,
                finite: [...vrm.springBoneManager.joints].every(joint => joint.bone.quaternion.toArray().every(Number.isFinite)) };
        };
        window.__hairTestSetCollisions = enabled => {
            const manager = __hairTestVrm.springBoneManager;
            __hairTestJoints.forEach((joint, i) => {
                joint.colliderGroups = enabled ? __hairTestGroups[i] : [];
                manager.addJoint(joint);
            });
            manager.reset();
        };
    })()`);
    const results = [];
    for (const [file, fraction] of [['idle_loop.vrma', 0.35], ['idle_stretch.vrma', 0.45], ['idle_airplane.vrma', 0.4], ['idle_sport.vrma', 0.55], ['idle_look.vrma', 0.5]]) {
        // Keep random idles disabled, but explicitly allow this test's clip.
        await evaluate(`animationSettings[${JSON.stringify(file.replace('.vrma', ''))}] = true;
            window.startSmoothTransition(window.getVRMAAnimationUrl(${JSON.stringify(file)}), { loopMode: 2201, transitionTime: 0 }).then(action => {
                if (!action) throw new Error('Animation failed to load');
                action.getMixer().stopAllAction(); action.reset().setEffectiveWeight(1).play();
                action.paused = true; action.time = action.getClip().duration * ${fraction};
                action.getMixer().update(0);
            });`);
        const poses = {};
        for (const enabled of [false, true]) {
            poses[enabled ? 'fixed' : 'original'] = await evaluate(`(() => {
                __hairTestSetCollisions(${enabled});
                for (let i = 0; i < 120; i++) __hairTestVrm.update(1 / 60);
                return __hairTestMeasure();
            })()`);
            assert.equal(poses[enabled ? 'fixed' : 'original'].finite, true);
            // Rear and side views make shoulder/torso clipping visible.
            if (file === 'idle_stretch.vrma' || file === 'idle_loop.vrma') {
                for (const [view, angle] of [['back', Math.PI], ['side', Math.PI / 2]]) {
                    await evaluate(`(() => {
                        const d = camera.position.distanceTo(controls.target);
                        camera.position.set(controls.target.x + Math.sin(${angle}) * d, controls.target.y,
                            controls.target.z + Math.cos(${angle}) * d);
                        controls.update();
                    })()`);
                    await pause(100);
                    await writeFile(`/tmp/hikari-hair-${file.replace('.vrma', '')}-${enabled ? 'fixed' : 'original'}-${view}.png`, (await window.webContents.capturePage()).toPNG());
                }
            }
        }
        results.push({ file, ...poses });
    }
    const gap = await evaluate(`(() => { __hairTestVrm.springBoneManager.update(5); return __hairTestMeasure(); })()`);
    assert.equal(gap.finite, true);
    assert.deepEqual(errors, []);
    console.log('WEB_HAIR_COLLISIONS_RESULTS', JSON.stringify({ configuration, results, gap }));
    for (const result of results) {
        assert.ok(result.fixed.total <= result.original.total + 0.005, `${result.file} must not increase body penetration`);
    }
    assert.ok(results.some(result => result.original.total > 0.02 && result.fixed.total < result.original.total * 0.5), 'Colliders must measurably reduce hair/body penetration');
    console.log('WEB_HAIR_COLLISIONS_OK');
    clearTimeout(timeout); window.destroy(); await server.close();
    await rm(profile, { recursive: true, force: true }); app.exit(0);
} catch (error) {
    console.error('WEB_HAIR_COLLISIONS_FAILED', error, errors);
    clearTimeout(timeout); window?.destroy(); await server.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }); app.exit(1);
}
}
void run();
