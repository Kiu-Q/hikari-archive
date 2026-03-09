/**
 * Hikari Electron Entry Point
 * Desktop version with window dragging and Electron-specific features
 */

console.log('[electron] Hikari Electron version starting');

import { init, handleResize, beginRandomIdleSelection, 
         hideMessagingPanel, showMessagingPanel, 
         disableMessaging, enableMessaging, 
         setMessagingThinking, resetMessagingPanel,
         saveCameraSettings, loadCameraSettings, resetCamera,
         runElectronWalkSequence } from './core.js';
import * as ws from './websocket.js';
import { 
    initHistoryPanel,
    showHistoryPanel,
    hideHistoryPanel,
    toggleHistoryPanel,
    displayHistoryMessages,
    fetchConversationHistory,
    loadMoreMessages,
    hideAllPanels,
    restorePanels
} from './conversation-history.js';

// ============================================================
// ELECTRON-SPECIFIC SETUP
// ============================================================

/**
 * Initialize Electron-specific features
 */
function initElectronFeatures() {
    console.log('[electron] Initializing Electron-specific features');
    
    // Setup window resize handler
    window.addEventListener('resize', handleResize);
    
    // Setup window dragging
    setupWindowDragging();
    
    // Setup token configuration
    setupTokenDialog();
    
    // Setup UI event listeners
    setupUIEventListeners();
    
    console.log('[electron] Electron features initialized');
}

/**
 * Setup window dragging functionality
 */
function setupWindowDragging() {
    console.log('[electron] Setting up window dragging');
    
    const dragButton = document.querySelector('.drag-btn-wrapper');
    if (dragButton) {
        dragButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (window.electronAPI) {
                window.isWindowDragging = true;
                dragButton.style.transition = 'none';
                dragButton.style.transform = 'translateY(0)';
                
                window.electronAPI.getWindowPosition().then((pos) => {
                    window.windowDragOffset = window.windowDragOffset || { x: 0, y: 0 };
                    window.windowDragOffset.x = e.screenX - pos.x;
                    window.windowDragOffset.y = e.screenY - pos.y;
                }).catch(err => {
                    console.warn('[electron] failed to get window position:', err);
                });
            }
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (window.isWindowDragging && window.electronAPI) {
            e.preventDefault();
            const newX = e.screenX - (window.windowDragOffset?.x || 0);
            const newY = e.screenY - (window.windowDragOffset?.y || 0);
            try {
                window.electronAPI.setWindowPosition(newX, newY);
            } catch (err) {
                console.warn('[electron] failed to update window position:', err);
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (window.isWindowDragging) {
            window.isWindowDragging = false;
            const dragButton = document.querySelector('.drag-btn-wrapper');
            if (dragButton) {
                dragButton.style.transition = 'all 0.3s ease';
            }
        }
    });

    document.addEventListener('mouseleave', () => {
        if (window.isWindowDragging) {
            window.isWindowDragging = false;
            const dragButton = document.querySelector('.drag-btn-wrapper');
            if (dragButton) {
                dragButton.style.transition = 'all 0.3s ease';
            }
        }
    });
}

/**
 * Setup UI event listeners
 */
function setupUIEventListeners() {
    console.log('[electron] Setting up UI event listeners');
    
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
                console.log('[electron] Camera reset');
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
                    
                    // Disable messaging controls and set to thinking state
                    disableMessaging();
                    setMessagingThinking();
                    
                    // Generate unique request ID
                    const requestId = 'req-' + Date.now();
                    const idempotencyKey = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    
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
                    
                    console.log('[electron] Sent request to OpenClaw:', requestId);
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
    
    // Speaking speed control - setup after init
    const speakingSpeedSlider = document.getElementById('speakingSpeedSlider');
    const speakingSpeedValue = document.getElementById('speakingSpeedValue');
    if (speakingSpeedSlider && speakingSpeedValue) {
        speakingSpeedSlider.addEventListener('input', (e) => {
            if (window._internalLipSync) {
                const speed = parseFloat(e.target.value);
                speakingSpeedValue.textContent = speed.toFixed(1) + 'x';
                window._internalLipSync.setSpeakingSpeed(speed);
                console.log('[electron] Speaking speed set to:', speed);
            }
        });
    }
    
    // Light controls
    setupLightControls();
    
    console.log('[electron] UI event listeners set up');
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
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.body.appendChild(toggleSettingsBtn);

    // Lip sync panel is now part of history panel, no separate toggle needed

    // History panel toggle (moved to left)
    const toggleHistoryBtn = document.createElement('button');
    toggleHistoryBtn.className = 'toggle-btn';
    toggleHistoryBtn.textContent = '💬';
    toggleHistoryBtn.style.bottom = '10px';
    toggleHistoryBtn.style.left = '10px';
    toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
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
    console.log('[electron] Setting up WebSocket URL input');
    
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
                console.log('[electron] WebSocket URL saved:', url);
                
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
                // Clear the URL setting
                localStorage.removeItem('websocket_url');
                console.log('[electron] WebSocket URL cleared');
                
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
                console.log('[electron] Token saved to localStorage');
                
                // Show success message
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    statusDiv.textContent = 'Token saved! Reconnecting...';
                    statusDiv.style.color = '#4CAF50';
                }
                
                // Reconnect WebSocket with new token
                ws.closeWebSocket();
                initWebSocket();
            }
        });
    }
    
    if (!savedToken) {
        console.warn('[electron] No token configured. Token can be set in settings panel');
    } else {
        console.log('[electron] Using saved token from localStorage');
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
            window.enableMessaging = enableMessaging;
            window.disableMessaging = disableMessaging;
            window.setMessagingThinking = setMessagingThinking;
            window.resetMessagingPanel = resetMessagingPanel;
            window.showMessagingPanel = showMessagingPanel;
            window.hideMessagingPanel = hideMessagingPanel;
            
            // Expose conversation history functions
            window.fetchConversationHistory = fetchConversationHistory;
            window.loadMoreMessages = loadMoreMessages;
            window.hideAllPanels = hideAllPanels;
            window.restorePanels = restorePanels;
            
            console.log('[electron] Core objects and messaging functions exposed');
        }, 100);
    });
}

/**
 * Initialize WebSocket connection
 */
function initWebSocket() {
    // Initialize WebSocket after a short delay to ensure DOM is ready
    setTimeout(() => {
        ws.initWebSocket();
    }, 1000);
}

// ============================================================
// INITIALIZATION
// ============================================================
async function initElectronApp() {
    console.log('[electron] Initializing Hikari Electron App');
    
    try {
        // Setup toggle buttons
        setupToggleButtons();
        
        // Initialize Electron-specific features
        initElectronFeatures();
        
        // Expose core objects
        exposeCoreObjects();
        
        // Override walk sequence for Electron app (use horizontal walking)
        window.runWalkSequence = runElectronWalkSequence;
        console.log('[electron] Using Electron-specific horizontal walk sequence');
        
        // Initialize core functionality
        await init();
        
        // Initialize history panel
        initHistoryPanel();
        
        // Expose history functions to window
        window.displayHistoryMessages = displayHistoryMessages;
        
        // Expose WebSocket sendMessage function for conversation history
        window.sendMessage = ws.sendMessage;
        console.log('[electron] WebSocket sendMessage exposed to window');
        
        console.log('[electron] History functions exposed to window');
        
        // Initialize WebSocket connection
        initWebSocket();
        
        console.log('[electron] Hikari Electron App initialized successfully');
        
        // Random idle system is now started automatically by startAutomaticSequence()
        
    } catch (error) {
        console.error('[electron] Initialization error:', error);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = 'Error initializing app: ' + error.message;
        }
    }
}

// Start app
initElectronApp();