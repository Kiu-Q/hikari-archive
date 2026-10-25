/**
 * UIModule - UI management and interactions
 * Ported from Electron version with responsive design
 * Phase 3: Dynamic animation grid, expression sliders, chat history
 */

import { CONFIG } from '../config.js';
import logger from '../logger.js';

let isAdvancedMode = false;
let currentPanel = 'chat';
let availableAnimations = [];
let availableExpressions = [];

// Known VRMA animations and expressions (can be loaded dynamically)
const DEFAULT_ANIMATIONS = [
    { name: 'Idle', url: '/assets/animations/idle.vrma', category: 'idle' },
    { name: 'Walk', url: '/assets/animations/walk.vrma', category: 'locomotion' },
    { name: 'Wave', url: '/assets/animations/wave.vrma', category: 'gesture' },
    { name: 'Bow', url: '/assets/animations/bow.vrma', category: 'gesture' },
    { name: 'Sit', url: '/assets/animations/sit.vrma', category: 'pose' },
    { name: 'Dance', url: '/assets/animations/dance.vrma', category: 'entertainment' },
];

const DEFAULT_EXPRESSIONS = [
    { name: 'Neutral', preset: 'neutral', category: 'base' },
    { name: 'Happy', preset: 'happy', category: 'positive' },
    { name: 'Sad', preset: 'sad', category: 'negative' },
    { name: 'Angry', preset: 'angry', category: 'negative' },
    { name: 'Surprised', preset: 'surprised', category: 'reaction' },
    { name: 'Blink', preset: 'blink', category: 'base' },
    { name: 'Wink', preset: 'wink', category: 'gesture' },
    { name: 'Thinking', preset: 'thinking', category: 'cognitive' },
];

export function initUI() {
    logger.info('ui', 'Initializing UIModule');
    setupEventListeners();
    setupAdvancedToggle();
    loadUIState();
    populateAnimationGrid();
    populateExpressionControls();
    loadChatHistory();
    updateUI();
}

function setupEventListeners() {
    const wsUrlInput = document.getElementById('wsUrl');
    if (wsUrlInput) {
        wsUrlInput.addEventListener('change', (e) => {
            if (window.setWebSocketUrl) window.setWebSocketUrl(e.target.value);
        });
        const savedUrl = localStorage.getItem('websocket_url');
        if (savedUrl) wsUrlInput.value = savedUrl;
    }
    
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (window.sendChatMessage) window.sendChatMessage(); }
        });
    }
    
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.addEventListener('click', () => { if (window.sendChatMessage) window.sendChatMessage(); });
    
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', () => { if (window.clearChatHistory) window.clearChatHistory(); });
    
    const exportHistoryBtn = document.getElementById('exportHistoryBtn');
    if (exportHistoryBtn) exportHistoryBtn.addEventListener('click', () => { if (window.exportChatHistory) window.exportChatHistory(); });
    
    document.querySelectorAll('.panel-tab').forEach(tab => {
        tab.addEventListener('click', () => { switchPanel(tab.dataset.panel); });
    });
    
    // Animation buttons (delegated for dynamic content)
    document.getElementById('animationsPanel')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.anim-btn');
        if (btn && btn.dataset.anim && window.loadVRMA) {
            window.loadVRMA(btn.dataset.anim);
        }
    });
    
    // Expression buttons with intensity (delegated)
    document.getElementById('expressionsPanel')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.expr-btn');
        if (btn && btn.dataset.expr && window.applyFacialExpression) {
            const intensity = parseFloat(btn.dataset.intensity) || 1.0;
            window.applyFacialExpression(btn.dataset.expr, intensity);
        }
    });
    
    // Expression intensity sliders
    document.getElementById('expressionsPanel')?.addEventListener('input', (e) => {
        if (e.target.matches('.expr-intensity-slider')) {
            const exprName = e.target.dataset.expr;
            const intensity = parseFloat(e.target.value);
            const valueDisplay = document.getElementById('expr-value-' + exprName);
            if (valueDisplay) valueDisplay.textContent = intensity.toFixed(1);
        }
    });
    
    // Chat history controls
    const loadHistoryBtn = document.getElementById('loadHistoryBtn');
    if (loadHistoryBtn) loadHistoryBtn.addEventListener('click', loadChatHistory);
    
    // Responsive handling
    window.addEventListener('resize', handleResize);
}

function setupAdvancedToggle() {
    const advancedToggle = document.getElementById('advancedToggle');
    const advancedPanel = document.getElementById('advancedPanel');
    if (advancedToggle && advancedPanel) {
        advancedToggle.addEventListener('click', () => {
            isAdvancedMode = !isAdvancedMode;
            advancedPanel.style.display = isAdvancedMode ? 'grid' : 'none';
            advancedToggle.textContent = isAdvancedMode ? 'Hide Advanced' : 'Show Advanced';
            localStorage.setItem('advancedMode', isAdvancedMode);
            logger.info('ui', 'Advanced mode:', isAdvancedMode);
        });
        const saved = localStorage.getItem('advancedMode');
        if (saved === 'true') { isAdvancedMode = true; advancedPanel.style.display = 'grid'; advancedToggle.textContent = 'Hide Advanced'; }
    }
}

function loadUIState() {
    const savedPanel = localStorage.getItem('currentPanel');
    if (savedPanel) switchPanel(savedPanel);
}

export function switchPanel(panelName) {
    currentPanel = panelName;
    localStorage.setItem('currentPanel', panelName);
    document.querySelectorAll('.panel-tab').forEach(tab => { tab.classList.toggle('active', tab.dataset.panel === panelName); });
    document.querySelectorAll('.panel-content').forEach(panel => { panel.classList.toggle('active', panel.id === panelName + 'Panel'); });
    logger.info('ui', 'Switched to panel:', panelName);
}

export function updateUI() {
    const statusEl = document.getElementById('connectionStatus');
    if (statusEl && window.getConnectionStatus) {
        const connected = window.getConnectionStatus();
        statusEl.textContent = connected ? 'Connected' : 'Disconnected';
        statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
    }
}

export function addChatMessage(role, content, metadata = {}) {
    const chatContainer = document.getElementById('chatMessages');
    if (!chatContainer) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message ' + role;
    const time = new Date().toLocaleTimeString();
    const meta = metadata.anim ? ' [' + metadata.anim + ']' : '';
    const expr = metadata.expr ? ' {' + metadata.expr + '}' : '';
    messageDiv.innerHTML = '<span class="message-role">' + (role === 'user' ? 'You' : 'Hikari') + '</span><span class="message-time">' + time + '</span><div class="message-content">' + escapeHtml(content) + '</div><div class="message-meta">' + meta + expr + '</div>';
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Save to history
    if (window.addHistoryEntry) {
        window.addHistoryEntry({ role, content, metadata, timestamp: Date.now() });
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function showThinking(show) {
    const thinkingEl = document.getElementById('thinkingIndicator');
    if (thinkingEl) thinkingEl.style.display = show ? 'block' : 'none';
}

export function showLoading(show) {
    const loadingEl = document.getElementById('loadingOverlay');
    if (loadingEl) loadingEl.style.display = show ? 'flex' : 'none';
}

export function showError(message) {
    const errorEl = document.getElementById('errorToast');
    if (errorEl) { errorEl.textContent = message; errorEl.style.display = 'block'; setTimeout(() => { errorEl.style.display = 'none'; }, 5000); }
}

// ============================================================
// PHASE 3: Dynamic Animation Grid
// ============================================================
export function populateAnimationGrid() {
    const grid = document.getElementById('animationGrid');
    if (!grid) return;
    
    // Use available animations from CoreModule if available, otherwise defaults
    const animations = availableAnimations.length > 0 ? availableAnimations : DEFAULT_ANIMATIONS;
    
    grid.innerHTML = '';
    animations.forEach(anim => {
        const btn = document.createElement('button');
        btn.className = 'anim-btn' + (anim.category ? ' anim-' + anim.category : '');
        btn.dataset.anim = anim.url;
        btn.title = anim.name + (anim.category ? ' (' + anim.category + ')' : '');
        btn.innerHTML = '<span class="anim-name">' + escapeHtml(anim.name) + '</span>' + (anim.category ? '<span class="anim-category">' + escapeHtml(anim.category) + '</span>' : '');
        grid.appendChild(btn);
    });
    logger.info('ui', 'Populated animation grid with', animations.length, 'animations');
}

export function setAvailableAnimations(animations) {
    availableAnimations = animations;
    populateAnimationGrid();
}

// ============================================================
// PHASE 3: Expression Controls with Intensity Sliders
// ============================================================
export function populateExpressionControls() {
    const container = document.getElementById('expressionControls');
    if (!container) return;
    
    const expressions = availableExpressions.length > 0 ? availableExpressions : DEFAULT_EXPRESSIONS;
    
    container.innerHTML = '';
    expressions.forEach(expr => {
        const controlDiv = document.createElement('div');
        controlDiv.className = 'expr-control' + (expr.category ? ' expr-' + expr.category : '');
        
        controlDiv.innerHTML = `
            <button class="expr-btn" data-expr="${escapeHtml(expr.preset)}" data-intensity="1.0" title="${escapeHtml(expr.name)}">
                <span class="expr-name">${escapeHtml(expr.name)}</span>
            </button>
            <div class="expr-slider-container">
                <input type="range" class="expr-intensity-slider" data-expr="${escapeHtml(expr.preset)}" min="0" max="1" step="0.1" value="1.0" aria-label="${escapeHtml(expr.name)} intensity">
                <span class="expr-value" id="expr-value-${escapeHtml(expr.preset)}">1.0</span>
            </div>
        `;
        container.appendChild(controlDiv);
    });
    logger.info('ui', 'Populated expression controls with', expressions.length, 'expressions');
}

export function setAvailableExpressions(expressions) {
    availableExpressions = expressions;
    populateExpressionControls();
}

// ============================================================
// PHASE 3: Chat History UI
// ============================================================
export function loadChatHistory() {
    const historyContainer = document.getElementById('chatHistory');
    if (!historyContainer || !window.getHistory) return;
    
    const history = window.getHistory();
    if (!history || history.length === 0) {
        historyContainer.innerHTML = '<div class="history-empty">No chat history yet</div>';
        return;
    }
    
    historyContainer.innerHTML = '';
    // Show last 50 messages
    const recent = history.slice(-50);
    recent.forEach(entry => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'history-entry ' + entry.role;
        const time = new Date(entry.timestamp).toLocaleString();
        msgDiv.innerHTML = `
            <span class="history-time">${time}</span>
            <span class="history-role">${entry.role === 'user' ? 'You' : 'Hikari'}</span>
            <div class="history-content">${escapeHtml(entry.content)}</div>
            ${entry.metadata && entry.metadata.expr ? '<span class="history-expr">{' + escapeHtml(entry.metadata.expr) + '}</span>' : ''}
        `;
        historyContainer.appendChild(msgDiv);
    });
    historyContainer.scrollTop = historyContainer.scrollHeight;
    logger.info('ui', 'Loaded chat history:', recent.length, 'messages');
}

export function clearChatHistoryUI() {
    const chatContainer = document.getElementById('chatMessages');
    if (chatContainer) chatContainer.innerHTML = '';
    const historyContainer = document.getElementById('chatHistory');
    if (historyContainer) historyContainer.innerHTML = '<div class="history-empty">No chat history yet</div>';
}

export function exportChatHistoryUI() {
    if (!window.exportHistory) return;
    const data = window.exportHistory();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hikari-chat-history-' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
    URL.revokeObjectURL(url);
    logger.info('ui', 'Exported chat history');
}

// ============================================================
// Mobile Responsive Handling
// ============================================================
function handleResize() {
    const isMobile = window.innerWidth < 768;
    const panels = document.querySelectorAll('.panel-content');
    panels.forEach(panel => {
        if (isMobile && !panel.classList.contains('active')) {
            panel.style.display = 'none';
        } else {
            panel.style.display = '';
        }
    });
    
    // Adjust animation grid columns
    const grid = document.getElementById('animationGrid');
    if (grid) {
        if (window.innerWidth < 480) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        else if (window.innerWidth < 768) grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
        else grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
    }
}

// Initialize responsive on load
if (typeof window !== 'undefined') {
    // Will be called after DOM is ready
    setTimeout(handleResize, 0);
}

export const UIModule = { 
    initUI, 
    updateUI, 
    addChatMessage, 
    showThinking, 
    showLoading, 
    showError, 
    switchPanel,
    populateAnimationGrid,
    setAvailableAnimations,
    populateExpressionControls,
    setAvailableExpressions,
    loadChatHistory,
    clearChatHistoryUI,
    exportChatHistoryUI
};

export default UIModule;
