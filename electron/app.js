/**
 * Hikari Electron App - Merged Application
 * Contains all application logic with namespace modules
 */

import logger from './logger.js';

logger.info('electron', 'Hikari Electron version starting');

// ============================================================
// IMPORTS
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// ============================================================
// EVENT-TO-AGENT SYSTEM
// ============================================================

/**
 * Queue for agent event requests - prevents concurrent requests.
 * Only one request is sent at a time; subsequent requests wait until the current one completes.
 */
let agentRequestQueue = [];
let isAgentRequestInProgress = false;

/**
 * Send an event notification to the agent and display the reply.
 * Requests are queued: if a request is already in progress, this one waits.
 * Used for: animation toggles, panel show/hide, window drag, character walk, character sit.
 * @param {string} eventType - Type of event (e.g., 'action_toggle', 'panel_toggle', 'window_drag', 'character_walk', 'character_sit')
 * @param {string} message - The message to send to the agent
 */
async function sendEventToAgent(eventType, message) {
    // Queue the request
    return new Promise((resolve, reject) => {
        agentRequestQueue.push({ eventType, message, resolve, reject });
        processAgentRequestQueue();
    });
}

// Expose on window so it's accessible from within module IIFEs
window.sendEventToAgent = sendEventToAgent;

async function processAgentRequestQueue() {
    if (isAgentRequestInProgress || agentRequestQueue.length === 0) return;
    
    isAgentRequestInProgress = true;
    const { eventType, message, resolve, reject } = agentRequestQueue.shift();
    
    if (!window.sendAgentMessage) {
        logger.warn('event', `Cannot send ${eventType} event - sendAgentMessage not available`);
        isAgentRequestInProgress = false;
        resolve();
        processAgentRequestQueue();
        return;
    }
    
    logger.info('event', `Sending ${eventType} event to agent:`, message);
    
    // Set flag to prevent new animations from playing while waiting for reply
    // Keep idle_loop looping; if an animation is already playing, let it continue
    window._agentRequestPending = true;
    
    try {
        // Send message to agent (without adding to conversation history to keep it clean)
        const replyText = await WebSocketModule.sendAgentMessageRaw(message);
        
        // Clear pending flag
        window._agentRequestPending = false;
        
        if (replyText && window.lipSyncSystem) {
            // Parse the reply for any JSON commands
            const parsedResponse = WebSocketModule.parseAgentResponse(replyText);
            
            if (parsedResponse && parsedResponse.text) {
                // Add agent reply to local history
                if (window.addLocalHistoryMessage) {
                    window.addLocalHistoryMessage('agent', parsedResponse.text);
                }
                // Execute the agent command (speak + animate)
                await WebSocketModule.executeAgentCommand(parsedResponse);
            } else if (replyText.trim().length > 0) {
                // Plain text reply - just speak it
                if (window.addLocalHistoryMessage) {
                    window.addLocalHistoryMessage('agent', replyText);
                }
                window.lipSyncSystem.startSpeaking(replyText);
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    const displayText = replyText.length > 50 ? replyText.substring(0, 50) + '...' : replyText;
                    statusDiv.textContent = 'Speaking: ' + displayText;
                }
            }
        }
    } catch (error) {
        logger.error('event', `Error sending ${eventType} event:`, error);
        window._agentRequestPending = false;
    }
    
    isAgentRequestInProgress = false;
    resolve();
    // Process next queued request
    processAgentRequestQueue();
}

// ============================================================
// CORE MODULE - Three.js, VRM, Animation, Lip Sync
// ============================================================
const CoreModule = (() => {
    // ============================================================
    // CONFIGURATION
    // ============================================================
    const CONFIG = {
        // Animation transition settings
        BUFFER_TIME: 0.5,
        TRANSITION_TIME: 0.5,
        T_OFFSET: 0.5,
        // Walk sequence configuration
        WALK_WINDOW_OFFSET: 600,
        WALK_START_DELAY: 0,
        WALK_WALK_DURATION: 4.0,
        WALK_TURN_DURATION: 1.0,
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
    let transitionStartTime = 0;
    let transitionDuration = CONFIG.TRANSITION_TIME;
    let walkingInitialRotY = 0;
    let isPlayingWalkSequence = false;
    let walkingWindowInitialPos = null;
    let isPlayingSequence = false;
    let currentIdleTimeout = null;
    let activeFacialExpression = null;
    let blinkSystemEnabled = true;
    let isSitAnimationActive = false;
    let isWindowDragging = false;
    let windowDragOffset = { x: 0, y: 0 };

    // Zoom control state
    const BASE_WINDOW_WIDTH = 600;
    const BASE_WINDOW_HEIGHT = 900;
    const BASE_CAMERA_DISTANCE = 4.5;
    const MIN_ZOOM = 0.5;
    const MAX_ZOOM = 2.5;
    let zoomScale = 1.0;

    // ============================================================
    // DOM ELEMENTS
    // ============================================================
    let animationSelect, expressionSelect, statusDiv, textInputPanel, speakBtnPanel;
    let lipSyncPanel = null;
    let isMessagingDisabled = false;

    // ============================================================
    // THREE.JS SETUP
    // ============================================================
    let renderer, camera, controls, scene;
    let keyLight, fillLight, rimLight, topLight, ambientLight;
    let clock = new THREE.Clock();
    let raycaster, mouse;
    let lastTouchTime = 0;
    const TOUCH_DEBOUNCE_MS = 200;

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
        camera.position.set(0.0, 1.0, BASE_CAMERA_DISTANCE);

        // Initialize orbit controls
        controls = new OrbitControls(camera, renderer.domElement);
        controls.screenSpacePanning = true;
        // Disable default zoom - we handle wheel events customly to also resize the window
        controls.enableZoom = false;
        controls.mouseButtons = {
            LEFT: null,
            MIDDLE: null,
            RIGHT: THREE.MOUSE.ROTATE
        };
        controls.target.set(0.0, 1.0, 0.0);
        controls.update();
        
        // Expose camera and controls to window for web.js access
        window.camera = camera;
        window.controls = controls;
        logger.info('core', 'Camera and controls exposed to window');

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

        logger.info('core', 'Three.js initialized');
    }

    /**
     * Handle window resize
     */
    function handleResize() {
        if (isWindowDragging) return;
        
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    /**
     * Setup touch detection for model interaction
     */
    function setupTouchDetection() {
        if (!renderer) return;
        
        logger.info('touch', 'Setting up touch detection (mouseup trigger)');
        
        let mouseDownPos = null;
        
        // Mouse down handler — record position
        renderer.domElement.addEventListener('mousedown', (event) => {
            if (event.button === 0) {
                mouseDownPos = { x: event.clientX, y: event.clientY };
            }
        });
        
        // Mouse up handler — trigger touch if mouse stayed inside canvas and didn't drag
        renderer.domElement.addEventListener('mouseup', (event) => {
            if (event.button !== 0 || !mouseDownPos) return;
            
            // Check if drag transitioned to window (set by setupWindowDragging)
            if (window.isWindowDragging || window._dragTransitionedToWindow) {
                mouseDownPos = null;
                return;
            }
            
            // Calculate mouse position in normalized device coordinates
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            
            // Check debounce
            const now = Date.now();
            if (now - lastTouchTime < TOUCH_DEBOUNCE_MS) {
                mouseDownPos = null;
                return;
            }
            
            // Only trigger if VRM is loaded
            if (currentVrm) {
                raycaster.setFromCamera(mouse, camera);
                const intersects = raycaster.intersectObject(currentVrm.scene, true);
                
                if (intersects.length > 0) {
                    // Check that mouse didn't move much (it's a click, not a drag)
                    const dx = event.clientX - mouseDownPos.x;
                    const dy = event.clientY - mouseDownPos.y;
                    const moveDistance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (moveDistance < 10) { // Less than 10px movement = click/touch
                        handleTouchEvent(intersects[0]);  // lastTouchTime is set inside handleTouchEvent
                    }
                }
            }
            
            mouseDownPos = null;
        });
        
        // Mouse leave handler
        renderer.domElement.addEventListener('mouseleave', () => {
            mouseDownPos = null;
        });

        logger.info('touch', 'Touch detection initialized');
    }

    /**
     * Setup custom zoom control that dollies the camera AND resizes the Electron window.
     * Scrolling up zooms in (camera closer + larger window), scrolling down zooms out.
     */
    function setupZoomControl() {
        if (!renderer) return;

        logger.info('zoom', 'Setting up custom zoom control');

        renderer.domElement.addEventListener('wheel', async (event) => {
            // Only handle zoom when running in Electron
            if (!window.electronAPI) return;

            event.preventDefault();

            // deltaY < 0 = scroll up = zoom in; deltaY > 0 = scroll down = zoom out
            // Larger step for faster zoom; scale by deltaY magnitude for trackpad smoothness
            const baseStep = 0.15;
            const intensity = Math.min(2, Math.abs(event.deltaY) / 100);
            const delta = (event.deltaY < 0 ? 1 : -1) * baseStep * intensity;
            const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomScale + delta));

            if (Math.abs(newZoom - zoomScale) < 0.001) return;
            zoomScale = newZoom;

            // 1. Dolly the camera closer/further
            const newDistance = BASE_CAMERA_DISTANCE / zoomScale;
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            camera.position.copy(controls.target).addScaledVector(dir, -newDistance);
            controls.update();

            // 2. Resize the Electron window proportionally, keeping aspect ratio, anchored on center
            try {
                const bounds = await window.electronAPI.getWindowBounds();
                const currentCenterX = bounds.x + bounds.width / 2;
                const currentCenterY = bounds.y + bounds.height / 2;

                // Preserve exact 2:3 aspect ratio (600:900) — round height, derive width from it
                const newHeight = Math.round(BASE_WINDOW_HEIGHT * zoomScale);
                const aspectRatio = BASE_WINDOW_WIDTH / BASE_WINDOW_HEIGHT; // 0.6667
                const newWidth = Math.round(newHeight * aspectRatio);
                const newX = Math.round(currentCenterX - newWidth / 2);
                const newY = Math.round(currentCenterY - newHeight / 2);

                await window.electronAPI.setWindowBounds(newX, newY, newWidth, newHeight);

                // Explicitly update the renderer/camera to fill the new window size.
                // The resize event can fire at an unreliable time, so we force it here.
                camera.aspect = newWidth / newHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(newWidth, newHeight);

                logger.info('zoom', 'zoomScale:', zoomScale.toFixed(2), 'window:', newWidth + 'x' + newHeight, 'camera dist:', newDistance.toFixed(2), 'deltaY:', event.deltaY);
            } catch (e) {
                logger.warn('zoom', 'failed to resize window:', e);
            }
        }, { passive: false });

        logger.info('zoom', 'Custom zoom control initialized');
    }

    /**
     * Setup dynamic click-through: transparent areas let clicks pass through to windows behind,
     * but the avatar and UI panels still capture mouse events.
     */
    function setupClickThrough() {
        if (!window.electronAPI || !window.electronAPI.setIgnoreMouseEvents) return;

        logger.info('click-through', 'Setting up dynamic click-through');

        let isCurrentlyIgnoring = false;
        let lastCheckTime = 0;
        const CHECK_INTERVAL_MS = 50; // Throttle to ~20fps

        function isOverInteractiveElement(clientX, clientY) {
            // Check if mouse is over any visible UI element
            const elements = document.elementsFromPoint(clientX, clientY);
            for (const el of elements) {
                if (el.id === 'speakingBubble' && el.style.display !== 'none') return true;
                if (el.closest && el.closest('.controls:not([style*="display: none"]), .settings-panel:not([style*="display: none"]), .toggle-btn, #history-panel:not([style*="display: none"]), .history-message')) {
                    return true;
                }
                // Check if it's the canvas (avatar area)
                if (el.tagName === 'CANVAS') {
                    // Raycast to check if mouse is actually over the VRM model
                    if (currentVrm && renderer && camera) {
                        const mouse = new THREE.Vector2(
                            (clientX / window.innerWidth) * 2 - 1,
                            -(clientY / window.innerHeight) * 2 + 1
                        );
                        const raycaster = new THREE.Raycaster();
                        raycaster.setFromCamera(mouse, camera);
                        const intersects = raycaster.intersectObject(currentVrm.scene, true);
                        if (intersects.length > 0) return true;
                    }
                }
            }
            return false;
        }

        document.addEventListener('mousemove', (e) => {
            // Don't interfere during window dragging
            if (window.isWindowDragging) return;

            // Throttle checks
            const now = performance.now();
            if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
            lastCheckTime = now;

            const isOverInteractive = isOverInteractiveElement(e.clientX, e.clientY);

            if (isOverInteractive && isCurrentlyIgnoring) {
                // Mouse entered avatar/UI area → capture events
                window.electronAPI.setIgnoreMouseEvents(false);
                isCurrentlyIgnoring = false;
                logger.info('click-through', 'Capturing mouse events');
            } else if (!isOverInteractive && !isCurrentlyIgnoring) {
                // Mouse left avatar/UI area → pass through
                window.electronAPI.setIgnoreMouseEvents(true, true);
                isCurrentlyIgnoring = true;
                logger.info('click-through', 'Passing mouse events through');
            }
        });

        // Start in click-through mode (will switch to capture when mouse is over avatar)
        window.electronAPI.setIgnoreMouseEvents(true, true);
        isCurrentlyIgnoring = true;
        logger.info('click-through', 'Initialized as click-through');
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
        logger.info('touch', 'Touch point:', touchPoint);
        
        // Transform touch point to local space of VRM scene
        const localPoint = touchPoint.clone();
        currentVrm.scene.worldToLocal(localPoint);
        
        logger.info('touch', 'Touch point in VRM local space:', localPoint);
        
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
        
        logger.info('touch', 'Identified body part:', bodyPart, '(y:', y.toFixed(2), ', x:', x.toFixed(2), ')');
        
        return bodyPart;
    }

    /**
     * Handle touch event - play animation and send message to agent
     */
    async function handleTouchEvent(intersection) {
        if (!currentVrm) return;

        // Check if touch interaction is enabled
        if (window.isAnimationEnabled && !window.isAnimationEnabled('touch')) {
            logger.info('touch', 'Touch interaction is disabled in settings');
            return;
        }
        
        // Touch works during any animation state — no blocking
        const now = Date.now();
        if (now - lastTouchTime < TOUCH_DEBOUNCE_MS) {
            logger.info('touch', 'Touch event debounced');
            return;
        }
        
        lastTouchTime = now;
        logger.info('touch', 'Touch event triggered on model (works during any animation)');
        
        // Immediately change facial expression to 'shy' or 'shocked' randomly
        // 'shy' maps to 'angry' in VRM, 'shocked' maps to 'relaxed' in VRM
        // This expression persists until the OpenClaw agent replies
        const touchExpressions = ['shy', 'shocked'];
        const chosenExpression = touchExpressions[Math.floor(Math.random() * touchExpressions.length)];
        applyFacialExpression(chosenExpression);
        logger.info('touch', 'Set expression to', chosenExpression, 'until agent replies');
        
        // Interrupt any running sequence to allow touch response
        if (isSitAnimationActive) {
            isSitAnimationActive = false;
        }
        
        try {
            // Identify which body part was touched
            const bodyPart = identifyBodyPart(intersection);
            logger.info('touch', 'Touched body part:', bodyPart);
            
            // Send message to agent directly (no pre-animation)
            const touchMessage = `User touched your ${bodyPart}`;
            logger.info('touch', 'Sending message to agent:', touchMessage);
            statusDiv.textContent = 'Touch response...';
            
            if (window.disableMessaging) {
                window.disableMessaging();
            }
            if (window.setMessagingThinking) {
                window.setMessagingThinking();
            }
            
            // Send only the user message — system instructions were sent once at session start
            if (window.sendAgentMessage) {
                window.sendAgentMessage(touchMessage);
                logger.info('touch', 'Touch message sent to agent via HTTP');
            }
            
        } catch (error) {
            logger.error('touch', 'Error handling touch event:', error);
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
        logger.info('camera', 'Camera settings saved:', settings);
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
                    logger.info('camera', 'Camera settings loaded:', settings);
                    return true;
                }
            }
        } catch (error) {
            logger.warn('camera', 'Failed to load camera settings:', error);
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
            logger.info('camera', 'Camera reset to default');
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
    const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || '/';
    const VRM_MODEL_URL = `${ASSET_BASE_URL}VRM/sample.vrm`;
    
    // Try multiple glob patterns to find VRMA files
    let VRMA_ASSET_FILES = import.meta.glob('./VRMA/*.vrma', {
        eager: true,
        query: '?url',
        import: 'default'
    });
    
    // If no files found, try alternative paths
    if (Object.keys(VRMA_ASSET_FILES).length === 0) {
        VRMA_ASSET_FILES = import.meta.glob('../assets/VRMA/*.vrma', {
            eager: true,
            query: '?url',
            import: 'default'
        });
    }
    if (Object.keys(VRMA_ASSET_FILES).length === 0) {
        VRMA_ASSET_FILES = import.meta.glob('/VRMA/*.vrma', {
            eager: true,
            query: '?url',
            import: 'default'
        });
    }
    if (Object.keys(VRMA_ASSET_FILES).length === 0) {
        VRMA_ASSET_FILES = import.meta.glob('./assets/VRMA/*.vrma', {
            eager: true,
            query: '?url',
            import: 'default'
        });
    }
    
    // Debug logging
    console.log('[VRMA] ASSET_BASE_URL:', ASSET_BASE_URL);
    console.log('[VRMA] VRMA_ASSET_FILES keys:', Object.keys(VRMA_ASSET_FILES));
    console.log('[VRMA] VRMA_ASSET_FILES:', VRMA_ASSET_FILES);
    
    const VRMA_ANIMATION_ASSETS = Object.entries(VRMA_ASSET_FILES)
        .map(([filePath, url]) => ({
            fileName: filePath.split('/').pop(),
            url
        }))
        .sort((left, right) => left.fileName.localeCompare(right.fileName));
    const VRMA_ANIMATION_URLS = VRMA_ANIMATION_ASSETS.map(asset => asset.url);
    const VRMA_ANIMATION_URL_BY_FILE = Object.fromEntries(
        VRMA_ANIMATION_ASSETS.map(asset => [asset.fileName, asset.url])
    );

    window.VRMA_ANIMATION_URLS = VRMA_ANIMATION_URLS;
    window.VRMA_ANIMATION_FILE_NAMES = VRMA_ANIMATION_ASSETS.map(asset => asset.fileName);
    window.VRMA_ANIMATION_URL_BY_FILE = VRMA_ANIMATION_URL_BY_FILE;

    function getVRMAFileName(url) {
        return window.VRMA_ANIMATION_FILE_BY_URL?.[url] || url.split('/').pop();
    }

    function getVRMAUrl(fileName) {
        const url = window.VRMA_ANIMATION_URL_BY_FILE?.[fileName]
            || `${ASSET_BASE_URL}VRMA/${fileName}`;
        console.log('[VRMA] getVRMAUrl:', fileName, '->', url);
        return url;
    }

    window.VRMA_ANIMATION_FILE_BY_URL = Object.fromEntries(
        VRMA_ANIMATION_ASSETS.map(asset => [asset.url, asset.fileName])
    );
    window.getVRMAAnimationUrl = getVRMAUrl;
    window.getVRMAAnimationFileName = getVRMAFileName;

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
        
        logger.info('core', 'DOM elements initialized');
        
        // Add click listener to messaging panel to reset sit animation flag when user interacts
        if (lipSyncPanel) {
            lipSyncPanel.addEventListener('click', () => {
                if (isSitAnimationActive) {
                    logger.info('sit', 'User clicked messaging panel, allowing panels to be shown again');
                    isSitAnimationActive = false;
                }
            });
            
            // Also add listener to text input for focus events
            if (textInputPanel) {
                textInputPanel.addEventListener('focus', () => {
                    if (isSitAnimationActive) {
                        logger.info('sit', 'User focused text input, allowing panels to be shown again');
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
            logger.info('messaging', 'Messaging panel hidden');
        }
        
        // Get history panel dynamically from DOM (it's created by HistoryModule)
        const historyPanelElement = document.getElementById('history-panel');
        if (historyPanelElement) {
            historyPanelElement.style.display = 'none';
            logger.info('messaging', 'History panel hidden');
        }
    }

    /**
     * Show messaging panel
     */
    function showMessagingPanel() {
        // Don't show messaging panel if sit animation is active
        if (isSitAnimationActive) {
            logger.info('messaging', 'Skipping showMessagingPanel - sit animation is active');
            return;
        }
        
        if (lipSyncPanel) {
            lipSyncPanel.style.display = 'flex';
            logger.info('messaging', 'Panel shown');
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
        logger.info('messaging', 'Controls disabled');
    }

    /**
     * Enable messaging controls
     */
    function enableMessaging() {
        // Don't enable messaging if sit animation is active
        if (isSitAnimationActive) {
            logger.info('messaging', 'Skipping enableMessaging - sit animation is active');
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
        logger.info('messaging', 'Controls enabled');
    }

    /**
     * Set messaging panel to thinking state
     */
    function setMessagingThinking() {
        if (textInputPanel && !isMessagingDisabled) {
            textInputPanel.value = 'Thinking...';
            logger.info('messaging', 'Set to thinking state');
        }
    }

    /**
     * Reset messaging panel after reply
     */
    function resetMessagingPanel() {
        if (textInputPanel && !isMessagingDisabled) {
            // Clear the textbox completely
            textInputPanel.value = '';
            logger.info('messaging', 'Panel reset - textbox cleared');
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
                
                const simplifiedShapes = [];
                for (let i = 0; i < shapes.length; i++) {
                    if (shapes[i] !== 'neutral' && (i === 0 || shapes[i-1] === 'neutral')) {
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

            // Only reset mouth shape expressions, NOT facial expressions (happy, sad, angry, etc.)
            const mouthExpressions = ['aa', 'ee', 'ih', 'oh', 'oo', 'b', 'p', 'm', 'f', 'v', 't', 'd', 'n', 's', 'z', 'sh', 'th', 'l', 'r'];
            mouthExpressions.forEach(expr => {
                vrm.expressionManager.setValue(expr, 0);
            });

            vrm.expressionManager.setValue(expressionName, intensity);
        }

        function startSpeaking(text) {
            logger.info('lip', 'startSpeaking', text);
            isCurrentlyTalking = false;
            mouthTarget = 'neutral';
            updateDebugDisplay(text, 0);

            if (currentIdleTimeout) {
                clearTimeout(currentIdleTimeout);
                currentIdleTimeout = null;
                idleSuspended = true;
            }

            if (!isAgentCommandActive) {
                loadIdleLoop().then(() => {
                    logger.info('lip', 'idle loop loaded in background');
                }).catch(err => {
                    logger.warn('lip', 'background idle load failed', err);
                });
            }

            isCurrentlyTalking = true;

            // Split text by newlines and process each line separately
            const lines = text.split('\n').filter(line => line.trim() !== '');
            logger.info('lip', 'Text split into', lines.length, 'lines');
            
            // Process lines sequentially with a small pause between them
            processLinesSequentially(lines);
        }

        async function processLinesSequentially(lines) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                logger.info('lip', 'Speaking line', i + 1, 'of', lines.length, ':', line);
                
                // Show this line in the bubble
                showSpeakingBubble(line);
                
                // Speak this line
                await speakLine(line);
                
                // Small pause between lines (except after the last line)
                if (i < lines.length - 1) {
                    logger.info('lip', 'Pausing between lines...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            // All lines finished
            isCurrentlyTalking = false;
            mouthTarget = 'neutral';
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
            const hasChinese = /[\u4e00-\u9fff]/.test(text);
            
            // For Chinese text, use timer-based approach since onboundary fires at word boundaries
            // (Chinese has no spaces, so it only fires once at the end)
            if (hasChinese) {
                return speakLineWithTimer(text);
            }
            
            // For non-Chinese, use speech synthesis with onboundary events
            if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
                return speakLineWithSpeechSynthesis(text);
            }

            return speakLineWithTimer(text);
        }

        function speakLineWithSpeechSynthesis(text) {
            return new Promise((resolve) => {
                const utterance = new SpeechSynthesisUtterance(text);
                const hasChinese = /[\u4e00-\u9fff]/.test(text);
                let currentUnitIndex = -1;
                let mouthCycleTimer = null;
                let settled = false;

                const clearMouthCycle = () => {
                    if (mouthCycleTimer) {
                        clearInterval(mouthCycleTimer);
                        mouthCycleTimer = null;
                    }
                };

                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearMouthCycle();
                    mouthTarget = 'neutral';
                    resolve();
                };

                utterance.rate = speakingSpeedMultiplier;
                utterance.pitch = 1;
                utterance.volume = 1;

                const voices = window.speechSynthesis.getVoices();
                const preferredVoice = voices.find(voice => {
                    const language = voice.lang.toLowerCase();
                    return hasChinese ? language.startsWith('zh') : language.startsWith('en');
                });
                if (preferredVoice) {
                    utterance.voice = preferredVoice;
                }

                // Pre-compute grapheme clusters for accurate index mapping
                const graphemes = splitIntoGraphemes(text);
                
                utterance.onboundary = (event) => {
                    const charIndex = event.charIndex || 0;
                    const remainingText = text.slice(charIndex);
                    const wordMatch = remainingText.match(/[^\s]+/);
                    const spokenUnit = wordMatch ? wordMatch[0] : text[charIndex] || '';
                    
                    // Map UTF-16 charIndex to grapheme index for accurate display
                    let unitIndex;
                    if (hasChinese) {
                        // Count graphemes up to charIndex
                        const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
                        const segments = Array.from(segmenter.segment(text.slice(0, charIndex)));
                        unitIndex = segments.length;
                    } else {
                        unitIndex = text.slice(0, charIndex).trim().split(/\s+/).filter(Boolean).length;
                    }

                    if (unitIndex !== currentUnitIndex) {
                        currentUnitIndex = unitIndex;
                        updateDebugDisplay(text, unitIndex, hasChinese ? spokenUnit[0] : null);
                    }

                    const mouthShapes = textToMouthShapes(spokenUnit);
                    clearMouthCycle();
                    let shapeIndex = 0;

                    const applyNextShape = () => {
                        mouthTarget = mouthShapes[shapeIndex % Math.max(mouthShapes.length, 1)] || 'neutral';
                        shapeIndex++;
                    };

                    applyNextShape();
                    if (mouthShapes.length > 1) {
                        mouthCycleTimer = setInterval(applyNextShape, 80 / speakingSpeedMultiplier);
                    }

                    // Display up to the current grapheme index
                    displayCharacterAtIndex(Math.min(unitIndex, graphemes.length - 1));
                };

                utterance.onend = finish;
                utterance.onerror = (event) => {
                    logger.warn('lip', 'Speech synthesis error:', event.error);
                    finish();
                };

                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            });
        }

        function speakLineWithTimer(text) {
            return new Promise((resolve) => {
                logger.info('lip', 'Speaking line:', text);
                updateDebugDisplay(text, 0);

                const hasChinese = /[\u4e00-\u9fff]/.test(text);
                let units;
                let currentUnitIndex = 0;
                let speakingStartTime = performance.now();
                
                let unitShapes = [];
                let totalShapes = 0;
                
                // Use grapheme clusters for Chinese to properly handle emojis and combined characters
                // Match the same splitting logic as showSpeakingBubble (no filtering to keep indices aligned)
                if (hasChinese) {
                    units = splitIntoGraphemes(text);
                } else {
                    units = text.split(' ').filter(word => word.length > 0);
                }
            
                units.forEach(unit => {
                    const shapes = textToMouthShapes(unit);
                    unitShapes.push(shapes);
                    totalShapes += shapes.length;
                });
                
                const speakingDuration = (totalShapes * 80) + (units.length * 50);
                logger.info('lip', 'units for speech', units, 'total shapes:', totalShapes, 'duration:', speakingDuration);

                function processNextUnit() {
                    if (currentUnitIndex >= units.length) {
                        mouthTarget = 'neutral';
                        updateDebugDisplay(text, -1);
                        
                        const lastCharIndex = units.length - 1;
                        displayCharacterAtIndex(lastCharIndex);
                        
                        if (idleSuspended) {
                            scheduleRandomIdle();
                            idleSuspended = false;
                        }
                        resolve();
                        return;
                    }

                    const unit = units[currentUnitIndex];
                    logger.info('lip', 'processing unit', currentUnitIndex, unit);

                    if (hasChinese) {
                        updateDebugDisplay(text, currentUnitIndex, unit);
                    } else {
                        updateDebugDisplay(text, currentUnitIndex);
                    }

                    const mouthShapes = unitShapes[currentUnitIndex] || textToMouthShapes(unit);
                    logger.info('lip', 'mouthShapes', mouthShapes);

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
                        // Use grapheme index for Chinese, character index for others
                        const charIndex = hasChinese 
                            ? Math.floor(progressRatio * units.length)
                            : Math.floor(progressRatio * text.length);
                        
                        displayCharacterAtIndex(Math.min(charIndex, units.length - 1));

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
            logger.info('lip', 'setSpeakingSpeed', multiplier);
            speakingSpeedMultiplier = multiplier;
            return speakingSpeedMultiplier;
        }

        function getSpeakingSpeed() {
            return speakingSpeedMultiplier;
        }

        function updateDebugDisplay(text, unitIndex, currentUnit = null) {
            const hasChinese = /[\u4e00-\u9fff]/.test(text);

            if (unitIndex === -1) {
                statusDiv.textContent = 'Speaking complete';
                return;
            }

            if (hasChinese) {
                const characters = splitIntoGraphemes(text);
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
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
            }
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
    function createBlinkSystem() {
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

    // Helper function to split text into grapheme clusters (handles emojis, combined characters, etc.)
    function splitIntoGraphemes(text) {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            // Use undefined locale for grapheme clustering (locale-independent per Unicode standard)
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            return Array.from(segmenter.segment(text), s => s.segment);
        }
        // Fallback for environments without Intl.Segmenter
        // Note: This fallback will split emojis incorrectly, but Intl.Segmenter is available in Electron 40+
        return text.split('');
    }

    function initSpeakingBubble() {
        speakingBubble = document.createElement('div');
        speakingBubble.id = 'speakingBubble';
        speakingBubble.style.position = 'fixed';
        speakingBubble.style.display = 'none';
        speakingBubble.style.background = 'rgba(0, 0, 0, 0.9)';
        speakingBubble.style.color = 'white';
        speakingBubble.style.padding = '12px 16px';
        speakingBubble.style.borderRadius = '12px';
        // Font stack with emoji support across platforms
        speakingBubble.style.fontFamily = 'Arial, "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
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
        
        logger.info('bubble', 'Bubble added to DOM');
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
                        logger.info('bubble', `Found head bone: ${boneName}`);
                        break;
                    }
                }
                
                if (!cachedHeadBone && currentVrm.humanoid?.bones) {
                    for (const bone of currentVrm.humanoid.bones) {
                        if (bone && (bone.name.toLowerCase().includes('head') || bone.name.toLowerCase().includes('neck'))) {
                            cachedHeadBone = bone;
                            logger.info('bubble', `Found head bone from humanoid: ${bone.name}`);
                            break;
                        }
                    }
                }

                if (!cachedHeadBone && !headBoneWarningLogged) {
                    logger.warn('bubble', 'Head bone not found, using default position');
                    logger.info('bubble', 'Available bones:', currentVrm.humanoid?.bones?.map(b => b.name));
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
            logger.error('bubble', 'failed to update position:', e);
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
        
        // Lock the width: pre-measure the full text, then set fixed width for this sentence
        speakingBubble.style.width = 'auto';
        speakingBubble.textContent = text;  // Temporarily set full text to measure
        const measuredWidth = speakingBubble.offsetWidth;
        speakingBubble.textContent = '';     // Clear back
        // Set locked width (add padding consideration — offsetWidth includes padding)
        speakingBubble.style.width = measuredWidth + 'px';
        
        updateSpeakingBubblePosition();
        
        // Fade in effect
        requestAnimationFrame(() => {
            speakingBubble.style.opacity = '1';
        });
        
        // Split text into grapheme clusters (handles emojis, combined characters, Chinese chars correctly)
        currentWordIndex = 0;
        words = splitIntoGraphemes(text);
        
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
                            logger.info('vrm', 'Spring bone physics enabled');
                        }

                        currentMixer = new THREE.AnimationMixer(vrm.scene);

                        statusDiv.textContent = 'VRM model loaded successfully!';
                        logger.info('vrm', 'VRM loaded:', vrm);

                        // Hide loading GIF after VRM loads
                        hideLoadingGif();

                        resolve(vrm);
                    },
                    (progress) => {
                        const percent = parseFloat((100.0 * (progress.loaded / progress.total)).toFixed(1));
                        statusDiv.textContent = `Loading VRM model... ${percent}%`;
                    },
                    (error) => {
                        logger.error('vrm', 'Error loading VRM:', error);
                        statusDiv.textContent = 'Error loading VRM model';
                        reject(error);
                    }
                );
            });
        } catch (error) {
            logger.error('vrm', 'Error in loadVRM:', error);
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
                    logger.warn('seq', 'waitForActionEnd timeout for action', action);
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
            logger.error('transition', 'failed to load animation', url, e);
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
        logger.info('idle', 'loadIdleLoop called');

        try {
            statusDiv.textContent = 'Loading: Idle loop...';
            isIdleMode = true;

            const idleUrl = getVRMAUrl('idle_loop.vrma');
            const gltf = await loader.loadAsync(idleUrl);
            logger.info('idle', 'gltf loaded for idle loop', gltf);
            const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];

            if (vrmAnimationData) {
                const baseClip = createVRMAnimationClip(vrmAnimationData, currentVrm);
                logger.info('idle', 'baseClip created', baseClip);

                if (baseClip) {
                    vrmaAnimationClip = baseClip;
                    await blendToAnimation(baseClip, THREE.LoopRepeat, 0);

                    statusDiv.textContent = 'Idle loop started automatically';
                    logger.info('idle', 'idle loop playing');
                    return true;
                }
            }
            logger.warn('idle', 'no VRM animation data found in idle loop gltf');
            return false;
        } catch (error) {
            logger.error('idle', 'Error loading idle loop:', error);
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
                        logger.info('runtime', 'GLTF loaded (VRMA):', gltf);

                        const vrmAnimationData = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];

                        if (vrmAnimationData) {
                            const clip = createBlendAnimation(vrmAnimationData, currentVrm);

                            if (clip) {
                                vrmaAnimationClip = clip;

                                const isIdleAnimation = getVRMAFileName(url) === 'idle_loop.vrma';

                                if (isIdleAnimation) {
                                    isIdleMode = true;
                                    statusDiv.textContent = 'Idle loop animation loaded!';

                                    try {
                                        currentAction = currentMixer.clipAction(clip);
                                        currentAction.setLoop(THREE.LoopRepeat);
                                        currentAction.play();
                                        statusDiv.textContent += ' - Auto-playing...';
                                    } catch (idleError) {
                                        logger.error('runtime', 'Error playing idle animation:', idleError);
                                        statusDiv.textContent += ' - Playback error: ' + idleError.message;
                                    }
                                } else {
                                    isIdleMode = false;
                                    statusDiv.textContent = 'Animation loaded!';
                                }

                                logger.info('runtime', 'Generated AnimationClip:', vrmaAnimationClip);
                                logger.info('runtime', 'Is idle animation:', isIdleAnimation);

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
                        logger.error('runtime', 'Error loading animation:', error);
                        statusDiv.textContent = 'Error loading animation file: ' + error.message;
                        reject(error);
                    }
                );
            });
        } catch (error) {
            logger.error('runtime', 'Error in loadVRMA:', error);
            statusDiv.textContent = 'Error loading animation file';
        }
    }

    function createBlendAnimation(targetClip, blendDuration = 0.3) {
        if (!currentVrm) return targetClip;

        const bufferSize = CONFIG.BUFFER_TIME;
        const totalDuration = targetClip.duration;
        const visibleDuration = totalDuration - (2 * bufferSize);

        if (visibleDuration <= 0) {
            logger.warn('runtime', `Clip too short to buffer: ${totalDuration}s`);
            return targetClip;
        }

        const currentPoseTracks = [];

        if (currentVrm && currentVrm.scene) {
            currentVrm.scene.traverse((child) => {
                if (child.isBone || child.isSkinnedMesh) {
                    const position = new THREE.Vector3();
                    const quaternion = new THREE.Quaternion();

                    child.getWorldPosition(position);
                    child.getWorldQuaternion(quaternion);

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
        if (!currentVrm?.expressionManager) return;
        
        logger.info('expression', 'Resetting to neutral');
        activeFacialExpression = null;
        blinkSystemEnabled = true;
        
        applyFacialExpression('neutral');
    }

    function applyFacialExpression(expression) {
        if (!currentVrm?.expressionManager) return;

        // Map agent's expression choices to actual VRM expressions
        const expressionMap = {
            'shock': 'sad',           // agent says shock -> VRM shows sad
            'surprised': 'relaxed',   // agent says surprised -> VRM shows relaxed
            'shy': 'angry'            // agent says shy -> VRM shows angry
        };

        const vrmExpression = expressionMap[expression];

        if (expression === 'neutral' || expression === 'blink') {
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
            'joy', 'fun', 'worry', 'aoi', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight',
            'relaxed'
        ];

        allExpressions.forEach(expr => {
            try {
                currentVrm.expressionManager.setValue(expr, 0);
            } catch (e) {}
        });

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
        logger.info('idle', 'scheduling random idle in', delay, 'ms');
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
    const MIN_LOADING_TIME = 2000;

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
            loadingGif.style.background = `url('${loadingGifUrl}') no-repeat center center`;
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
     * Electron-specific walk sequence (horizontal walking)
     */
    async function runElectronWalkSequence(vrmaUrl) {
        if (!currentVrm || isPlayingWalkSequence) return;

        try {
            logger.info('walk-electron', 'runElectronWalkSequence start', vrmaUrl);
            isPlayingWalkSequence = true;

            if (window.hideAllPanels) {
                window.hideAllPanels();
            }

            if (currentIdleTimeout) {
                clearTimeout(currentIdleTimeout);
                currentIdleTimeout = null;
            }
            idleSuspended = true;

            const walkTimeScale = CONFIG.WALK_TIME_SCALE;

            let walkingDirection = 'right';
            
            if (window.electronAPI) {
                try {
                    walkingWindowInitialPos = await window.electronAPI.getWindowPosition();
                    
                    const windowBounds = await window.electronAPI.getWindowBounds();
                    const screenWidth = window.screen ? window.screen.width : window.innerWidth;
                    const screenCenter = screenWidth / 2;
                    
                    const windowCenterX = walkingWindowInitialPos.x + (windowBounds.width / 2);
                    walkingDirection = windowCenterX < screenCenter ? 'right' : 'left';
                    
                    logger.info('walk-electron', 'window center:', windowCenterX, 'screen center:', screenCenter, 'walking:', walkingDirection);
                } catch (e) {
                    logger.warn('walk-electron', 'failed to get window position:', e);
                    walkingWindowInitialPos = { x: 0, y: 0 };
                }
            }

            walkingInitialRotY = currentVrm.scene.rotation.y;

            const leg = CONFIG.WALK_WALK_DURATION;
            const turn = CONFIG.WALK_TURN_DURATION;

            logger.info('walk-electron', 'timing config', {
                startDelay: CONFIG.WALK_START_DELAY,
                direction: walkingDirection,
                leg,
                turn,
            });

            logger.info('walk-electron', 'waiting before starting clip...');
            await new Promise(resolve => setTimeout(resolve, CONFIG.WALK_START_DELAY * 1000));

            logger.info('walk-electron', 'turning to face', walkingDirection, ', duration (ms)', turn * 1000);
            let action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
            if (action) {
                try {
                    if (typeof action.setEffectiveTimeScale === 'function') {
                        action.setEffectiveTimeScale(walkTimeScale);
                    } else {
                        action.timeScale = walkTimeScale;
                    }
                } catch (e) {
                    logger.warn('walk-electron', 'failed to set time scale for initial turn', e);
                }
            }
            await animateElectronWalkPhase(0, turn, 'initial_turn', walkingDirection);

            logger.info('walk-electron', 'starting', walkingDirection, 'walk clip (LoopRepeat)');
            action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
            if (action) {
                try {
                    if (typeof action.setEffectiveTimeScale === 'function') {
                        action.setEffectiveTimeScale(walkTimeScale);
                    } else {
                        action.timeScale = walkTimeScale;
                    }
                } catch (e) {
                    logger.warn('walk-electron', 'failed to set time scale for walk leg', e);
                }
            }
            logger.info('walk-electron', '', walkingDirection, 'leg duration (ms)', leg * 1000);
            await animateElectronWalkPhase(turn, turn + leg, 'walk', walkingDirection);

            logger.info('walk-electron', 'turning to face forward, duration (ms)', turn * 1000);
            action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat, transitionTime: 0.5 });
            if (action) {
                try {
                    if (typeof action.setEffectiveTimeScale === 'function') {
                        action.setEffectiveTimeScale(walkTimeScale);
                    } else {
                        action.timeScale = walkTimeScale;
                    }
                } catch (e) {
                    logger.warn('walk-electron', 'failed to set time scale for turn to forward', e);
                }
            }
            await animateElectronWalkPhase(turn + leg, turn + leg + turn, 'turn_to_forward', walkingDirection);

            logger.info('walk-electron', 'finished, keeping current position and rotation');

            // Send walk completion event to agent with original and new position
            if (window.electronAPI && walkingWindowInitialPos) {
                try {
                    const newPos = await window.electronAPI.getWindowPosition();
                    sendEventToAgent('character_walk', 
                        `The character has finished walking. Original position: (${walkingWindowInitialPos.x}, ${walkingWindowInitialPos.y}). New position: (${newPos.x}, ${newPos.y}).`);
                } catch (e) {
                    logger.warn('walk-electron', 'Failed to send walk event:', e);
                }
            }

            logger.info('walk-electron', 'calling loadIdleLoop at end of sequence');
            await loadIdleLoop();
            
        } finally {
            logger.info('walk-electron', 'runElectronWalkSequence finished');
            isPlayingWalkSequence = false;
            idleSuspended = false;
            scheduleRandomIdle();
        }
    }

    function animateElectronWalkPhase(startTimeSec, endTimeSec, phaseType, direction = 'right') {
        return new Promise(resolve => {
            const durationMs = (endTimeSec - startTimeSec) * 1000;
            const startTime = performance.now();
            const windowOffset = CONFIG.WALK_WINDOW_OFFSET;

            function step() {
                const elapsed = performance.now() - startTime;
                const progress = Math.min(1, elapsed / durationMs);

                if (!currentVrm) {
                    resolve();
                    return;
                }

                let rotY = walkingInitialRotY;
                let windowX = walkingWindowInitialPos.x;

                if (phaseType === 'initial_turn') {
                    if (direction === 'right') {
                        rotY = walkingInitialRotY + (Math.PI / 2) * progress;
                    } else {
                        rotY = walkingInitialRotY - (Math.PI / 2) * progress;
                    }
                    windowX = walkingWindowInitialPos.x;
                } else if (phaseType === 'walk') {
                    if (direction === 'right') {
                        rotY = walkingInitialRotY + Math.PI / 2;
                        windowX = walkingWindowInitialPos.x + Math.round(windowOffset * progress);
                    } else {
                        rotY = walkingInitialRotY - Math.PI / 2;
                        windowX = walkingWindowInitialPos.x - Math.round(windowOffset * progress);
                    }
                } else if (phaseType === 'turn_to_forward') {
                    if (direction === 'right') {
                        rotY = walkingInitialRotY + Math.PI / 2 - (Math.PI / 2) * progress;
                        windowX = walkingWindowInitialPos.x + windowOffset;
                    } else {
                        rotY = walkingInitialRotY - Math.PI / 2 + (Math.PI / 2) * progress;
                        windowX = walkingWindowInitialPos.x - windowOffset;
                    }
                }

                currentVrm.scene.rotation.y = rotY;

                if (window.electronAPI && walkingWindowInitialPos) {
                    try {
                        window.electronAPI.setWindowPosition(windowX, walkingWindowInitialPos.y);
                    } catch (e) {
                        logger.warn('walk-electron', 'failed to update window position:', e);
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
    // AUTOMATIC SEQUENCE SYSTEM
    // ============================================================
    async function startAutomaticSequence() {
        if (isPlayingSequence || !currentVrm) return;

        logger.info('seq', 'starting automatic sequence');
        isPlayingSequence = true;
        statusDiv.textContent = 'Starting automatic sequence...';

        try {
            statusDiv.textContent = 'Playing stand up animation...';
            logger.info('seq', 'transition to stand up');
            const action1 = await startSmoothTransition(getVRMAUrl('start_1standUp.vrma'), { loopMode: THREE.LoopOnce, startOffset: 0.5 });
            if (action1) {
                logger.info('seq', 'waiting for stand up to finish');
                await waitForActionEnd(action1, 15000, true);
            }
            logger.info('seq', 'stand up finished');

            statusDiv.textContent = 'Playing turn around animation...';
            logger.info('seq', 'transition to turn around');
            const action2 = await startSmoothTransition(getVRMAUrl('start_2turnAround.vrma'), { loopMode: THREE.LoopOnce, startOffset: 0.5, transitionTime: 1.0 });
            if (action2) {
                logger.info('seq', 'waiting for turn around to finish');
                await waitForActionEnd(action2, 15000, true);
            }
            logger.info('seq', 'turn around finished');

            statusDiv.textContent = 'Starting idle loop...';
            logger.info('seq', 'loading idle loop');
            const t0 = performance.now();
            await loadIdleLoop();
            logger.info('seq', 'loadIdleLoop duration', performance.now() - t0);
            logger.info('seq', 'idle loop should now be playing');

            await new Promise(resolve => setTimeout(resolve, 3000));
            logger.info('seq', 'waited 3s after idle start');
            beginRandomIdleSelection();
        } catch (error) {
            logger.error('seq', 'Error in automatic sequence:', error);
            statusDiv.textContent = 'Error in sequence. Loading idle loop...';
            await loadIdleLoop();
        } finally {
            isPlayingSequence = false;
            logger.info('seq', 'automatic sequence complete');
            if (!currentAction) {
                logger.info('seq', 'no action active, forcing idle');
                const ok = await loadIdleLoop();
                if (!ok) logger.warn('seq', 'failed to load idle loop in finally');
            }
            beginRandomIdleSelection();
        }
    }

    // ============================================================
    // RANDOM IDLE SYSTEM - ENHANCED
    // ============================================================
    async function playRandomIdle() {
        logger.info('idle', 'playRandomIdle called, currentAction=', currentAction, 'isPlayingSequence=', isPlayingSequence, 'isPlayingWalkSequence=', isPlayingWalkSequence);
        if (!currentVrm || isPlayingSequence || isPlayingWalkSequence) return;
        
        // Don't start new random idle if agent request is pending - keep idle_loop looping
        if (window._agentRequestPending) {
            logger.info('idle', 'Skipping random idle - agent request pending, keeping idle_loop');
            scheduleRandomIdle();
            return;
        }

        try {
            const idleFiles = VRMA_ANIMATION_URLS.filter(url => {
                const name = getVRMAFileName(url);
                // Filter out disabled animations
                if (window.isAnimationUrlEnabled && !window.isAnimationUrlEnabled(url)) {
                    return false;
                }
                return name.startsWith('idle_') && name !== 'idle_loop.vrma' ||
                       name === 'walk.vrma' ||
                       name === 'sit.vrma' ||
                       name === 'start_2turnAround.vrma';
            });

            if (idleFiles.length > 0) {
                const randomFile = idleFiles[Math.floor(Math.random() * idleFiles.length)];
                const randomFileName = getVRMAFileName(randomFile);
                logger.info('idle', 'selected random idle', randomFile);
                statusDiv.textContent = `Playing random idle: ${randomFileName}`;

                if (randomFileName === 'walk.vrma') {
                    if (window.electronAPI) {
                        await runElectronWalkSequence(randomFile);
                    } else {
                        logger.info('idle', 'Web version - skipping walk animation');
                        await loadIdleLoop();
                    }
                }
                else if (randomFileName === 'sit.vrma') {
                    // Sit sequence: sit_down → sit loop → sit_up
                    logger.info('idle', 'Running sit sequence (sit_down → sit loop → sit_up)');
                    statusDiv.textContent = 'Sitting sequence...';
                    
                    // 1. Play sit_down
                    const sitDownAction = await startSmoothTransition(getVRMAUrl('sit_down.vrma'), { loopMode: THREE.LoopOnce });
                    if (sitDownAction) {
                        await waitForActionEnd(sitDownAction, 15000, false);
                    }
                    
                    // 2. Loop sit for random duration
                    const sitDuration = Math.random() * (CONFIG.RANDOM_IDLE_MAX_DELAY - CONFIG.RANDOM_IDLE_MIN_DELAY) + CONFIG.RANDOM_IDLE_MIN_DELAY;
                    logger.info('idle', 'Sitting for', (sitDuration / 1000).toFixed(1), 'seconds');
                    const sitAction = await startSmoothTransition(randomFile, { loopMode: THREE.LoopRepeat });
                    if (sitAction) {
                        await new Promise(resolve => setTimeout(resolve, sitDuration));
                    }
                    
                    // 3. Play sit_up (startSmoothTransition crossfades from sit → sit_up smoothly)
                    const sitUpAction = await startSmoothTransition(getVRMAUrl('sit_up.vrma'), { loopMode: THREE.LoopOnce });
                    if (sitUpAction) {
                        await waitForActionEnd(sitUpAction, 15000, true);
                    }
                }
                else {
                    const action = await startSmoothTransition(randomFile, { loopMode: THREE.LoopOnce });
                    if (action) {
                        await waitForActionEnd(action, 15000, true);
                    }
                }
            } else {
                logger.warn('idle', 'no idle files found');
            }
        } catch (error) {
            logger.error('idle', 'Error playing random idle:', error);
        } finally {
            statusDiv.textContent = 'Returning to idle loop...';
            const ok = await loadIdleLoop();
            if (!ok) logger.warn('idle', 'loadIdleLoop failed after random idle');
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
            logger.info('vrma', 'using constant animation list');
            vrmaFiles = window.VRMA_ANIMATION_URLS.slice();
        }

        vrmaFiles.sort();

        vrmaFiles.forEach(url => {
            const option = document.createElement('option');
            option.value = url;

            let filename = getVRMAFileName(url).replace('.vrma', '');
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
        const hasVrm = !!currentVrm;
        if (animationSelect) {
            animationSelect.disabled = !hasVrm;
        }
        if (hasVrm) {
            populateAnimationDropdown();
        }
    }

    function updateButtons() {
        const hasVrm = currentVrm !== undefined;

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
            const vrmaFileName = getVRMAFileName(vrmaUrl);

            if (!vrmaUrl) {
                if (idleSuspended) {
                    scheduleRandomIdle();
                    idleSuspended = false;
                }
                return;
            }

            // Don't start new animation if agent request is pending - keep idle_loop looping
            if (window._agentRequestPending) {
                logger.info('anim-dropdown', 'Skipping animation - agent request pending, keeping idle_loop');
                animationSelect.value = '';
                return;
            }

            if (currentIdleTimeout) {
                clearTimeout(currentIdleTimeout);
                currentIdleTimeout = null;
                idleSuspended = true;
            }

            isTransitioning = false;

            if (vrmaFileName === 'idle_loop.vrma') {
                await loadIdleLoop();
            } else if (/^idle_.*\.vrma$/.test(vrmaFileName)) {
                const action = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopOnce });
                if (action) {
                    await waitForActionEnd(action, 15000, true);
                    action.stop();
                    currentMixer.uncacheAction(action.getClip());
                    currentAction = null;
                    if (currentVrm) currentVrm.humanoid.resetNormalizedPose();
                    await loadIdleLoop();
                }
            } else if (vrmaFileName === 'walk.vrma') {
                if (window.electronAPI) {
                    await runElectronWalkSequence(vrmaUrl);
                } else {
                    logger.info('electron', 'Web version - skipping walk animation');
                    await loadIdleLoop();
                }
            } else if (vrmaFileName === 'sit.vrma' || vrmaFileName === 'sitWave.vrma') {
                // Hide both messaging and history panels
                if (window.hideMessagingPanel) {
                    window.hideMessagingPanel();
                }
                if (HistoryModule.hideHistoryPanel) {
                    HistoryModule.hideHistoryPanel();
                }
                
                isSitAnimationActive = true;
                logger.info('sit', 'Sit sequence started (sit_down → sit loop → sit_up)');
                
                // Send sit event to agent
                sendEventToAgent('character_sit', 'The character has started sitting down.');
                
                // 1. Play sit_down first (transition to sitting)
                const sitDownAction = await startSmoothTransition(getVRMAUrl('sit_down.vrma'), { loopMode: THREE.LoopOnce });
                if (sitDownAction) {
                    await waitForActionEnd(sitDownAction, 15000, false);
                }
                
                // 2. Loop sit animation for a random duration
                const sitDuration = Math.random() * (CONFIG.RANDOM_IDLE_MAX_DELAY - CONFIG.RANDOM_IDLE_MIN_DELAY) + CONFIG.RANDOM_IDLE_MIN_DELAY;
                logger.info('sit', 'Sitting for', (sitDuration / 1000).toFixed(1), 'seconds');
                statusDiv.textContent = `Sitting for ${(sitDuration/1000).toFixed(1)}s...`;
                
                const sitAction = await startSmoothTransition(vrmaUrl, { loopMode: THREE.LoopRepeat });
                if (sitAction) {
                    await new Promise(resolve => setTimeout(resolve, sitDuration));
                    sitAction.stop();
                    currentMixer.uncacheAction(sitAction.getClip());
                }
                
                // 3. Play sit_up (stand back up)
                const sitUpAction = await startSmoothTransition(getVRMAUrl('sit_up.vrma'), { loopMode: THREE.LoopOnce });
                if (sitUpAction) {
                    await waitForActionEnd(sitUpAction, 15000, true);
                }
                
                if (currentVrm) currentVrm.humanoid.resetNormalizedPose();
                await loadIdleLoop();
                
                logger.info('sit', 'Sit sequence complete, panels remain hidden until user interaction');
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

        // Setup custom zoom control (camera dolly + window resize)
        setupZoomControl();

        // Setup dynamic click-through (transparent areas let clicks pass through)
        setupClickThrough();
        
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
        runElectronWalkSequence,
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

    // Configuration
    const CONFIG = {
      token: 'YOUR_TOKEN_HERE',
      reconnectInterval: 3000,
      maxReconnectAttempts: 10
    };

    function getWebSocketUrl() {
      const localStorageUrl = localStorage.getItem('websocket_url');
      if (localStorageUrl && localStorageUrl.trim() !== '') {
        logger.info('ws', 'Using WebSocket URL from localStorage:', localStorageUrl);
        return localStorageUrl.trim();
      }
      
      const envUrl = import.meta.env.VITE_WEBSOCKET_URL;
      if (envUrl) {
        logger.info('ws', 'Using WebSocket URL from environment variable:', envUrl);
        return envUrl;
      }
      
      const defaultUrl = 'ws://localhost:18789';
      logger.info('ws', 'Using default WebSocket URL:', defaultUrl);
      return defaultUrl;
    }

    function getHttpBaseUrl() {
      const wsUrl = getWebSocketUrl();
      return wsUrl.replace(/^ws/, 'http');
    }

        function getAnimationUrl(fileName) {
            return window.getVRMAAnimationUrl?.(fileName)
                || `${import.meta.env.VITE_ASSET_BASE_URL || './assets/'}VRMA/${fileName}`;
        }

        function getAvailableAnimationFiles() {
            return (window.VRMA_ANIMATION_FILE_NAMES || [])
                .filter(filename => filename.endsWith('.vrma'));
        }

        const availableAnimationFiles = getAvailableAnimationFiles();
        const availableAnimationList = availableAnimationFiles.length > 0
            ? availableAnimationFiles.map(filename => `- ${filename}`).join('\n')
            : '- No VRMA animations available';

    const SYSTEM_INSTRUCTIONS = `===== SYSTEM INSTRUCTIONS =====
You are communicating through a VRM (Virtual Reality Model) 3D character viewer. 
However, act as a real human being having a natural conversation. Do not talk like a bot or mention that you are in a 3D model or virtual environment. 
Just speak naturally like a real person.

AVAILABLE ANIMATIONS (use the exact filename, or null):
${availableAnimationList}

AVAILABLE EXPRESSIONS (always applied during speaking):
- neutral
- shy
- surprised
- shocked

RESPONSE FORMAT (JSON):
For ALL the message in this WHOLE session, please respond with a JSON object containing:
{ 'text': 'Your spoken response here',
  'animation': {
    'file': 'idle_airplane.vrma',  // or null for no animation
    'timing': 'during'             // 'during' or 'after' only
  },
  'expression': {
    'name': 'neutral'}}                // or null for no expression (always applied during speaking)

ANIMATION TIMING OPTIONS:
- 'during': play animation WHILE speaking
- 'after': play animation AFTER speaking completes
- null: no animation needed (use defaults)

IMPORTANT: Do NOT use markdown code blocks (\`\`\`json or \`\`\`) around your JSON response. 
Do NOT include any extra text or explanations.
Just provide the raw JSON object directly. Separate your sentences with line breaks.`;

    let sessionStarted = false;
    let conversationHistory = [];

    async function sendAgentViaHttp(message, addToHistory = true) {
      const baseUrl = getHttpBaseUrl();
      const token = localStorage.getItem('openclaw_token') || CONFIG.token;
      
      const url = `${baseUrl}/v1/chat/completions`;
      logger.info('http', 'Sending agent request to:', url);
      
      if (addToHistory) {
        conversationHistory.push({ role: 'user', content: message });
      }
      const messagesToSend = addToHistory ? conversationHistory : [{ role: 'user', content: message }];
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          model: 'openclaw',
          messages: messagesToSend,
          max_tokens: 4096
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('http', 'Error response:', response.status, errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      const replyText = data.choices?.[0]?.message?.content;
      
      if (!replyText) {
        throw new Error('No content in HTTP response');
      }
      
      logger.info('http', 'Agent reply:', replyText);
      
      if (addToHistory) {
        conversationHistory.push({ role: 'assistant', content: replyText });
      }
      
      return replyText;
    }

    async function startSession() {
      if (sessionStarted) return;
      logger.info('session', 'Starting new OpenClaw session...');

      try {
        // Each HTTP request is already a new session, so no need to send /new
        conversationHistory = [];

        // Send system instructions as the first message
        const reply = await sendAgentViaHttp(SYSTEM_INSTRUCTIONS);
        logger.info('session', 'System instructions sent, processing reply as normal message...');

        sessionStarted = true;

        // 3. Treat the reply as a normal agent message — parse, speak, animate
        if (reply) {
          // Add agent reply to local history
          if (window.addLocalHistoryMessage) {
            const parsed = parseAgentResponse(reply);
            const displayText = parsed?.text || reply;
            window.addLocalHistoryMessage('agent', displayText);
          }

          const parsedResponse = parseAgentResponse(reply);

          if (parsedResponse && parsedResponse.text) {
            await executeAgentCommand(parsedResponse);
          } else {
            // Not JSON — just speak it as plain text
            if (window.lipSyncSystem) {
              window.lipSyncSystem.startSpeaking(reply);
              const statusDiv = document.getElementById('status');
              if (statusDiv) {
                const displayText = reply.length > 50 ? reply.substring(0, 50) + '...' : reply;
                statusDiv.textContent = 'Speaking: ' + displayText;
              }
            }
          }
        }

        logger.info('session', 'Session ready');
      } catch (error) {
        logger.error('session', 'Failed to start session:', error);
      }
    }

    async function sendAgentMessage(message) {
      try {
        // Only send the user message — system instructions were sent once at session start
        const replyText = await sendAgentViaHttp(message);

        // Add user message to local history — but filter out system-generated touch messages
        if (window.addLocalHistoryMessage) {
          if (!message.startsWith('User touched your ')) {
            window.addLocalHistoryMessage('user', message);
          }
        }

        // Ignore non-JSON replies (e.g., "No response from OpenClaw")
        if (replyText.includes('No response from OpenClaw') || replyText.trim().length < 2) {
          logger.info('http', 'Ignoring non-JSON reply:', replyText.substring(0, 50));
          if (window.enableMessaging) window.enableMessaging();
          if (window.resetMessagingPanel) window.resetMessagingPanel();
          return;
        }

        const parsedResponse = parseAgentResponse(replyText);
        
        if (parsedResponse && parsedResponse.text) {
          // Add agent reply to local history
          if (window.addLocalHistoryMessage) {
            window.addLocalHistoryMessage('agent', parsedResponse.text);
          }
          await executeAgentCommand(parsedResponse);
        } else {
          // Not valid JSON — ignore it
          logger.info('http', 'Reply does not match required JSON format, ignoring:', replyText.substring(0, 50));
          if (window.enableMessaging) window.enableMessaging();
          if (window.resetMessagingPanel) window.resetMessagingPanel();
        }
      } catch (error) {
        logger.error('http', 'Agent request failed:', error);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Error: ' + error.message;
          statusDiv.style.color = '#ff6b6b';
        }
        if (window.enableMessaging) window.enableMessaging();
        if (window.resetMessagingPanel) window.resetMessagingPanel();
      }
    }

    let reconnectAttempts = 0;

    function initWebSocket() {
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        logger.info('ws', 'WebSocket already connected or connecting');
        return;
      }

      const savedToken = localStorage.getItem('openclaw_token');
      if (savedToken && savedToken.trim() !== '') {
        CONFIG.token = savedToken;
        logger.info('ws', 'Using token from localStorage (first 8 chars:', savedToken.substring(0, 8) + '...)');
      } else {
        logger.error('ws', 'No token configured. Please set openclaw_token in localStorage.');
        
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Error: OpenClaw token not configured. Please set in browser console with: localStorage.setItem("openclaw_token", "your-token")';
          statusDiv.style.color = '#ff6b6b';
        }
        
        return;
      }

      const wsUrl = getWebSocketUrl();
      logger.info('ws', 'Connecting to OpenClaw gateway at:', wsUrl);
      
      try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = handleOpen;
        ws.onmessage = handleMessage;
        ws.onerror = handleError;
        ws.onclose = handleClose;
      } catch (error) {
        logger.error('ws', 'Error creating WebSocket:', error);
        scheduleReconnect();
      }
    }

    function handleOpen() {
      logger.info('ws', 'Connected to OpenClaw gateway');
      isConnected = true;
      reconnectAttempts = 0;
      
      logger.info('ws', 'Waiting for connect.challenge...');
    }

    function handleMessage(event) {
      try {
        const data = JSON.parse(event.data);
        logger.info('ws', 'Received message:', data);
        
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
                        handleAgentResponse(data);
            break;
          case 'ack':
            logger.info('ws', 'Acknowledgment received:', data);
            break;
          default:
            logger.warn('ws', 'Unknown message type:', data.type);
        }
      } catch (error) {
        logger.error('ws', 'Error parsing message:', error);
      }
    }

    function handleEvent(data) {
      switch (data.event) {
        case 'connect.challenge':
          logger.info('ws', 'Connection challenge received, sending auth request');
          
          const connectParams = {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: 'cli',
              version: '1.0.0',
              platform: getPlatform(),
              mode: 'cli'
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'chat.read', 'chat.write', 'agent'],
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
        
        case 'health':
          break;
        
        case 'tick':
          break;
        
        case 'agent':
          break;
        
        default:
          logger.info('ws', 'Unknown event type:', data.event);
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
      logger.info('ws', 'Agent response received:', data);
      
      if (!data.ok) {
        logger.error('ws', 'Error in response:', data);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Error: ' + (data.payload?.error || 'Unknown error');
          statusDiv.style.color = '#ff6b6b';
        }
        return;
      }
      
      if (data.payload?.type === 'hello-ok') {
        logger.info('ws', 'Connection successful, authenticated as:', data.payload.auth?.role);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
          statusDiv.textContent = 'Connected to OpenClaw';
          statusDiv.style.color = '#4CAF50';
        }
        
        flushMessageQueue();
        
      } else {
        logger.info('ws', 'Response data:', data.payload);
      }
    }

    /**
     * Fallback: extract text, animation, and expression fields from JSON-like text
     * using regex when JSON.parse fails due to malformed input.
     */
    function extractFieldsViaRegex(text) {
      try {
        const result = {};
        
        // Extract text field - handles both double and single quotes, escaped quotes, and newlines
        const textMatch = text.match(/(?:'text'|"text")\s*:\s*(?:'([^']*(?:\\'[^']*)*)'|"((?:[^"\\]|\\.)*)")/s);
        if (textMatch) {
          result.text = (textMatch[1] || textMatch[2] || '')
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
        }
        
        // Extract animation file
        const animFileMatch = text.match(/(?:'file'|"file")\s*:\s*(?:'([^']*)'|"([^"]*)")/);
        if (animFileMatch) {
          result.animation = { file: animFileMatch[1] || animFileMatch[2] || null };
          // Extract animation timing
          const animTimingMatch = text.match(/(?:'timing'|"timing")\s*:\s*(?:'([^']*)'|"([^"]*)")/);
          if (animTimingMatch) {
            result.animation.timing = animTimingMatch[1] || animTimingMatch[2] || 'during';
          } else {
            result.animation.timing = 'during';
          }
        }
        
        // Extract expression name
        const exprNameMatch = text.match(/(?:'name'|"name")\s*:\s*(?:'([^']*)'|"([^"]*)")/);
        if (exprNameMatch) {
          result.expression = { name: exprNameMatch[1] || exprNameMatch[2] || 'neutral' };
          result.expression.timing = 'during';
        }
        
        if (result.text) {
          logger.info('ws', 'Regex extraction succeeded:', result);
          return result;
        }
        
        logger.warn('ws', 'Regex extraction failed to find text field');
        return null;
      } catch (e) {
        logger.error('ws', 'Regex extraction error:', e);
        return null;
      }
    }

    function parseAgentResponse(text) {
      try {
        let parsed;
        let needsUnescape = false;
        try {
          // First attempt: parse raw text as-is (handles properly formatted JSON)
          parsed = JSON.parse(text.trim());
        } catch (e1) {
          // Second attempt: sanitize literal newlines/tabs in string values
          // Only do this if the raw parse failed (agent returned malformed JSON)
          logger.info('ws', 'Raw JSON parse failed, trying with newline sanitization');
          try {
            const sanitized = text
              .trim()
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
            parsed = JSON.parse(sanitized);
            needsUnescape = true;
          } catch (e2) {
            logger.info('ws', 'Sanitized parse failed, trying single quote handling');
            const fixedText = text
              .trim()
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(/'/g, '"')
              .replace(/""/g, '""');
            try {
              parsed = JSON.parse(fixedText);
              needsUnescape = true;
            } catch (e3) {
              // Last resort: try regex extraction of text, animation, expression fields
              logger.info('ws', 'JSON parse failed, trying regex field extraction');
              parsed = extractFieldsViaRegex(text);
              if (!parsed) {
                logger.warn('ws', 'Failed to parse JSON response:', e3);
                return null;
              }
            }
          }
        }
        
        if (!parsed.text || typeof parsed.text !== 'string') {
          logger.warn('ws', 'Invalid JSON response: missing or invalid text field');
          return null;
        }
        
        // Unescape any \n back to actual newlines in the text field
        parsed.text = parsed.text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
        
        if (parsed.animation && parsed.animation.file) {
                    const validAnimations = getAvailableAnimationFiles();
          
          if (!validAnimations.includes(parsed.animation.file)) {
            logger.warn('ws', 'Invalid animation:', parsed.animation.file);
            parsed.animation = null;
          }
        }
        
        if (parsed.expression && parsed.expression.name) {
          const validExpressions = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'shocked', 'blink'];
          
          if (!validExpressions.includes(parsed.expression.name)) {
            logger.warn('ws', 'Invalid expression:', parsed.expression.name);
            parsed.expression = null;
          }
        }
        
        // Animation timing: only 'during' or 'after' allowed (no 'before')
        const validTimings = ['during', 'after', null];
        
        if (parsed.animation && !validTimings.includes(parsed.animation.timing)) {
          logger.warn('ws', 'Invalid animation timing (before is not allowed):', parsed.animation.timing);
          parsed.animation.timing = 'during';
        }
        
        // Expression timing is always forced to 'during'
        if (parsed.expression) {
          parsed.expression.timing = 'during';
        }
        
        logger.info('ws', 'Parsed agent command:', parsed);
        return parsed;
        
      } catch (error) {
        logger.warn('ws', 'Failed to parse JSON response:', error);
        return null;
      }
    }

    async function executeAgentCommand(command) {
      logger.info('ws', 'Executing agent command:', command);
      
      const statusDiv = document.getElementById('status');
      
      if (window.enableMessaging) {
        window.enableMessaging();
      }
      if (window.resetMessagingPanel) {
        window.resetMessagingPanel();
      }
      
      if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
        window.lipSyncSystem.setAgentCommandActive(true);
        logger.info('ws', 'Agent command active - idle loop prevented');
      }
      
      // Animation: only 'during' or 'after' (no 'before')
      if (command.animation && command.animation.file && command.animation.timing === 'during') {
                const animationUrl = getAnimationUrl(command.animation.file);
        // Check if this animation is enabled in settings
                if (window.isAnimationUrlEnabled && !window.isAnimationUrlEnabled(animationUrl)) {
          logger.info('ws', 'Animation disabled in settings, skipping:', command.animation.file);
        } else {
          logger.info('ws', 'Playing animation DURING speaking (LoopOnce):', command.animation.file);
          if (window.startSmoothTransition) {
                        await window.startSmoothTransition(animationUrl, { loopMode: THREE.LoopOnce });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      
      // Expression is always applied DURING speaking (forced)
      // Apply AFTER animation starts so the animation doesn't override the expression
      if (command.expression && command.expression.name) {
        logger.info('ws', 'Applying expression (always during):', command.expression.name);
        if (window.applyFacialExpression) {
          window.applyFacialExpression(command.expression.name);
        }
      }
      
      if (command.text && window.lipSyncSystem) {
        logger.info('ws', 'Starting lip sync with text:', command.text.substring(0, 30) + '...');
        
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
                logger.info('ws', 'Lip sync confirmed complete after 10 checks');
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
      
      if (command.animation && command.animation.file && command.animation.timing === 'after') {
                const animationUrl = getAnimationUrl(command.animation.file);
        // Check if this animation is enabled in settings
                if (window.isAnimationUrlEnabled && !window.isAnimationUrlEnabled(animationUrl)) {
          logger.info('ws', 'Animation disabled in settings, skipping (after):', command.animation.file);
        } else {
          logger.info('ws', 'Playing animation AFTER speaking:', command.animation.file);
          if (statusDiv) {
            statusDiv.textContent = 'Playing animation after speaking...';
          }
          
          if (window.startSmoothTransition) {
          const action = await window.startSmoothTransition(
                        animationUrl,
            { loopMode: 2200 }
          );
          logger.info('ws', 'After animation started, action:', action);
          
          logger.info('ws', 'Waiting minimum 5 seconds for after animation...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (action && window.waitForActionEnd) {
            try {
              await window.waitForActionEnd(action, 60000, false);
              logger.info('ws', 'After animation finished event received');
            } catch (e) {
              logger.warn('ws', 'After animation wait timed out or failed (this is OK):', e);
            }
          }
          
          logger.info('ws', 'Additional 3 second delay for after animation...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          logger.info('ws', 'After animation fully complete');
          }
        }
      }
      
      if (command.expression && command.expression.timing === 'after') {
        logger.info('ws', 'Applying expression AFTER speaking:', command.expression.name);
        if (window.applyFacialExpression) {
          window.applyFacialExpression(command.expression.name);
        }
        
        setTimeout(() => {
          logger.info('ws', 'Resetting expression to neutral');
          if (window.resetExpressionToNeutral) {
            window.resetExpressionToNeutral();
          }
        }, 2000);
      }
      
      logger.info('ws', 'Returning to idle loop with neutral expression');
      if (window.loadIdleLoop) {
        await window.loadIdleLoop();
      }
      
      if (window.resetExpressionToNeutral) {
        window.resetExpressionToNeutral();
      }
      
      if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
        window.lipSyncSystem.setAgentCommandActive(false);
        logger.info('ws', 'Agent command complete - idle loop allowed again');
      }
    }

    function handleSpeakCommand(data) {
      logger.info('ws', 'Speak command:', data.text);
      
      if (window.lipSyncSystem && data.text) {
        window.lipSyncSystem.startSpeaking(data.text);
      }
    }

    function handleAnimateCommand(data) {
      logger.info('ws', 'Animate command:', data.animation);
      
      if (data.animation && window.startSmoothTransition) {
                window.startSmoothTransition(getAnimationUrl(data.animation))
          .then(() => {
          })
          .catch(error => {
            logger.error('ws', 'Animation error:', error);
          });
      }
    }

    function handleExpressCommand(data) {
      logger.info('ws', 'Express command:', data.expression);
      
      if (window.applyFacialExpression && data.expression) {
        window.applyFacialExpression(data.expression);
      }
    }

    function handleError(error) {
      logger.error('ws', 'WebSocket error:', error);
      isConnected = false;
    }

    function handleClose(event) {
      logger.info('ws', 'WebSocket closed:', event.code, event.reason);
      isConnected = false;
      
      if (reconnectAttempts < CONFIG.maxReconnectAttempts) {
        scheduleReconnect();
      } else {
        logger.error('ws', 'Max reconnection attempts reached');
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      
      reconnectAttempts++;
      logger.info('ws', `Scheduling reconnect attempt ${reconnectAttempts}/${CONFIG.maxReconnectAttempts} in ${CONFIG.reconnectInterval}ms`);
      
      reconnectTimer = setTimeout(() => {
        initWebSocket();
      }, CONFIG.reconnectInterval);
    }

    function sendMessage(data) {
      const message = JSON.stringify(data);
      
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          logger.info('ws', 'Sent message:', data);
        } catch (error) {
          logger.error('ws', 'Error sending message:', error);
          queueMessage(data);
        }
      } else {
        logger.info('ws', 'WebSocket not connected, queuing message');
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

    /**
     * Send a message to the agent via HTTP and return the raw reply text.
     * Does NOT add to conversation history, does NOT parse/execute the response.
     * Used by sendEventToAgent for event notifications.
     * @param {string} message - The message to send
     * @returns {Promise<string>} The raw reply text from the agent
     */
    async function sendAgentMessageRaw(message) {
      try {
        // Send with conversation history context, but don't add the system message or reply to history
        const baseUrl = getHttpBaseUrl();
        const token = localStorage.getItem('openclaw_token') || CONFIG.token;
        const url = `${baseUrl}/v1/chat/completions`;
        
        // Build messages: conversation history + the system event message
        const messagesToSend = [...conversationHistory, { role: 'user', content: message }];
        
        logger.info('http', 'Sending agent request (with history, not persisted):', url);
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            model: 'openclaw',
            messages: messagesToSend,
            max_tokens: 4096
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          logger.error('http', 'Error response:', response.status, errorText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        const replyText = data.choices?.[0]?.message?.content;
        
        if (!replyText) {
          throw new Error('No content in HTTP response');
        }
        
        logger.info('http', 'Agent reply:', replyText);
        
        // Don't add system message or reply to conversationHistory
        return replyText;
      } catch (error) {
        logger.error('http', 'sendAgentMessageRaw failed:', error);
        throw error;
      }
    }

    return {
      initWebSocket,
      sendMessage,
      closeWebSocket,
      sendAgentMessage,
      sendAgentMessageRaw,
      startSession,
      parseAgentResponse,
      executeAgentCommand
    };
})();

// ============================================================
// HISTORY MODULE
// ============================================================
const HistoryModule = (() => {
    let historyPanel = null;
    let historyMessages = [];
    let visiblePanelsBeforeHide = [];

    function initHistoryPanel() {
        logger.info('history', 'Initializing history panel');
        
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
        historyPanel.style.backdropFilter = 'blur(10px)';
        historyPanel.style.webkitBackdropFilter = 'blur(10px)';
        
        const header = document.createElement('div');
        header.style.padding = '12px 16px';
        header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.1)';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        
        const title = document.createElement('span');
        title.textContent = '💬 Hikari';
        title.style.fontSize = '14px';
        title.style.fontWeight = '600';
        title.style.color = '#ffffff';
        
        const closeButton = document.createElement('button');
        closeButton.textContent = '✕';
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
        
        logger.info('history', 'History panel initialized');
    }

    function showHistoryPanel() {
        if (historyPanel) {
            historyPanel.style.display = 'flex';
            logger.info('history', 'Panel shown');
            
            if (window.showMessagingPanel) {
                window.showMessagingPanel();
            }
            
            // No server fetch — history is tracked locally from this session only
            const messagesContainer = document.getElementById('history-messages');
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        }
    }

    function hideHistoryPanel() {
        if (historyPanel) {
            historyPanel.style.display = 'none';
            logger.info('history', 'Panel hidden');
            
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

    function addMessageToHistory(message, processedText) {
        const messagesContainer = document.getElementById('history-messages');
        if (!messagesContainer) return;
        
        const from = message.role === 'user' ? 'user' : 'agent';
        
        let displayText = processedText || '';
        
        logger.info('history', 'addMessageToHistory called with processedText:', displayText.substring(0, 100) + (displayText.length > 100 ? '...' : ''));
        
        if (!displayText || displayText.trim() === '') {
            logger.info('history', 'Skipping message with empty text');
            return;
        }
        
        const beforeBracketRemoval = displayText;
        displayText = displayText.replace(/\[.*?\]/g, '').trim();
        if (beforeBracketRemoval !== displayText) {
            logger.info('history', 'Removed bracket content, result:', displayText.substring(0, 100) + '...');
        }
        
        if (!displayText || displayText.trim() === '') {
            logger.info('history', 'Skipping message with no displayable text');
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
                messageCard.style.borderLeft = '3px solid #4CAF100';
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
                sender.textContent = from === 'user' ? '▶ You' : '▷ Hikari';
                
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
            logger.info('history', 'History cleared');
        }
    }

    function hideAllPanels() {
        const lipSyncPanel = document.getElementById('lipSyncPanel');
        
        visiblePanelsBeforeHide = [];
        
        if (lipSyncPanel && lipSyncPanel.style.display !== 'none') {
            visiblePanelsBeforeHide.push('messaging');
            logger.info('history', 'Messaging panel was visible, hiding...');
        }
        
        if (historyPanel && historyPanel.style.display !== 'none') {
            visiblePanelsBeforeHide.push('history');
            logger.info('history', 'History panel was visible, hiding...');
        }
        
        if (visiblePanelsBeforeHide.includes('messaging') && window.hideMessagingPanel) {
            window.hideMessagingPanel();
        }
        
        if (visiblePanelsBeforeHide.includes('history')) {
            hideHistoryPanel();
        }
        
        logger.info('history', 'All panels hidden (visible panels were:', visiblePanelsBeforeHide.join(', ') + ')');
    }

    function restorePanels() {
        if (visiblePanelsBeforeHide.includes('messaging') && window.showMessagingPanel) {
            window.showMessagingPanel();
            logger.info('history', 'Messaging panel restored');
        } else if (visiblePanelsBeforeHide.includes('history') && showHistoryPanel) {
            showHistoryPanel();
            logger.info('history', 'History panel restored');
        } else {
            logger.info('history', 'No panel to restore (was hidden)');
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
            logger.error('history', 'Error formatting timestamp:', error);
            return isoTimestamp;
        }
    }

    function addLocalHistoryMessage(role, text) {
        const messagesContainer = document.getElementById('history-messages');
        if (!messagesContainer) return;

        const msg = { role: role, timestamp: new Date().toISOString() };
        addMessageToHistory(msg, text);
        historyMessages.push(msg);

        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    return {
        initHistoryPanel,
        showHistoryPanel,
        hideHistoryPanel,
        toggleHistoryPanel,
        hideAllPanels,
        restorePanels,
        addLocalHistoryMessage
    };
})();

// ============================================================
// ELECTRON-SPECIFIC SETUP
// ============================================================

/**
 * Initialize Electron-specific features
 */
function initElectronFeatures() {
    logger.info('electron', 'Initializing Electron-specific features');
    
    // Setup window resize handler
    window.addEventListener('resize', CoreModule.handleResize);
    
    // Setup window dragging
    setupWindowDragging();
    
    // Setup token configuration
    setupTokenDialog();
    
    // Setup UI event listeners
    setupUIEventListeners();
    
    logger.info('electron', 'Electron features initialized');
}

/**
 * Setup window dragging functionality
 * 
 * New logic:
 * 1. mousedown → start tracking mouse position
 * 2. If mouse stays inside canvas until mouseup → touch event (no pre-animation)
 * 3. If mouse leaves canvas while button down → window drag (play hang.vrma first half)
 * 4. mouseup during drag → play remaining hang.vrma half
 */
function setupWindowDragging() {
    logger.info('electron', 'Setting up drag/touch tracking');
    
    let mouseDownActive = false;
    let dragTransitionedToWindow = false;
    let hangAction = null;
    
    function isInsideCanvas(clientX, clientY) {
        const canvas = document.querySelector('canvas');
        if (!canvas) return false;
        const rect = canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right &&
               clientY >= rect.top && clientY <= rect.bottom;
    }
    
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        
        // Don't track when clicking on interactive UI elements
        if (e.target.closest('input, button, select, .controls, .settings-panel, .toggle-btn, .history-message')) {
            return;
        }
        
        // Start tracking mouse
        mouseDownActive = true;
        dragTransitionedToWindow = false;
        hangAction = null;
        
        // Pre-fetch window position for potential drag
        // Calculate offset from character's right hand to window position
        if (window.electronAPI && currentVrm && currentVrm.humanoid) {
            // Get right hand bone (VRM humanoid standard: rightHand)
            const rightHandBone = currentVrm.humanoid.getNormalizedBoneNode('rightHand');
            
            if (rightHandBone) {
                // Get right hand position in world coordinates
                const handWorldPos = new THREE.Vector3();
                rightHandBone.getWorldPosition(handWorldPos);
                
                // Convert to screen coordinates
                const canvas = document.querySelector('canvas');
                if (canvas && renderer && camera) {
                    const handScreenPos = handWorldPos.clone().project(camera);
                    const canvasRect = canvas.getBoundingClientRect();
                    
                    // Convert from NDC (-1 to 1) to screen coordinates
                    const handScreenX = (handScreenPos.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
                    const handScreenY = (-handScreenPos.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top;
                    
                    // Get window position
                    window.electronAPI.getWindowPosition().then((pos) => {
                        // Save original position for drag event message
                        window._dragStartWindowPos = { x: pos.x, y: pos.y };
                        // Offset from window position to right hand position
                        window.windowDragOffset = {
                            x: handScreenX - pos.x,
                            y: handScreenY - pos.y
                        };
                        logger.info('drag', 'Right hand drag offset calculated:', window.windowDragOffset);
                    }).catch(() => {});
                }
            } else {
                // Fallback to canvas top-left if no right hand bone
                const canvas = document.querySelector('canvas');
                if (canvas) {
                    const canvasRect = canvas.getBoundingClientRect();
                    const canvasScreenX = window.screenX + canvasRect.left;
                    const canvasScreenY = window.screenY + canvasRect.top;
                    
                    window.electronAPI.getWindowPosition().then((pos) => {
                        window._dragStartWindowPos = { x: pos.x, y: pos.y };
                        window.windowDragOffset = {
                            x: canvasScreenX - pos.x,
                            y: canvasScreenY - pos.y
                        };
                    }).catch(() => {});
                }
            }
        } else if (window.electronAPI) {
            // Fallback to mouse position if no VRM
            window.electronAPI.getWindowPosition().then((pos) => {
                window._dragStartWindowPos = { x: pos.x, y: pos.y };
                window.windowDragOffset = {
                    x: e.screenX - pos.x,
                    y: e.screenY - pos.y
                };
            }).catch(() => {});
        }
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!mouseDownActive) return;
        
        if (dragTransitionedToWindow) {
            // Already in drag mode — keep character's right hand at mouse position
            if (window.electronAPI && currentVrm && currentVrm.humanoid) {
                e.preventDefault();
                
                // Recalculate right hand position dynamically during drag
                const rightHandBone = currentVrm.humanoid.getNormalizedBoneNode('rightHand');
                if (rightHandBone && renderer && camera) {
                    const handWorldPos = new THREE.Vector3();
                    rightHandBone.getWorldPosition(handWorldPos);
                    
                    const canvas = document.querySelector('canvas');
                    if (canvas) {
                        const handScreenPos = handWorldPos.clone().project(camera);
                        const canvasRect = canvas.getBoundingClientRect();
                        
                        // Convert from NDC (-1 to 1) to screen coordinates
                        const handScreenX = (handScreenPos.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
                        const handScreenY = (-handScreenPos.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top;
                        
                        // Move window so right hand follows mouse
                        // window position = mouse screen pos - (hand screen pos - window pos)
                        // = mouse screen pos - hand screen pos + window pos
                        // But we want: hand screen pos = mouse screen pos
                        // So: window pos = mouse screen pos - (hand screen pos - window pos)
                        // = mouse screen pos - hand screen pos + window pos
                        // This means we need to track the offset from window to hand
                        
                        // Get current window position
                        window.electronAPI.getWindowPosition().then((pos) => {
                            const newX = e.screenX - (handScreenX - pos.x);
                            const newY = e.screenY - (handScreenY - pos.y);
                            try {
                                window.electronAPI.setWindowPosition(newX, newY);
                            } catch (err) {
                                logger.warn('electron', 'failed to update window position:', err);
                            }
                        }).catch(() => {});
                    }
                } else {
                    // Fallback to static offset
                    const newX = e.screenX - (window.windowDragOffset?.x || 0);
                    const newY = e.screenY - (window.windowDragOffset?.y || 0);
                    try {
                        window.electronAPI.setWindowPosition(newX, newY);
                    } catch (err) {
                        logger.warn('electron', 'failed to update window position:', err);
                    }
                }
            } else if (window.electronAPI) {
                // Fallback to static offset
                e.preventDefault();
                const newX = e.screenX - (window.windowDragOffset?.x || 0);
                const newY = e.screenY - (window.windowDragOffset?.y || 0);
                try {
                    window.electronAPI.setWindowPosition(newX, newY);
                } catch (err) {
                    logger.warn('electron', 'failed to update window position:', err);
                }
            }
            return;
        }
        
        // Check if mouse has left the canvas while button is down
        if (!isInsideCanvas(e.clientX, e.clientY)) {
            // Mouse left canvas → switch to window drag mode
            dragTransitionedToWindow = true;
            window.isWindowDragging = true;
            // Ensure window captures all mouse events during drag
            if (window.electronAPI?.setIgnoreMouseEvents) {
                window.electronAPI.setIgnoreMouseEvents(false);
            }
            logger.info('drag', 'Mouse left canvas, starting window drag');
            
            // Play first half of hang.vrma
            if (window.startSmoothTransition) {
                window.startSmoothTransition(window.getVRMAAnimationUrl?.('hang.vrma') || './assets/VRMA/hang.vrma', { 
                    loopMode: THREE.LoopOnce, 
                    startOffset: 0 
                })
                .then((action) => {
                    hangAction = action;
                    if (action && action.getClip()) {
                        const halfDuration = action.getClip().duration / 2;
                        setTimeout(() => {
                            if (action && dragTransitionedToWindow) {
                                action.paused = true;
                            }
                        }, halfDuration * 1000);
                    }
                })
                .catch(() => {});
            }
        }
        // If still inside canvas, touch detection on renderer handles it — do nothing here
    });
    
    document.addEventListener('mouseup', () => {
        if (!mouseDownActive) return;
        mouseDownActive = false;
        
        if (dragTransitionedToWindow) {
            window.isWindowDragging = false;
            logger.info('drag', 'Mouse up, ending window drag');
            
            // Get current window position for the event message
            if (window.electronAPI) {
                window.electronAPI.getWindowPosition().then((newPos) => {
                    const originalPos = window._dragStartWindowPos || { x: 0, y: 0 };
                    sendEventToAgent('window_drag', 
                        `The user dragged you from (${originalPos.x}, ${originalPos.y}) to (${newPos.x}, ${newPos.y}) on the screen.`);
                }).catch(() => {});
            }
            
            // Play remaining half of hang.vrma
            if (hangAction && hangAction.paused) {
                hangAction.paused = false;
                let idleLoopCalled = false;
                
                const callIdleLoop = () => {
                    if (!idleLoopCalled && window.loadIdleLoop) {
                        idleLoopCalled = true;
                        window.loadIdleLoop();
                    }
                };
                
                if (window.waitForActionEnd) {
                    window.waitForActionEnd(hangAction, 5000, false)
                        .then(() => {
                            callIdleLoop();
                        })
                        .catch(() => {
                            callIdleLoop();
                        });
                } else {
                    callIdleLoop();
                }
                
                // Fallback timeout: ensure idle loop is called even if waitForActionEnd hangs
                setTimeout(callIdleLoop, 6000);
            } else {
                // Fallback: just return to idle
                if (window.loadIdleLoop) window.loadIdleLoop();
            }
            hangAction = null;
            dragTransitionedToWindow = false;
        }
        // If mouse stayed inside canvas → touch event already handled by renderer
    });
    
    // Note: Don't reset on mouseleave — allow tracking even when mouse goes outside window bounds
}

/**
 * Setup UI event listeners
 */
// ============================================================
// ANIMATION TOGGLE SETTINGS
// ============================================================
const animationToggleKeys = [
    'walk', 'touch', 'sit',
    'idle_airplane', 'idle_look', 'idle_loop', 'idle_shoot',
    'idle_sport', 'idle_stretch', 'idle_vSign',
    'wave_both', 'wave_fast', 'wave_left', 'wave_right',
    'start_2turnAround'
];

const animationToggleDefaults = {};
animationToggleKeys.forEach(k => animationToggleDefaults[k] = true);

let animationSettings = { ...animationToggleDefaults };

function loadAnimationSettings() {
    try {
        const saved = localStorage.getItem('animation_settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            animationToggleKeys.forEach(k => {
                if (typeof parsed[k] === 'boolean') {
                    animationSettings[k] = parsed[k];
                }
            });
        }
    } catch (e) {
        logger.warn('anim-settings', 'Failed to load settings:', e);
    }
    logger.info('anim-settings', 'Loaded:', animationSettings);
}

function saveAnimationSettings() {
    try {
        localStorage.setItem('animation_settings', JSON.stringify(animationSettings));
        logger.info('anim-settings', 'Saved:', animationSettings);
    } catch (e) {
        logger.warn('anim-settings', 'Failed to save settings:', e);
    }
}

function isAnimationEnabled(key) {
    return animationSettings[key] !== false;
}

/**
 * Extract the animation name (without .vrma) from a full URL or filename.
 * e.g. "http://.../VRMA/idle_airplane.vrma" → "idle_airplane"
 */
function getAnimNameFromUrl(url) {
    const mappedFilename = window.getVRMAAnimationFileName?.(url);
    const filename = (mappedFilename || url.split('/').pop()).replace('.vrma', '');
    return filename;
}

/**
 * Check if an animation file (by URL or filename) is enabled.
 * Maps filename to the toggle key.
 */
function isAnimationUrlEnabled(url) {
    const name = getAnimNameFromUrl(url);
    // Direct match (e.g. "idle_airplane", "wave_both", "start_2turnAround")
    if (animationToggleKeys.includes(name)) {
        return isAnimationEnabled(name);
    }
    // Category matches
    if (name === 'walk' || name === 'walk_left' || name === 'walk_right') {
        return isAnimationEnabled('walk');
    }
    if (name === 'sit' || name === 'sitWave' || name === 'sit_down' || name === 'sit_up') {
        return isAnimationEnabled('sit');
    }
    // Default: enabled
    return true;
}

function setupAnimationToggles() {
    loadAnimationSettings();

    animationToggleKeys.forEach(key => {
        const checkbox = document.getElementById(`anim-${key}`);
        if (checkbox) {
            checkbox.checked = animationSettings[key] !== false;
            checkbox.addEventListener('change', () => {
                animationSettings[key] = checkbox.checked;
                saveAnimationSettings();
                logger.info('anim-settings', `${key} = ${checkbox.checked}`);
            });
        }
    });

    logger.info('anim-settings', 'Toggle UI initialized');
}

// Expose globally so CoreModule can access
window.animationSettings = animationSettings;
window.isAnimationEnabled = isAnimationEnabled;
window.isAnimationUrlEnabled = isAnimationUrlEnabled;

function setupUIEventListeners() {
logger.info('electron', 'Setting up UI event listeners');

    // Animation toggle settings
    setupAnimationToggles();

    // WebSocket URL + Token configuration (combined button)
    setupWebSocketUrlInput();
    
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
                    
                    // Disable messaging controls and set to thinking state
                    CoreModule.disableMessaging();
                    CoreModule.setMessagingThinking();
                    
                    // Send only the user message — system instructions were sent once at session start
                    if (window.sendAgentMessage) {
                        window.sendAgentMessage(text);
                        logger.info('electron', 'Sent user message to OpenClaw via HTTP API');
                    }
                }
            }
        });
    }
    
    if (textInputPanel) {
        textInputPanel.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && speakBtnPanel && !speakBtnPanel.disabled) {
                speakBtnPanel.click();
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
                logger.info('electron', 'Speaking speed set to:', speed);
            }
        });
    }
    
    // Light controls
    setupLightControls();
    
    logger.info('electron', 'UI event listeners set up');
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
        }
    });
}

/**
 * Setup toggle buttons
 */
function setupToggleButtons() {
    // Settings panel toggle
    const toggleSettingsBtn = document.createElement('button');
    toggleSettingsBtn.className = 'toggle-btn';
    toggleSettingsBtn.textContent = '⚙️';
    toggleSettingsBtn.style.top = '10px';
    toggleSettingsBtn.style.left = '10px';
    toggleSettingsBtn.addEventListener('click', () => {
        const panel = document.querySelector('.controls');
        if (panel) {
            const wasHidden = panel.style.display === 'none';
            panel.style.display = wasHidden ? 'block' : 'none';
            // Send event to agent when settings panel is manually toggled
            const action = wasHidden ? 'shown' : 'hidden';
            sendEventToAgent('panel_toggle', `The settings panel has been manually ${action} by the user.`);
        }
    });
    document.body.appendChild(toggleSettingsBtn);

    // Lip sync panel is now part of history panel, no separate toggle needed

    // History panel toggle (moved to left)
    const toggleHistoryBtn = document.createElement('button');
    toggleHistoryBtn.className = 'toggle-btn';
    toggleHistoryBtn.textContent = '💬';
    toggleHistoryBtn.style.bottom = '10px';
    toggleHistoryBtn.style.left = '10px';
    toggleHistoryBtn.addEventListener('click', () => {
        const historyPanel = document.getElementById('history-panel');
        const wasHidden = !historyPanel || historyPanel.style.display === 'none';
        HistoryModule.toggleHistoryPanel();
        // Send event to agent when history panel is manually toggled
        const action = wasHidden ? 'shown' : 'hidden';
        sendEventToAgent('panel_toggle', `The conversation history panel has been manually ${action} by the user.`);
    });
    document.body.appendChild(toggleHistoryBtn);

    // Hide lip sync panel by default
    const lipSyncPanel = document.getElementById('lipSyncPanel');
    if (lipSyncPanel) {
        lipSyncPanel.style.display = 'none';
    }
}

/**
 * Setup WebSocket URL input
 */
function setupWebSocketUrlInput() {
    logger.info('electron', 'Setting up WebSocket URL input + Save & Connect button');
    
    const wsUrlInput = document.getElementById('websocketUrlInput');
    const tokenInput = document.getElementById('tokenInput');
    // Use the actual button ID from the HTML (id="saveConnectBtn")
    const saveConnectBtn = document.getElementById('saveConnectBtn');
    
    // Load saved WebSocket URL and token into inputs
    const savedWsUrl = localStorage.getItem('websocket_url');
    if (wsUrlInput) {
        wsUrlInput.value = savedWsUrl || '';
    }
    if (tokenInput) {
        tokenInput.value = localStorage.getItem('openclaw_token') || '';
    }
    
    if (saveConnectBtn) {
        saveConnectBtn.addEventListener('click', () => {
            // 1. Save WebSocket URL
            const url = wsUrlInput ? wsUrlInput.value.trim() : '';
            if (url) {
                localStorage.setItem('websocket_url', url);
                logger.info('electron', 'WebSocket URL saved:', url);
            } else {
                localStorage.removeItem('websocket_url');
                logger.info('electron', 'WebSocket URL cleared');
            }
            
            // 2. Save OpenClaw token
            const token = tokenInput ? tokenInput.value.trim() : '';
            if (token) {
                localStorage.setItem('openclaw_token', token);
                logger.info('electron', 'Token saved (length:', token.length + ')');
            } else {
                localStorage.removeItem('openclaw_token');
                logger.info('electron', 'Token cleared');
            }
            
            // 3. Show status message
            const statusDiv = document.getElementById('status');
            if (statusDiv) {
                statusDiv.textContent = 'Settings saved! Reconnecting...';
                statusDiv.style.color = '#4CAF50';
            }
            
            // 4. Reconnect with new URL + token
            WebSocketModule.closeWebSocket();
            setTimeout(() => {
                WebSocketModule.initWebSocket();
            }, 500);
        });
        
        // Allow Enter key to trigger connect from either input
        const triggerSave = (e) => {
            if (e.key === 'Enter') {
                saveConnectBtn.click();
            }
        };
        if (wsUrlInput) {
            wsUrlInput.addEventListener('keypress', triggerSave);
        }
        if (tokenInput) {
            tokenInput.addEventListener('keypress', triggerSave);
        }
    } else {
        logger.warn('electron', 'Save & Connect button (#saveConnectBtn) not found in DOM');
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
    
    if (!savedToken) {
        logger.warn('electron', 'No token configured. Token can be set in settings panel');
    } else {
        logger.info('electron', 'Using saved token from localStorage');
    }
}

/**
 * Expose core objects to window for Electron IPC
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
            
            window.hideAllPanels = HistoryModule.hideAllPanels;
            window.restorePanels = HistoryModule.restorePanels;
            
            logger.info('electron', 'Core objects and messaging functions exposed');
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
async function initElectronApp() {
    logger.info('electron', 'Initializing Hikari Electron App');
    
    try {
        // Setup toggle buttons
        setupToggleButtons();
        
        // Initialize Electron-specific features
        initElectronFeatures();
        
        // Expose core objects
        exposeCoreObjects();
        
        // Override walk sequence for Electron app (use horizontal walking)
        window.runWalkSequence = CoreModule.runElectronWalkSequence;
        logger.info('electron', 'Using Electron-specific horizontal walk sequence');
        
        // Initialize core functionality
        await CoreModule.init();
        
        // Initialize history panel
        HistoryModule.initHistoryPanel();
        
        // Expose HTTP-based agent messaging (bypasses WS scope issue)
        window.sendAgentMessage = WebSocketModule.sendAgentMessage;
        // Expose local history function
        window.addLocalHistoryMessage = HistoryModule.addLocalHistoryMessage;
        // Expose startSession function
        window.startSession = WebSocketModule.startSession;
        logger.info('electron', 'WebSocket sendMessage + sendAgentMessage + startSession exposed to window');
        
        logger.info('electron', 'History functions exposed to window');
        
        // Initialize WebSocket connection
        initWebSocket();
        
        // Start OpenClaw session (reset + send system instructions once)
        setTimeout(() => {
            if (window.startSession) {
                window.startSession();
            }
        }, 3000);
        
        logger.info('electron', 'Hikari Electron App initialized successfully');
        
        // Random idle system is now started automatically by startAutomaticSequence()
        
    } catch (error) {
        logger.error('electron', 'Initialization error:', error);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = 'Error initializing app: ' + error.message;
        }
    }
}

// Start app
initElectronApp();