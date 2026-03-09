/**
 * Conversation History Module
 * Manages display and fetching of conversation history from OpenClaw
 */

console.log('[history] Conversation history module loaded');

// ============================================================
// STATE
// ============================================================
let historyPanel = null;
let historyMessages = [];
let currentOffset = 0;
let hasMoreMessages = false;
let totalCount = 0;
let isLoadingHistory = false;
  let displayedTimestamps = new Set(); // Track displayed messages to prevent duplicates
  let allPanelsVisible = false; // Track if panels were visible before animation
  let visiblePanelsBeforeHide = []; // Track which panels were visible: array of 'messaging' and/or 'history'

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize history panel and toggle button
 */
export function initHistoryPanel() {
    console.log('[history] Initializing history panel');
    
    // Move history panel upward to make room for messaging panel below it
    historyPanel = document.createElement('div');
    historyPanel.id = 'history-panel';
    historyPanel.style.display = 'none';
    historyPanel.style.position = 'absolute';
    historyPanel.style.bottom = '100px'; // More space above messaging panel (which is at bottom: 10px with ~100px height)
    historyPanel.style.left = '10px'; // Move to left side, right of 💬 button, matching message panel
    historyPanel.style.width = 'auto';
    historyPanel.style.maxWidth = '400px';
    historyPanel.style.maxHeight = '40vh';
    historyPanel.style.background = 'rgba(0, 0, 0, 0.6)'; // Match messaging panel
    historyPanel.style.color = 'white'; // Match messaging panel
    historyPanel.style.padding = '20px'; // Match messaging panel
    historyPanel.style.borderRadius = '12px'; // Match messaging panel
    historyPanel.style.zIndex = '100';
    historyPanel.style.display = 'none';
    historyPanel.style.flexDirection = 'column';
    historyPanel.style.gap = '12px';
    historyPanel.style.overflow = 'hidden';
    
    // Create header
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
    
    // Create messages container
    const messagesContainer = document.createElement('div');
    messagesContainer.id = 'history-messages';
    messagesContainer.style.flex = '1';
    messagesContainer.style.overflowY = 'auto';
    messagesContainer.style.padding = '12px 16px';
    messagesContainer.style.display = 'flex';
    messagesContainer.style.flexDirection = 'column';
    messagesContainer.style.gap = '12px';
    
    // Assemble panel
    historyPanel.appendChild(header);
    historyPanel.appendChild(messagesContainer);
    document.body.appendChild(historyPanel);
    
    console.log('[history] History panel initialized');
}

// ============================================================
// PANEL CONTROL
// ============================================================

/**
 * Show history panel and fetch initial messages
 */
export function showHistoryPanel() {
    if (historyPanel) {
        historyPanel.style.display = 'flex';
        console.log('[history] Panel shown');
        
        // Show messaging panel (now part of combined panel)
        if (window.showMessagingPanel) {
            window.showMessagingPanel();
        }
        
        // Fetch initial history if not already loaded
        if (historyMessages.length === 0) {
            fetchConversationHistory(0);
        } else {
            // Scroll to bottom (latest messages) if already loaded
            const messagesContainer = document.getElementById('history-messages');
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                console.log('[history] Scrolled to bottom (latest messages)');
            }
        }
    }
}

/**
 * Hide history panel
 */
export function hideHistoryPanel() {
    if (historyPanel) {
        historyPanel.style.display = 'none';
        console.log('[history] Panel hidden');
        
        // Also hide messaging panel when history is hidden
        if (window.hideMessagingPanel) {
            window.hideMessagingPanel();
        }
    }
}

/**
 * Toggle history panel visibility
 */
export function toggleHistoryPanel() {
    if (historyPanel.style.display === 'none' || !historyPanel.style.display) {
        showHistoryPanel();
    } else {
        hideHistoryPanel();
    }
}

// ============================================================
// HISTORY FETCHING
// ============================================================

/**
 * Fetch conversation history from OpenClaw
 * @param {number} offset - Offset for pagination (0 = latest 100, 100 = next 100, etc.)
 */
export async function fetchConversationHistory(offset = 0) {
    console.log('[history] fetchConversationHistory called with offset:', offset);
    if (isLoadingHistory) {
        console.log('[history] Already loading history, ignoring request');
        return;
    }
    
    isLoadingHistory = true;
    
    // Reset currentOffset and displayedTimestamps if this is a new fetch (offset = 0)
    if (offset === 0) {
        currentOffset = 0;
        displayedTimestamps.clear(); // Clear duplicate tracking on new fetch
        console.log('[history] Reset currentOffset and cleared displayedTimestamps for new fetch');
    }
    
    console.log('[history] Fetching history with offset:', offset);
    
    try {
        // Send history request to OpenClaw
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

/**
 * Load more older messages
 */
export function loadMoreMessages() {
    console.log('[history] Loading more messages, current offset:', currentOffset);
    
    // Calculate new offset (add 100 for next page)
    const newOffset = currentOffset + 100;
    fetchConversationHistory(newOffset);
}

// ============================================================
// HISTORY DISPLAY
// ============================================================

/**
 * Display messages in history panel
 * @param {Array} messages - Array of message objects from OpenClaw
 * @param {number} totalCountMsg - Total count of messages
 * @param {boolean} hasMoreMsg - Whether there are more messages to load
 */
export function displayHistoryMessages(messages, totalCountMsg, hasMoreMsg) {
    console.log('\n========== CONVERSATION HISTORY DISPLAY START ==========');
    console.log('[history] Total messages fetched:', messages.length);
    console.log('[history] Total count available:', totalCountMsg);
    console.log('[history] Has more messages:', hasMoreMsg);
    console.log('[history] Current offset:', currentOffset);
    console.log('[history] Current historyMessages count:', historyMessages.length);
    console.log('[history] Displayed timestamps count:', displayedTimestamps.size);
    console.log('[history] About to process', messages.length, 'messages');
    
    console.log('\n--- ALL FETCHED MESSAGES (RAW) ---');
    messages.forEach((msg, index) => {
        console.log(`\n[Message ${index + 1}/${messages.length}]`);
        console.log('  Role:', msg.role);
        console.log('  Timestamp:', msg.timestamp);
        console.log('  Content type:', Array.isArray(msg.content) ? 'Array[' + msg.content.length + ']' : typeof msg.content);
        console.log('  Content structure:', JSON.stringify(msg.content, null, 2).substring(0, 200) + '...');
    });
    
    const messagesContainer = document.getElementById('history-messages');
    if (!messagesContainer) {
        console.error('[history] ERROR: messagesContainer not found!');
        return;
    }
    
    // Update state
    totalCount = totalCountMsg;
    hasMoreMessages = hasMoreMsg;
    
    // Clear existing messages if this is initial load (offset = 0)
    if (currentOffset === 0) {
        messagesContainer.innerHTML = '';
        historyMessages = [];
        console.log('[history] Cleared container for initial load (offset=0)');
    }
    
    console.log('\n--- FILTERING PROCESS ---');
    let acceptedCount = 0;
    let rejectedCount = 0;
    
    // Add new messages
    messages.forEach((msg, msgIndex) => {
        console.log(`\n[Filtering Message ${msgIndex + 1}/${messages.length}]`);
        console.log('  Role:', msg.role);
        console.log('  Timestamp:', msg.timestamp);
        
        // Filter 1: Skip toolResult messages (system messages)
        if (msg.role === 'toolResult') {
            console.log('  ❌ REJECTED: Role is "toolResult"');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Passed toolResult check');
        
        // Filter 2: Skip messages without text content
        if (!msg.content || msg.content.length === 0) {
            console.log('  ❌ REJECTED: No content or empty content array');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Passed content existence check (content.length:', msg.content.length + ')');
        
        // Find actual text content (skip thinking content)
        const textContent = msg.content.find(item => item.type === 'text');
        if (!textContent || !textContent.text) {
            console.log('  ❌ REJECTED: No text content found in content array');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Found text content');
        
        let text = textContent.text;
        console.log('  Text preview:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
        
        // Filter 3: Skip HEARTBEAT messages
        if (text.includes('HEARTBEAT') || text.includes('HEARTBEAT_OK')) {
            console.log('  ❌ REJECTED: HEARTBEAT system message');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a HEARTBEAT message');
        
        // Filter 4: Skip "New session started" messages
        if (text.includes('New session started') || text.includes('✅')) {
            console.log('  ❌ REJECTED: Session system message');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a session message');
        
        // Filter 5: Skip messages asking to read HEARTBEAT.md
        if (text.includes('Read HEARTBEAT.md')) {
            console.log('  ❌ REJECTED: HEARTBEAT instruction message');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a HEARTBEAT instruction');
        
        // Filter 6: Skip session instruction messages (from user role)
        // Also skip system prompts like "User touched your head"
        if (text.includes('/new or /reset') || text.includes('Do not mention internal steps')) {
            console.log('  ❌ REJECTED: Session instruction message');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a session instruction');
        
        // Filter 7: Handle system instruction blocks
        // BUT first check if this is a user message with system instructions
        // If so, extract only the user message part (before ===== SYSTEM INSTRUCTIONS =====)
        if (text.includes('===== USER MESSAGE =====') || 
            text.includes('===== SYSTEM INSTRUCTIONS =====') ||
            text.includes('AVAILABLE ANIMATIONS') ||
            text.includes('AVAILABLE EXPRESSIONS') ||
            text.includes('RESPONSE FORMAT') ||
            text.includes('TIMING OPTIONS') ||
            text.includes('IMPORTANT:')) {
            
            // Special handling for user messages with system instructions
            // Extract only the user message part between ===== USER MESSAGE ===== and ===== SYSTEM INSTRUCTIONS =====
            if (msg.role === 'user' && text.includes('===== USER MESSAGE =====') && text.includes('===== SYSTEM INSTRUCTIONS =====')) {
                // Extract text between the markers
                const userMessageMatch = text.match(/===== USER MESSAGE =====\s*([\s\S]*?)\s*===== SYSTEM INSTRUCTIONS =====/);
                if (userMessageMatch && userMessageMatch[1]) {
                    text = userMessageMatch[1].trim();
                    console.log('  Extracted user message from system block:', text.substring(0, 100) + '...');
                } else {
                    console.log('  ❌ REJECTED: System instruction block (could not extract user message)');
                    rejectedCount++;
                    return;
                }
            } else {
                console.log('  ❌ REJECTED: System instruction block');
                rejectedCount++;
                return;
            }
        }
        console.log('  ✓ Not a system instruction block');
        
        // Filter 7b: Skip system prompts (user messages that are just system triggers)
        // These include messages like "User touched your head", "User touched your nose", etc.
        // These are system-generated prompts, not actual user conversation
        // This check must happen AFTER extracting user message from system blocks
        const systemPromptPatterns = [
            /^User touched (?:your|the) \w+$/i,  // "User touched your head", "User touched the screen"
            /^User (?:clicked|tapped|pressed) \w+$/i,  // "User clicked button", "User tapped screen"
            /^User (?:said|typed|entered) \w+$/i,  // "User said hello", "User typed command"
            /^(?:Touch|Click|Tap|Press) \w+$/i,  // Direct action prompts
            /^System: /i,  // System messages
            /^🎵 /,  // Audio system prompts
        ];
        
        const isSystemPrompt = systemPromptPatterns.some(pattern => pattern.test(text.trim()));
        if (isSystemPrompt) {
            console.log('  ❌ REJECTED: System prompt (not actual user message)');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a system prompt');
        
        // Filter 8: Skip raw JSON responses ONLY from toolResult role
        // Assistant messages with JSON are valid and contain actual text
        if (msg.role === 'toolResult' &&
            text.trim().startsWith('{') && 
            (text.includes("'text'") || text.includes('"text"')) &&
            (text.includes("'animation'") || text.includes('"animation"')) &&
            (text.includes("'expression'") || text.includes('"expression"'))) {
            console.log('  ❌ REJECTED: Raw JSON response from toolResult');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a raw JSON response from toolResult');
        
        // Parse JSON if it's a JSON response from assistant
        // This extracts actual text from agent's JSON response
        if (msg.role === 'assistant' && text.trim().startsWith('{')) {
            let parsed;
            try {
                // Try standard JSON parse first (double quotes)
                parsed = JSON.parse(text);
                if (parsed.text) {
                    text = parsed.text;
                    console.log('  Extracted text from JSON:', text.substring(0, 100) + '...');
                }
            } catch (e1) {
                // If that fails, try to handle single quotes
                // Extract's 'text' value directly using regex instead of replacing quotes
                console.log('  Standard JSON parse failed, trying direct text extraction');
                try {
                    // Extract text value from single-quote JSON: {'text': 'content'}
                    // Look for 'text': followed by ' and capture everything until the next ' that ends the string
                    const textMatch = text.match(/'text'\s*:\s*'([^']*(?:\\'[^']*)*)'/);
                    if (textMatch && textMatch[1]) {
                        text = textMatch[1]
                            .replace(/\\'/g, "'")  // Unescape single quotes
                            .replace(/\\"/g, '"')   // Unescape double quotes
                            .replace(/\\n/g, '\n')  // Unescape newlines
                            .replace(/\\r/g, '\r')  // Unescape carriage returns
                            .replace(/\\t/g, '\t'); // Unescape tabs
                        console.log('  Extracted text from JSON (single-quote):', text.substring(0, 100) + '...');
                    } else {
                        console.log('  Not valid JSON, using text as-is');
                    }
                } catch (e2) {
                    // Not valid JSON, use as-is
                    console.log('  Not valid JSON, using text as-is');
                }
            }
        }
        
        // Filter 9: Skip duplicate messages (check by timestamp)
        if (displayedTimestamps.has(msg.timestamp)) {
            console.log('  ❌ REJECTED: Duplicate message (timestamp already displayed)');
            rejectedCount++;
            return;
        }
        console.log('  ✓ Not a duplicate message');
        
        // Mark as displayed
        displayedTimestamps.add(msg.timestamp);
        console.log('  ✓ Timestamp added to displayedTimestamps');
        
        // All filters passed - add to display
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
    
    // Update offset
    currentOffset += messages.length;
    
    // Auto-scroll to bottom (newest messages at bottom)
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    isLoadingHistory = false;
    
    console.log('[history] Messages displayed, total:', historyMessages.length);
}

/**
 * Add a single message to history panel
 * @param {object} message - Message object from OpenClaw
 * @param {string} processedText - Already processed text from filtering logic (includes JSON extraction, system block extraction, etc.)
 */
export function addMessageToHistory(message, processedText) {
    const messagesContainer = document.getElementById('history-messages');
    if (!messagesContainer) return;
    
    // Map OpenClaw role to display format
    // OpenClaw uses 'role' (user, assistant), we use 'from' (user, agent)
    const from = message.role === 'user' ? 'user' : 'agent';
    
    // Use the processed text that was already filtered and extracted
    let displayText = processedText || '';
    
    console.log('[history] addMessageToHistory called with processedText:', displayText.substring(0, 100) + (displayText.length > 100 ? '...' : ''));
    
    // Skip if no text content
    if (!displayText || displayText.trim() === '') {
        console.log('[history] Skipping message with empty text');
        return;
    }
    
    // Remove text in square brackets [ ] (media attachments, system info, etc.)
    // Use regex to remove everything between [ and ]
    const beforeBracketRemoval = displayText;
    displayText = displayText.replace(/\[.*?\]/g, '').trim();
    if (beforeBracketRemoval !== displayText) {
        console.log('[history] Removed bracket content, result:', displayText.substring(0, 100) + '...');
    }
    
    // Skip if no text after removing bracket content
    if (!displayText || displayText.trim() === '') {
        console.log('[history] Skipping message with no displayable text');
        return;
    }
    
    // Split by newlines and create separate message cards for each line
    const lines = displayText.split('\n').filter(line => line.trim() !== '');
    
    // Create message cards for each line
    lines.forEach((lineText, index) => {
        const messageCard = document.createElement('div');
        messageCard.className = 'history-message';
        messageCard.style.padding = '8px 10px';
        messageCard.style.borderRadius = '6px';
        messageCard.style.display = 'flex';
        messageCard.style.flexDirection = 'column';
        messageCard.style.gap = '4px';
        messageCard.style.maxWidth = '80%';
        
        // Style based on sender
        if (from === 'user') {
            messageCard.style.background = 'rgba(128, 128, 128, 0.2)';
            messageCard.style.borderLeft = '3px solid #808080';
            messageCard.style.alignSelf = 'flex-end'; // Stick to right
        } else if (from === 'agent') {
            messageCard.style.background = 'rgba(76, 175, 80, 0.2)';
            messageCard.style.borderLeft = '3px solid #4CAF100';
            messageCard.style.alignSelf = 'flex-start'; // Stick to left
        } else {
            messageCard.style.background = 'rgba(128, 128, 128, 0.2)';
            messageCard.style.borderLeft = '3px solid #808080';
            messageCard.style.alignSelf = 'flex-start';
        }
        
        // Create header with sender and timestamp (only for first line)
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
        
        // Create message text
        const text = document.createElement('div');
        text.style.color = '#ffffff';
        text.style.fontSize = '13px';
        text.style.lineHeight = '1.4';
        text.style.wordBreak = 'break-word';
        
        text.textContent = lineText;
        
        messageCard.appendChild(text);
        
        // Append to bottom (oldest at top, newest at bottom)
        messagesContainer.appendChild(messageCard);
    });
    
    // Auto-scroll to bottom (newest messages)
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Clear history display
 */
export function clearHistoryDisplay() {
    const messagesContainer = document.getElementById('history-messages');
    if (messagesContainer) {
        messagesContainer.innerHTML = '';
        historyMessages = [];
        currentOffset = 0;
        hasMoreMessages = false;
        displayedTimestamps.clear(); // Clear duplicate tracking
        
        console.log('[history] History cleared');
    }
}

// ============================================================
// PANEL CONTROL FOR ANIMATIONS
// ============================================================

/**
 * Hide all panels (messaging and history) before animations
 * Saves current visibility state to restore later
 */
export function hideAllPanels() {
    const lipSyncPanel = document.getElementById('lipSyncPanel');
    
    // Reset tracking - use array to track multiple visible panels
    visiblePanelsBeforeHide = [];
    
    // Track which panels were visible
    if (lipSyncPanel && lipSyncPanel.style.display !== 'none') {
        visiblePanelsBeforeHide.push('messaging');
        console.log('[history] Messaging panel was visible, hiding...');
    }
    
    if (historyPanel && historyPanel.style.display !== 'none') {
        visiblePanelsBeforeHide.push('history');
        console.log('[history] History panel was visible, hiding...');
    }
    
    // Hide messaging panel if visible
    if (visiblePanelsBeforeHide.includes('messaging') && window.hideMessagingPanel) {
        window.hideMessagingPanel();
    }
    
    // Hide history panel if visible
    if (visiblePanelsBeforeHide.includes('history')) {
        hideHistoryPanel();
    }
    
    allPanelsVisible = (visiblePanelsBeforeHide.length > 0);
    console.log('[history] All panels hidden (visible panels were:', visiblePanelsBeforeHide.join(', ') + ')');
}

/**
 * Restore panel visibility after animations complete
 * Only restores to panel that was previously visible
 */
export function restorePanels() {
    if (visiblePanelsBeforeHide.includes('messaging') && window.showMessagingPanel) {
        // Restore messaging panel
        window.showMessagingPanel();
        console.log('[history] Messaging panel restored');
    } else if (visiblePanelsBeforeHide.includes('history') && showHistoryPanel) {
        // Restore history panel
        showHistoryPanel();
        console.log('[history] History panel restored');
    } else {
        // No panel was visible, nothing to restore
        console.log('[history] No panel to restore (was hidden)');
    }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Format timestamp for display (24-hour format with date)
 * @param {string} isoTimestamp - ISO 8601 timestamp
 * @returns {string} Formatted timestamp (e.g., "15:45 - Mar 7")
 */
function formatTimestamp(isoTimestamp) {
    try {
        const date = new Date(isoTimestamp);
        
        // Format time: HH:MM (24-hour)
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const timeStr = `${hours}:${minutes}`;
        
        // Format date: Mon 7, Tue 8, etc.
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

// Export functions to window object for core.js access
window.hideAllPanels = hideAllPanels;
window.restorePanels = restorePanels;
console.log('[history] hideAllPanels and restorePanels exported to window');
