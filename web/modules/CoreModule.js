/**
 * CoreModule - Core VRM/Three.js functionality
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { CONFIG } from '../config.js';
import logger from '../logger.js';

// Global state
let currentVrm, currentMixer, currentAction, vrmaAnimationClip;
let isIdleMode = false, isTransitioning = false, idleSuspended = false;
let currentIdleTimeout = null, transitionStartTime = 0, transitionDuration = 0;
let activeFacialExpression = null, blinkSystemEnabled = true;
let isPlayingWalkSequence = false, lastTouchTime = 0;
let scene, camera, renderer, controls, clock, loader;
let statusDiv, canvasContainer;
let ASSET_BASE_URL = '/assets/';

export function setAssetBaseUrl(url) {
    ASSET_BASE_URL = url;
    logger.info('core', 'Asset base URL set to:', ASSET_BASE_URL);
}

export async function initCore() {
    logger.info('core', 'Initializing CoreModule');
    statusDiv = document.getElementById('status');
    canvasContainer = document.getElementById('canvasContainer') || document.body;
    initThreeJS();
    initLoader();
    await loadVRM();
    animate();
    logger.info('core', 'CoreModule initialized');
}

function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    
    camera = new THREE.PerspectiveCamera(CONFIG.CAMERA_FOV, window.innerWidth / window.innerHeight, CONFIG.CAMERA_NEAR, CONFIG.CAMERA_FAR);
    camera.position.set(CONFIG.DEFAULT_CAMERA_POS.x, CONFIG.DEFAULT_CAMERA_POS.y, CONFIG.DEFAULT_CAMERA_POS.z);
    
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    canvasContainer.appendChild(renderer.domElement);
    
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(CONFIG.CONTROLS_TARGET.x, CONFIG.CONTROLS_TARGET.y, CONFIG.CONTROLS_TARGET.z);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enablePan = true;
    controls.minDistance = 1.0;
    controls.maxDistance = 10.0;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minPolarAngle = 0.1;
    controls.update();
    
    clock = new THREE.Clock();
    setupLighting();
    window.addEventListener('resize', onWindowResize);
    logger.info('core', 'Three.js initialized');
}

function setupLighting() {
    scene.add(new THREE.AmbientLight(0xffffff, CONFIG.AMBIENT_LIGHT_INTENSITY));
    
    const keyLight = new THREE.DirectionalLight(0xffffff, CONFIG.KEY_LIGHT_INTENSITY);
    keyLight.position.set(CONFIG.KEY_LIGHT_POS.x, CONFIG.KEY_LIGHT_POS.y, CONFIG.KEY_LIGHT_POS.z);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.camera.left = -5; keyLight.shadow.camera.right = 5;
    keyLight.shadow.camera.top = 5; keyLight.shadow.camera.bottom = -5;
    scene.add(keyLight);
    
    const fillLight = new THREE.DirectionalLight(0xffffff, CONFIG.FILL_LIGHT_INTENSITY);
    fillLight.position.set(CONFIG.FILL_LIGHT_POS.x, CONFIG.FILL_LIGHT_POS.y, CONFIG.FILL_LIGHT_POS.z);
    scene.add(fillLight);
    
    const rimLight = new THREE.DirectionalLight(0xffffff, CONFIG.RIM_LIGHT_INTENSITY);
    rimLight.position.set(CONFIG.RIM_LIGHT_POS.x, CONFIG.RIM_LIGHT_POS.y, CONFIG.RIM_LIGHT_POS.z);
    scene.add(rimLight);
    
    const topLight = new THREE.DirectionalLight(0xffffff, CONFIG.TOP_LIGHT_INTENSITY);
    topLight.position.set(CONFIG.TOP_LIGHT_POS.x, CONFIG.TOP_LIGHT_POS.y, CONFIG.TOP_LIGHT_POS.z);
    scene.add(topLight);
}

function initLoader() {
    loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    logger.info('core', 'GLTF loader with VRM plugins initialized');
}

export async function loadVRM() {
    const vrmUrl = `${ASSET_BASE_URL}VRM/sample.vrm`;
    logger.info('core', 'Loading VRM from:', vrmUrl);
    if (statusDiv) statusDiv.textContent = 'Loading VRM model...';
    
    try {
        const gltf = await loader.loadAsync(vrmUrl);
        const vrm = gltf.userData.vrm;
        if (!vrm) throw new Error('VRM data not found in GLTF');
        
        currentVrm = vrm;
        scene.add(vrm.scene);
        currentMixer = new THREE.AnimationMixer(vrm.scene);
        
        VRMUtils.removeUnnecessaryJoints(vrm.scene);
        vrm.humanoid.normalizeBoneNames();
        vrm.blink.enableAutoBlink();
        vrm.lookAt.target = camera;
        vrm.lookAt.eyes = vrm.lookAt.head = vrm.lookAt.neck = true;
        
        logger.info('core', 'VRM loaded successfully');
        if (statusDiv) statusDiv.textContent = 'VRM loaded! Starting idle loop...';
        await loadIdleLoop();
    } catch (error) {
        logger.error('core', 'Failed to load VRM:', error);
        if (statusDiv) { statusDiv.textContent = 'Error loading VRM: ' + error.message; statusDiv.style.color = '#ff6b6b'; }
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
// ============================================================
// ANIMATION SYSTEM
// ============================================================
export async function loadIdleLoop() {
    if (!currentVrm) return false;
    logger.info('idle', 'loadIdleLoop called');
    try {
        if (statusDiv) statusDiv.textContent = 'Loading: Idle loop...';
        isIdleMode = true;
        const idleUrl = `${ASSET_BASE_URL}VRMA/idle_loop.vrma`;
        const gltf = await loader.loadAsync(idleUrl);
        logger.info('idle', 'gltf loaded for idle loop');
        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];
        if (vrmAnimationData) {
            const baseClip = createVRMAnimationClip(vrmAnimationData, currentVrm);
            if (baseClip) {
                vrmaAnimationClip = baseClip;
                await blendToAnimation(baseClip, THREE.LoopRepeat, 0);
                if (statusDiv) statusDiv.textContent = 'Idle loop started automatically';
                logger.info('idle', 'idle loop playing');
                return true;
            }
        }
        logger.warn('idle', 'no VRM animation data found in idle loop gltf');
        return false;
    } catch (error) {
        logger.error('idle', 'Error loading idle loop:', error);
        if (statusDiv) statusDiv.textContent = 'Failed to load idle loop';
        return false;
    }
}

export async function loadVRMA(url) {
    if (!currentVrm) { if (statusDiv) statusDiv.textContent = 'VRM model not loaded. Please load VRM model first.'; return; }
    logger.info('core', 'Loading VRMA:', url);
    try {
        if (statusDiv) statusDiv.textContent = 'Loading VRMA animation...';
        const gltf = await loader.loadAsync(url);
        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];
        if (vrmAnimationData) {
            const clip = createVRMAnimationClip(vrmAnimationData, currentVrm);
            if (clip) {
                vrmaAnimationClip = clip;
                const isIdleAnimation = url.includes('idle_loop.vrma');
                if (isIdleAnimation) {
                    isIdleMode = true; if (statusDiv) statusDiv.textContent = 'Idle loop animation loaded!';
                    try { currentAction = currentMixer.clipAction(clip); currentAction.setLoop(THREE.LoopRepeat); currentAction.play(); if (statusDiv) statusDiv.textContent += ' - Auto-playing...'; }
                    catch (e) { logger.error('core', 'Error playing idle animation:', e); if (statusDiv) statusDiv.textContent += ' - Playback error: ' + e.message; }
                } else { isIdleMode = false; if (statusDiv) statusDiv.textContent = 'Animation loaded!'; }
                logger.info('core', 'Generated AnimationClip:', vrmaAnimationClip);
                return vrmaAnimationClip;
            }
        }
        throw new Error('Could not create AnimationClip from VRMA data.');
    } catch (error) { logger.error('core', 'Error loading VRMA:', error); if (statusDiv) statusDiv.textContent = 'Error: ' + error.message; }
}

export async function startSmoothTransition(url, { loopMode = THREE.LoopRepeat, startOffset = CONFIG.T_OFFSET, resetPose = false, transitionTime = CONFIG.TRANSITION_TIME } = {}) {
    if (!currentVrm) return null;
    isTransitioning = true; transitionStartTime = performance.now(); transitionDuration = transitionTime;
    try {
        const gltf = await loader.loadAsync(url);
        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];
        if (vrmAnimationData) {
            const toClip = createVRMAnimationClip(vrmAnimationData, currentVrm);
            if (toClip) { vrmaAnimationClip = toClip; isIdleMode = false; await blendToAnimation(toClip, loopMode, startOffset, resetPose, transitionTime); setTimeout(() => { isTransitioning = false; }, 300); return currentAction; }
        }
    } catch (e) { logger.error('transition', 'failed to load animation', url, e); }
    return null;
}

function blendToAnimation(targetClip, loopMode = THREE.LoopRepeat, startOffset = CONFIG.T_OFFSET, resetPose = false, transitionTime = CONFIG.TRANSITION_TIME) {
    if (resetPose && currentVrm) { currentVrm.humanoid.resetNormalizedPose(); currentMixer.update(0); }
    const nextAction = currentMixer.clipAction(targetClip);
    nextAction.setLoop(loopMode); nextAction.clampWhenFinished = (loopMode !== THREE.LoopRepeat);
    nextAction.enabled = true; nextAction.weight = 1; nextAction.setEffectiveWeight(1); nextAction.setEffectiveTimeScale(1);
    nextAction.reset(); nextAction.time = startOffset; nextAction.play();
    if (currentAction && currentAction !== nextAction) { nextAction.crossFadeFrom(currentAction, transitionTime, true); const prev = currentAction; setTimeout(() => { prev.stop(); }, transitionTime * 1000); }
    currentMixer.update(0); currentAction = nextAction; return Promise.resolve(currentAction);
}

export async function waitForActionEnd(action, maxWait = CONFIG.DEFAULT_MAX_WAIT, resetPose = true) {
    if (!currentMixer || !action) return Promise.resolve(false);
    return new Promise((resolve) => {
        let finished = false;
        const handler = (e) => { if (e.action === action) { finished = true; currentMixer.removeEventListener('finished', handler); clearTimeout(timer); if (resetPose && currentVrm) currentVrm.humanoid.resetNormalizedPose(); resolve(true); } };
        currentMixer.addEventListener('finished', handler);
        const timer = setTimeout(() => { if (!finished) { currentMixer.removeEventListener('finished', handler); logger.warn('seq', 'waitForActionEnd timeout'); resolve(false); } }, maxWait);
    });
}

// ============================================================
// EXPRESSION SYSTEM
// ============================================================
export function applyFacialExpression(expressionName) {
    if (!currentVrm || !currentVrm.expressionManager) { logger.warn('expr', 'VRM or expressionManager not available'); return; }
    const expressionMap = { 'neutral': 'neutral', 'happy': 'happy', 'sad': 'sad', 'angry': 'angry', 'surprised': 'surprised', 'blink': 'blink', 'shy': 'angry', 'shocked': 'surprised', 'relaxed': 'neutral' };
    const vrmExpression = expressionMap[expressionName] || 'neutral';
    const allExpressions = ['neutral','happy','sad','angry','surprised','blink','blinkLeft','blinkRight','Lblink','Rblink','eyeBlink','blink_l','blink_r','blinking','Blink','EYE_BLINK','BLINK'];
    allExpressions.forEach(expr => { try { currentVrm.expressionManager.setValue(expr, 0); } catch (e) {} });
    if (vrmExpression === 'blink') { currentVrm.expressionManager.setValue('blink', 1); setTimeout(() => { allExpressions.forEach(expr => { try { currentVrm.expressionManager.setValue(expr, 0); } catch (e) {} }); activeFacialExpression = null; }, 200); }
    else { currentVrm.expressionManager.setValue(vrmExpression, 1.0); }
    activeFacialExpression = vrmExpression;
    logger.info('expr', 'Applied expression:', expressionName, '->', vrmExpression);
}

export function resetExpressionToNeutral() {
    if (!currentVrm || !currentVrm.expressionManager) return;
    const allExpressions = ['neutral','happy','sad','angry','surprised','blink','blinkLeft','blinkRight','Lblink','Rblink','eyeBlink','blink_l','blink_r','blinking','Blink','EYE_BLINK','BLINK'];
    allExpressions.forEach(expr => { try { currentVrm.expressionManager.setValue(expr, 0); } catch (e) {} });
    currentVrm.expressionManager.setValue('neutral', 1); activeFacialExpression = null; blinkSystemEnabled = true;
    logger.info('expr', 'Reset to neutral expression');
}

// ============================================================
// RANDOM IDLE SYSTEM
// ============================================================
export function beginRandomIdleSelection() { scheduleRandomIdle(); }

function scheduleRandomIdle() {
    if (currentIdleTimeout) clearTimeout(currentIdleTimeout);
    const delay = Math.random() * (CONFIG.RANDOM_IDLE_MAX_DELAY - CONFIG.RANDOM_IDLE_MIN_DELAY) + CONFIG.RANDOM_IDLE_MIN_DELAY;
    logger.info('idle', 'scheduling random idle in', delay, 'ms');
    currentIdleTimeout = setTimeout(playRandomIdle, delay);
}

async function playRandomIdle() {
    if (!currentVrm || !isIdleMode) return;
    const idleAnimations = ['idle_airplane.vrma','idle_look.vrma','idle_shoot.vrma','idle_sport.vrma','idle_stretch.vrma','idle_vSign.vrma','wave_both.vrma','wave_fast.vrma','wave_left.vrma','wave_right.vrma','start_2turnAround.vrma'];
    const randomAnim = idleAnimations[Math.floor(Math.random() * idleAnimations.length)];
    const url = ASSET_BASE_URL + 'VRMA/' + randomAnim;
    logger.info('idle', 'Playing random idle:', randomAnim);
    try {
        await startSmoothTransition(url, { loopMode: THREE.LoopOnce, resetPose: true });
        if (currentAction) await waitForActionEnd(currentAction, 30000, true);
        await loadIdleLoop();
    } catch (error) { logger.error('idle', 'Error playing random idle:', error); await loadIdleLoop(); }
    finally { scheduleRandomIdle(); }
}

// ============================================================
// WALK SEQUENCE (DISABLED FOR WEB)
// ============================================================
export async function runWalkSequence(vrmaUrl) {
    logger.info('walk', 'Walk sequence disabled in web version');
    if (vrmaUrl) await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopOnce });
    return null;
}

export async function runElectronWalkSequence(vrmaUrl) {
    logger.warn('walk', 'runElectronWalkSequence called in web version - not supported');
    return runWalkSequence(vrmaUrl);
}

// ============================================================
// TOUCH SYSTEM
// ============================================================
function identifyBodyPart(intersection) {
    if (!currentVrm) return 'body';
    const touchPoint = intersection.point; const localPoint = touchPoint.clone(); currentVrm.scene.worldToLocal(localPoint);
    const y = localPoint.y, x = localPoint.x; const isLeftSide = x < 0, isRightSide = x >= 0;
    let bodyPart = 'body';
    if (y > CONFIG.HEAD_THRESHOLD) bodyPart = 'head';
    else if (y > CONFIG.CHEST_THRESHOLD) bodyPart = 'chest';
    else if (y > CONFIG.HIP_THRESHOLD) bodyPart = 'hip';
    else bodyPart = 'leg';
    logger.info('touch', 'Identified body part:', bodyPart, '(y:', y.toFixed(2), ', x:', x.toFixed(2), ')');
    return bodyPart;
}

export async function handleTouchEvent(intersection) {
    if (!currentVrm) return;
    const now = Date.now(); if (now - lastTouchTime < CONFIG.TOUCH_DEBOUNCE_MS) { logger.info('touch', 'Touch event debounced'); return; }
    lastTouchTime = now; logger.info('touch', 'Touch event triggered on model');
    const touchExpressions = ['shy', 'shocked']; const chosenExpression = touchExpressions[Math.floor(Math.random() * touchExpressions.length)];
    applyFacialExpression(chosenExpression); logger.info('touch', 'Set expression to', chosenExpression, 'until agent replies');
    try {
        const bodyPart = identifyBodyPart(intersection); logger.info('touch', 'Touched body part:', bodyPart);
        if (statusDiv) statusDiv.textContent = 'Touch response...';
        const touchAction = await startSmoothTransition(`${ASSET_BASE_URL}VRMA/sit.vrma`, { loopMode: THREE.LoopRepeat });
        if (touchAction) { logger.info('touch', 'Touch animation playing'); await new Promise(resolve => setTimeout(resolve, CONFIG.TOUCH_RESPONSE_DURATION)); logger.info('touch', 'Touch animation completed'); }
        const touchMessage = 'User touched your ' + bodyPart; logger.info('touch', 'Sending message to agent:', touchMessage);
        if (window.disableMessaging) window.disableMessaging(); if (window.setMessagingThinking) window.setMessagingThinking();
        const requestId = 'touch-' + Date.now(); const idempotencyKey = 'touch-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const fullMessage = '===== USER MESSAGE =====\n' + touchMessage + '\n\n===== SYSTEM INSTRUCTIONS =====\nThe user has just touched your ' + bodyPart + '. Respond naturally to this interaction.\nYou can use facial expressions and animations to respond.';
        if (window.sendMessage) { window.sendMessage({ type: 'req', id: requestId, method: 'agent', params: { message: fullMessage, sessionKey: 'main', timeout: 60, idempotencyKey: idempotencyKey } }); logger.info('touch', 'Touch message sent to agent:', requestId); }
        logger.info('touch', 'Returning to idle loop'); await loadIdleLoop();
    } catch (error) { logger.error('touch', 'Error handling touch event:', error); await loadIdleLoop(); }
}

// ============================================================
// ANIMATION LOOP & SYSTEMS
// ============================================================
let lipSyncSystem, blinkSystem;

export function initSystems() {
    lipSyncSystem = createLipSyncSystem(); blinkSystem = createBlinkSystem();
    window.lipSyncSystem = lipSyncSystem; window.applyFacialExpression = applyFacialExpression;
    window.loadVRMA = loadVRMA; window.startSmoothTransition = startSmoothTransition;
    window.loadIdleLoop = loadIdleLoop; window.resetExpressionToNeutral = resetExpressionToNeutral;
    window._internalLipSync = lipSyncSystem;
}

function animate() {
    requestAnimationFrame(animate); const deltaTime = clock.getDelta();
    if (currentVrm) {
        currentVrm.update(deltaTime);
        if (blinkSystem) blinkSystem.update(currentVrm, deltaTime);
        if (lipSyncSystem) {
            lipSyncSystem.update(currentVrm, deltaTime);
            if (!lipSyncSystem.isTalking() && activeFacialExpression && activeFacialExpression !== 'blink') { activeFacialExpression = null; blinkSystemEnabled = true; }
            updateSpeakingBubblePosition();
            if (activeFacialExpression) {
                const allPossibleBlinkExpressions = ['blink','blinkLeft','blinkRight','Lblink','Rblink','eyeBlink','blink_l','blink_r','blinking','Blink','EYE_BLINK','BLINK'];
                allPossibleBlinkExpressions.forEach(expr => { try { if (currentVrm.expressionManager && typeof currentVrm.expressionManager.setValue === 'function') currentVrm.expressionManager.setValue(expr, 0); } catch (e) {} });
            }
        }
    }
    if (isTransitioning && currentAction) { const elapsed = (performance.now() - transitionStartTime) / 1000; if (elapsed >= transitionDuration) isTransitioning = false; }
    if (currentMixer) currentMixer.update(deltaTime);
    controls.update(); renderer.render(scene, camera);
}
// ============================================================
// LOADING GIF CONTROL
// ============================================================
let loadingGif = null, loadingStartTime = 0; const MIN_LOADING_TIME = 2000;
export function showLoadingGif() {
    if (loadingGif && loadingGif.parentElement) loadingGif.remove();
    loadingStartTime = performance.now();
    loadingGif = document.createElement('div'); loadingGif.id = 'loadingGif';
    loadingGif.style.position = 'fixed'; loadingGif.style.top = '0'; loadingGif.style.left = '0'; loadingGif.style.width = '100vw'; loadingGif.style.height = '100vh'; loadingGif.style.zIndex = '10000'; loadingGif.style.display = 'block'; loadingGif.style.opacity = '1'; loadingGif.style.transition = 'opacity 1s ease-out';
    const loadingGifUrl = `${ASSET_BASE_URL}loading.gif`; const img = new Image();
    img.onload = () => { loadingGif.style.background = `url('${loadingGifUrl}') no-repeat center center`; loadingGif.style.backgroundSize = 'cover'; };
    img.onerror = () => { loadingGif.style.background = `url('${loadingGifUrl}') no-repeat center center`; loadingGif.style.backgroundSize = 'cover'; };
    img.src = loadingGifUrl; document.body.appendChild(loadingGif);
}
export function hideLoadingGif() {
    const elapsed = performance.now() - loadingStartTime; const remainingTime = Math.max(0, MIN_LOADING_TIME - elapsed);
    setTimeout(() => { if (loadingGif) { loadingGif.style.opacity = '0'; setTimeout(() => { if (loadingGif && loadingGif.parentElement) { loadingGif.remove(); loadingGif = null; } }, 1000); } }, remainingTime);
}

// ============================================================
// SPEAKING BUBBLE
// ============================================================
let speakingBubble = null, bubbleHideTimer = null;
function updateSpeakingBubblePosition() { if (!speakingBubble || !currentVrm) return; const headBone = currentVrm.humanoid.getBoneNode('head'); if (!headBone) return; const headPosition = new THREE.Vector3(); headBone.getWorldPosition(headPosition); const screenPos = headPosition.clone().project(camera); const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth; const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight - CONFIG.BUBBLE_MARGIN_TOP; speakingBubble.style.left = x + 'px'; speakingBubble.style.top = y + 'px'; speakingBubble.style.transform = 'translate(-50%, -100%)'; }
export function showSpeakingBubble(text) { if (speakingBubble && speakingBubble.parentElement) speakingBubble.remove(); speakingBubble = document.createElement('div'); speakingBubble.style.position = 'fixed'; speakingBubble.style.zIndex = '1000'; speakingBubble.style.maxWidth = CONFIG.BUBBLE_MAX_WIDTH + 'px'; speakingBubble.style.padding = CONFIG.BUBBLE_PADDING + 'px ' + (CONFIG.BUBBLE_PADDING * 1.5) + 'px'; speakingBubble.style.background = 'rgba(0, 0, 0, 0.8)'; speakingBubble.style.color = 'white'; speakingBubble.style.borderRadius = '16px'; speakingBubble.style.fontSize = '14px'; speakingBubble.style.lineHeight = '1.4'; speakingBubble.style.pointerEvents = 'none'; speakingBubble.style.boxShadow = '0 ' + CONFIG.BUBBLE_SHADOW_OFFSET + 'px ' + CONFIG.BUBBLE_SHADOW_BLUR + 'px rgba(0, 0, 0, 0.3)'; speakingBubble.style.border = '1px solid rgba(255, 255, 255, 0.1)'; speakingBubble.style.whiteSpace = 'pre-wrap'; speakingBubble.style.wordWrap = 'break-word'; speakingBubble.textContent = text; document.body.appendChild(speakingBubble); updateSpeakingBubblePosition(); }
export function hideSpeakingBubble() { if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; } if (speakingBubble) { speakingBubble.style.opacity = '0'; speakingBubble.style.transition = 'opacity 0.5s ease-out'; setTimeout(() => { if (speakingBubble && speakingBubble.parentElement) { speakingBubble.remove(); speakingBubble = null; } }, 500); } }

// ============================================================
// BLINK SYSTEM
// ============================================================
function createBlinkSystem() {
    let nextBlinkTime = 0, isBlinking = false, blinkProgress = 0; const blinkDuration = CONFIG.BLINK_DURATION;
    function scheduleNextBlink() { const interval = 2000 + Math.random() * 4000; nextBlinkTime = performance.now() / 1000 + interval; } scheduleNextBlink();
    return { update(vrm, deltaTime) { if (!blinkSystemEnabled || !vrm || !vrm.expressionManager) return; if (activeFacialExpression && activeFacialExpression !== 'blink') return; const now = performance.now() / 1000; if (isBlinking) { blinkProgress += deltaTime; const progress = Math.min(blinkProgress / blinkDuration, 1); const blinkValue = Math.sin(progress * Math.PI); const blinkExpressions = ['blink','blinkLeft','blinkRight','Lblink','Rblink','eyeBlink','blink_l','blink_r','blinking','Blink','EYE_BLINK','BLINK']; blinkExpressions.forEach(expr => { try { vrm.expressionManager.setValue(expr, blinkValue); } catch (e) {} }); if (progress >= 1) { isBlinking = false; blinkProgress = 0; blinkExpressions.forEach(expr => { try { vrm.expressionManager.setValue(expr, 0); } catch (e) {} }); scheduleNextBlink(); } } else if (now >= nextBlinkTime) { isBlinking = true; blinkProgress = 0; } } };
}
// ============================================================
// LIP SYNC SYSTEM (Advanced - from Electron)
// ============================================================
function splitIntoGraphemes(text) { if (typeof Intl !== 'undefined' && Intl.Segmenter) { const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' }); return Array.from(segmenter.segment(text)).map(s => s.segment); } return Array.from(text); }

function createLipSyncSystem() {
    let mouthTarget = 'neutral', mouthCurrent = 'neutral', isCurrentlyTalking = false; let speakingSpeedMultiplier = 1.0, currentIdleTimeout = null, idleSuspended = false, isAgentCommandActive = false;
    const vowelToMouthShape = { 'a':'aa','e':'ee','i':'ih','o':'oh','u':'oo','A':'aa','E':'ee','I':'ih','O':'oh','U':'oo','あ':'aa','い':'ih','う':'oo','え':'ee','お':'oh','ア':'aa','イ':'ih','ウ':'oo','エ':'ee','オ':'oh','k':'k','g':'k','ng':'k','s':'s','z':'s','sh':'sh','ch':'sh','j':'sh','t':'t','d':'t','n':'n','h':'h','f':'f','v':'f','m':'m','b':'b','p':'b','r':'r','l':'r','w':'oo','y':'ih','neutral':'neutral' };
    function updateMouthShape(vrm, deltaTime) { if (!vrm || !vrm.expressionManager) return; const targetIntensity = isCurrentlyTalking ? 0.8 : 0; const decayRate = deltaTime * CONFIG.EXPRESSION_DECAY_MULTIPLIER; const allMouthShapes = ['aa','ee','ih','oh','oo','k','s','t','n','h','f','m','b','r','w','neutral']; allMouthShapes.forEach(shape => { try { const current = vrm.expressionManager.getValue(shape) || 0; const target = (shape === mouthTarget) ? targetIntensity : 0; const newValue = current + (target - current) * Math.min(decayRate * 10, 1); vrm.expressionManager.setValue(shape, newValue); } catch (e) {} }); }
    function setSpeakingSpeed(speed) { speakingSpeedMultiplier = speed; logger.info('lip', 'Speaking speed set to:', speed); }
    function isTalking() { return isCurrentlyTalking; }
    function setAgentCommandActive(active) { isAgentCommandActive = active; logger.info('lip', 'Agent command active:', active); }
    async function startSpeaking(text) { logger.info('lip', 'startSpeaking', text); isCurrentlyTalking = false; mouthTarget = 'neutral'; if (currentIdleTimeout) { clearTimeout(currentIdleTimeout); currentIdleTimeout = null; idleSuspended = true; } if (!isAgentCommandActive) { loadIdleLoop().then(() => { logger.info('lip', 'idle loop loaded in background'); }).catch(err => { logger.warn('lip', 'background idle load failed', err); }); } isCurrentlyTalking = true; const lines = text.split('\n').filter(line => line.trim() !== ''); logger.info('lip', 'Text split into', lines.length, 'lines'); await processLinesSequentially(lines); }
    async function processLinesSequentially(lines) { for (let i = 0; i < lines.length; i++) { const line = lines[i].trim(); if (!line) continue; logger.info('lip', 'Speaking line', i + 1, 'of', lines.length, ':', line); showSpeakingBubble(line); await speakLine(line); if (i < lines.length - 1) { logger.info('lip', 'Pausing between lines...'); await new Promise(resolve => setTimeout(resolve, CONFIG.SPEECH_LINE_PAUSE)); } } isCurrentlyTalking = false; mouthTarget = 'neutral'; hideSpeakingBubble(); if (window.resetExpressionToNeutral) window.resetExpressionToNeutral(); if (idleSuspended) { scheduleRandomIdle(); idleSuspended = false; } }
    function speakLine(text) { const hasChinese = /[\u4e00-\u9fff]/.test(text); if (hasChinese) return speakLineWithTimer(text); if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') return speakLineWithSpeechSynthesis(text); return speakLineWithTimer(text); }
function speakLineWithSpeechSynthesis(text) { return new Promise((resolve) => { const utterance = new SpeechSynthesisUtterance(text); const hasChinese = /[\u4e00-\u9fff]/.test(text); let currentUnitIndex = -1, mouthCycleTimer = null, settled = false; const clearMouthCycle = () => { if (mouthCycleTimer) { clearInterval(mouthCycleTimer); mouthCycleTimer = null; } }; const finish = () => { if (settled) return; settled = true; clearMouthCycle(); mouthTarget = 'neutral'; resolve(); }; utterance.rate = speakingSpeedMultiplier; utterance.pitch = 1; utterance.volume = 1; const voices = window.speechSynthesis.getVoices(); const preferredVoice = voices.find(voice => { const language = voice.lang.toLowerCase(); return hasChinese ? language.startsWith('zh') : language.startsWith('en'); }); if (preferredVoice) utterance.voice = preferredVoice; const graphemes = splitIntoGraphemes(text); utterance.onboundary = (event) => { const charIndex = event.charIndex || 0; const remainingText = text.slice(charIndex); const wordMatch = remainingText.match(/[^\s]+/); const spokenUnit = wordMatch ? wordMatch[0] : text[charIndex] || ''; let unitIndex; if (hasChinese) { const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' }); const segments = Array.from(segmenter.segment(text.slice(0, charIndex))); unitIndex = segments.length; } else { unitIndex = text.slice(0, charIndex).trim().split(/\s+/).filter(Boolean).length; } if (unitIndex !== currentUnitIndex) { currentUnitIndex = unitIndex; updateDebugDisplay(text, unitIndex, hasChinese ? spokenUnit[0] : null); } const firstChar = spokenUnit[0]?.toLowerCase(); if (firstChar && vowelToMouthShape[firstChar]) mouthTarget = vowelToMouthShape[firstChar]; }; utterance.onend = () => { logger.info('lip', 'SpeechSynthesis finished'); finish(); }; utterance.onerror = (event) => { logger.error('lip', 'SpeechSynthesis error:', event.error); finish(); }; const estimatedDuration = (text.length * CONFIG.SPEECH_BASE_DURATION) / speakingSpeedMultiplier + 2000; setTimeout(() => { if (!settled) { logger.warn('lip', 'SpeechSynthesis timeout fallback'); finish(); } }, estimatedDuration); window.speechSynthesis.speak(utterance); }); }
    function speakLineWithTimer(text) { return new Promise((resolve) => { const graphemes = splitIntoGraphemes(text); const totalUnits = graphemes.length; const unitDuration = (CONFIG.SPEECH_UNIT_DELAY + Math.random() * 30) / speakingSpeedMultiplier; let currentIndex = 0; const interval = setInterval(() => { if (currentIndex >= totalUnits) { clearInterval(interval); mouthTarget = 'neutral'; resolve(); return; } const char = graphemes[currentIndex]; const lowerChar = char.toLowerCase(); if (vowelToMouthShape[lowerChar]) mouthTarget = vowelToMouthShape[lowerChar]; else if (/[\u4e00-\u9fff]/.test(char)) { const shapes = ['aa','ee','ih','oh','oo']; mouthTarget = shapes[Math.floor(Math.random() * shapes.length)]; } updateDebugDisplay(text, currentIndex, char); currentIndex++; }, unitDuration); setTimeout(() => { clearInterval(interval); mouthTarget = 'neutral'; resolve(); }, totalUnits * unitDuration + 1000); }); }
    function updateDebugDisplay(text, unitIndex, currentChar = null) { const debugDiv = document.getElementById('lipSyncDebug'); if (debugDiv) { const displayText = text.length > 100 ? text.substring(0, 100) + '...' : text; debugDiv.textContent = 'Speaking: "' + displayText + '" | Unit: ' + unitIndex + ' | Char: ' + (currentChar || 'N/A') + ' | Mouth: ' + mouthTarget; } }
    return { update: updateMouthShape, startSpeaking, setSpeakingSpeed, isTalking, setAgentCommandActive };
}

// ============================================================
// EXPORTS
// ============================================================
export function getCurrentVrm() { return currentVrm; }
export function getCurrentMixer() { return currentMixer; }
export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getControls() { return controls; }
export function getClock() { return clock; }
export function getLoader() { return loader; }
export function getAssetBaseUrl() { return ASSET_BASE_URL; }
export function getStatusDiv() { return statusDiv; }

export const CoreModule = { initCore, setAssetBaseUrl, loadVRM, loadVRMA, startSmoothTransition, waitForActionEnd, loadIdleLoop, beginRandomIdleSelection, runWalkSequence, runElectronWalkSequence, applyFacialExpression, resetExpressionToNeutral, handleTouchEvent, initSystems, showLoadingGif, hideLoadingGif, showSpeakingBubble, hideSpeakingBubble };

export default CoreModule;