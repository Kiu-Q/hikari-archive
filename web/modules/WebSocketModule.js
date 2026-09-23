// WebSocketModule - WebSocket and HTTP communication with robust reconnection, message queue persistence, and heartbeat
import { CONFIG, getHttpBaseUrl } from '../config.js';
import logger from '../logger.js';

let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let messageQueue = [];
let isProcessingQueue = false;
let messageHandlers = new Map();
let pendingRequests = new Map();
let isConnected = false;
let wsUrl = 'ws://localhost:' + CONFIG.DEFAULT_WS_PORT;

// Heartbeat mechanism
let heartbeatTimer = null;
let heartbeatInterval = 30000; // 30 seconds
let missedHeartbeats = 0;
const MAX_MISSED_HEARTBEATS = 3;

// Persistent message queue (survives page reloads during disconnect)
const PERSISTENT_QUEUE_KEY = 'hikari_message_queue';
const MAX_PERSISTENT_QUEUE = 100;

export function setWebSocketUrl(url) {
    wsUrl = url;
    localStorage.setItem('websocket_url', url);
    logger.info('ws', 'WebSocket URL set to:', wsUrl);
}

export function getWebSocketUrl() {
    return wsUrl;
}

export function initWebSocket() {
    logger.info('ws', 'Initializing WebSocket connection to:', wsUrl);
    if (ws) ws.close();
    
    // Load persistent queue on init
    loadPersistentQueue();
    
    try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            logger.info('ws', 'WebSocket connected');
            isConnected = true;
            wsReconnectAttempts = 0;
            missedHeartbeats = 0;
            if (window.onConnectionChange) window.onConnectionChange(true);
            startHeartbeat();
            processMessageQueue();
        };
        ws.onclose = (event) => {
            logger.warn('ws', 'WebSocket closed:', event.code, event.reason);
            isConnected = false;
            stopHeartbeat();
            if (window.onConnectionChange) window.onConnectionChange(false);
            scheduleReconnect();
        };
        ws.onerror = (error) => { logger.error('ws', 'WebSocket error:', error); };
        ws.onmessage = (event) => { handleMessage(event.data); };
    } catch (error) { logger.error('ws', 'Failed to create WebSocket:', error); scheduleReconnect(); }
}

function scheduleReconnect() {
    if (wsReconnectAttempts >= CONFIG.MAX_WS_RECONNECT_ATTEMPTS) { 
        logger.error('ws', 'Max reconnect attempts reached'); 
        stopHeartbeat();
        return; 
    }
    wsReconnectAttempts++;
    // Exponential backoff: 3s, 6s, 12s, 24s, 48s... capped at 60s
    const baseDelay = CONFIG.WS_RECONNECT_INTERVAL;
    const delay = Math.min(baseDelay * Math.pow(2, wsReconnectAttempts - 1), 60000);
    logger.info('ws', 'Scheduling reconnect in', delay, 'ms (attempt', wsReconnectAttempts + ')');
    wsReconnectTimer = setTimeout(() => { initWebSocket(); }, delay);
}

function handleMessage(data) {
    try {
        const message = JSON.parse(data);
        logger.debug('ws', 'Received message:', message);
        
        // Handle heartbeat pong
        if (message.type === 'pong') {
            missedHeartbeats = 0;
            return;
        }
        
        if (message.id && pendingRequests.has(message.id)) {
            const { resolve, reject } = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            if (message.error) reject(new Error(message.error.message || 'Unknown error'));
            else resolve(message.result);
            return;
        }
        if (message.method) {
            const handler = messageHandlers.get(message.method);
            if (handler) handler(message.params);
            else logger.warn('ws', 'No handler for method:', message.method);
        }
    } catch (error) { logger.error('ws', 'Error parsing message:', error); }
}

export function sendMessage(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn('ws', 'WebSocket not connected, queueing message');
        messageQueue.push(message);
        if (messageQueue.length > CONFIG.MAX_MESSAGE_QUEUE) messageQueue.shift();
        savePersistentQueue();
        return;
    }
    try { ws.send(JSON.stringify(message)); logger.debug('ws', 'Sent message:', message); }
    catch (error) { logger.error('ws', 'Error sending message:', error); messageQueue.push(message); savePersistentQueue(); }
}

function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    while (messageQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const message = messageQueue.shift();
        try { ws.send(JSON.stringify(message)); logger.debug('ws', 'Sent queued message:', message); }
        catch (error) { logger.error('ws', 'Error sending queued message:', error); messageQueue.unshift(message); break; }
    }
    isProcessingQueue = false;
    savePersistentQueue();
}

// Heartbeat mechanism
function startHeartbeat() {
    stopHeartbeat(); // Clear any existing
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
            missedHeartbeats++;
            if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
                logger.warn('ws', 'Heartbeat failed, closing connection');
                ws.close();
            }
        } else {
            stopHeartbeat();
        }
    }, heartbeatInterval);
    logger.debug('ws', 'Heartbeat started');
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        missedHeartbeats = 0;
        logger.debug('ws', 'Heartbeat stopped');
    }
}

// Persistent message queue (localStorage)
function savePersistentQueue() {
    try {
        const queueToSave = messageQueue.slice(-MAX_PERSISTENT_QUEUE);
        localStorage.setItem(PERSISTENT_QUEUE_KEY, JSON.stringify(queueToSave));
    } catch (error) {
        logger.warn('ws', 'Failed to save persistent queue:', error);
    }
}

function loadPersistentQueue() {
    try {
        const saved = localStorage.getItem(PERSISTENT_QUEUE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                messageQueue = parsed.slice(-CONFIG.MAX_MESSAGE_QUEUE);
                logger.info('ws', 'Loaded', messageQueue.length, 'messages from persistent queue');
            }
        }
    } catch (error) {
        logger.warn('ws', 'Failed to load persistent queue:', error);
        messageQueue = [];
    }
}

function clearPersistentQueue() {
    localStorage.removeItem(PERSISTENT_QUEUE_KEY);
}

export function registerHandler(method, handler) {
    messageHandlers.set(method, handler);
    logger.info('ws', 'Registered handler for:', method);
}

export function unregisterHandler(method) {
    messageHandlers.delete(method);
}

export async function sendRequest(method, params, timeout = 30000) {
    const id = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Request timeout')); }, timeout);
        pendingRequests.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (err) => { clearTimeout(timer); reject(err); } });
        sendMessage({ type: 'req', id, method, params });
    });
}

// HTTP REST API (Electron approach)
export async function httpRequest(endpoint, options = {}) {
    const baseUrl = getHttpBaseUrl();
    const url = baseUrl + endpoint;
    const defaultOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const mergedOptions = { ...defaultOptions, ...options };
    if (options.body && typeof options.body === 'object') mergedOptions.body = JSON.stringify(options.body);
    logger.info('http', 'Request:', mergedOptions.method, url);
    try {
        const response = await fetch(url, mergedOptions);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'HTTP ' + response.status);
        logger.debug('http', 'Response:', data);
        return data;
    } catch (error) { logger.error('http', 'Request failed:', error); throw error; }
}

// Agent communication via HTTP (Electron approach)
export async function sendAgentMessage(message, sessionKey = 'main', timeout = 60, idempotencyKey = null) {
    const key = idempotencyKey || 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    return httpRequest('/v1/chat/completions', { method: 'POST', body: { message, sessionKey, timeout, idempotencyKey: key } });
}

export function getConnectionStatus() { return isConnected; }

export function disconnect() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    stopHeartbeat();
    if (ws) { ws.close(); ws = null; }
    isConnected = false; messageQueue = []; pendingRequests.clear();
    clearPersistentQueue();
    logger.info('ws', 'WebSocket disconnected');
}

// Export queue status for debugging
export function getQueueStatus() {
    return {
        queueLength: messageQueue.length,
        pendingRequests: pendingRequests.size,
        isConnected,
        reconnectAttempts: wsReconnectAttempts
    };
}

export const WebSocketModule = { 
    initWebSocket, 
    setWebSocketUrl, 
    getWebSocketUrl, 
    sendMessage, 
    registerHandler, 
    unregisterHandler, 
    sendRequest, 
    httpRequest, 
    sendAgentMessage, 
    getConnectionStatus, 
    disconnect,
    getQueueStatus
};

export default WebSocketModule;
