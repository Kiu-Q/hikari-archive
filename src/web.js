/**
 * Hikari Web Entry Point
 * Mobile/browser version without Electron-specific features
 */

console.log('[web] Hikari Web version starting');

import * as THREE from 'three';
import { 
    init, 
    handleResize, 
    beginRandomIdleSelection,
    hideMessagingPanel,
    showMessagingPanel,
    disableMessaging,
    enableMessaging,
    setMessagingThinking,
    resetMessagingPanel
} from './core.js';
import * as ws from './websocket.js';
import { 
    initHistoryPanel,
    showHistoryPanel,
    hideHistoryPanel,
    toggleHistoryPanel,
    displayHistoryMessages
} from './conversation-history.js';

// ============================================================
// WEB-SPECIFIC SETUP
// ============================================================

/**
 * Initialize web-specific features
 */
function initWebFeatures() {
    console.log('[web] Initializing web-specific features');
    
    // Setup window resize handler
    window.addEventListener('resize', handleResize);
    
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

let touchStartX = 0;
let touchStartY = 0;

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
 * Handle touch move (rotate camera)
 */
function handleTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;
    
    // Rotate camera based on touch movement
    // This is handled by OrbitControls, we just prevent scrolling
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
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
    
    console.log('[web] Removed Electron-specific elements');
}

/**
 * Setup toggle buttons
 */
function setupToggleButtons() {
    // Set background to loading.gif
    document.body.style.backgroundImage = 'url("./assets/loading.gif")';
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
            border-radius: 12px;
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
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        }
    });
    document.body.appendChild(toggleSettingsBtn);

    // History panel toggle button (bottom-left - messaging button removed)
    const toggleHistoryBtn = document.createElement('button');
    toggleHistoryBtn.className = 'toggle-btn';
    toggleHistoryBtn.textContent = '💬';
    toggleHistoryBtn.style.bottom = '10px';
    toggleHistoryBtn.style.left = '10px';
    toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
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
    
    console.log('[web] Toggle buttons set up, panels hidden by default');
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
                    
                    console.log('[web] Message sent:', text);
                    
                    // Hide all panels when message is sent
                    const controlsPanel = document.querySelector('.controls');
                    const lipSyncPanel = document.getElementById('lipSyncPanel');
                    const historyPanel = document.getElementById('history-panel');
                    
                    if (controlsPanel) {
                        controlsPanel.style.display = 'none';
                        console.log('[web] ✓ Hidden controls panel');
                    }
                    if (lipSyncPanel) {
                        lipSyncPanel.style.display = 'none';
                        console.log('[web] ✓ Hidden lip sync panel');
                    }
                    if (historyPanel) {
                        historyPanel.style.display = 'none';
                        console.log('[web] ✓ Hidden history panel');
                    }
                    
                    // Disable messaging controls and set to thinking state
                    disableMessaging();
                    setMessagingThinking();
                    
                    // Generate unique request ID
                    const requestId = 'req-' + Date.now();
                    
                    // Construct full message with user message + system instructions
                    const fullMessage = `===== USER MESSAGE =====
${text}

===== SYSTEM INSTRUCTIONS =====
You are communicating through a VRM (Virtual Reality Model) 3D character viewer.

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

IMPORTANT: Do NOT use markdown code blocks (\`\`\`json or \`\`\`) around your JSON response. Just provide the raw JSON object directly.
Note: Animations play fully before proceeding. Expression resets to 'neutral' when returning to idle_loop.`;
                    
                    // Send request to OpenClaw agent with full context
                    const idempotencyKey = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    
                    ws.sendMessage({
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
                    
                    console.log('[web] Sent request to OpenClaw:', requestId, text);
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
    
    // Speaking speed control
    const speakingSpeedSlider = document.getElementById('speakingSpeedSlider');
    const speakingSpeedValue = document.getElementById('speakingSpeedValue');
    if (speakingSpeedSlider && speakingSpeedValue && window._internalLipSync) {
        speakingSpeedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            speakingSpeedValue.textContent = speed.toFixed(1) + 'x';
            window._internalLipSync.setSpeakingSpeed(speed);
            console.log('[web] Speaking speed set to:', speed);
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
        }
    });
}

/**
 * Display connection status
 */
function displayConnectionStatus() {
    const statusDiv = document.getElementById('status');
    if (!statusDiv) return;
    
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
        const isConnected = ws.isWebSocketConnected();
        
        if (isConnected) {
            statusIndicator.style.background = 'rgba(76, 175, 80, 0.8)';
            statusIndicator.style.opacity = '1';
            statusIndicator.textContent = '● Connected';
            
            // Hide immediately when connected
            statusIndicator.style.display = 'none';
            
            // Record first connection time
            if (connectionShownTime === 0) {
                connectionShownTime = Date.now();
            }
            
            // Fade out after 5 seconds if still connected
            if (fadeOutTimeout) {
                clearTimeout(fadeOutTimeout);
            }
            fadeOutTimeout = setTimeout(() => {
                if (ws.isWebSocketConnected()) {
                    statusIndicator.style.opacity = '0';
                }
            }, 5000);
            
        } else {
            statusIndicator.style.background = 'rgba(244, 67, 54, 0.8)';
            statusIndicator.style.opacity = '1';
            statusIndicator.textContent = '○ Disconnected';
            
            // Reset connection time when disconnected
            connectionShownTime = 0;
            
            // Clear fade out timeout
            if (fadeOutTimeout) {
                clearTimeout(fadeOutTimeout);
                fadeOutTimeout = null;
            }
        }
    }, 1000);
    
    // Store interval for cleanup
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
                ws.closeWebSocket();
                setTimeout(() => {
                    ws.initWebSocket();
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
                ws.closeWebSocket();
                setTimeout(() => {
                    ws.initWebSocket();
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
}

/**
 * Setup token configuration dialog
 */
function setupTokenDialog() {
    // Check if token is configured
    const savedToken = localStorage.getItem('openclaw_token');
    
    // Token input is now in HTML, just set up event listener
    const tokenInput = document.getElementById('tokenInput');
    const saveTokenBtn = document.getElementById('saveTokenBtn');
    
    if (tokenInput) {
        tokenInput.value = savedToken || '';
    }
    
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
                ws.closeWebSocket();
                initWebSocketConnection();
            }
        });
    }
    
    if (!savedToken) {
        // Show error in status
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = 'Please configure OpenClaw token in settings panel';
            statusDiv.style.color = '#ff6b6b';
        }
        console.error('[web] No token configured. Please set openclaw_token in localStorage.');
        console.log('[web] Use the settings panel to configure your token');
    } else {
        console.log('[web] Using saved token from localStorage');
    }
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
        await init();
        
        // Expose messaging functions to window for websocket.js access
        window.enableMessaging = enableMessaging;
        
        window.resetMessagingPanel = resetMessagingPanel;
        window.disableMessaging = disableMessaging;
        window.setMessagingThinking = setMessagingThinking;
        window.hideMessagingPanel = hideMessagingPanel;
        window.showMessagingPanel = showMessagingPanel;
        console.log('[web] Messaging functions exposed to window with camera restoration');
        
        // Initialize history panel
        initHistoryPanel();
        
        // Expose history functions to window
        window.displayHistoryMessages = displayHistoryMessages;
        
        // Expose WebSocket sendMessage function for conversation history
        window.sendMessage = ws.sendMessage;
        console.log('[web] WebSocket sendMessage exposed to window');
        
        console.log('[web] History functions exposed to window');
        
        // Setup token
        setupTokenDialog();
        
        // Initialize WebSocket connection
        initWebSocketConnection();
        
        // Initialize web-specific features
        initWebFeatures();
        
        // Setup toggle buttons
        setupToggleButtons();
        
        // Setup UI event listeners
        setupUIEventListeners();
        
        // Display connection status
        displayConnectionStatus();
        
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

/**
 * Initialize WebSocket connection
 */
function initWebSocketConnection() {
    // Initialize WebSocket after a short delay to ensure DOM is ready
    setTimeout(() => {
        ws.initWebSocket();
    }, 1000);
}

// Start the app
initWebApp();