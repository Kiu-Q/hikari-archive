/**
 * Shared Configuration for Hikari App
 * Used by both Electron and Web versions
 */

export const CONFIG = {
    DEBUG: true,
    
    // Animation transition settings
    BUFFER_TIME: 0.5,
    TRANSITION_TIME: 0.5,
    T_OFFSET: 0.5,
    BLEND_DURATION: 0.3,
    
    // Walk sequence configuration (disabled for web)
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
    
    // Timing constants
    SHORT_DELAY: 100,
    MEDIUM_DELAY: 500,
    LONG_DELAY: 3000,
    MIN_WAIT_BEFORE_AFTER_ANIM: 5000,
    MIN_LOADING_TIME: 4000,
    TRANSITION_COMPLETE_DELAY: 300,
    
    // Animation timing
    SPEECH_UNIT_DELAY: 50,
    SPEECH_BASE_DURATION: 80,
    SPEECH_LINE_PAUSE: 500,
    BLINK_DURATION: 0.2,
    BLINK_RESET_DELAY: 200,
    EXPRESSION_DECAY_MULTIPLIER: 4,
    
    // Camera settings
    CAMERA_FOV: 30.0,
    CAMERA_NEAR: 0.1,
    CAMERA_FAR: 20.0,
    DEFAULT_CAMERA_POS: { x: 0.0, y: 1.0, z: 4.5 },
    CONTROLS_TARGET: { x: 0.0, y: 1.0, z: 0.0 },
    
    // Lighting
    KEY_LIGHT_INTENSITY: 1,
    FILL_LIGHT_INTENSITY: 0.5,
    RIM_LIGHT_INTENSITY: 1,
    TOP_LIGHT_INTENSITY: 0.5,
    AMBIENT_LIGHT_INTENSITY: 0,
    KEY_LIGHT_POS: { x: 3.0, y: 4.0, z: 5.0 },
    FILL_LIGHT_POS: { x: -3.0, y: 3.0, z: 4.0 },
    RIM_LIGHT_POS: { x: 0.0, y: 2.0, z: -5.0 },
    TOP_LIGHT_POS: { x: 0.0, y: 5.0, z: 0.0 },
    
    // Speaking bubble
    BUBBLE_MAX_WIDTH: 300,
    BUBBLE_MARGIN_TOP: 80,
    BUBBLE_PADDING: 12,
    BUBBLE_SHADOW_BLUR: 12,
    BUBBLE_SHADOW_OFFSET: 4,
    BUBBLE_HIDE_DELAY: 3000,
    
    // Body part detection thresholds
    HEAD_THRESHOLD: 1.4,
    CHEST_THRESHOLD: 1.1,
    HIP_THRESHOLD: 0.7,
    
    // WebSocket / HTTP
    DEFAULT_WS_PORT: 18789,
    HISTORY_BATCH_SIZE: 100,
    MAX_MESSAGE_QUEUE: 50,
    WS_RECONNECT_INTERVAL: 3000,
    MAX_WS_RECONNECT_ATTEMPTS: 10,
    
    // Animation
    DEFAULT_MAX_WAIT: 15000,
    ANIMATION_TRACKS_TO_KEEP: 6,
    LIP_SYNC_CHECK_COUNT: 10,
    LIP_SYNC_CHECK_INTERVAL: 100,
    
    // Touch detection
    TOUCH_DEBOUNCE_MS: 1000,
    TOUCH_RESPONSE_DURATION: 3000,
    
    // Platform detection
    isElectron: false,
    isWeb: true
};

// Platform-specific overrides
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    CONFIG.isElectron = true;
    CONFIG.isWeb = false;
}

// Export getHttpBaseUrl helper
export function getHttpBaseUrl() {
    // In production, use the WebSocket URL's HTTP equivalent
    // For OpenClaw, the HTTP API is typically on the same host:port
    const wsUrl = localStorage.getItem('websocket_url') || `ws://localhost:${CONFIG.DEFAULT_WS_PORT}`;
    try {
        const url = new URL(wsUrl);
        // Convert ws:// to http://, wss:// to https://
        const httpProtocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        return `${httpProtocol}//${url.host}`;
    } catch (e) {
        return `http://localhost:${CONFIG.DEFAULT_WS_PORT}`;
    }
}

export default CONFIG;