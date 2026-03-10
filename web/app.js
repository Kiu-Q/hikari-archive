/**
 * Hikari Web App - Merged Application
 * Contains all application logic with namespace modules
 */

console.log('[web] Hikari Web version starting');

// ============================================================
// IMPORTS
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// ============================================================
// CORE MODULE - Three.js, VRM, Animation, Lip Sync
// ============================================================
const CoreModule = (() => {
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
    let isSitAnimationActive = false;
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
    function initThreeJS() {
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
    function handleResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    /**
     * Setup touch detection for model interaction
     */
    function setupTouchDetection() {
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
        const y = localPoint.y;
        
        // Define height ranges for different body parts
        const HEAD_THRESHOLD = 1.4;
        const CHEST_THRESHOLD = 1.1;
        const HIP_THRESHOLD = 0.7;
        
        // Also check X coordinate to distinguish left/right sides if needed
        const x = localPoint.x;
        
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
            // Identify which body part was touched
            const bodyPart = identifyBodyPart(intersection);
            console.log('[touch] Touched body part:', bodyPart);
            
            // Step 1: Play touch animation
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

IMPORTANT: Do NOT use markdown code blocks (\\`\\`json or \\`\\`) around your JSON response. Just provide the raw JSON object directly.
Note: Animations play fully before proceeding. Expression resets to 'neutral' when returning to idle_loop.`;
                
                // Send request to OpenClaw agent with full context
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
    function saveCameraSettings() {
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
    function loadCameraSettings() {
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
    function resetCamera() {
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
    const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || '../assets/';
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
    function initDOMElements() {
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
    function hideMessagingPanel() {
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
    function showMessagingPanel() {
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
    function disableMessaging() {
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
    function enableMessaging() {
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
    function setMessagingThinking() {
        if (textInputPanel && !isMessagingDisabled) {
            originalMessageText = textInputPanel.value;
            textInputPanel.value = 'Thinking...';
            console.log('[messaging] Set to thinking state');
        }
    }

    /**
     * Reset messaging panel after reply
     */
    function resetMessagingPanel() {
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
    function createLipSyncSystem() {
        let isCurrentlyTalking = false;
        let mouthTarget = 'a';
        let mouthProgress = 0;
        let localCurrentExpression = '';
        let speakingSpeedMultiplier = 1.0;
        let isAgentCommandActive = false;

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
                    'a': 'aa', 'e': 'ee', 'i': 'ih', 'o': 'oh', 'u': 'oo'
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
                
                const simplifiedShapes = [];
                for (let i = 0; i < shapes.length; i++) {
                    if (shapes[i] !== 'neutral' && (i === 0 || shapes[i - 1] === 'neutral')) {
                        simplifiedShapes.push(shapes[i]);
                    }
                }
                return simplifiedShapes;
            }

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
            if (!vrm.expressionManager) return;

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
                let speakingStartTime = performance.now();
                
                let unitShapes = [];
                let totalShapes = 0;
                
                if (hasChinese) {
                    units = text.split('').filter(char => char.trim() !== '');
                } else {
                    units = text.split(' ').filter(word => word.length > 0);
                }
            
                units.forEach(unit => {
                    const shapes = textToMouthShapes(unit);
                    unitShapes.push(shapes);
                    totalShapes += shapes.length;
                });
                
                const speakingDuration = (totalShapes * 80) + (units.length * 50);
                const maxDuration = speakingDuration / speakingSpeedMultiplier;
                
                console.log('[lip] units for speech', units, 'total shapes:', totalShapes, 'duration:', speakingDuration, 'max duration:', maxDuration);

                function processNextUnit() {
                    if (currentUnitIndex >= units.length) {
                        mouthTarget = 'neutral';
                        updateDebugDisplay(text, -1);
                        
                        const lastCharIndex = text.length - 1;
                        displayCharacterAtIndex(lastCharIndex);
                        
                        if (idleSuspended) {
                            scheduleRandomIdle();
                            idleSuspended = false;
                        }
                        resolve();
                        return;
                    }

                    const unit = units[currentUnitIndex];
                    console.log('[lip] processing unit', currentUnitIndex, unit);

                    if (hasChinese) {
                        updateDebugDisplay(text, currentUnitIndex, unit);
                    } else {
                        updateDebugDisplay(text, currentUnitIndex);
                    }

                    const mouthShapes = unitShapes[currentUnitIndex] || textToMouthShapes(unit);
                    console.log('[lip] mouthShapes', mouthShapes);

                    if (mouthShapes.length === 0) {
                        currentUnitIndex++;
                        setTimeout(processNextUnit, 400 / speakingSpeedMultiplier);
                        return;
                    }

                    let shapeIndex = 0;

                    function processNextShape() {
                        if (shapeIndex >= mouthShapes.length) {
                            currentUnitIndex++;
                            updateDebugDisplay(text, -1);
                            setTimeout(processNextUnit, 50 / speakingSpeedMultiplier);
                            return;
                        }

                        const shape = mouthShapes[shapeIndex];
                        mouthTarget = shape;
                        shapeIndex++;

                        const elapsed = performance.now() - speakingStartTime;
                        const progressRatio = elapsed / speakingDuration;
                        const charIndex = Math.floor(progressRatio * text.length);
                        
                        displayCharacterAtIndex(Math.min(charIndex, text.length - 1));

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
            if (!vrm.expressionManager) return;

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
    function createBlinkSystem() {
        let isBlinking = false;
        let blinkProgress = 0;
        let timeSinceLastBlink = 0;

        const BLINK_DURATION = 0.2;
        const MIN_BLINK_INTERVAL = 1;
        const MAX_BLINK_INTERVAL = 6;

        let nextBlinkTime = Math.random() * (MAX_BLINK_INTERVAL - MIN_BLINK_INTERVAL) + MIN_BLINK_INTERVAL;

        function update(vrm, delta) {
            if (!vrm.expressionManager) return;

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

    function initSpeakingBubble() {
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
                
                if (!cachedHeadBone && currentVrm.humanoid.bones) {
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
                    console.log('[bubble] Available bones:', currentVrm.humanoid.bones.map(b => b.name));
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

    function showSpeakingBubble(text) {
        clearCachedHeadBone();
        
        speakingBubble.textContent = '';
        currentDisplayedText = '';
        
        currentSpeakingText = text;
        bubbleVisible = true;
        
        speakingBubble.style.setProperty('display', 'block', 'important');
        
        speakingBubble.style.left = '50%';
        speakingBubble.style.top = '40%';
        
        updateSpeakingBubblePosition();
        
        // Fade in effect
        requestAnimationFrame(() => {
            speakingBubble.style.opacity = '1';
        });
        
        // Split text into characters
        currentWordIndex = 0;
        words = text.split('');
        
        // Display first character immediately
        if (words.length > 0) {
            displayCharacterAtIndex(0);
        }
    }

    function hideSpeakingBubble() {
        if (bubbleHideTimer) {
            clearTimeout(bubbleHideTimer);
        }
        
        if (wordDisplayTimer) {
            clearTimeout(wordDisplayTimer);
        }
        
        bubbleHideTimer = setTimeout(() => {
            speakingBubble.style.opacity = '0';
            
            setTimeout(() => {
                bubbleVisible = false;
                speakingBubble.style.display = 'none';
                currentSpeakingText = '';
                currentDisplayedText = '';
                words = [];
                currentWordIndex = 0;
            }, 300);
        }, 3000);
    }

    function displayCharacterAtIndex(charIndex) {
        if (!bubbleVisible || charIndex < 0) {
            return;
        }
        
        if (charIndex >= words.length) {
            charIndex = words.length - 1;
        }
        
        const displayedChars = words.slice(0, charIndex + 1);
        currentDisplayedText = displayedChars.join('');
        speakingBubble.textContent = currentDisplayedText;
        
        currentWordIndex = charIndex;
    }

    function getWordCount() {
        return words.length;
    }

    function updateSpeakingBubbleText(text) {
        if (bubbleVisible) {
            speakingBubble.textContent = text;
        }
    }

    // ============================================================
    // VRM LOADING
    // ============================================================
    async function loadVRM(url) {
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
    function waitForActionEnd(action, maxWait = 15000, resetPose = false) {
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

    async function startSmoothTransition(url, { loopMode = THREE.LoopRepeat, startOffset = CONFIG.T_OFFSET, resetPose = false, transitionTime = CONFIG.TRANSITION_TIME } = {}) {
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

    async function loadIdleLoop() {
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

    async function loadVRMA(url) {
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
     */
    function resetExpressionToNeutral() {
        if (!currentVrm.expressionManager) return;
        
        console.log('[expression] Resetting to neutral');
        activeFacialExpression = null;
        blinkSystemEnabled = true;
        
        applyFacialExpression('neutral');
    }

    function applyFacialExpression(expression) {
        if (!currentVrm.expressionManager) return;

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
    function beginRandomIdleSelection() {
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

    function initSystems() {
        lipSyncSystem = createLipSyncSystem();
        blinkSystem = createBlinkSystem();
        
        // Expose core functions to window for WebSocket access
        window.lipSyncSystem = lipSyncSystem;
        window.applyFacialExpression = applyFacialExpression;
        window.loadVRMA = loadVRMA;
        window.startSmoothTransition = startSmoothTransition;
        window.loadIdleLoop = loadIdleLoop;
        window.resetExpressionToNeutral = resetExpressionToNeutral;
        
        window._internalLipSync = lipSyncSystem;
    }

    function animate() {
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
    const MIN_LOADING_TIME = 4000;

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
        
        const loadingGifUrl = `${ASSET_BASE_URL}loading.gif`;
        
        const img = new Image();
        img.onload = () => {
            loadingGif.style.background = `url('${loadingGifUrl}') no-repeat center center`;
            loadingGif.style.backgroundSize = 'cover';
        };
        img.onerror = () => {
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
    // WALK SEQUENCE SYSTEM - Web version (vertical walking)
    // ============================================================

    /**
     * Web walk sequence (vertical walking - forward/backward)
     * This is the default walking behavior for web version
     * @param {string} vrmaUrl - URL of walk animation file
     */
    async function runWalkSequence(vrmaUrl) {
        if (!currentVrm || isPlayingWalkSequence) return;

        try {
            console.log('[walk] runWalkSequence start', vrmaUrl);
            isPlayingWalkSequence = true;

            if (window.hideAllPanels) {
                window.hideAllPanels();
            }

            if (currentIdleTimeout) {
                clearTimeout(currentIdleTimeout);
                currentIdleTimeout = null;
                idleSuspended = true;
            }

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
                let windowY = walkingWindowInitialPos.y || 0;

                if (phaseType === 'initial_turn') {
                    rotY = walkingInitialRotY;
                    windowY = walkingWindowInitialPos.y || 0;
                } else if (phaseType === 'walk') {
                    rotY = walkingInitialRotY;
                    if (direction === 'forward') {
                        windowY = (walkingWindowInitialPos.y || 0) - Math.round(windowOffset * progress);
                    } else {
                        windowY = (walkingWindowInitialPos.y || 0) + Math.round(windowOffset * progress);
                    }
                } else if (phaseType === 'turn_to_forward') {
                    rotY = walkingInitialRotY;
                    if (direction === 'forward') {
                        windowY = (walkingWindowInitialPos.y || 0) - windowOffset;
                    } else {
                        windowY = (walkingWindowInitialPos.y || 0) + windowOffset;
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
    async function runStart1Sequence() {
        console.log('[idle1] runStart1Sequence start');
        isPlayingSequence = true;

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
    async function startAutomaticSequence() {
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
    async function playRandomIdle() {
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
                    // Web version does not support walk animation (Electron-only)
                    console.log('[idle] Web version - skipping walk animation');
                    await loadIdleLoop();
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
    async function populateAnimationDropdown() {
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

    function updateDropdownReferences() {
        const hasVrm = currentVrm !== undefined;
        if (animationSelect) {
            animationSelect.disabled = !hasVrm;
        }
        if (hasVrm) {
            populateAnimationDropdown();
        }
    }

    function updateButtons() {
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

    function setupAnimationDropdown() {
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
                // Web version does not support walk animation (Electron-only)
                console.log('[web] Web version - skipping walk animation');
                await loadIdleLoop();
            } else if (vrmaUrl.includes('sit.vrma') || vrmaUrl.includes('sitWave.vrma')) {
                if (window.hideAllPanels) {
                    window.hideAllPanels();
                }
                
                if (window.hideHistoryPanel) {
                    window.hideHistoryPanel();
                }
                
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
                
                await loadIdleLoop();
                
                console.log('[sit] Sit animation complete, panels remain hidden until user interaction');
            } else {
                await startSmoothTransition(vrmaUrl);
            }
        });
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================
    async function init() {
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

    // Export public API
    return {
        init,
        handleResize,
        beginRandomIdleSelection,
        hideMessagingPanel,
        showMessagingPanel,
        disableMessaging,
        enableMessaging,
        setMessagingThinking,
        resetMessagingPanel,
        saveCameraSettings,
        loadCameraSettings,
        resetCamera,
        runWalkSequence,
        loadVRMA,
        startSmoothTransition,
        loadIdleLoop,
        resetExpressionToNeutral,
        applyFacialExpression,
        updateSpeakingBubbleText,
        displayCharacterAtIndex,
        getWordCount,
        showSpeakingBubble,
        hideSpeakingBubble,
        waitForActionEnd
    };
})();

// ============================================================
// WEBSOCKET MODULE
// ============================================================
const WebSocketModule = (() => {
    let ws = null;
    let reconnectTimer = null;
    let isConnected = false;
    let messageQueue = [];
    let processedRunIds = new Set();
    let currentWebSocketUrl = null;

    // Configuration
    const CONFIG = {
      token: 'YOUR_TOKEN_HERE',
      reconnectInterval: 3000,
      maxReconnectAttempts: 10
    };

    function getWebSocketUrl() {
      const localStorageUrl = localStorage.getItem('websocket_url');
      if (localStorageUrl && localStorageUrl.trim() !== '') {
        console.log('[ws] Using WebSocket URL from localStorage:', localStorageUrl);
        return localStorageUrl.trim();
      }
      
      const envUrl = import.meta.env.VITE_WEBSOCKET_URL;
      if (envUrl) {
        console.log('[ws] Using WebSocket URL from environment variable:', envUrl);
        return envUrl;
      }
      
      const defaultUrl = 'ws://localhost:18789';
      console.log('[ws] Using default WebSocket URL:', defaultUrl);
      return defaultUrl;
    }

    let reconnectAttempts = 0;

    function initWebSocket() {
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        console.log('[ws] WebSocket already connected or connecting');
        return;
      }

      const savedToken = localStorage.getItem('openclaw_token');
      if (savedToken && savedToken.trim() !== '') {
        CONFIG.token = savedToken;
        console.log('[ws] Using token from localStorage (first 8 chars:', savedToken.substring(0, 8) + '...)');
      } else {
        console.error('[ws] No token configured. Please set openclaw_token in localStorage.');
        
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Error: OpenClaw token not configured. Please set in browser console with: localStorage.setItem("openclaw_token", "your-token")';
          statusDiv.style.color = '#ff6b6b';
        }
        
        return;
      }

      const wsUrl = getWebSocketUrl();
      currentWebSocketUrl = wsUrl;
      console.log('[ws] Connecting to OpenClaw gateway at:', wsUrl);
      
      try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = handleOpen;
        ws.onmessage = handleMessage;
        ws.onerror = handleError;
        ws.onclose = handleClose;
      } catch (error) {
        console.error('[ws] Error creating WebSocket:', error);
        scheduleReconnect();
      }
    }

    function handleOpen() {
      console.log('[ws] Connected to OpenClaw gateway');
      isConnected = true;
      reconnectAttempts = 0;
      
      console.log('[ws] Waiting for connect.challenge...');
    }

    function handleMessage(event) {
      try {
        const data = JSON.parse(event.data);
        console.log('[ws] Received message:', data);
        
        switch (data.type) {
          case 'speak':
            handleSpeakCommand(data);
            break;
          case 'animate':
            handleAnimateCommand(data);
            break;
          case 'express':
            handleExpressCommand(data);
            break;
          case 'event':
            handleEvent(data);
            break;
          case 'res':
            if (data.id && data.id.startsWith('history-')) {
              handleHistoryResponse(data);
            } else {
              handleAgentResponse(data);
            }
            break;
          case 'history':
            handleHistoryResponse(data);
            break;
          case 'ack':
            console.log('[ws] Acknowledgment received:', data);
            break;
          default:
            console.warn('[ws] Unknown message type:', data.type);
        }
      } catch (error) {
        console.error('[ws] Error parsing message:', error);
      }
    }

    function handleEvent(data) {
      switch (data.event) {
        case 'connect.challenge':
          console.log('[ws] Connection challenge received, sending auth request');
          
          const connectParams = {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'cli',
              version: '1.0.0',
              platform: getPlatform(),
              mode: 'cli'
            },
            role: 'operator',
            auth: {
              token: CONFIG.token
            }
          };
          
          sendMessage({
            type: 'req',
            id: 'conn-' + Date.now(),
            method: 'connect',
            params: connectParams
          });
          break;
        
        case 'chat':
          handleChatEvent(data);
          break;
        
        case 'health':
          break;
        
        case 'tick':
          console.log('[ws] Tick event received, updating conversation history');
          if (window.fetchConversationHistory) {
            window.fetchConversationHistory(0);
          }
          break;
        
        case 'agent':
          break;
        
        default:
          console.log('[ws] Unknown event type:', data.event);
      }
    }

    function handleChatEvent(data) {
      console.log('[ws] Chat event received:', data);
      
      const runId = data.payload.runId;
      if (runId && processedRunIds.has(runId)) {
        console.log('[ws] Ignoring duplicate event with runId:', runId);
        return;
      }
      
      const sessionKey = data.payload.sessionKey || data.sessionKey;
      const state = data.payload.state;
      
      const isValidSession = sessionKey === 'agent:main:main' || sessionKey === 'main';
      
      if (!isValidSession) {
        console.log('[ws] Ignoring message from non-main agent:', { sessionKey, state });
        return;
      }
      
      if (state !== 'final') {
        console.log('[ws] Ignoring non-final message (still typing):', { sessionKey, state });
        return;
      }
      
      const messageContent = data.payload.message.content;
      if (messageContent && messageContent.length > 0) {
        const textContent = messageContent.find(item => item.type === 'text');
        const rawText = textContent ? textContent.text : null;
        
        if (rawText) {
          console.log('[ws] Chat message from main agent (raw):', rawText);
          
          // Filter system messages
          if (rawText.includes('HEARTBEAT') || rawText.includes('HEARTBEAT_OK')) {
            console.log('[ws] Skipping HEARTBEAT system message');
            return;
          }
          if (rawText.includes('New session started') || rawText.includes('✅')) {
            console.log('[ws] Skipping session system message');
            return;
          }
          if (rawText.includes('Read HEARTBEAT.md')) {
            console.log('[ws] Skipping HEARTBEAT instruction message');
            return;
          }
          if (rawText.includes('/new or /reset') || rawText.includes('Do not mention internal steps')) {
            console.log('[ws] Skipping session instruction message');
            return;
          }
          if (rawText.includes('===== USER MESSAGE =====') || 
              rawText.includes('===== SYSTEM INSTRUCTIONS =====') ||
              rawText.includes('AVAILABLE ANIMATIONS') ||
              rawText.includes('AVAILABLE EXPRESSIONS') ||
              rawText.includes('RESPONSE FORMAT') ||
              rawText.includes('TIMING OPTIONS') ||
              rawText.includes('IMPORTANT:')) {
            console.log('[ws] Skipping system instruction message');
            return;
          }
          if (rawText.trim().startsWith('{') && 
              (rawText.includes("'text'") || rawText.includes('"text"')) &&
              (rawText.includes("'animation'") || rawText.includes('"animation"')) &&
              (rawText.includes("'expression'") || rawText.includes('"expression"'))) {
            console.log('[ws] Skipping raw JSON response');
            return;
          }
          
          const parsedResponse = parseAgentResponse(rawText);
          let textToSpeak;
          
          if (parsedResponse && parsedResponse.text) {
            textToSpeak = parsedResponse.text;
            console.log('[ws] Extracted text from JSON:', textToSpeak);
            
            if (parsedResponse.animation || parsedResponse.expression) {
              executeAgentCommand(parsedResponse);
            }
          } else {
            textToSpeak = rawText;
            console.log('[ws] Using raw text (not JSON):', textToSpeak);
          }
          
          if (runId) {
            processedRunIds.add(runId);
          }
          
          if (window.enableMessaging) {
            window.enableMessaging();
          }
          if (window.resetMessagingPanel) {
            window.resetMessagingPanel();
          }
          
          if (!parsedResponse || !parsedResponse.animation || !parsedResponse.expression) {
            if (window.lipSyncSystem && textToSpeak) {
              window.lipSyncSystem.startSpeaking(textToSpeak);
              
              const statusDiv = document.getElementById('status');
              if (statusDiv) {
                const displayText = textToSpeak.length > 30 ? textToSpeak.substring(0, 30) + '...' : textToSpeak;
                statusDiv.textContent = 'Speaking: ' + displayText;
              }
            }
          }
        }
      }
    }

    function getPlatform() {
      const userAgent = navigator.userAgent;
      if (userAgent.indexOf('Win') !== -1) return 'windows';
      if (userAgent.indexOf('Mac') !== -1) return 'macos';
      if (userAgent.indexOf('Linux') !== -1) return 'linux';
      if (userAgent.indexOf('Android') !== -1) return 'android';
      if (userAgent.indexOf('iOS') !== -1) return 'ios';
      return 'unknown';
    }

    function handleAgentResponse(data) {
      console.log('[ws] Agent response received:', data);
      
      if (!data.ok) {
        console.error('[ws] Error in response:', data);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Error: ' + (data.payload.error || 'Unknown error');
          statusDiv.style.color = '#ff6b6b';
        }
        return;
      }
      
      if (data.payload.type === 'hello-ok') {
        console.log('[ws] Connection successful, authenticated as:', data.payload.auth.role);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Connected to OpenClaw';
          statusDiv.style.color = '#4CAF50';
        }
        
        flushMessageQueue();
        
      } else if (data.payload.result.payloads && data.payload.result.payloads.length > 0) {
        const runId = data.payload.runId || data.payload.result.meta.systemPromptReport.generatedAt;
        if (runId && processedRunIds.has(runId)) {
          console.log('[ws] Ignoring duplicate res with runId:', runId);
          return;
        }
        
        const sessionKey = data.payload.result.meta.agentMeta.sessionKey || 
                       data.payload.result.meta.systemPromptReport.sessionKey ||
                       data.payload.result.sessionKey || 
                       data.sessionKey;
        const state = data.payload.result.state;
        
        const isValidSession = sessionKey === 'agent:main:main' || sessionKey === 'main';
        
        if (!isValidSession) {
          console.log('[ws] Ignoring response from non-main agent:', { sessionKey, state });
          return;
        }
        
        const replyText = data.payload.result.payloads[0].text;
        if (replyText) {
          console.log('[ws] AI reply from main agent:', replyText);
          
          if (runId) {
            processedRunIds.add(runId);
          }
          
          const parsedResponse = parseAgentResponse(replyText);
          
          if (parsedResponse) {
            executeAgentCommand(parsedResponse);
          } else {
            console.warn('[ws] Response is not valid JSON, treating as plain text');
            console.log('[ws] Plain text reply:', replyText);
            
            if (window.enableMessaging) {
              window.enableMessaging();
            }
            if (window.resetMessagingPanel) {
              window.resetMessagingPanel();
            }
            
            if (window.lipSyncSystem) {
              window.lipSyncSystem.startSpeaking(replyText);
              
              const statusDiv = document.getElementById('status');
              if (statusDiv) {
                const displayText = replyText.length > 50 ? replyText.substring(0, 50) + '...' : replyText;
                statusDiv.textContent = 'Speaking: ' + displayText;
              }
            }
          }
        }
        
      } else if (data.payload.status === 'accepted') {
        console.log('[ws] Request accepted, waiting for reply...');
        
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Processing request...';
        }
      } else {
        console.log('[ws] Response data:', data.payload);
      }
    }

    function parseAgentResponse(text) {
      try {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e1) {
          console.log('[ws] Standard JSON parse failed, trying single quote handling');
          const fixedText = text
            .replace(/'/g, '"')
            .replace(/""/g, '""');
          parsed = JSON.parse(fixedText);
        }
        
        if (!parsed.text || typeof parsed.text !== 'string') {
          console.warn('[ws] Invalid JSON response: missing or invalid text field');
          return null;
        }
        
        if (parsed.animation && parsed.animation.file) {
          const validAnimations = [
            'idle_loop.vrma', 'idle_airplane.vrma', 'idle_shoot.vrma', 
            'idle_sport.vrma', 'idle_stretch.vrma', 'idle_vSign.vrma',
            'sit.vrma', 'sitWave.vrma', 'start_1standUp.vrma', 
            'start_2turnAround.vrma', 'walk.vrma',
            'wave_both.vrma', 'wave_left.vrma', 'wave_right.vrma'
          ];
          
          if (!validAnimations.includes(parsed.animation.file)) {
            console.warn('[ws] Invalid animation:', parsed.animation.file);
            parsed.animation = { file: 'idle_loop.vrma', timing: 'during' };
          }
        }
        
        if (parsed.expression && parsed.expression.name) {
          const validExpressions = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'blink'];
          
          if (!validExpressions.includes(parsed.expression.name)) {
            console.warn('[ws] Invalid expression:', parsed.expression.name);
            parsed.expression = { name: 'neutral', timing: 'during' };
          }
        }
        
        const validTimings = ['before', 'during', 'after', null];
        
        if (parsed.animation && !validTimings.includes(parsed.animation.timing)) {
          console.warn('[ws] Invalid animation timing:', parsed.animation.timing);
          parsed.animation.timing = 'during';
        }
        
        if (parsed.expression && !validTimings.includes(parsed.expression.timing)) {
          console.warn('[ws] Invalid expression timing:', parsed.expression.timing);
          parsed.expression.timing = 'during';
        }
        
        console.log('[ws] Parsed agent command:', parsed);
        return parsed;
        
      } catch (error) {
        console.warn('[ws] Failed to parse JSON response:', error);
        return null;
      }
    }

    async function executeAgentCommand(command) {
      console.log('[ws] Executing agent command:', command);
      
      const statusDiv = document.getElementById('status');
      
      if (window.enableMessaging) {
        window.enableMessaging();
      }
      if (window.resetMessagingPanel) {
        window.resetMessagingPanel();
      }
      
      if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
        window.lipSyncSystem.setAgentCommandActive(true);
        console.log('[ws] Agent command active - idle loop prevented');
      }
      
      const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || '../assets/';
      
      if (command.animation && command.animation.timing === 'before') {
        console.log('[ws] Playing animation BEFORE speaking:', command.animation.file);
        if (statusDiv) {
          statusDiv.textContent = 'Playing animation before speaking...';
        }
        
        if (window.startSmoothTransition) {
          const action = await window.startSmoothTransition(
            `${ASSET_BASE_URL}VRMA/${command.animation.file}`,
            { loopMode: 2200 }
          );
          console.log('[ws] Before animation started, action:', action);
          
          console.log('[ws] Waiting minimum 5 seconds for before animation...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (action && window.waitForActionEnd) {
            try {
              await window.waitForActionEnd(action, 60000, false);
              console.log('[ws] Before animation finished event received');
            } catch (e) {
              console.warn('[ws] Before animation wait timed out or failed (this is OK):', e);
            }
          }
          
          console.log('[ws] Additional 3 second delay for before animation...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          console.log('[ws] Before animation fully complete, proceeding to speech');
        }
      }
      
      if (command.expression && command.expression.timing === 'before') {
        console.log('[ws] Applying expression BEFORE speaking:', command.expression.name);
        if (window.applyFacialExpression) {
          window.applyFacialExpression(command.expression.name);
        }
      }
      
      if (command.animation && command.animation.timing === 'during') {
        console.log('[ws] Playing animation DURING speaking:', command.animation.file);
        if (window.startSmoothTransition) {
          await window.startSmoothTransition(`${ASSET_BASE_URL}VRMA/${command.animation.file}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (command.expression && command.expression.timing === 'during') {
        console.log('[ws] Applying expression DURING speaking:', command.expression.name);
        if (window.applyFacialExpression) {
          window.applyFacialExpression(command.expression.name);
        }
      }
      
      if (command.text && window.lipSyncSystem) {
        console.log('[ws] Starting lip sync with text:', command.text.substring(0, 30) + '...');
        
        if (window.hideAllPanels) {
          window.hideAllPanels();
        }
        
        if (statusDiv) {
          const displayText = command.text.length > 50 ? command.text.substring(0, 50) + '...' : command.text;
          statusDiv.textContent = 'Speaking: ' + displayText;
        }
        
        window.lipSyncSystem.startSpeaking(command.text);
        
        await new Promise((resolve) => {
          let notTalkingCount = 0;
          const checkInterval = setInterval(() => {
            if (!window.lipSyncSystem.isTalking()) {
              notTalkingCount++;
              if (notTalkingCount >= 10) {
                clearInterval(checkInterval);
                console.log('[ws] Lip sync confirmed complete after 10 checks');
                resolve();
              }
            } else {
              notTalkingCount = 0;
            }
          }, 100);
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (window.restorePanels) {
          window.restorePanels();
        }
      }
      
      if (command.animation && command.animation.timing === 'after') {
        console.log('[ws] Playing animation AFTER speaking:', command.animation.file);
        if (statusDiv) {
          statusDiv.textContent = 'Playing animation after speaking...';
        }
        
        if (window.startSmoothTransition) {
          const action = await window.startSmoothTransition(
            `${ASSET_BASE_URL}VRMA/${command.animation.file}`,
            { loopMode: 2200 }
          );
          console.log('[ws] After animation started, action:', action);
          
          console.log('[ws] Waiting minimum 5 seconds for after animation...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (action && window.waitForActionEnd) {
            try {
              await window.waitForActionEnd(action, 60000, false);
              console.log('[ws] After animation finished event received');
            } catch (e) {
              console.warn('[ws] After animation wait timed out or failed (this is OK):', e);
            }
          }
          
          console.log('[ws] Additional 3 second delay for after animation...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          console.log('[ws] After animation fully complete');
        }
      }
      
      if (command.expression && command.expression.timing === 'after') {
        console.log('[ws] Applying expression AFTER speaking:', command.expression.name);
        if (window.applyFacialExpression) {
          window.applyFacialExpression(command.expression.name);
        }
        
        setTimeout(() => {
          console.log('[ws] Resetting expression to neutral');
          if (window.resetExpressionToNeutral) {
            window.resetExpressionToNeutral();
          }
        }, 2000);
      }
      
      console.log('[ws] Returning to idle loop with neutral expression');
      if (window.loadIdleLoop) {
        await window.loadIdleLoop();
      }
      
      if (window.resetExpressionToNeutral) {
        window.resetExpressionToNeutral();
      }
      
      if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
        window.lipSyncSystem.setAgentCommandActive(false);
        console.log('[ws] Agent command complete - idle loop allowed again');
      }
    }

    function handleHistoryResponse(data) {
      console.log('\n========== WEBSOCKET HISTORY RESPONSE START ==========');
      console.log('[ws] History response received');
      console.log('[ws] Response OK:', data.ok);
      console.log('[ws] Response ID:', data.id);
      
      if (!data.ok) {
        console.error('[ws] ERROR: Response not OK');
        console.error('[ws] Error details:', data.payload.error || data);
        return;
      }
      
      const messages = data.payload.messages || [];
      const totalCount = data.payload.totalCount || 0;
      const hasMore = data.payload.hasMore || false;
      
      console.log('\n[ws] HISTORY METADATA:');
      console.log('  Messages in this batch:', messages.length);
      console.log('  Total messages available:', totalCount);
      console.log('  Has more messages:', hasMore);
      
      if (window.displayHistoryMessages) {
        window.displayHistoryMessages(messages, totalCount, hasMore);
      } else {
        console.warn('[ws] displayHistoryMessages function not available');
      }
    }

    function handleSpeakCommand(data) {
      console.log('[ws] Speak command:', data.text);
      
      if (window.lipSyncSystem && data.text) {
        window.lipSyncSystem.startSpeaking(data.text);
        sendStatus('speaking');
      }
    }

    function handleAnimateCommand(data) {
      console.log('[ws] Animate command:', data.animation);
      
      const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || '../assets/';
      
      if (data.animation && window.startSmoothTransition) {
        sendStatus('animating', { animation: data.animation });
        window.startSmoothTransition(`${ASSET_BASE_URL}VRMA/${data.animation}`)
          .then(() => {
            sendStatus('idle');
          })
          .catch(error => {
            console.error('[ws] Animation error:', error);
            sendStatus('error', { error: error.message });
          });
      }
    }

    function handleExpressCommand(data) {
      console.log('[ws] Express command:', data.expression);
      
      if (window.applyFacialExpression && data.expression) {
        window.applyFacialExpression(data.expression);
        sendStatus('expressing', { expression: data.expression });
      }
    }

    function handleError(error) {
      console.error('[ws] WebSocket error:', error);
      isConnected = false;
    }

    function handleClose(event) {
      console.log('[ws] WebSocket closed:', event.code, event.reason);
      isConnected = false;
      
      if (reconnectAttempts < CONFIG.maxReconnectAttempts) {
        scheduleReconnect();
      } else {
        console.error('[ws] Max reconnection attempts reached');
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      
      reconnectAttempts++;
      console.log(`[ws] Scheduling reconnect attempt ${reconnectAttempts}/${CONFIG.maxReconnectAttempts} in ${CONFIG.reconnectInterval}ms`);
      
      reconnectTimer = setTimeout(() => {
        initWebSocket();
      }, CONFIG.reconnectInterval);
    }

    function sendMessage(data) {
      const message = JSON.stringify(data);
      
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          console.log('[ws] Sent message:', data);
        } catch (error) {
          console.error('[ws] Error sending message:', error);
          queueMessage(data);
        }
      } else {
        console.log('[ws] WebSocket not connected, queuing message');
        queueMessage(data);
      }
    }

    function queueMessage(data) {
      messageQueue.push(data);
      if (messageQueue.length > 50) {
        messageQueue.shift();
      }
    }

    function flushMessageQueue() {
      while (messageQueue.length > 0) {
        const message = messageQueue.shift();
        sendMessage(message);
      }
    }

    function sendStatus(state, details = {}) {
      sendMessage({
        type: 'status',
        state: state,
        timestamp: Date.now(),
        ...details
      });
    }

    function isWebSocketConnected() {
      return isConnected;
    }

    function closeWebSocket() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      if (ws) {
        ws.close();
        ws = null;
      }
      
      isConnected = false;
      messageQueue = [];
      reconnectAttempts = 0;
    }

    return {
      initWebSocket,
      sendMessage,
      isWebSocketConnected,
      closeWebSocket
    };
})();

// ============================================================
// HISTORY MODULE
// ============================================================
const HistoryModule = (() => {
    let historyPanel = null;
    let historyMessages = [];
    let currentOffset = 0;
    let hasMoreMessages = false;
    let totalCount = 0;
    let isLoadingHistory = false;
    let displayedTimestamps = new Set();
    let allPanelsVisible = false;
    let visiblePanelsBeforeHide = [];

    function initHistoryPanel() {
        console.log('[history] Initializing history panel');
        
        historyPanel = document.createElement('div');
        historyPanel.id = 'history-panel';
        historyPanel.style.display = 'none';
        historyPanel.style.position = 'absolute';
        historyPanel.style.bottom = '100px';
        historyPanel.style.left = '10px';
        historyPanel.style.width = 'auto';
        historyPanel.style.maxWidth = '400px';
        historyPanel.style.maxHeight = '40vh';
        historyPanel.style.background = 'rgba(0, 0, 0, 0.6)';
        historyPanel.style.color = 'white';
        historyPanel.style.padding = '20px';
        historyPanel.style.borderRadius = '12px';
        historyPanel.style.zIndex = '100';
        historyPanel.style.display = 'none';
        historyPanel.style.flexDirection = 'column';
        historyPanel.style.gap = '12px';
        historyPanel.style.overflow = 'hidden';
        
        const header = document.createElement('div');
        header.style.padding = '12px 16px';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        
        const title = document.createElement('span');
        title.textContent = 'Hikari';
        title.style.fontSize = '14px';
        title.style.fontWeight = '600';
        title.style.color = '#ffffff';
        
        const closeButton = document.createElement('button');
        closeButton.textContent = 'x';
        closeButton.style.background = 'transparent';
        closeButton.style.color = '#ffffff';
        closeButton.style.border = 'none';
        closeButton.style.fontSize = '16px';
        closeButton.style.cursor = 'pointer';
        closeButton.style.padding = '4px 8px';
        closeButton.style.borderRadius = '4px';
        closeButton.addEventListener('click', hideHistoryPanel);
        
        header.appendChild(title);
        header.appendChild(closeButton);
        
        const messagesContainer = document.createElement('div');
        messagesContainer.id = 'history-messages';
        messagesContainer.style.flex = '1';
        messagesContainer.style.overflowY = 'auto';
        messagesContainer.style.padding = '12px 16px';
        messagesContainer.style.display = 'flex';
        messagesContainer.style.flexDirection = 'column';
        messagesContainer.style.gap = '12px';
        
        historyPanel.appendChild(header);
        historyPanel.appendChild(messagesContainer);
        document.body.appendChild(historyPanel);
        
        console.log('[history] History panel initialized');
    }

    function showHistoryPanel() {
        if (historyPanel) {
            historyPanel.style.display = 'flex';
            console.log('[history] Panel shown');
            
            if (window.showMessagingPanel) {
                window.showMessagingPanel();
            }
            
            if (historyMessages.length === 0) {
                fetchConversationHistory(0);
            } else {
                const messagesContainer = document.getElementById('history-messages');
                if (messagesContainer) {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    console.log('[history] Scrolled to bottom (latest messages)');
                }
        }
    }

    function hideHistoryPanel() {
        if (historyPanel) {
            historyPanel.style.display = 'none';
            console.log('[history] Panel hidden');
            
            if (window.hideMessagingPanel) {
                window.hideMessagingPanel();
            }
        }
    }

    function toggleHistoryPanel() {
        if (historyPanel.style.display === 'none' || !historyPanel.style.display) {
            showHistoryPanel();
        } else {
            hideHistoryPanel();
        }
    }

    async function fetchConversationHistory(offset = 0) {
        console.log('[history] fetchConversationHistory called with offset:', offset);
        if (isLoadingHistory) {
            console.log('[history] Already loading history, ignoring request');
            return;
        }
        
        isLoadingHistory = true;
        
        if (offset === 0) {
            currentOffset = 0;
            displayedTimestamps.clear();
            console.log('[history] Reset currentOffset and cleared displayedTimestamps for new fetch');
        }
        
        console.log('[history] Fetching history with offset:', offset);
        
        try {
            const requestId = 'history-' + Date.now();
            
            if (window.sendMessage) {
                window.sendMessage({
                    type: 'req',
                    id: requestId,
                    method: 'chat.history',
                    params: {
                        sessionKey: 'main',
                        limit: 100
                    }
                });
                
                console.log('[history] History request sent:', requestId);
            } else {
                console.error('[history] sendMessage not available');
            }
        } catch (error) {
            console.error('[history] Error fetching history:', error);
            isLoadingHistory = false;
        }
    }

    function loadMoreMessages() {
        console.log('[history] Loading more messages, current offset:', currentOffset);
        
        const newOffset = currentOffset + 100;
        fetchConversationHistory(newOffset);
    }

    function displayHistoryMessages(messages, totalCountMsg, hasMoreMsg) {
        console.log('\n========== CONVERSATION HISTORY DISPLAY START ==========');
        console.log('[history] Total messages fetched:', messages.length);
        console.log('[history] Total count available:', totalCountMsg);
        console.log('[history] Has more messages:', hasMoreMsg);
        console.log('[history] Current offset:', currentOffset);
        
        const messagesContainer = document.getElementById('history-messages');
        if (!messagesContainer) {
            console.error('[history] ERROR: messagesContainer not found!');
            return;
        }
        
        totalCount = totalCountMsg;
        hasMoreMessages = hasMoreMsg;
        
        if (currentOffset === 0) {
            messagesContainer.innerHTML = '';
            historyMessages = [];
            console.log('[history] Cleared container for initial load (offset=0)');
        }
        
        console.log('\n--- FILTERING PROCESS ---');
        let acceptedCount = 0;
        let rejectedCount = 0;
        
        messages.forEach((msg, msgIndex) => {
            console.log(`\n[Filtering Message ${msgIndex + 1}/${messages.length}]`);
            console.log('  Role:', msg.role);
            console.log('  Timestamp:', msg.timestamp);
            
            if (msg.role === 'toolResult') {
                console.log('  REJECTED: Role is "toolResult"');
                rejectedCount++;
                return;
            }
            console.log('  Passed toolResult check');
            
            if (!msg.content || msg.content.length === 0) {
                console.log('  REJECTED: No content or empty content array');
                rejectedCount++;
                return;
            }
            console.log('  Passed content existence check (content.length:', msg.content.length + ')');
            
            const textContent = msg.content.find(item => item.type === 'text');
            if (!textContent || !textContent.text) {
                console.log('  REJECTED: No text content found in content array');
                rejectedCount++;
                return;
            }
            console.log('  Found text content');
            
            let text = textContent.text;
            console.log('  Text preview:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
            
            if (text.includes('HEARTBEAT') || text.includes('HEARTBEAT_OK')) {
                console.log('  REJECTED: HEARTBEAT system message');
                rejectedCount++;
                return;
            }
            console.log('  Not a HEARTBEAT message');
            
            if (text.includes('New session started') || text.includes('✅')) {
                console.log('  REJECTED: Session system message');
                rejectedCount++;
                return;
            }
            console.log('  Not a session message');
            
            if (text.includes('Read HEARTBEAT.md')) {
                console.log('  REJECTED: HEARTBEAT instruction message');
                rejectedCount++;
                return;
            }
            console.log('  Not a HEARTBEAT instruction');
            
            if (text.includes('/new or /reset') || text.includes('Do not mention internal steps')) {
                console.log('  REJECTED: Session instruction message');
                rejectedCount++;
                return;
            }
            console.log('  Not a session instruction');
            
            if (text.includes('===== USER MESSAGE =====') || 
                text.includes('===== SYSTEM INSTRUCTIONS =====') ||
                text.includes('AVAILABLE ANIMATIONS') ||
                text.includes('AVAILABLE EXPRESSIONS') ||
                text.includes('RESPONSE FORMAT') ||
                text.includes('TIMING OPTIONS') ||
                text.includes('IMPORTANT:')) {
                console.log('  REJECTED: System instruction message');
                rejectedCount++;
                return;
            }
            console.log('  Not a system instruction block');
            
            const systemPromptPatterns = [
                /^User touched (?:your|the) \w+$/i,
                /^User (?:clicked|tapped|pressed) \w+$/i,
                /^User (?:said|typed|entered) \w+$/i,
                /^(?:Touch|Click|Tap|Press) \w+$/i,
                /^System: /i
            ];
            
            const isSystemPrompt = systemPromptPatterns.some(pattern => pattern.test(text.trim()));
            if (isSystemPrompt) {
                console.log('  REJECTED: System prompt (not actual user message)');
                rejectedCount++;
                return;
            }
            console.log('  Not a system prompt');
            
            if (msg.role === 'toolResult' &&
                text.trim().startsWith('{') && 
                (text.includes("'text'") || text.includes('"text"')) &&
                (text.includes("'animation'") || text.includes('"animation"')) &&
                (text.includes("'expression'") || text.includes('"expression"'))) {
                console.log('  REJECTED: Raw JSON response from toolResult');
                rejectedCount++;
                return;
            }
            console.log('  Not a raw JSON response from toolResult');
            
            if (msg.role === 'assistant' && text.trim().startsWith('{')) {
                let parsed;
                try {
                    parsed = JSON.parse(text);
                    if (parsed.text) {
                        text = parsed.text;
                        console.log('  Extracted text from JSON:', text.substring(0, 100) + '...');
                    }
                } catch (e1) {
                    console.log('  Standard JSON parse failed, trying direct text extraction');
                    try {
                        const textMatch = text.match(/'text'\s*:\s*'([^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[^']*(?:\\'[:';
                console.log('  ❌ REJECTED: User touched (?:your|the) \w+$/i,');
                rejectedCount++;
                return;
            }
            console.log('  ✓ Passed all filters');
            console.log('  ✅ ACCEPTED: All filters passed');
            acceptedCount++;
            addMessageToHistory(msg, text);
            historyMessages.push(msg);
        });
        
        console.log('\n--- FILTERING SUMMARY ---');
        console.log('  Total messages processed:', messages.length);
        console.log('  Accepted messages:', acceptedCount);
        console.log('  Rejected messages:', rejectedCount);
        console.log('  Acceptance rate:', ((acceptedCount / messages.length) * 100).toFixed(2) + '%');
        
        currentOffset += messages.length;
        
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        isLoadingHistory = false;
        
        console.log('[history] Messages displayed, total:', historyMessages.length);
    }

    function addMessageToHistory(message, processedText) {
        const messagesContainer = document.getElementById('history-messages');
        if (!messagesContainer) return;
        
        const from = message.role === 'user' ? 'user' : 'agent';
        
        let displayText = processedText || '';
        
        console.log('[history] addMessageToHistory called with processedText:', displayText.substring(0, 100) + (displayText.length > 100 ? '...' : ''));
        
        if (!displayText || displayText.trim() === '') {
            console.log('[history] Skipping message with empty text');
            return;
        }
        
        const beforeBracketRemoval = displayText;
        displayText = displayText.replace(/\[.*?\]/g, '').trim();
        if (beforeBracketRemoval !== displayText) {
            console.log('[history] Removed bracket content, result:', displayText.substring(0, 100) + (displayText.length > 100 ? '...' : ''));
        }
        
        if (!displayText || displayText.trim() === '') {
            console.log('[history] Skipping message with no displayable text');
            return;
        }
        
        const lines = displayText.split('\n').filter(line => line.trim() !== '');
        
        lines.forEach((lineText, index) => {
            const messageCard = document.createElement('div');
            messageCard.className = 'history-message';
            messageCard.style.padding = '8px 10px';
            messageCard.style.borderRadius = '6px';
            messageCard.style.display = 'flex';
            messageCard.style.flexDirection = 'column';
            messageCard.style.gap = '4px';
            messageCard.style.maxWidth = '80%';
            
            if (from === 'user') {
                messageCard.style.background = 'rgba(128, 128, 128, 0.2)';
                messageCard.style.borderLeft = '3px solid #808080';
                messageCard.style.alignSelf = 'flex-end';
            } else if (from === 'agent') {
                messageCard.style.background = 'rgba(76, 175, 80, 0.2)';
                messageCard.style.borderLeft = '3px solid #4CAF50';
                messageCard.style.alignSelf = 'flex-start';
            } else {
                messageCard.style.background = 'rgba(128, 128, 128, 0.2)';
                messageCard.style.borderLeft = '3px solid #808080';
                messageCard.style.alignSelf = 'flex-start';
            }
            
            if (index === 0) {
                const header = document.createElement('div');
                header.style.display = 'flex';
                header.style.justifyContent = 'space-between';
                header.style.alignItems = 'center';
                header.style.fontSize = '11px';
                header.style.fontWeight = '600';
                header.style.color = '#e0e0e0';
                
                const sender = document.createElement('span');
                sender.textContent = from === 'user' ? '▶ You' : 'Hikari';
                
                const timestamp = document.createElement('span');
                timestamp.textContent = formatTimestamp(message.timestamp);
                
                header.appendChild(sender);
                header.appendChild(timestamp);
                
                messageCard.appendChild(header);
            }
            
            const text = document.createElement('div');
            text.style.color = '#ffffff';
            text.style.fontSize = '13px';
            text.style.lineHeight = '1.4';
            text.style.wordBreak = 'break-word';
            
            text.textContent = lineText;
            
            messageCard.appendChild(text);
            
            messagesContainer.appendChild(messageCard);
        });
        
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function clearHistoryDisplay() {
        const messagesContainer = document.getElementById('history-messages');
        if (messagesContainer) {
            messagesContainer.innerHTML = '';
            historyMessages = [];
            currentOffset = 0;
            hasMoreMessages = false;
            displayedTimestamps.clear();
            console.log('[history] History cleared');
    }

    function hideAllPanels() {
        const lipSyncPanel = document.getElementById('lipSyncPanel');
        
        visiblePanelsBeforeHide = [];
        
        if (lipSyncPanel && lipSyncPanel.style.display !== 'none') {
            visiblePanelsBeforeHide.push('messaging');
            console.log('[history] Messaging panel was visible, hiding...');
        }
        
        if (historyPanel && historyPanel.style.display !== 'none') {
            visiblePanelsBeforeHide.push('history');
            console.log('[history] History panel was visible, hiding...');
        }
        
        if (visiblePanelsBeforeHide.includes('messaging') && window.hideMessagingPanel) {
            window.hideMessagingPanel();
        }
        
        if (visiblePanelsBeforeHide.includes('history')) {
            hideHistoryPanel();
        }
        
        allPanelsVisible = (visiblePanelsBeforeHide.length > 0);
        console.log('[history] All panels hidden (visible panels were:', visiblePanelsBeforeHide.join(', ') + ')');
    }

    function restorePanels() {
        if (visiblePanelsBeforeHide.includes('messaging') && window.showMessagingPanel) {
            window.showMessagingPanel();
            console.log('[history] Messaging panel restored');
        } else if (visiblePanelsBeforeHide.includes('history') && showHistoryPanel) {
            showHistoryPanel();
            console.log('[history] History panel restored');
        } else {
            console.log('[history] No panel to restore (was hidden)');
        }
    }

    function formatTimestamp(isoTimestamp) {
        try {
            const date = new Date(isoTimestamp);
            
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const timeStr = `${hours}:${minutes}`;
            
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const month = months[date.getMonth()];
            const day = date.getDate();
            const dateStr = `${month} ${day}`;
            
            return `${timeStr} - ${dateStr}`;
        } catch (error) {
            console.error('[history] Error formatting timestamp:', error);
            return isoTimestamp;
        }
    }

    return {
        initHistoryPanel,
        showHistoryPanel,
        hideHistoryPanel,
        toggleHistoryPanel,
        fetchConversationHistory,
        loadMoreMessages,
        displayHistoryMessages,
        hideAllPanels,
        restorePanels
    };
})();

// ============================================================
// WEB-SPECIFIC SETUP
// ============================================================

/**
 * Initialize Web-specific features
 */
function initWebFeatures() {
    console.log('[web] Initializing Web-specific features');
    
    // Setup window resize handler
    window.addEventListener('resize', CoreModule.handleResize);
    
    // Setup touch controls for mobile
    setupTouchControls();
    
    // Remove window dragging elements (Electron-only)
    removeDragElements();
    
    console.log('[web] Web features initialized');
}

/**
 * Setup touch controls for mobile devices
 */
function setupTouchControls() {
    console.log('[web] Setting up touch controls');
    
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    
    // Add touch event listeners
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    
    console.log('[web] Touch controls enabled');
}

/**
 * Handle touch start
 */
function handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
}

/**
 * Handle touch move
 */
function handleTouchMove(e) {
    e.preventDefault();
}

/**
 * Handle touch end
 */
function handleTouchEnd(e) {
    e.preventDefault();
}

/**
 * Remove Electron-specific drag elements
 */
function removeDragElements() {
    const dragButton = document.querySelector('.drag-btn-wrapper');
    
    if (dragButton) {
        dragButton.style.display = 'none';
        console.log('[web] Removed drag button');
    }
}

/**
 * Setup UI event listeners
 */
function setupUIEventListeners() {
    console.log('[web] Setting up UI event listeners');
    
    // WebSocket URL configuration
    setupWebSocketUrlInput();
    
    // Reset camera button
    const resetCameraBtn = document.getElementById('resetCameraBtn');
    if (resetCameraBtn) {
        resetCameraBtn.addEventListener('click', () => {
            if (window.camera && window.controls) {
                window.camera.position.set(0.0, 1.0, 4.5);
                window.controls.target.set(0.0, 1.0, 0.0);
                window.controls.update();
                console.log('[web] Camera reset');
            }
        });
    }
    
    // Lip sync panel
    const textInputPanel = document.getElementById('textInputPanel');
    const speakBtnPanel = document.getElementById('speakBtnPanel');
    
    if (speakBtnPanel) {
        speakBtnPanel.addEventListener('click', () => {
            if (window.lipSyncSystem && textInputPanel) {
                const text = textInputPanel.value.trim();
                if (text) {
                    const statusDiv = document.getElementById('status');
                    if (statusDiv) {
                        statusDiv.textContent = 'Waiting for OpenClaw reply...';
                    }
                    
                    // Hide all panels when message is sent
                    const controlsPanel = document.querySelector('.controls');
                    const lipSyncPanel = document.getElementById('lipSyncPanel');
                    const historyPanel = document.getElementById('history-panel');
                    
                    if (controlsPanel) {
                        controlsPanel.style.display = 'none';
                        console.log('[web] Hidden controls panel');
                    }
                    if (lipSyncPanel) {
                        lipSyncPanel.style.display = 'none';
                        console.log('[web] Hidden lip sync panel');
                    }
                    if (historyPanel) {
                        historyPanel.style.display = 'none';
                        console.log('[web] Hidden history panel');
                    }
                    
                    // Disable messaging controls and set to thinking state
                    CoreModule.disableMessaging();
                    CoreModule.setMessagingThinking();
                    
                    // Generate unique request ID
                    const requestId = 'req-' + Date.now();
                    const idempotencyKey = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    
                    // Construct full message with user message + system instructions
                    const fullMessage = `===== USER MESSAGE =====
${text}

===== SYSTEM INSTRUCTIONS =====
You are communicating through a VRM (Virtual Reality Model)3D character viewer.

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
- 'after': play animation/expression AFTER speaking completes
- null: no animation/expression needed (use defaults)

IMPORTANT: Do NOT use markdown code blocks (\\`\\`json or \\`\\`) around your JSON response. Just provide the raw JSON object directly.
Note: Animations play fully before proceeding. Expression resets to 'neutral' when returning to idle_loop.`;
                    
                    // Send request to OpenClaw agent with full context
                    WebSocketModule.sendMessage({
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
                    
                    console.log('[web] Sent request to OpenClaw:', requestId);
                }
            }
        });
        
        if (textInputPanel) {
            textInputPanel.addEventListener('keypress', (event) => {
                if (event.key === 'Enter' && speakBtnPanel && !speakBtnPanel.disabled) {
                    speakBtnPanel.click();
                }
            });
        }
    
    // Expression select
    const expressionSelect = document.getElementById('expressionSelect');
    if (expressionSelect) {
        expressionSelect.addEventListener('change', () => {
            if (window.applyFacialExpression) {
                const expression = expressionSelect.value;
                if (expression) {
                    window.applyFacialExpression(expression);
                }
            }
        });
    }
    
    // Speaking speed control - setup after init
    const speakingSpeedSlider = document.getElementById('speakingSpeedSlider');
    const speakingSpeedValue = document.getElementById('speakingSpeedValue');
    if (speakingSpeedSlider && speakingSpeedValue) {
        speakingSpeedSlider.addEventListener('input', (e) => {
            if (window._internalLipSync) {
                const speed = parseFloat(e.target.value);
                speakingSpeedValue.textContent = speed.toFixed(1) + 'x';
                window._internalLipSync.setSpeakingSpeed(speed);
                console.log('[web] Speaking speed set to:', speed);
            }
        });
    }
    
    // Light controls
    setupLightControls();
    
    console.log('[web] UI event listeners set up');
}

/**
 * Setup light brightness controls
 */
function setupLightControls() {
    const lightControls = [
        { id: 'keyLight', valueId: 'keyLightValue' },
        { id: 'fillLight', valueId: 'fillLightValue' },
        { id: 'rimLight', valueId: 'rimLightValue' },
        { id: 'topLight', valueId: 'topLightValue' },
        { id: 'ambientLight', valueId: 'ambientLightValue' }
    ];

    lightControls.forEach(({ id, valueId }) => {
        const slider = document.getElementById(`${id}Slider`);
        const valueSpan = document.getElementById(valueId);

        if (slider && valueSpan && window[id]) {
            slider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                window[id].intensity = value;
                valueSpan.textContent = value.toFixed(1);
            });
        });
    });
}

/**
 * Setup toggle buttons
 */
function setupToggleButtons() {
    // Set background to loading.gif
    document.body.style.backgroundImage = 'url(../assets/loading.gif)';
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
    
    // Add CSS for toggle buttons (invisible until hovered, like Electron)
    const style = document.createElement('style');
    style.textContent = `
        .toggle-btn {
            position: fixed;
            z-index: 1000;
            width: 75px;
            height: 75px;
            padding: 12px 16px;
            background: transparent;
            color: transparent;
            border: none;
            cursor: pointer;
            font-size: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            opacity: 0;
        }
        .toggle-btn:hover {
            background: linear-gradient(145deg, #4CAF50, #2e8b57);
            color: white;
            opacity: 0.7;
            transform: translateY(-2px);
            box-shadow: 0 6px 12px rgba(0, 0, 0, 0.4);
        }
        .toggle-btn:active {
            transform: translateY(0);
        }
    `;
    document.head.appendChild(style);

    // Settings panel toggle button (top-left)
    const toggleSettingsBtn = document.createElement('button');
    toggleSettingsBtn.className = 'toggle-btn';
    toggleSettingsBtn.textContent = '⚙️';
    toggleSettingsBtn.style.top = '10px';
    toggleSettingsBtn.style.left = '10px';
    toggleSettingsBtn.addEventListener('click', () => {
        const panel = document.querySelector('.controls');
        if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    });
    document.body.appendChild(toggleSettingsBtn);

    // History panel toggle button (bottom-left - messaging button removed)
    const toggleHistoryBtn = document.createElement('button');
    toggleHistoryBtn.className = 'toggle-btn';
    toggleHistoryBtn.textContent = 'Hikari';
    toggleHistoryBtn.style.bottom = '10px';
    toggleHistoryBtn.style.left = '10px';
    toggleHistoryBtn.addEventListener('click', HistoryModule.toggleHistoryPanel);
    document.body.appendChild(toggleHistoryBtn);

    // Hide panels by default
    const controlsPanel = document.querySelector('.controls');
    const lipSyncPanel = document.getElementById('lipSyncPanel');
    
    if (controlsPanel) {
        controlsPanel.style.display = 'none';
    }
    
    if (lipSyncPanel) {
        lipSyncPanel.style.display = 'none';
    }
    
    console.log('[web] Toggle buttons set up, panels hidden');
}

/**
 * Setup WebSocket URL input
 */
function setupWebSocketUrlInput() {
    console.log('[web] Setting up WebSocket URL input');
    
    const wsUrlInput = document.getElementById('websocketUrlInput');
    const connectWsBtn = document.getElementById('connectWsBtn');
    
    // Load saved WebSocket URL
    const savedWsUrl = localStorage.getItem('websocket_url');
    if (wsUrlInput) {
        wsUrlInput.value = savedWsUrl || '';
    }
    
    if (connectWsBtn) {
        connectWsBtn.addEventListener('click', () => {
            const url = wsUrlInput.value.trim();
            if (url) {
                // Save to localStorage
                localStorage.setItem('websocket_url', url);
                console.log('[web] WebSocket URL saved:', url);
                
                // Show status message
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    statusDiv.textContent = 'WebSocket URL updated! Reconnecting...';
                    statusDiv.style.color = '#4CAF50';
                }
                
                // Reconnect with new URL
                WebSocketModule.closeWebSocket();
                setTimeout(() => {
                    WebSocketModule.initWebSocket();
                }, 500);
            } else {
                // Clear URL setting
                localStorage.removeItem('websocket_url');
                console.log('[web] WebSocket URL cleared');
                
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    statusDiv.textContent = 'WebSocket URL cleared. Reconnecting...';
                    statusDiv.style.color = '#4CAF50';
                }
                
                // Reconnect with default URL
                WebSocketModule.closeWebSocket();
                setTimeout(() => {
                    WebSocketModule.initWebSocket();
                }, 500);
            }
        });
        
        // Allow Enter key to trigger connect
        if (wsUrlInput) {
            wsUrlInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    connectWsBtn.click();
                }
            });
        }
    }

/**
 * Setup token configuration dialog
 */
function setupTokenDialog() {
    // Check if token is configured
    const savedToken = localStorage.getItem('openclaw_token');
    
    // Load saved token value into input
    const tokenInput = document.getElementById('tokenInput');
    if (tokenInput) {
        tokenInput.value = savedToken || '';
    }
    
    // Handle save button
    const saveTokenBtn = document.getElementById('saveTokenBtn');
    if (saveTokenBtn) {
        saveTokenBtn.addEventListener('click', () => {
            const token = tokenInput ? tokenInput.value.trim() : '';
            if (token) {
                localStorage.setItem('openclaw_token', token);
                console.log('[web] Token saved to localStorage');
                
                // Show success message
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    statusDiv.textContent = 'Token saved! Reconnecting...';
                    statusDiv.style.color = '#4CAF50';
                }
                
                // Reconnect WebSocket with new token
                WebSocketModule.closeWebSocket();
                WebSocketModule.initWebSocket();
            }
        });
    }
    
    if (!savedToken) {
        console.warn('[web] No token configured. Token can be set in settings panel');
    } else {
        console.log('[web] Using saved token from localStorage');
    }
}

/**
 * Display connection status
 */
function displayConnectionStatus() {
    const statusIndicator = document.createElement('div');
    statusIndicator.id = 'connection-status';
    statusIndicator.style.position = 'fixed';
    statusIndicator.style.top = '10px';
    statusIndicator.style.right = '10px';
    statusIndicator.style.padding = '8px 12px';
    statusIndicator.style.borderRadius = '8px';
    statusIndicator.style.fontSize = '12px';
    statusIndicator.style.fontWeight = 'bold';
    statusIndicator.style.zIndex = '1000';
    statusIndicator.style.background = 'rgba(128, 128, 128, 0.8)';
    statusIndicator.style.color = 'white';
    statusIndicator.style.transition = 'opacity 1s ease';
    statusIndicator.textContent = 'Connecting...';
    
    document.body.appendChild(statusIndicator);
    
    let connectionShownTime = 0;
    let fadeOutTimeout = null;
    
    // Update status based on WebSocket connection
    const checkConnection = setInterval(() => {
        const isConnected = WebSocketModule.isWebSocketConnected();
        
        if (isConnected) {
            statusIndicator.style.background = 'rgba(76, 175, 80, 0.8)';
            statusIndicator.style.opacity = '1';
            statusIndicator.textContent = 'Connected';
            
            // Hide immediately when connected
            statusIndicator.style.display = 'none';
            
            // Record first connection time
            if (connectionShownTime === 0) {
                connectionShownTime = Date.now();
            }
            
            // Fade out after 5 seconds if still connected
            if (fadeOutTimeout) {
                clearTimeout(fadeOutTimeout);
            fadeOutTimeout = setTimeout(() => {
                if (WebSocketModule.isWebSocketConnected()) {
                    statusIndicator.style.opacity = '0';
                }
            }, 5000);
            
        } else {
            statusIndicator.style.background = 'rgba(244, 67, 54, 0.8)';
            statusIndicator.style.opacity = '1';
            statusIndicator.textContent = 'Disconnected';
            
            // Reset connection time when disconnected
            connectionShownTime = 0;
            
            // Clear fade out timeout
            if (fadeOutTimeout) {
                clearTimeout(fadeOutTimeout);
                fadeOutTimeout = null;
            }
        }
    }, 1000);
    
    window.connectionCheckInterval = checkConnection;
}

/**
 * Show device info
 */
function showDeviceInfo() {
    const userAgent = navigator.userAgent;
    let deviceType = 'Desktop';
    
    if (/Mobile|Android|iPhone|iPad|iPod/i.test(userAgent)) {
        deviceType = 'Mobile';
    } else if (/Tablet/i.test(userAgent)) {
        deviceType = 'Tablet';
    }
    
    console.log('[web] Device:', deviceType);
    console.log('[web] User Agent:', userAgent);
}

/**
 * Expose core objects to window for WebSocket access
 */
function exposeCoreObjects() {
    // Store references for IPC handlers
    window.addEventListener('DOMContentLoaded', () => {
        // These will be set by core.js initialization
        setTimeout(() => {
            window.camera = window.camera;
            window.controls = window.controls;
            
            // Attach messaging control functions to window for WebSocket access
            window.enableMessaging = CoreModule.enableMessaging;
            window.disableMessaging = CoreModule.disableMessaging;
            window.setMessagingThinking = CoreModule.setMessagingThinking;
            window.resetMessagingPanel = CoreModule.resetMessagingPanel;
            window.showMessagingPanel = CoreModule.showMessagingPanel;
            window.hideMessagingPanel = CoreModule.hideMessagingPanel;
            
            // Expose conversation history functions
            window.fetchConversationHistory = HistoryModule.fetchConversationHistory;
            window.loadMoreMessages = HistoryModule.loadMoreMessages;
            window.hideAllPanels = HistoryModule.hideAllPanels;
            window.restorePanels = HistoryModule.restorePanels;
            
            console.log('[web] Core objects and messaging functions exposed');
        }, 100);
    });
}

/**
 * Initialize WebSocket connection
 */
function initWebSocket() {
    // Initialize WebSocket after a short delay to ensure DOM is ready
    setTimeout(() => {
        WebSocketModule.initWebSocket();
    }, 1000);
}

// ============================================================
// INITIALIZATION
// ============================================================
async function initWebApp() {
    console.log('[web] Initializing Hikari Web App');
    
    try {
        // Show device info
        showDeviceInfo();
        
        // Initialize core functionality
        await CoreModule.init();
        
        // Expose messaging functions to window for websocket.js access
        window.enableMessaging = CoreModule.enableMessaging;
        window.disableMessaging = CoreModule.disableMessaging;
        window.setMessagingThinking = CoreModule.setMessagingThinking;
        window.resetMessagingPanel = CoreModule.resetMessagingPanel;
        window.showMessagingPanel = CoreModule.showMessagingPanel;
        window.hideMessagingPanel = CoreModule.hideMessagingPanel;
        
        console.log('[web] Messaging functions exposed to window with camera restoration');
        
        // Initialize history panel
        HistoryModule.initHistoryPanel();
        
        // Expose history functions to window
        window.displayHistoryMessages = HistoryModule.displayHistoryMessages;
        
        // Expose WebSocket sendMessage function for conversation history
        window.sendMessage = WebSocketModule.sendMessage;
        console.log('[web] WebSocket sendMessage exposed to window');
        
        console.log('[web] History functions exposed to window');
        
        // Initialize Web-specific features
        initWebFeatures();
        
        // Setup token
        setupTokenDialog();
        
        // Display connection status
        displayConnectionStatus();
        
        // Initialize WebSocket connection
        initWebSocket();
        
        console.log('[web] Hikari Web App initialized successfully');
        
        // Random idle system is now started automatically by startAutomaticSequence()
        
    } catch (error) {
        console.error('[web] Initialization error:', error);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = 'Error initializing app: ' + error.message;
        }
    }
}

// Start app
initWebApp();