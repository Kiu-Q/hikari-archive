/**
 * Hikari Core - Shared Logic Module
 * Contains all Three.js, VRM, lip sync, and animation logic
 * Used by both Electron and Web versions
 */

console.log('[core] Module loaded');

// ============================================================
// IMPORTS
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    DEBUG: true,
    
    // Animation transition settings
    BUFFER_TIME: 0.5,
    TRANSITION_TIME: 0.5,
    T_OFFSET: 0.5,
    // Walk sequence configuration
    WALK_PATH_DISTANCE: 2.0,
    WALK_WINDOW_OFFSET: 600,
    WALK_START_DELAY: 0,
    WALK_WALK_DURATION: 4.0,
    WALK_TURN_DURATION: 1.0,
    WALK_PAUSE_DURATION: 3.0,
    WALK_TIME_SCALE: 0.5,
    
    // Random idle configuration
    RANDOM_IDLE_MIN_DELAY: 20000,
    RANDOM_IDLE_MAX_DELAY: 30000,
};

// ============================================================
// GLOBAL STATE
// ============================================================
let currentVrm = undefined;
let currentMixer = undefined;
let currentAction = undefined;
let vrmaAnimationClip = undefined;
let isIdleMode = false;
let isTransitioning = false;
let idleSuspended = false;
let lipSyncActive = false;
let currentExpression = '';
let transitionStartTime = 0;
let transitionDuration = CONFIG.TRANSITION_TIME;
let walkingPathActive = false;
let walkingStartTimeSec = 0;
let walkingTotalDurationSec = 0;
let walkingInitialPos = new THREE.Vector3();
let walkingInitialRotY = 0;
let isPlayingWalkSequence = false;
let walkingWindowInitialPos = null;
let isPlayingSequence = false;
let currentIdleTimeout = null;
let activeFacialExpression = null;
let blinkSystemEnabled = true;
let isSitAnimationActive = false; // Flag to prevent panel restoration during sit
let isDragging = false;
let dragStartPosition = new THREE.Vector2();
let currentDragPosition = new THREE.Vector2();
let mouseInWindow = false;
let mousePosition = new THREE.Vector2();
let initialModelRotationX = 0;
let isSitAnimationPlaying = false;
let isWindowDragging = false;
let windowDragOffset = { x: 0, y: 0 };

// ============================================================
// DOM ELEMENTS
// ============================================================
let animationSelect, expressionSelect, statusDiv, textInputPanel, speakBtnPanel;
let lipSyncPanel = null;
let historyPanel = null;
let originalMessageText = '';
let isMessagingDisabled = false;

// ============================================================
// THREE.JS SETUP
// ============================================================
let renderer, camera, controls, scene;
let keyLight, fillLight, rimLight, topLight, ambientLight;
let clock = new THREE.Clock();
let raycaster, mouse;
let isTouchEnabled = true;
let lastTouchTime = 0;
const TOUCH_DEBOUNCE_MS = 1000;

/**
 * Initialize Three.js scene
 */
export function initThreeJS() {
    // Initialize renderer
    renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: true 
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);

    // Initialize camera
    camera = new THREE.PerspectiveCamera(
        30.0,
        window.innerWidth / window.innerHeight,
        0.1,
        20.0
    );
    camera.position.set(0.0, 1.0, 4.5);

    // Initialize orbit controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE
    };
    controls.target.set(0.0, 1.0, 0.0);
    controls.update();
    
    // Expose camera and controls to window for web.js access
    window.camera = camera;
    window.controls = controls;
    console.log('[core] Camera and controls exposed to window');

    // Initialize scene
    scene = new THREE.Scene();
    scene.background = null;

    // Setup lighting
    keyLight = new THREE.DirectionalLight(0xffffff, 1);
    keyLight.position.set(3.0, 4.0, 5.0).normalize();
    scene.add(keyLight);

    fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    fillLight.position.set(-3.0, 3.0, 4.0).normalize();
    scene.add(fillLight);

    rimLight = new THREE.DirectionalLight(0xffffff, 1);
    rimLight.position.set(0.0, 2.0, -5.0).normalize();
    scene.add(rimLight);

    topLight = new THREE.DirectionalLight(0xffffff, 0.5);
    topLight.position.set(0.0, 5.0, 0.0).normalize();
    scene.add(topLight);

    ambientLight = new THREE.AmbientLight(0xffffff, 0);
    scene.add(ambientLight);

    // Initialize raycaster for touch detection
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    console.log('[core] Three.js initialized');
}

/**
 * Handle window resize
 */
export function handleResize() {
    if (isWindowDragging) return;
    
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Setup touch detection for model interaction
 */
export function setupTouchDetection() {
    if (!renderer) return;
    
    console.log('[touch] Setting up touch detection');
    
    let isMouseDown = false;
    let isTouching = false;
    
    // Mouse move handler - update raycaster
    renderer.domElement.addEventListener('mousemove', (event) => {
        if (!isTouchEnabled) return;
        
        // Calculate mouse position in normalized device coordinates (-1 to +1)
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        
        // Check debounce
        const now = Date.now();
        if (now - lastTouchTime < TOUCH_DEBOUNCE_MS) {
            return;
        }
        
        // Only trigger if left mouse button is down
        if (isMouseDown && currentVrm) {
            // Raycast from camera
            raycaster.setFromCamera(mouse, camera);
            
            // Check for intersections with VRM model
            const intersects = raycaster.intersectObject(currentVrm.scene, true);
            
            if (intersects.length > 0) {
                // User is touching the model
                if (!isTouching) {
                    isTouching = true;
                    handleTouchEvent(intersects[0]);
                }
            } else {
                isTouching = false;
            }
        }
    });
    
    // Mouse down handler
    renderer.domElement.addEventListener('mousedown', (event) => {
        if (event.button === 0) { // Left mouse button
            isMouseDown = true;
        }
    });
    
    // Mouse up handler
    renderer.domElement.addEventListener('mouseup', (event) => {
        if (event.button === 0) {
            isMouseDown = false;
            isTouching = false;
        }
    });
    
    // Mouse leave handler
    renderer.domElement.addEventListener('mouseleave', () => {
        isMouseDown = false;
        isTouching = false;
    });
    
    console.log('[touch] Touch detection initialized');
}

/**
 * Identify body part using spatial analysis of VRM humanoid bones
 * @param {Object} intersection - Raycaster intersection data
 * @returns {string} Human-readable body part name
 */
function identifyBodyPart(intersection) {
    if (!intersection || !intersection.object || !currentVrm || !currentVrm.humanoid) {
        return 'body';
    }
    
    // Get the intersection point in world space
    const touchPoint = intersection.point;
    console.log('[touch] Touch point:', touchPoint);
    
    // Transform touch point to local space of VRM scene
    const localPoint = touchPoint.clone();
    currentVrm.scene.worldToLocal(localPoint);
    
    console.log('[touch] Touch point in VRM local space:', localPoint);
    
    // Use Y coordinate (height) to determine body part
    // These thresholds are based on typical VRM humanoid proportions
    const y = localPoint.y;
    
    // Define height ranges for different body parts (adjust based on your VRM model)
    // Typical VRM model: height ~1.6-1.8 units
    const HEAD_THRESHOLD = 1.4;     // Above this is head
    const CHEST_THRESHOLD = 1.1;    // Above this is upper body
    const HIP_THRESHOLD = 0.7;      // Above this is lower body
    
    // Also check X coordinate to distinguish left/right sides if needed
    const x = localPoint.x;
    const isLeftSide = x < 0;
    const isRightSide = x >= 0;
    
    let bodyPart = 'body';
    
    if (y > HEAD_THRESHOLD) {
        bodyPart = 'head';
    } else if (y > CHEST_THRESHOLD) {
        bodyPart = 'chest';
    } else if (y > HIP_THRESHOLD) {
        bodyPart = 'hip';
    } else {
        bodyPart = 'leg';
    }
    
    console.log('[touch] Identified body part:', bodyPart, '(y:', y.toFixed(2), ', x:', x.toFixed(2), ')');
    
    return bodyPart;
}

/**
 * Handle touch event - play animation and send message to agent
 * @param {Object} intersection - Raycaster intersection data
 */
async function handleTouchEvent(intersection) {
    if (!currentVrm) return;
    
    const now = Date.now();
    if (now - lastTouchTime < TOUCH_DEBOUNCE_MS) {
        console.log('[touch] Touch event debounced');
        return;
    }
    
    lastTouchTime = now;
    console.log('[touch] Touch event triggered on model');
    
    try {
        // Identify which body part was touched with improved detection
        const bodyPart = identifyBodyPart(intersection);
        console.log('[touch] Touched body part:', bodyPart);
        
        // Step 1: Play touch animation (using sit.vrma for touch response)
        console.log('[touch] Playing touch animation...');
        statusDiv.textContent = 'Touch response...';
        
        // Load and play sit animation for touch response
        const touchAction = await startSmoothTransition(
            `${ASSET_BASE_URL}VRMA/sit.vrma`,
            { loopMode: THREE.LoopRepeat }
        );
        
        if (touchAction) {
            console.log('[touch] Touch animation playing');
            // Wait for animation to complete
            await new Promise(resolve => setTimeout(resolve, 3000));
            console.log('[touch] Touch animation completed');
        }
        
        // Step 2: Send message to agent
        const touchMessage = `User touched your ${bodyPart}`;
        console.log('[touch] Sending message to agent:', touchMessage);
        
        if (window.sendMessage) {
            // Disable messaging controls and set to thinking state
            if (window.disableMessaging) {
                window.disableMessaging();
            }
            if (window.setMessagingThinking) {
                window.setMessagingThinking();
            }
            
            // Generate unique request ID
            const requestId = 'touch-' + Date.now();
            const idempotencyKey = 'touch-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
            
            // Construct full message with touch context
            const fullMessage = `===== USER MESSAGE =====
${touchMessage}

===== SYSTEM INSTRUCTIONS =====
The user has just touched your ${bodyPart}. Respond naturally to this interaction.
You can use facial expressions and animations to respond.

AVAILABLE ANIMATIONS (and what they do):
- idle_loop: Continuous idle animation (default state)
- idle_airplane: Make airplane gesture with arm
- idle_shoot: Make shooting gesture with hand
- idle_sport: Do sports movements/stretching
- idle_stretch: Stretch body and limbs
- idle_vSign: Make V-sign with hand
- sit: Sit down on ground
- sitWave: Sit and wave to greet
- start_1standUp: Stand up from sitting position
- start_2turnAround: Turn around to face camera
- walk: Walk forward, gesture, walk back
- wave_both: Wave with both hands
- wave_left: Wave with left hand
- wave_right: Wave with right hand

AVAILABLE EXPRESSIONS:
- neutral (default state)
- happy
- sad
- angry
- surprised
- blink (single blink, then neutral)

RESPONSE FORMAT (JSON):
Please respond with a JSON object containing:
{
  'text': 'Your spoken response here',
  'animation': {
    'file': 'idle_loop.vrma',  // or null for no animation
    'timing': 'before'            // 'before', 'during', 'after', or null
  },
  'expression': {
    'name': 'happy',             // or null for no expression
    'timing': 'during'            // 'before', 'during', 'after', or null
  }
}

TIMING OPTIONS:
- 'before': play animation/expression BEFORE speaking
- 'during': play animation/expression WHILE speaking
- 'after': play animation/expression AFTER speaking completes
- null: no animation/expression needed (use defaults)

IMPORTANT: Do NOT use markdown code blocks (\`\`\`json or \`\`\`) around your JSON response. Just provide the raw JSON object directly.`;
            
            // Send request to OpenClaw agent
            window.sendMessage({
                type: 'req',
                id: requestId,
                method: 'agent',
                params: {
                    message: fullMessage,
                    sessionKey: 'main',
                    timeout: 60,
                    idempotencyKey: idempotencyKey
                }
            });
            
            console.log('[touch] Touch message sent to agent:', requestId);
        }
        
        // Step 3: Return to idle loop after animation
        console.log('[touch] Returning to idle loop');
        await loadIdleLoop();
        
    } catch (error) {
        console.error('[touch] Error handling touch event:', error);
        // Return to idle loop on error
        await loadIdleLoop();
    }
}

/**
 * Save camera settings to localStorage
 */
export function saveCameraSettings() {
    if (!camera || !controls) return;
    
    const settings = {
        position: {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z
        },
        target: {
            x: controls.target.x,
            y: controls.target.y,
            z: controls.target.z
        }
    };
    
    localStorage.setItem('camera_settings', JSON.stringify(settings));
    console.log('[camera] Camera settings saved:', settings);
}

/**
 * Load camera settings from localStorage
 */
export function loadCameraSettings() {
    try {
        const savedSettings = localStorage.getItem('camera_settings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            
            if (camera && controls) {
                // Restore camera position
                if (settings.position) {
                    camera.position.set(
                        settings.position.x,
                        settings.position.y,
                        settings.position.z
                    );
                }
                
                // Restore controls target
                if (settings.target) {
                    controls.target.set(
                        settings.target.x,
                        settings.target.y,
                        settings.target.z
                    );
                }
                
                controls.update();
                console.log('[camera] Camera settings loaded:', settings);
                return true;
            }
        }
    } catch (error) {
        console.warn('[camera] Failed to load camera settings:', error);
    }
    return false;
}

/**
 * Reset camera to default position
 */
export function resetCamera() {
    if (camera && controls) {
        camera.position.set(0.0, 1.0, 4.5);
        controls.target.set(0.0, 1.0, 0.0);
        controls.update();
        console.log('[camera] Camera reset to default');
    }
}

// ============================================================
// GLTF LOADER
// ============================================================
const loader = new GLTFLoader();
loader.crossOrigin = 'anonymous';
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

// ============================================================
// ASSET PATHS
// ============================================================
const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || '../';
const VRM_MODEL_URL = `${ASSET_BASE_URL}VRM/sample.vrm`;
const VRMA_ANIMATION_URLS = [
    `${ASSET_BASE_URL}VRMA/idle_loop.vrma`,
    `${ASSET_BASE_URL}VRMA/idle_airplane.vrma`,
    `${ASSET_BASE_URL}VRMA/idle_shoot.vrma`,
    `${ASSET_BASE_URL}VRMA/idle_sport.vrma`,
    `${ASSET_BASE_URL}VRMA/idle_stretch.vrma`,
    `${ASSET_BASE_URL}VRMA/idle_vSign.vrma`,
    `${ASSET_BASE_URL}VRMA/sit.vrma`,
    `${ASSET_BASE_URL}VRMA/sitWave.vrma`,
    `${ASSET_BASE_URL}VRMA/start_1standUp.vrma`,
    `${ASSET_BASE_URL}VRMA/start_2turnAround.vrma`,
    `${ASSET_BASE_URL}VRMA/walk.vrma`,
    `${ASSET_BASE_URL}VRMA/wave_both.vrma`,
    `${ASSET_BASE_URL}VRMA/wave_left.vrma`,
    `${ASSET_BASE_URL}VRMA/wave_right.vrma`
];

window.VRMA_ANIMATION_URLS = VRMA_ANIMATION_URLS;

// ============================================================
// DOM ELEMENTS INITIALIZATION
// ============================================================
export function initDOMElements() {
    animationSelect = document.getElementById('animationSelect');
    expressionSelect = document.getElementById('expressionSelect');
    statusDiv = document.getElementById('status');
    textInputPanel = document.getElementById('textInputPanel');
    speakBtnPanel = document.getElementById('speakBtnPanel');
    lipSyncPanel = document.getElementById('lipSyncPanel');
    historyPanel = document.getElementById('history-panel');
    
    console.log('[core] DOM elements initialized');
    
    // Add click listener to messaging panel to reset sit animation flag when user interacts
    if (lipSyncPanel) {
        lipSyncPanel.addEventListener('click', () => {
            if (isSitAnimationActive) {
                console.log('[sit] User clicked messaging panel, allowing panels to be shown again');
                isSitAnimationActive = false;
            }
        });
        
        // Also add listener to text input for focus events
        if (textInputPanel) {
            textInputPanel.addEventListener('focus', () => {
                if (isSitAnimationActive) {
                    console.log('[sit] User focused text input, allowing panels to be shown again');
                    isSitAnimationActive = false;
                }
            });
        }
    }
}

// ============================================================
// MESSAGING PANEL CONTROL
// ============================================================

/**
 * Hide messaging panel
 */
export function hideMessagingPanel() {
    if (lipSyncPanel) {
        lipSyncPanel.style.display = 'none';
        if (historyPanel) {
            historyPanel.style.display = 'none';
        }
        console.log('[messaging] Panel hidden');

    }
}

/**
 * Show messaging panel
 */
export function showMessagingPanel() {
    // Don't show messaging panel if sit animation is active
    if (isSitAnimationActive) {
        console.log('[messaging] Skipping showMessagingPanel - sit animation is active');
        return;
    }
    
    if (lipSyncPanel) {
        lipSyncPanel.style.display = 'flex';
        console.log('[messaging] Panel shown');
    }
}

/**
 * Disable messaging controls
 */
export function disableMessaging() {
    isMessagingDisabled = true;
    if (textInputPanel) {
        textInputPanel.disabled = true;
        textInputPanel.style.opacity = '0.5';
        textInputPanel.style.cursor = 'not-allowed';
    }
    if (speakBtnPanel) {
        speakBtnPanel.disabled = true;
        speakBtnPanel.style.opacity = '0.5';
        speakBtnPanel.style.cursor = 'not-allowed';
    }
    console.log('[messaging] Controls disabled');
}

/**
 * Enable messaging controls
 */
export function enableMessaging() {
    // Don't enable messaging if sit animation is active
    if (isSitAnimationActive) {
        console.log('[messaging] Skipping enableMessaging - sit animation is active');
        return;
    }
    
    isMessagingDisabled = false;
    if (textInputPanel) {
        textInputPanel.disabled = false;
        textInputPanel.style.opacity = '1';
        textInputPanel.style.cursor = 'auto';
    }
    if (speakBtnPanel) {
        speakBtnPanel.disabled = false;
        speakBtnPanel.style.opacity = '1';
        speakBtnPanel.style.cursor = 'auto';
    }
    console.log('[messaging] Controls enabled');
}

/**
 * Set messaging panel to thinking state
 */
export function setMessagingThinking() {
    if (textInputPanel && !isMessagingDisabled) {
        originalMessageText = textInputPanel.value;
        textInputPanel.value = 'Thinking...';
        console.log('[messaging] Set to thinking state');
    }
}

/**
 * Reset messaging panel after reply
 */
export function resetMessagingPanel() {
    if (textInputPanel && !isMessagingDisabled) {
        // Clear the textbox completely
        textInputPanel.value = '';
        originalMessageText = '';
        console.log('[messaging] Panel reset - textbox cleared');
    }
    
    // Also enable messaging controls after reply
    enableMessaging();
}

// ============================================================
// LIP SYNC SYSTEM
// ============================================================
export function createLipSyncSystem() {
    let isCurrentlyTalking = false;
    let mouthTarget = 'a';
    let mouthProgress = 0;
    let localCurrentExpression = '';
    let speakingSpeedMultiplier = 1.0;
    let isAgentCommandActive = false; // Track if agent command is executing

    const vowelShapes = {
        'a': 'aa', 'e': 'ee', 'i': 'ih', 'o': 'oh', 'u': 'oo'
    };

    const consonantShapes = {
        'b': 'b', 'p': 'p', 'm': 'm',
        'f': 'f', 'v': 'v',
        't': 't', 'd': 'd', 'n': 'n',
        's': 's', 'z': 'z', 'sh': 'sh', 'th': 'th',
        'l': 'l', 'r': 'r'
    };

    function textToMouthShapes(text) {
        const shapes = [];
        const vowels = 'aeiou';
        const currentText = text.toLowerCase();
        const hasChinese = /[\u4e00-\u9fff]/.test(currentText);

        if (hasChinese) {
            const chineseMouthMap = {
                '啊': 'aa', '阿': 'aa', '喔': 'oh', '哦': 'oh', '鹅': 'ee', '饿': 'ee',
                '我': 'oo', '沃': 'oo', '安': 'aa', '恩': 'ih', '嗯': 'ih',
                '一': 'ee', '衣': 'ee', '医': 'ee', '以': 'ih', '意': 'ih',
                '你': 'ih', '呢': 'ih', '了': 'l', '的': 'd', '地': 'd', '得': 'd',
                '是': 'sh', '不': 'b', '在': 'z', '有': 'ih', '就': 'ih',
                '他': 't', '她': 't', '它': 't', '谁': 'sh', '说': 'sh', '话': 'h',
                '来': 'l', '去': 'ch', '个': 'g', '和': 'h', '与': 'y',
                '你': 'ih', '我': 'oo', '他': 't', '她': 't', '它': 't',
                '中': 'jh', '国': 'g', '人': 'r', '大': 'd', '小': 'x'
            };

            for (let i = 0; i < currentText.length; i++) {
                const char = currentText[i];
                if (chineseMouthMap[char]) {
                    shapes.push(chineseMouthMap[char]);
                } else {
                    const randomShape = ['aa', 'ih', 'oh', 'oo'][Math.floor(Math.random() * 4)];
                    shapes.push(randomShape);
                }
            }
        } else {
            for (let i = 0; i < currentText.length; i++) {
                const char = currentText[i];
                const nextChar = currentText[i + 1] || '';
                const combined = char + nextChar;

                if (consonantShapes[combined]) {
                    shapes.push(consonantShapes[combined]);
                    i++;
                } else if (vowels.includes(char)) {
                    shapes.push(vowelShapes[char] || 'aa');
                } else if (consonantShapes[char]) {
                    shapes.push(consonantShapes[char]);
                } else if (char === ' ' || char === ',') {
                    shapes.push('neutral');
                } else {
                    shapes.push('neutral');
                }
            }

            for (let i = shapes.length - 1; i > 0; i--) {
                if (shapes[i] === 'neutral' && shapes[i - 1] === 'neutral') {
                    shapes.splice(i, 1);
                } else {
                    break;
                }
            }
            
            // SIMPLIFY: Only keep the first shape of each word to reduce flashing
            // This makes the lip sync much smoother and more natural
            const simplifiedShapes = [];
            for (let i = 0; i < shapes.length; i++) {
                if (shapes[i] !== 'neutral' && (i === 0 || shapes[i-1] === 'neutral')) {
                    simplifiedShapes.push(shapes[i]);
                }
            }
            return simplifiedShapes;
        }

        // Simplify Chinese as well - just take every other character to reduce shapes
        if (shapes.length > 2) {
            const simplifiedChinese = [];
            for (let i = 0; i < shapes.length; i += 2) {
                simplifiedChinese.push(shapes[i]);
            }
            return simplifiedChinese;
        }

        return shapes;
    }

    function applyMouthShape(vrm, shape) {
        if (!vrm?.expressionManager) return;

        const shapeToExpression = {
            'aa': 'aa', 'ee': 'ee', 'ih': 'ih', 'oh': 'oh', 'oo': 'oo',
            'b': 'b', 'p': 'p', 'm': 'm', 'f': 'f', 'v': 'v',
            't': 't', 'd': 'd', 'n': 'n', 's': 's', 'z': 'z',
            'sh': 'sh', 'th': 'th', 'l': 'l', 'r': 'r',
            'neutral': 'neutral'
        };

        const expressionName = shapeToExpression[shape] || 'neutral';
        const intensity = expressionName === 'neutral' ? 0 : 0.5;

        const allExpressions = ['aa', 'ee', 'ih', 'oh', 'oo', 'b', 'p', 'm', 'f', 'v', 't', 'd', 'n', 's', 'z', 'sh', 'th', 'l', 'r'];
        allExpressions.forEach(expr => {
            vrm.expressionManager.setValue(expr, 0);
        });

        vrm.expressionManager.setValue(expressionName, intensity);
    }

    function startSpeaking(text) {
        console.log('[lip] startSpeaking', text);
        isCurrentlyTalking = false;
        mouthTarget = 'neutral';
        updateDebugDisplay(text, 0);

        lipSyncActive = true;
        if (currentIdleTimeout) {
            clearTimeout(currentIdleTimeout);
            currentIdleTimeout = null;
            idleSuspended = true;
        }

        // Don't load idle loop in background if agent command is executing
        // This prevents idle loop from overriding agent animations
        if (!isAgentCommandActive) {
            loadIdleLoop().then(() => {
                console.log('[lip] idle loop loaded in background');
            }).catch(err => {
                console.warn('[lip] background idle load failed', err);
            });
        }

        localCurrentExpression = text;
        currentExpression = text;
        isCurrentlyTalking = true;

        // Split text by newlines and process each line separately
        const lines = text.split('\n').filter(line => line.trim() !== '');
        console.log('[lip] Text split into', lines.length, 'lines');
        
        // Process lines sequentially with a small pause between them
        processLinesSequentially(lines);
    }

    async function processLinesSequentially(lines) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            console.log('[lip] Speaking line', i + 1, 'of', lines.length, ':', line);
            
            // Show this line in the bubble
            showSpeakingBubble(line);
            
            // Speak this line
            await speakLine(line);
            
            // Small pause between lines (except after the last line)
            if (i < lines.length - 1) {
                console.log('[lip] Pausing between lines...');
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        // All lines finished
        isCurrentlyTalking = false;
        mouthTarget = 'neutral';
        lipSyncActive = false;
        hideSpeakingBubble();
        
        // Immediately reset facial expression to neutral after speech completes
        if (window.resetExpressionToNeutral) {
            window.resetExpressionToNeutral();
        }
        
        if (idleSuspended) {
            scheduleRandomIdle();
            idleSuspended = false;
        }
    }

    function speakLine(text) {
        return new Promise((resolve) => {
            console.log('[lip] Speaking line:', text);
            updateDebugDisplay(text, 0);

            const hasChinese = /[\u4e00-\u9fff]/.test(text);
            let units;
            let currentUnitIndex = 0;
            let speakingStartTime = performance.now(); // Track when speaking started
            
            // Calculate actual speaking duration based on shapes, not just character count
            let unitShapes = [];
            let totalShapes = 0;
            
            if (hasChinese) {
                units = text.split('').filter(char => char.trim() !== '');
            } else {
                units = text.split(' ').filter(word => word.length > 0);
            }
        
            // Pre-calculate shapes to get accurate duration
            units.forEach(unit => {
                const shapes = textToMouthShapes(unit);
                unitShapes.push(shapes);
                totalShapes += shapes.length;
            });
            
            // Actual duration: 80ms per shape + 50ms between units
            const speakingDuration = (totalShapes * 80) + (units.length * 50);
            
            // Use the same calculated duration for the timeout to ensure synchronization
            const maxDuration = speakingDuration / speakingSpeedMultiplier;
            
            console.log('[lip] units for speech', units, 'total shapes:', totalShapes, 'duration:', speakingDuration, 'max duration:', maxDuration);

            function processNextUnit() {
                if (currentUnitIndex >= units.length) {
                    // DON'T set isCurrentlyTalking to false here - let processLinesSequentially handle it
                    // This prevents premature resolution during line pauses
                    mouthTarget = 'neutral';
                    updateDebugDisplay(text, -1);
                    
                    // Ensure all characters are displayed before hiding bubble
                    const lastCharIndex = text.length - 1;
                    displayCharacterAtIndex(lastCharIndex);
                    
                    if (idleSuspended) {
                        scheduleRandomIdle();
                        idleSuspended = false;
                    }
                    resolve(); // Resolve the Promise when done
                    return;
                }

                const unit = units[currentUnitIndex];
                console.log('[lip] processing unit', currentUnitIndex, unit);

                if (hasChinese) {
                    updateDebugDisplay(text, currentUnitIndex, unit);
                } else {
                    updateDebugDisplay(text, currentUnitIndex);
                }

                // Use cached shapes to ensure consistency
                const mouthShapes = unitShapes[currentUnitIndex] || textToMouthShapes(unit);
                console.log('[lip] mouthShapes', mouthShapes);

                if (mouthShapes.length === 0) {
                    currentUnitIndex++;
                    // Much slower delay for empty units
                    setTimeout(processNextUnit, 400 / speakingSpeedMultiplier);
                    return;
                }

                let shapeIndex = 0;

                function processNextShape() {
                    if (shapeIndex >= mouthShapes.length) {
                        currentUnitIndex++;
                        updateDebugDisplay(text, -1);
                        // Extremely fast delay between units
                        setTimeout(processNextUnit, 50 / speakingSpeedMultiplier);
                        return;
                    }

                    const shape = mouthShapes[shapeIndex];
                    mouthTarget = shape;
                    shapeIndex++;

                    // Display characters progressively based on elapsed time
                    const elapsed = performance.now() - speakingStartTime;
                    const progressRatio = elapsed / speakingDuration;
                    const charIndex = Math.floor(progressRatio * text.length);
                    
                    displayCharacterAtIndex(Math.min(charIndex, text.length - 1));

                    // Extremely fast base duration for very quick speech (80ms per shape)
                    const baseDuration = 80;
                    const shapeDuration = baseDuration / speakingSpeedMultiplier;
                    setTimeout(processNextShape, shapeDuration);
                }

                processNextShape();
            }

            processNextUnit();
        });
    }

    function setSpeakingSpeed(multiplier) {
        console.log('[lip] setSpeakingSpeed', multiplier);
        speakingSpeedMultiplier = multiplier;
        return speakingSpeedMultiplier;
    }

    function getSpeakingSpeed() {
        return speakingSpeedMultiplier;
    }

    function updateDebugDisplay(text, unitIndex, currentUnit = null) {
        currentExpression = text;
        const hasChinese = /[\u4e00-\u9fff]/.test(text);

        if (unitIndex === -1) {
            statusDiv.textContent = 'Speaking complete';
            return;
        }

        if (hasChinese) {
            const characters = text.split('').filter(char => char.trim() !== '');
            const spokenText = characters.slice(0, unitIndex + 1).join('');
            const currentChar = currentUnit || characters[unitIndex];
            const remainingText = characters.slice(unitIndex + 1).join('');

            const debugText = `Speaking: ${spokenText}<span class="current-word">${currentChar}</span>${remainingText}`;
            statusDiv.innerHTML = debugText;
        } else {
            const words = text.split(' ').filter(word => word.length > 0);
            const debugText = `Speaking: ${words.slice(0, unitIndex + 1).join(' ')}<span class="current-word">${words[unitIndex]}</span>${words.slice(unitIndex + 1).join(' ')}`;
            statusDiv.innerHTML = debugText;
        }
    }

    function stopSpeaking() {
        isCurrentlyTalking = false;
        mouthTarget = 'neutral';
    }

    function update(vrm, delta) {
        if (!vrm?.expressionManager) return;

        if (isCurrentlyTalking) {
            applyMouthShape(vrm, mouthTarget);
        } else {
            const expressions = ['aa', 'ee', 'ih', 'oh', 'oo', 'b', 'p', 'm', 'f', 'v', 't', 'd', 'n', 's', 'z', 'sh', 'th', 'l', 'r'];

            expressions.forEach(expr => {
                const currentValue = vrm.expressionManager.getValue(expr);
                if (currentValue > 0.01) {
                    const newValue = Math.max(0, currentValue - delta * 4);
                    vrm.expressionManager.setValue(expr, newValue);
                }
            });

            vrm.expressionManager.setValue('neutral', 0);
        }
    }

    return {
        update,
        startSpeaking,
        stopSpeaking,
        setSpeakingSpeed,
        getSpeakingSpeed,
        isTalking: () => isCurrentlyTalking,
        setAgentCommandActive: (active) => { isAgentCommandActive = active; }
    };
}

// ============================================================
// BLINK SYSTEM
// ============================================================
export function createBlinkSystem() {
    let isBlinking = false;
    let blinkProgress = 0;
    let timeSinceLastBlink = 0;

    const BLINK_DURATION = 0.2;
    const MIN_BLINK_INTERVAL = 1;
    const MAX_BLINK_INTERVAL = 6;

    let nextBlinkTime = Math.random() * (MAX_BLINK_INTERVAL - MIN_BLINK_INTERVAL) + MIN_BLINK_INTERVAL;

    function update(vrm, delta) {
        if (!vrm?.expressionManager) return;

        if (!blinkSystemEnabled || activeFacialExpression) {
            const allPossibleBlinkExpressions = [
                'blink', 'blinkLeft', 'blinkRight', 'Lblink', 'Rblink',
                'eyeBlink', 'blink_l', 'blink_r', 'blinking',
                'Blink', 'EYE_BLINK', 'BLINK'
            ];

            allPossibleBlinkExpressions.forEach(expr => {
                try {
                    if (vrm.expressionManager && typeof vrm.expressionManager.setValue === 'function') {
                        vrm.expressionManager.setValue(expr, 0);
                    }
                } catch (e) {}
            });

            isBlinking = false;
            blinkProgress = 0;
            timeSinceLastBlink = nextBlinkTime * 2;

            return;
        }

        timeSinceLastBlink += delta;

        if (!isBlinking && timeSinceLastBlink >= nextBlinkTime) {
            isBlinking = true;
            blinkProgress = 0;
        }

        if (isBlinking) {
            blinkProgress += delta / BLINK_DURATION;

            const blinkValue = Math.sin(Math.PI * blinkProgress);
            vrm.expressionManager.setValue('blink', blinkValue);

            if (blinkProgress >= 1) {
                isBlinking = false;
                blinkProgress = 0;
                timeSinceLastBlink = 0;
                vrm.expressionManager.setValue('blink', 0);
                nextBlinkTime = Math.random() * (MAX_BLINK_INTERVAL - MIN_BLINK_INTERVAL) + MIN_BLINK_INTERVAL;
            }
        }
    }

    function reset() {
        isBlinking = false;
        blinkProgress = 0;
        timeSinceLastBlink = nextBlinkTime * 2;
    }

    return {
        update,
        reset,
        get isBlinking() { return isBlinking; },
        set isBlinking(val) { isBlinking = !!val; }
    };
}

// ============================================================
// SPEAKING BUBBLE
// ============================================================
let speakingBubble, currentSpeakingText = '', bubbleVisible = false;
let cachedHeadBone = null, headBoneWarningLogged = false;
let bubbleHideTimer = null;
let currentDisplayedText = '';
let currentWordIndex = 0;
let words = [];
let wordDisplayTimer = null;

export function initSpeakingBubble() {
    speakingBubble = document.createElement('div');
    speakingBubble.id = 'speakingBubble';
    speakingBubble.style.position = 'fixed';
    speakingBubble.style.display = 'none';
    speakingBubble.style.background = 'rgba(0, 0, 0, 0.9)';
    speakingBubble.style.color = 'white';
    speakingBubble.style.padding = '12px 16px';
    speakingBubble.style.borderRadius = '12px';
    speakingBubble.style.fontFamily = 'Arial, sans-serif';
    speakingBubble.style.fontSize = '16px';
    speakingBubble.style.lineHeight = '1.4';
    speakingBubble.style.maxWidth = '300px';
    speakingBubble.style.pointerEvents = 'none';
    speakingBubble.style.zIndex = '999999';
    speakingBubble.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
    speakingBubble.style.transform = 'translate(-50%, 0)';
    speakingBubble.style.marginTop = '80px';
    speakingBubble.style.border = '1px solid rgba(255, 255, 255, 0.2)';
    speakingBubble.style.transition = 'opacity 0.3s ease-in-out';
    speakingBubble.style.opacity = '0';

    document.body.appendChild(speakingBubble);
    
    console.log('[bubble] Bubble added to DOM');
}

function updateSpeakingBubblePosition() {
    if (!currentVrm || !bubbleVisible) return;

    try {
        if (!cachedHeadBone) {
            // Try multiple possible bone names that different VRM models might use
            const possibleBoneNames = [
                'Head',
                'head',
                'neck',
                'headTop'
            ];
            
            for (const boneName of possibleBoneNames) {
                cachedHeadBone = currentVrm.humanoid.getNormalizedBoneNode(boneName);
                if (cachedHeadBone) {
                    console.log(`[bubble] Found head bone: ${boneName}`);
                    break;
                }
            }
            
            // If still not found, try getting from humanoid bones directly
            if (!cachedHeadBone && currentVrm.humanoid?.bones) {
                for (const bone of currentVrm.humanoid.bones) {
                    if (bone && (bone.name.toLowerCase().includes('head') || bone.name.toLowerCase().includes('neck'))) {
                        cachedHeadBone = bone;
                        console.log(`[bubble] Found head bone from humanoid: ${bone.name}`);
                        break;
                    }
                }
            }

            if (!cachedHeadBone && !headBoneWarningLogged) {
                console.warn('[bubble] Head bone not found, using default position');
                console.log('[bubble] Available bones:', currentVrm.humanoid?.bones?.map(b => b.name));
                headBoneWarningLogged = true;
            }
        }

        if (!cachedHeadBone) {
            speakingBubble.style.left = '50%';
            speakingBubble.style.top = '40%';
            return;
        }

        const headPosition = new THREE.Vector3();
        cachedHeadBone.getWorldPosition(headPosition);
        
        const screenPosition = headPosition.clone().project(camera);
        
        const x = (screenPosition.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-(screenPosition.y * 0.5) + 0.5) * window.innerHeight;
        
        speakingBubble.style.left = `${x}px`;
        speakingBubble.style.top = `${y}px`;
    } catch (e) {
        console.error('[bubble] failed to update position:', e);
        speakingBubble.style.left = '50%';
        speakingBubble.style.top = '40%';
    }
}

function clearCachedHeadBone() {
    cachedHeadBone = null;
    headBoneWarningLogged = false;
}

export function showSpeakingBubble(text) {
    clearCachedHeadBone();
    
    // Clear previous content when showing new message
    speakingBubble.textContent = '';
    currentDisplayedText = '';
    
    currentSpeakingText = text;
    bubbleVisible = true;
    
    speakingBubble.style.setProperty('display', 'block', 'important');
    
    speakingBubble.style.left = '50%';
    speakingBubble.style.top = '40%';
    
    updateSpeakingBubblePosition();
    
    // Zoom camera to head when bubble appears (web version only)
    if (window.camera && window.controls && !window.electronAPI) {
        console.log('[bubble] ========== BUBBLE SHOW - CAMERA ZOOM START ==========');
        
        // Store original camera position if not already stored
        if (!window.originalCameraPosition || !window.originalCameraTarget) {
            window.originalCameraPosition = window.camera.position.clone();
            window.originalCameraTarget = window.controls.target.clone();
            console.log('[bubble] Stored original camera position:', window.originalCameraPosition);
        }
        
        // Animate camera zoom to head
        const startPos = window.camera.position.clone();
        const startTarget = window.controls.target.clone();
        const endPos = new THREE.Vector3(0.0, 1.4, 2.5); // Further back and slightly lower
        const endTarget = new THREE.Vector3(0.0, 1.4, 0.0);
        const duration = 300; // 300ms transition
        const startTime = Date.now();
        
        function animateCameraZoom() {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3); // Ease out cubic
            
            window.camera.position.lerpVectors(startPos, endPos, eased);
            window.controls.target.lerpVectors(startTarget, endTarget, eased);
            window.controls.update();
            
            if (progress < 1) {
                requestAnimationFrame(animateCameraZoom);
            } else {
                console.log('[bubble] Camera zoom complete');
            }
        }
        
        animateCameraZoom();
        console.log('[bubble] ========== BUBBLE SHOW - CAMERA ZOOM COMPLETE ==========');
    }
    
    // Fade in effect
    requestAnimationFrame(() => {
        speakingBubble.style.opacity = '1';
    });
    
    // Split text into characters (works for both English and Chinese)
    currentWordIndex = 0;
    words = text.split(''); // Split into individual characters
    
    // Display first character immediately
    if (words.length > 0) {
        displayCharacterAtIndex(0);
    }
}

export function hideSpeakingBubble() {
    // Clear any existing hide timer
    if (bubbleHideTimer) {
        clearTimeout(bubbleHideTimer);
    }
    
    // Clear word display timer
    if (wordDisplayTimer) {
        clearTimeout(wordDisplayTimer);
    }
    
    // Keep bubble visible for a few seconds after lip sync finishes
    bubbleHideTimer = setTimeout(() => {
        speakingBubble.style.opacity = '0';
        
        // Restore camera position when bubble actually fades out (web version only)
        if (window.camera && window.controls && window.originalCameraPosition && window.originalCameraTarget && !window.electronAPI) {
            console.log('[bubble] ========== BUBBLE FADE OUT - CAMERA RESTORE START ==========');
            
            // Smoothly restore camera to original position
            const startPos = window.camera.position.clone();
            const startTarget = window.controls.target.clone();
            const endPos = window.originalCameraPosition;
            const endTarget = window.originalCameraTarget;
            const duration = 500; // 500ms transition
            const startTime = Date.now();
            
            function animateCameraRestore() {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3); // Ease out cubic
                
                window.camera.position.lerpVectors(startPos, endPos, eased);
                window.controls.target.lerpVectors(startTarget, endTarget, eased);
                window.controls.update();
                
                if (progress < 1) {
                    requestAnimationFrame(animateCameraRestore);
                } else {
                    // Clear stored positions
                    window.originalCameraPosition = null;
                    window.originalCameraTarget = null;
                    console.log('[bubble] Camera restored');
                }
            }
            
            animateCameraRestore();
            console.log('[bubble] ========== BUBBLE FADE OUT - CAMERA RESTORE COMPLETE ==========');
        }
        
        setTimeout(() => {
            bubbleVisible = false;
            speakingBubble.style.display = 'none';
            currentSpeakingText = '';
            currentDisplayedText = '';
            words = [];
            currentWordIndex = 0;
        }, 300); // Wait for fade out animation
    }, 3000); // Stay visible for 3 seconds
}

// Export function to be called by lip sync system - displays character by character
export function displayCharacterAtIndex(charIndex) {
    if (!bubbleVisible || charIndex < 0) {
        return;
    }
    
    // Ensure charIndex is within bounds
    if (charIndex >= words.length) {
        charIndex = words.length - 1;
    }
    
    // Display all characters up to this index
    const displayedChars = words.slice(0, charIndex + 1);
    currentDisplayedText = displayedChars.join('');
    speakingBubble.textContent = currentDisplayedText;
    
    currentWordIndex = charIndex;
}

// Export character count for lip sync system to use
export function getWordCount() {
    return words.length;
}

export function updateSpeakingBubbleText(text) {
    if (bubbleVisible) {
        speakingBubble.textContent = text;
    }
}

// ============================================================
// VRM LOADING
// ============================================================
export async function loadVRM(url) {
    try {
        statusDiv.textContent = 'Loading VRM model...';

        return new Promise((resolve, reject) => {
            loader.load(
                url,
                (gltf) => {
                    const vrm = gltf.userData.vrm;

                    VRMUtils.removeUnnecessaryVertices(gltf.scene);
                    VRMUtils.combineSkeletons(gltf.scene);
                    VRMUtils.combineMorphs(vrm);

                    vrm.scene.traverse((obj) => {
                        obj.frustumCulled = false;
                    });

                    if (currentVrm) {
                        scene.remove(currentVrm.scene);
                        currentVrm.dispose();
                    }

                    scene.add(vrm.scene);
                    vrm.scene.rotation.y = Math.PI;
                    currentVrm = vrm;

                    if (currentVrm.springBoneManager) {
                        currentVrm.springBoneManager.update(0);
                        if (typeof currentVrm.springBoneManager.reset === 'function') {
                            currentVrm.springBoneManager.reset();
                        }
                        if (typeof currentVrm.springBoneManager.setGravityFactor === 'function') {
                            currentVrm.springBoneManager.setGravityFactor(0.5);
                        }
                        if (typeof currentVrm.springBoneManager.setDragForceFactor === 'function') {
                            currentVrm.springBoneManager.setDragForceFactor(0.3);
                        }
                        console.log('[vrm] Spring bone physics enabled');
                    }

                    currentMixer = new THREE.AnimationMixer(vrm.scene);

                    statusDiv.textContent = 'VRM model loaded successfully!';
                    console.log('VRM loaded:', vrm);

                    // Hide loading GIF after VRM loads
                    hideLoadingGif();

                    resolve(vrm);
                },
                (progress) => {
                    const percent = parseFloat((100.0 * (progress.loaded / progress.total)).toFixed(1));
                    statusDiv.textContent = `Loading VRM model... ${percent}%`;
                },
                (error) => {
                    console.error('Error loading VRM:', error);
                    statusDiv.textContent = 'Error loading VRM model';
                    reject(error);
                }
            );
        });
    } catch (error) {
        console.error('Error in loadVRM:', error);
        statusDiv.textContent = 'Error loading VRM model';
    }
}

// ============================================================
// ANIMATION SYSTEM
// ============================================================
export function waitForActionEnd(action, maxWait = 15000, resetPose = false) {
    return new Promise(resolve => {
        let finished = false;
        
        const handler = (e) => {
            if (e.action === action) {
                finished = true;
                currentMixer.removeEventListener('finished', handler);
                clearTimeout(timer);
                
                if (resetPose && currentVrm) {
                    currentVrm.humanoid.resetNormalizedPose();
                }
                resolve(true);
            }
        };
        currentMixer.addEventListener('finished', handler);

        const timer = setTimeout(() => {
            if (!finished) {
                currentMixer.removeEventListener('finished', handler);
                console.warn('[seq] waitForActionEnd timeout for action', action);
                resolve(false);
            }
        }, maxWait);
    });
}

export async function startSmoothTransition(url, { loopMode = THREE.LoopRepeat, startOffset = CONFIG.T_OFFSET, resetPose = false, transitionTime = CONFIG.TRANSITION_TIME } = {}) {
    if (!currentVrm) return null;

    isTransitioning = true;
    transitionStartTime = performance.now();
    transitionDuration = transitionTime;

    try {
        const gltf = await loader.loadAsync(url);
        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];

        if (vrmAnimationData) {
            const toClip = createVRMAnimationClip(vrmAnimationData, currentVrm);

            if (toClip) {
                vrmaAnimationClip = toClip;
                isIdleMode = false;

                await blendToAnimation(toClip, loopMode, startOffset, resetPose, transitionTime);

                setTimeout(() => {
                    isTransitioning = false;
                }, 300);

                return currentAction;
            }
        }
    } catch (e) {
        console.error('[transition] failed to load animation', url, e);
    }

    return null;
}

function blendToAnimation(targetClip, loopMode = THREE.LoopRepeat, startOffset = CONFIG.T_OFFSET, resetPose = false, transitionTime = CONFIG.TRANSITION_TIME) {
    if (resetPose && currentVrm) {
        currentVrm.humanoid.resetNormalizedPose();
        currentMixer.update(0);
    }

    const nextAction = currentMixer.clipAction(targetClip);
    nextAction.setLoop(loopMode);
    nextAction.clampWhenFinished = (loopMode !== THREE.LoopRepeat);
    nextAction.enabled = true;
    nextAction.weight = 1;
    nextAction.setEffectiveWeight(1);
    nextAction.setEffectiveTimeScale(1);
    nextAction.reset();
    nextAction.time = startOffset;
    nextAction.play();

    if (currentAction && currentAction !== nextAction) {
        nextAction.crossFadeFrom(currentAction, transitionTime, true);
        
        const prev = currentAction;
        setTimeout(() => {
            prev.stop();
        }, transitionTime * 1000);
    }

    currentMixer.update(0);

    currentAction = nextAction;
    return Promise.resolve(currentAction);
}

export async function loadIdleLoop() {
    if (!currentVrm) return false;
    console.log('[idle] loadIdleLoop called');

    try {
        statusDiv.textContent = 'Loading: Idle loop...';
        isIdleMode = true;

        const idleUrl = `${ASSET_BASE_URL}VRMA/idle_loop.vrma`;
        const gltf = await loader.loadAsync(idleUrl);
        console.log('[idle] gltf loaded for idle loop', gltf);
        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];

        if (vrmAnimationData) {
            const baseClip = createVRMAnimationClip(vrmAnimationData, currentVrm);
            console.log('[idle] baseClip created', baseClip);

            if (baseClip) {
                vrmaAnimationClip = baseClip;
                await blendToAnimation(baseClip, THREE.LoopRepeat, 0);

                statusDiv.textContent = 'Idle loop started automatically';
                console.log('[idle] idle loop playing');
                return true;
            }
        }
        console.warn('[idle] no VRM animation data found in idle loop gltf');
        return false;
    } catch (error) {
        console.error('[idle] Error loading idle loop:', error);
        statusDiv.textContent = 'Failed to load idle loop';
        return false;
    }
}

export async function loadVRMA(url) {
    if (!currentVrm) {
        statusDiv.textContent = 'VRM model not loaded. Please load VRM model first.';
        return;
    }

    try {
        statusDiv.textContent = 'Loading VRMA animation...';

        return new Promise((resolve, reject) => {
            loader.load(
                url,
                (gltf) => {
                    console.log('GLTF loaded (VRMA):', gltf);

                    const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];

                    if (vrmAnimationData) {
                        const clip = createBlendAnimation(vrmAnimationData, currentVrm);

                        if (clip) {
                            vrmaAnimationClip = clip;

                            const isIdleAnimation = url.includes('idle_loop.vrma');

                            if (isIdleAnimation) {
                                isIdleMode = true;
                                statusDiv.textContent = 'Idle loop animation loaded!';

                                try {
                                    currentAction = currentMixer.clipAction(clip);
                                    currentAction.setLoop(THREE.LoopRepeat);
                                    currentAction.play();
                                    statusDiv.textContent += ' - Auto-playing...';
                                } catch (idleError) {
                                    console.error('Error playing idle animation:', idleError);
                                    statusDiv.textContent += ' - Playback error: ' + idleError.message;
                                }
                            } else {
                                isIdleMode = false;
                                statusDiv.textContent = 'Animation loaded!';
                            }

                            console.log('Generated AnimationClip:', vrmaAnimationClip);
                            console.log('Is idle animation:', isIdleAnimation);

                            resolve(vrmaAnimationClip);
                        }
                    } else {
                        throw new Error('Could not create AnimationClip from VRMA data.');
                    }
                },
                (progress) => {
                    const percent = (100.0 * (progress.loaded / progress.total)).toFixed(1);
                    statusDiv.textContent = `Loading VRMA animation... ${percent}%`;
                },
                (error) => {
                    console.error('Error loading animation:', error);
                    statusDiv.textContent = 'Error loading animation file: ' + error.message;
                    reject(error);
                }
            );
        });
    } catch (error) {
        console.error('Error in loadVRMA:', error);
        statusDiv.textContent = 'Error loading animation file';
    }
}

function createBlendAnimation(targetClip, blendDuration = 0.3) {
    if (!currentVrm) return targetClip;

    const bufferSize = CONFIG.BUFFER_TIME;
    const totalDuration = targetClip.duration;
    const visibleDuration = totalDuration - (2 * bufferSize);

    if (visibleDuration <= 0) {
        console.warn(`Clip too short to buffer: ${totalDuration}s`);
        return targetClip;
    }

    const currentPoseTracks = [];

    if (currentVrm && currentVrm.scene) {
        currentVrm.scene.traverse((child) => {
            if (child.isBone || child.isSkinnedMesh) {
                const position = new THREE.Vector3();
                const quaternion = new THREE.Quaternion();
                const scale = new THREE.Vector3();

                child.getWorldPosition(position);
                child.getWorldQuaternion(quaternion);
                child.getWorldScale(scale);

                currentPoseTracks.push(new THREE.VectorKeyframeTrack(
                    `${child.uuid}.position`,
                    [0, blendDuration, visibleDuration],
                    [position.x, position.y, position.z, position.x, position.y, position.z]
                ));

                currentPoseTracks.push(new THREE.QuaternionKeyframeTrack(
                    `${child.uuid}.quaternion`,
                    [0, blendDuration, visibleDuration],
                    [quaternion.x, quaternion.y, quaternion.z, quaternion.w, quaternion.x, quaternion.y, quaternion.z, quaternion.w]
                ));
            }
        });
    }

    const duration = Math.max(targetClip.duration, blendDuration);
    const blendClip = new THREE.AnimationClip('blend', duration, [
        ...currentPoseTracks,
        ...targetClip.tracks.slice(0, 6)
    ]);

    return blendClip;
}

// ============================================================
// FACIAL EXPRESSIONS
// ============================================================

/**
 * Reset facial expression to neutral
 * Used after animations complete to clear expressions
 */
export function resetExpressionToNeutral() {
    if (!currentVrm?.expressionManager) return;
    
    console.log('[expression] Resetting to neutral');
    activeFacialExpression = null;
    blinkSystemEnabled = true;
    
    applyFacialExpression('neutral');
}

export function applyFacialExpression(expression) {
    if (!currentVrm?.expressionManager) return;

    if (expression === 'neutral') {
        activeFacialExpression = null;
        blinkSystemEnabled = true;
    } else {
        activeFacialExpression = expression;
        blinkSystemEnabled = false;
    }

    const allPossibleBlinkExpressions = [
        'blink', 'blinkLeft', 'blinkRight', 'Lblink', 'Rblink',
        'eyeBlink', 'blink_l', 'blink_r', 'blinking',
        'Blink', 'EYE_BLINK', 'BLINK'
    ];

    allPossibleBlinkExpressions.forEach(expr => {
        try {
            if (currentVrm.expressionManager && typeof currentVrm.expressionManager.setValue === 'function') {
                currentVrm.expressionManager.setValue(expr, 0);
            }
        } catch (e) {}
    });

    const allExpressions = [
        'aa', 'ee', 'ih', 'oh', 'oo', 'b', 'p', 'm', 'f', 'v', 't', 'd', 'n', 's', 'z', 'sh', 'th', 'l', 'r',
        'neutral', 'happy', 'sad', 'angry', 'surprised', 'blink',
        'joy', 'fun', 'worry', 'aoi', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight'
    ];

    allExpressions.forEach(expr => {
        try {
            currentVrm.expressionManager.setValue(expr, 0);
        } catch (e) {}
    });

    const expressionMap = {
        'neutral': 'neutral',
        'happy': 'happy',
        'sad': 'sad',
        'angry': 'angry',
        'surprised': 'surprised',
        'blink': 'blink'
    };

    const vrmExpression = expressionMap[expression];

    if (vrmExpression) {
        if (expression === 'blink') {
            currentVrm.expressionManager.setValue('blink', 1);
            setTimeout(() => {
                allExpressions.forEach(expr => {
                    try {
                        currentVrm.expressionManager.setValue(expr, 0);
                    } catch (e) {}
                });
                activeFacialExpression = null;
            }, 200);
        } else {
            const intensity = 1.0;
            currentVrm.expressionManager.setValue(vrmExpression, intensity);
        }
    }
}

// ============================================================
// RANDOM IDLE SYSTEM
// ============================================================
export function beginRandomIdleSelection() {
    scheduleRandomIdle();
}

function scheduleRandomIdle() {
    if (currentIdleTimeout) {
        clearTimeout(currentIdleTimeout);
    }

    const delay = Math.random() * (CONFIG.RANDOM_IDLE_MAX_DELAY - CONFIG.RANDOM_IDLE_MIN_DELAY) + CONFIG.RANDOM_IDLE_MIN_DELAY;
    console.log('[idle] scheduling random idle in', delay, 'ms');
    currentIdleTimeout = setTimeout(playRandomIdle, delay);
}

// ============================================================
// ANIMATION LOOP
// ============================================================
let lipSyncSystem, blinkSystem;

export function initSystems() {
    lipSyncSystem = createLipSyncSystem();
    blinkSystem = createBlinkSystem();
    
    // Expose core functions to window for WebSocket access
    window.lipSyncSystem = lipSyncSystem;
    window.applyFacialExpression = applyFacialExpression;
    window.loadVRMA = loadVRMA;
    window.startSmoothTransition = startSmoothTransition;
    window.loadIdleLoop = loadIdleLoop;
    window.resetExpressionToNeutral = resetExpressionToNeutral;
    
    // Store internal references for speed control
    window._internalLipSync = lipSyncSystem;
}

export function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();

    if (currentVrm) {
        currentVrm.update(deltaTime);

        if (blinkSystem) {
            blinkSystem.update(currentVrm, deltaTime);
        }

        if (lipSyncSystem) {
            lipSyncSystem.update(currentVrm, deltaTime);

            if (!lipSyncSystem.isTalking() && activeFacialExpression && activeFacialExpression !== 'blink') {
                activeFacialExpression = null;
                blinkSystemEnabled = true;
            }

            updateSpeakingBubblePosition();

            if (activeFacialExpression) {
                const allPossibleBlinkExpressions = [
                    'blink', 'blinkLeft', 'blinkRight', 'Lblink', 'Rblink',
                    'eyeBlink', 'blink_l', 'blink_r', 'blinking',
                    'Blink', 'EYE_BLINK', 'BLINK'
                ];

                allPossibleBlinkExpressions.forEach(expr => {
                    try {
                        if (currentVrm.expressionManager && typeof currentVrm.expressionManager.setValue === 'function') {
                            currentVrm.expressionManager.setValue(expr, 0);
                        }
                    } catch (e) {}
                });
            }
        }

        if (isTransitioning && currentAction) {
            const elapsed = (performance.now() - transitionStartTime) / 1000;
            if (elapsed >= transitionDuration) {
                isTransitioning = false;
            }
        }
    }

    if (currentMixer) {
        currentMixer.update(deltaTime);
    }

    controls.update();
    renderer.render(scene, camera);
}

// ============================================================
// LOADING GIF CONTROL
// ============================================================
let loadingGif = null;
let loadingStartTime = 0;
const MIN_LOADING_TIME = 4000; // Extended by 1 second (was 3000)

function showLoadingGif() {
    if (loadingGif && loadingGif.parentElement) {
        loadingGif.remove();
    }
    
    loadingStartTime = performance.now();
    
    loadingGif = document.createElement('div');
    loadingGif.id = 'loadingGif';
    loadingGif.style.position = 'fixed';
    loadingGif.style.top = '0';
    loadingGif.style.left = '0';
    loadingGif.style.width = '100vw';
    loadingGif.style.height = '100vh';
    loadingGif.style.zIndex = '10000';
    loadingGif.style.display = 'block';
    loadingGif.style.opacity = '1';
    loadingGif.style.transition = 'opacity 1s ease-out';
    
    // Try to load from assets directory first, fall back to root
    const loadingGifUrl = `${ASSET_BASE_URL}loading.gif`;
    
    // Create image to check if loading.gif exists
    const img = new Image();
    img.onload = () => {
        loadingGif.style.background = `url('${loadingGifUrl}') no-repeat center center`;
        loadingGif.style.backgroundSize = 'cover';
    };
    img.onerror = () => {
        // Fallback to root if assets version doesn't work
        loadingGif.style.background = "url('/loading.gif') no-repeat center center";
        loadingGif.style.backgroundSize = 'cover';
    };
    img.src = loadingGifUrl;
    
    document.body.appendChild(loadingGif);
}

function hideLoadingGif() {
    const elapsed = performance.now() - loadingStartTime;
    const remainingTime = Math.max(0, MIN_LOADING_TIME - elapsed);
    
    setTimeout(() => {
        if (loadingGif) {
            loadingGif.style.opacity = '0';
            
            setTimeout(() => {
                if (loadingGif && loadingGif.parentElement) {
                    loadingGif.remove();
                    loadingGif = null;
                }
            }, 1000);
        }
    }, remainingTime);
}

// ============================================================
// WALK SEQUENCE SYSTEM
// ============================================================

/**
 * Electron-specific walk sequence (horizontal walking - left/right)
 * This is the original walking behavior for Electron app
 * @param {string} vrmaUrl - URL of walk animation file
 */
export async function runElectronWalkSequence(vrmaUrl) {
    if (!currentVrm || isPlayingWalkSequence) return;

    try {
        console.log('[walk-electron] runElectronWalkSequence start', vrmaUrl);
        isPlayingWalkSequence = true;

        // Hide all panels during walk animation
        if (window.hideAllPanels) {
            window.hideAllPanels();
        }

        if (currentIdleTimeout) {
            clearTimeout(currentIdleTimeout);
            currentIdleTimeout = null;
        }
        idleSuspended = true;

        const walkTimeScale = CONFIG.WALK_TIME_SCALE;

        let walkingDirection = 'right'; // Default
        let windowX = 0;
        
        if (window.electronAPI) {
            try {
                walkingWindowInitialPos = await window.electronAPI.getWindowPosition();
                windowX = walkingWindowInitialPos.x;
                
                // Get screen width to determine direction
                const windowBounds = await window.electronAPI.getWindowBounds();
                const screenWidth = window.screen ? window.screen.width : window.innerWidth;
                const screenCenter = screenWidth / 2;
                
                // Determine if window is on left or right side
                const windowCenterX = windowX + (windowBounds.width / 2);
                walkingDirection = windowCenterX < screenCenter ? 'right' : 'left';
                
                console.log('[walk-electron] window center:', windowCenterX, 'screen center:', screenCenter, 'walking:', walkingDirection);
            } catch (e) {
                console.warn('[walk-electron] failed to get window position:', e);
                walkingWindowInitialPos = { x: 0, y: 0 };
            }
        }

        walkingPathActive = true;
        const nowSec = performance.now() / 1000;
        walkingStartTimeSec = nowSec + CONFIG.WALK_START_DELAY;
        walkingInitialPos.copy(currentVrm.scene.position);
        walkingInitialRotY = currentVrm.scene.rotation.y;

        const leg = CONFIG.WALK_WALK_DURATION;
        const turn = CONFIG.WALK_TURN_DURATION;
        walkingTotalDurationSec = 2 * turn;

        console.log('[walk-electron] timing config', {
            startDelay: CONFIG.WALK_START_DELAY,
            direction: walkingDirection,
            leg,
            turn,
            totalPathSeconds: walkingTotalDurationSec,
        });

        // Wait before starting walk animation
        console.log('[walk-electron] waiting before starting clip...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.WALK_START_DELAY * 1000));

        // --- Initial turn to face walking direction ---
        console.log('[walk-electron] turning to face', walkingDirection, ', duration (ms)', turn * 1000);
        let action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk-electron] failed to set time scale for initial turn', e);
            }
        }
        await animateElectronWalkPhase(0, turn, 'initial_turn', walkingDirection);

        // --- Walk phase ---
        console.log('[walk-electron] starting', walkingDirection, 'walk clip (LoopRepeat)');
        action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk-electron] failed to set time scale for walk leg', e);
            }
        }
        console.log('[walk-electron]', walkingDirection, 'leg duration (ms)', leg * 1000);
        await animateElectronWalkPhase(turn, turn + leg, 'walk', walkingDirection);

        // --- Turn to face forward ---
        console.log('[walk-electron] turning to face forward, duration (ms)', turn * 1000);
        action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk-electron] failed to set time scale for turn to forward', e);
            }
        }
        await animateElectronWalkPhase(turn + leg, turn + leg + turn, 'turn_to_forward', walkingDirection);

        // Stop path driving (keep current position, don't reset)
        walkingPathActive = false;
        console.log('[walk-electron] finished, keeping current position and rotation');

        // Transition back to idle loop (no vSign animation)
        console.log('[walk-electron] calling loadIdleLoop at end of sequence');
        await loadIdleLoop();
        
        // REMOVED: Don't auto-restore panels after walk animation
    } finally {
        console.log('[walk-electron] runElectronWalkSequence finished');
        isPlayingWalkSequence = false;
        idleSuspended = false;
        scheduleRandomIdle();
    }
}

/**
 * Animate a walk phase for Electron (horizontal walking)
 * @param {number} startTimeSec - Start time in seconds
 * @param {number} endTimeSec - End time in seconds
 * @param {string} phaseType - Type of phase ('initial_turn', 'walk', 'turn_to_forward')
 * @param {string} direction - Walking direction ('right' or 'left')
 * @returns {Promise} Resolves when phase completes
 */
function animateElectronWalkPhase(startTimeSec, endTimeSec, phaseType, direction = 'right') {
    return new Promise(resolve => {
        const durationMs = (endTimeSec - startTimeSec) * 1000;
        const startTime = performance.now();
        const windowOffset = CONFIG.WALK_WINDOW_OFFSET;

        function step() {
            const elapsed = performance.now() - startTime;
            const elapsedSec = elapsed / 1000;
            const progress = Math.min(1, elapsed / durationMs);

            if (!currentVrm) {
                resolve();
                return;
            }

            let rotY = walkingInitialRotY;
            let windowX = walkingWindowInitialPos.x;

            // Calculate rotation and window position based on phase type and direction
            if (phaseType === 'initial_turn') {
                // Turn to face walking direction
                if (direction === 'right') {
                    rotY = walkingInitialRotY + (Math.PI / 2) * progress; // Turn to face right (+90°)
                } else {
                    rotY = walkingInitialRotY - (Math.PI / 2) * progress; // Turn to face left (-90°)
                }
                // Window stays at original position during initial turn
                windowX = walkingWindowInitialPos.x;
            } else if (phaseType === 'walk') {
                // Face walking direction and move window horizontally
                if (direction === 'right') {
                    rotY = walkingInitialRotY + Math.PI / 2; // Face right (+90°)
                    // Move window to right during walk
                    windowX = walkingWindowInitialPos.x + Math.round(windowOffset * progress);
                } else {
                    rotY = walkingInitialRotY - Math.PI / 2; // Face left (-90°)
                    // Move window to left during walk
                    windowX = walkingWindowInitialPos.x - Math.round(windowOffset * progress);
                }
            } else if (phaseType === 'turn_to_forward') {
                // Turn from walking direction to face forward
                if (direction === 'right') {
                    rotY = walkingInitialRotY + Math.PI / 2 - (Math.PI / 2) * progress; // Turn from right to forward
                    // Window stays at far right position during turn
                    windowX = walkingWindowInitialPos.x + windowOffset;
                } else {
                    rotY = walkingInitialRotY - Math.PI / 2 + (Math.PI / 2) * progress; // Turn from left to forward
                    // Window stays at far left position during turn
                    windowX = walkingWindowInitialPos.x - windowOffset;
                }
            }

            // Update VRM rotation only (walk in place)
            currentVrm.scene.rotation.y = rotY;

            // Sync window position with walking phase
            if (window.electronAPI && walkingWindowInitialPos) {
                try {
                    window.electronAPI.setWindowPosition(windowX, walkingWindowInitialPos.y);
                } catch (e) {
                    console.warn('[walk-electron] failed to update window position:', e);
                }
            }

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }

        step();
    });
}

/**
 * Web/walking walk sequence (vertical walking - forward/backward)
 * This is the default walking behavior for web version
 * @param {string} vrmaUrl - URL of walk animation file
 */
/**
 * Web/walking walk sequence (vertical walking - forward/backward)
 * This is the default walking behavior for web version
 * @param {string} vrmaUrl - URL of walk animation file
 */
export async function runWalkSequence(vrmaUrl) {
    if (!currentVrm || isPlayingWalkSequence) return;

    try {
        console.log('[walk] runWalkSequence start', vrmaUrl);
        isPlayingWalkSequence = true;

        // Hide all panels during walk animation
        if (window.hideAllPanels) {
            window.hideAllPanels();
        }

        if (currentIdleTimeout) {
            clearTimeout(currentIdleTimeout);
            currentIdleTimeout = null;
        }
        idleSuspended = true;

        const walkTimeScale = CONFIG.WALK_TIME_SCALE;

        let walkingDirection = 'forward';
        
        if (window.electronAPI) {
            try {
                walkingWindowInitialPos = await window.electronAPI.getWindowPosition();
                const windowBounds = await window.electronAPI.getWindowBounds();
                const screenHeight = window.screen ? window.screen.height : window.innerHeight;
                const screenCenterY = screenHeight / 2;
                
                const windowCenterY = walkingWindowInitialPos.y + (windowBounds.height / 2);
                walkingDirection = windowCenterY < screenCenterY ? 'forward' : 'backward';
                
                console.log('[walk] window center:', windowCenterY, 'screen center:', screenCenterY, 'walking:', walkingDirection);
            } catch (e) {
                console.warn('[walk] failed to get window position:', e);
                walkingWindowInitialPos = { x: 0, y: 0 };
            }
        }

        walkingPathActive = true;
        const nowSec = performance.now() / 1000;
        walkingStartTimeSec = nowSec + CONFIG.WALK_START_DELAY;
        walkingInitialPos.copy(currentVrm.scene.position);
        walkingInitialRotY = currentVrm.scene.rotation.y;

        const leg = CONFIG.WALK_WALK_DURATION;
        const turn = CONFIG.WALK_TURN_DURATION;
        walkingTotalDurationSec = 2 * turn;

        console.log('[walk] timing config', {
            startDelay: CONFIG.WALK_START_DELAY,
            direction: walkingDirection,
            leg,
            turn,
            totalPathSeconds: walkingTotalDurationSec,
        });

        console.log('[walk] waiting before starting clip...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.WALK_START_DELAY * 1000));

        console.log('[walk] turning to face', walkingDirection, ', duration (ms)', turn * 1000);
        let action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk] failed to set time scale for initial turn', e);
            }
        }
        await animateWalkPhase(0, turn, 'initial_turn', walkingDirection);

        console.log('[walk] starting', walkingDirection, 'walk clip (LoopRepeat)');
        action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk] failed to set time scale for walk leg', e);
            }
        }
        console.log('[walk]', walkingDirection, 'leg duration (ms)', leg * 1000);
        await animateWalkPhase(turn, turn + leg, 'walk', walkingDirection);

        console.log('[walk] turning to face forward, duration (ms)', turn * 1000);
        action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
        if (action) {
            try {
                if (typeof action.setEffectiveTimeScale === 'function') {
                    action.setEffectiveTimeScale(walkTimeScale);
                } else {
                    action.timeScale = walkTimeScale;
                }
            } catch (e) {
                console.warn('[walk] failed to set time scale for turn to forward', e);
            }
        }
        await animateWalkPhase(turn + leg, turn + leg + turn, 'turn_to_forward', walkingDirection);

        walkingPathActive = false;
        console.log('[walk] finished, keeping current position and rotation');

        console.log('[walk] calling loadIdleLoop at end of sequence');
        await loadIdleLoop();
        
        // REMOVED: Don't auto-restore panels after walk animation
    } finally {
        console.log('[walk] runWalkSequence finished');
        isPlayingWalkSequence = false;
        idleSuspended = false;
        scheduleRandomIdle();
    }
}

function animateWalkPhase(startTimeSec, endTimeSec, phaseType, direction = 'forward') {
    return new Promise(resolve => {
        const durationMs = (endTimeSec - startTimeSec) * 1000;
        const startTime = performance.now();
        const windowOffset = CONFIG.WALK_WINDOW_OFFSET;

        function step() {
            const elapsed = performance.now() - startTime;
            const elapsedSec = elapsed / 1000;
            const progress = Math.min(1, elapsed / durationMs);

            if (!currentVrm) {
                resolve();
                return;
            }

            let rotY = walkingInitialRotY;
            let windowY = walkingWindowInitialPos?.y || 0;

            if (phaseType === 'initial_turn') {
                // Turn to face forward or backward (no rotation needed for forward/backward)
                rotY = walkingInitialRotY;
                windowY = walkingWindowInitialPos?.y || 0;
            } else if (phaseType === 'walk') {
                // Walk forward or backward (no rotation needed)
                rotY = walkingInitialRotY;
                if (direction === 'forward') {
                    windowY = (walkingWindowInitialPos?.y || 0) - Math.round(windowOffset * progress);
                } else {
                    windowY = (walkingWindowInitialPos?.y || 0) + Math.round(windowOffset * progress);
                }
            } else if (phaseType === 'turn_to_forward') {
                // Turn back to face forward (no rotation needed)
                rotY = walkingInitialRotY;
                if (direction === 'forward') {
                    windowY = (walkingWindowInitialPos?.y || 0) - windowOffset;
                } else {
                    windowY = (walkingWindowInitialPos?.y || 0) + windowOffset;
                }
            }

            currentVrm.scene.rotation.y = rotY;

            if (window.electronAPI && walkingWindowInitialPos) {
                try {
                    window.electronAPI.setWindowPosition(walkingWindowInitialPos.x, windowY);
                } catch (e) {
                    console.warn('[walk] failed to update window position:', e);
                }
            }

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }

        step();
    });
}

// ============================================================
// START_1 SPECIAL SEQUENCE
// ============================================================
export async function runStart1Sequence() {
    console.log('[idle1] runStart1Sequence start');
    isPlayingSequence = true;

    // Hide messaging panel during start_1 animation
    hideMessagingPanel();

    try {
        statusDiv.textContent = 'Playing start_1 stand up...';
        console.log('[idle1] step 1: transition to start_1standUp');
        const action = await startSmoothTransition(`${ASSET_BASE_URL}VRMA/start_1standUp.vrma`, { 
            loopMode: THREE.LoopOnce, 
            startOffset: 0.5 
        });
        
        if (!action) {
            console.warn('[idle1] failed to create action');
            return;
        }

        console.log('[idle1] step 1 complete: start_1 animation started');

        console.log('[idle1] step 2: waiting 0.1s before pausing');
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log('[idle1] step 2: pausing animation at time', action.time);
        const pausedTime = action.time;
        action.paused = true;
        action.timeScale = 0;
        statusDiv.textContent = 'Animation paused...';

        const stayTime = Math.random() * (CONFIG.RANDOM_IDLE_MAX_DELAY - CONFIG.RANDOM_IDLE_MIN_DELAY) + CONFIG.RANDOM_IDLE_MIN_DELAY;
        console.log('[idle1] step 3: waiting for', stayTime, 'ms');
        statusDiv.textContent = `Waiting for ${(stayTime/1000).toFixed(1)}s...`;
        
        await new Promise(resolve => setTimeout(resolve, stayTime));
        console.log('[idle1] step 3 complete: wait finished');

        console.log('[idle1] step 4: resuming animation from time', pausedTime);
        action.paused = false;
        action.timeScale = 1;
        statusDiv.textContent = 'Resuming animation...';

        await waitForActionEnd(action, 15000, false);
        console.log('[idle1] step 4 complete: animation finished');

        console.log('[idle1] step 5: returning to idle loop');
        statusDiv.textContent = 'Returning to idle loop...';
        const ok = await loadIdleLoop();
        if (!ok) console.warn('[idle1] loadIdleLoop failed');
        console.log('[idle1] step 5 complete: idle loop resumed');
        
        // Show messaging panel after start_1 animation completes
        // REMOVED: Don't auto-show messaging panel after walk animation

    } catch (error) {
        console.error('[idle1] Error in start_1 sequence:', error);
    } finally {
        isPlayingSequence = false;
        console.log('[idle1] runStart1Sequence finished');
    }
}

// ============================================================
// AUTOMATIC SEQUENCE SYSTEM
// ============================================================
export async function startAutomaticSequence() {
    if (isPlayingSequence || !currentVrm) return;

    console.log('[seq] starting automatic sequence');
    isPlayingSequence = true;
    statusDiv.textContent = 'Starting automatic sequence...';

    try {
        statusDiv.textContent = 'Playing stand up animation...';
        console.log('[seq] transition to stand up');
        const action1 = await startSmoothTransition(`${ASSET_BASE_URL}VRMA/start_1standUp.vrma`, { loopMode: THREE.LoopOnce, startOffset: 0.5 });
        if (action1) {
            console.log('[seq] waiting for stand up to finish');
            await waitForActionEnd(action1, 15000, true);
        }
        console.log('[seq] stand up finished');

        statusDiv.textContent = 'Playing turn around animation...';
        console.log('[seq] transition to turn around');
        const action2 = await startSmoothTransition(`${ASSET_BASE_URL}VRMA/start_2turnAround.vrma`, { loopMode: THREE.LoopOnce, startOffset: 0.5, transitionTime: 1.0 });
        if (action2) {
            console.log('[seq] waiting for turn around to finish');
            await waitForActionEnd(action2, 15000, true);
        }
        console.log('[seq] turn around finished');

        statusDiv.textContent = 'Starting idle loop...';
        console.log('[seq] loading idle loop');
        const t0 = performance.now();
        await loadIdleLoop();
        console.log('[seq] loadIdleLoop duration', performance.now() - t0);
        console.log('[seq] idle loop should now be playing');

        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log('[seq] waited 3s after idle start');
        beginRandomIdleSelection();
    } catch (error) {
        console.error('[seq] Error in automatic sequence:', error);
        statusDiv.textContent = 'Error in sequence. Loading idle loop...';
        await loadIdleLoop();
    } finally {
        isPlayingSequence = false;
        console.log('[seq] automatic sequence complete');
        if (!currentAction) {
            console.log('[seq] no action active, forcing idle');
            const ok = await loadIdleLoop();
            if (!ok) console.warn('[seq] failed to load idle loop in finally');
        }
        beginRandomIdleSelection();
    }
}

// ============================================================
// RANDOM IDLE SYSTEM - ENHANCED
// ============================================================
export async function playRandomIdle() {
    console.log('[idle] playRandomIdle called, currentAction=', currentAction, 'isPlayingSequence=', isPlayingSequence, 'isPlayingWalkSequence=', isPlayingWalkSequence);
    if (!currentVrm || isPlayingSequence || isPlayingWalkSequence) return;

    try {
        const idleFiles = VRMA_ANIMATION_URLS.filter(url => {
            const name = url.split('/').pop();
            return name.startsWith('idle_') && name !== 'idle_loop.vrma' || 
                   name === 'walk.vrma' || 
                   name === 'start_1standUp.vrma' || 
                   name === 'start_2turnAround.vrma';
        });

        if (idleFiles.length > 0) {
            const randomFile = idleFiles[Math.floor(Math.random() * idleFiles.length)];
            console.log('[idle] selected random idle', randomFile);
            statusDiv.textContent = `Playing random idle: ${randomFile}`;

            if (randomFile.includes('walk.vrma')) {
                // Use Electron-specific horizontal walking for Electron app
                // Web version does not support walk animation
                if (window.electronAPI) {
                    await runElectronWalkSequence(randomFile);
                } else {
                    console.log('[idle] Web version - skipping walk animation');
                    // Just load idle loop instead
                    await loadIdleLoop();
                }
            }
            else if (randomFile.includes('start_1standUp.vrma')) {
                await runStart1Sequence();
            } 
            else {
                const action = await startSmoothTransition(randomFile, { loopMode: THREE.LoopOnce });
                if (action) {
                    await waitForActionEnd(action, 15000, true);
                }
            }
        } else {
            console.warn('[idle] no idle files found');
        }
    } catch (error) {
        console.error('[idle] Error playing random idle:', error);
    } finally {
        statusDiv.textContent = 'Returning to idle loop...';
        const ok = await loadIdleLoop();
        if (!ok) console.warn('[idle] loadIdleLoop failed after random idle');
        scheduleRandomIdle();
    }
}

// ============================================================
// ANIMATION DROPDOWN HANDLING
// ============================================================
export async function populateAnimationDropdown() {
    const select = document.getElementById('animationSelect');
    if (!select) return;
    
    select.innerHTML = '<option value="">Select Animation</option>';

    let vrmaFiles = [];

    if (Array.isArray(window.VRMA_ANIMATION_URLS)) {
        console.log('[vrma] using constant animation list');
        vrmaFiles = window.VRMA_ANIMATION_URLS.slice();
    }

    vrmaFiles.sort();

    vrmaFiles.forEach(url => {
        const option = document.createElement('option');
        option.value = url;

        let filename = url.split('/').pop().replace('.vrma', '');
        filename = filename.replace('CC0animation', '');
        filename = filename.replace('CC0_', '');
        filename = filename.replace('_', ' ');
        filename = filename.charAt(0).toUpperCase() + filename.slice(1);

        if (filename.toLowerCase().includes('idle') && filename.toLowerCase().includes('loop')) {
            filename = 'Idle Loop';
        }

        option.textContent = filename;
        select.appendChild(option);
    });
}

export function updateDropdownReferences() {
    const hasVrm = !!currentVrm;
    if (animationSelect) {
        animationSelect.disabled = !hasVrm;
    }
    if (hasVrm) {
        populateAnimationDropdown();
    }
}

export function updateButtons() {
    const hasVrm = currentVrm !== undefined;
    const hasVrma = vrmaAnimationClip !== undefined;

    if (animationSelect) {
        animationSelect.disabled = !hasVrm;
    }
    if (speakBtnPanel) {
        speakBtnPanel.disabled = !hasVrm;
    }
    if (expressionSelect) {
        expressionSelect.disabled = !hasVrm;
    }

    if (isIdleMode && hasVrm && animationSelect) {
        for (let i = 0; i < animationSelect.options.length; i++) {
            if (animationSelect.options[i].value.includes('idle_loop.vrma')) {
                animationSelect.selectedIndex = i;
                break;
            }
        }
    } else if (animationSelect) {
        animationSelect.selectedIndex = 0;
    }
}

export function setupAnimationDropdown() {
    if (!animationSelect) return;
    
    animationSelect.addEventListener('change', async () => {
        const vrmaUrl = animationSelect.value;

        if (!vrmaUrl) {
            if (idleSuspended) {
                scheduleRandomIdle();
                idleSuspended = false;
            }
            return;
        }

        if (currentIdleTimeout) {
            clearTimeout(currentIdleTimeout);
            currentIdleTimeout = null;
            idleSuspended = true;
        }

        isTransitioning = false;

        if (vrmaUrl.includes('idle_loop.vrma')) {
            await loadIdleLoop();
        } else if (/idle_.*\.vrma$/.test(vrmaUrl)) {
            const action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopOnce });
            if (action) {
                await waitForActionEnd(action, 15000, true);
                action.stop();
                currentMixer.uncacheAction(action.getClip());
                currentAction = null;
                if (currentVrm) currentVrm.humanoid.resetNormalizedPose();
                await loadIdleLoop();
            }
        } else if (vrmaUrl.includes('walk.vrma')) {
            // Use Electron-specific horizontal walking for Electron app
            // Use Web-specific vertical walking for web app
            if (window.electronAPI) {
                await runElectronWalkSequence(vrmaUrl);
            } else {
                await runWalkSequence(vrmaUrl);
            }
        } else if (vrmaUrl.includes('sit.vrma') || vrmaUrl.includes('sitWave.vrma')) {
            // Hide all panels during sit animation
            if (window.hideAllPanels) {
                window.hideAllPanels();
            }
            
            // Ensure history panel is also hidden
            if (window.hideHistoryPanel) {
                window.hideHistoryPanel();
            }
            
            // Set flag to prevent panel restoration
            isSitAnimationActive = true;
            console.log('[sit] Sit animation started, panels hidden, restoration prevented');
            
            const action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat });
            if (action) {
                await waitForActionEnd(action, 15000, true);
                action.stop();
                currentMixer.uncacheAction(action.getClip());
                currentAction = null;
                if (currentVrm) currentVrm.humanoid.resetNormalizedPose();
            }
            
            // Load idle loop after sit animation
            await loadIdleLoop();
            
            // DON'T reset the flag - keep panels hidden until user explicitly interacts
            // This prevents panels from being restored by agent responses
            console.log('[sit] Sit animation complete, panels remain hidden until user interaction');
        } else {
            await startSmoothTransition(vrmaUrl);
        }
    });
}

// ============================================================
// INITIALIZATION
// ============================================================
export async function init() {
    // Show loading GIF first
    showLoadingGif();
    
    initThreeJS();
    initDOMElements();
    initSpeakingBubble();
    initSystems();
    
    // Setup animation dropdown
    setupAnimationDropdown();
    
    // Setup touch detection for model interaction
    setupTouchDetection();
    
    // Load VRM model
    await loadVRM(VRM_MODEL_URL);
    
    // Update UI
    updateButtons();
    updateDropdownReferences();
    
    // Start animation loop
    animate();
    
    // Start automatic sequence after VRM loads
    startAutomaticSequence();
}
