/**
 * WebSocket Client for Hikari-OpenClaw Integration
 * Handles bidirectional communication with OpenClaw gateway
 */

let ws = null;
let reconnectTimer = null;
let isConnected = false;
let messageQueue = [];
let processedRunIds = new Set(); // Track processed runIds to avoid duplicates
let currentWebSocketUrl = null; // Store current WebSocket URL for reference

// Configuration
const CONFIG = {
  token: 'YOUR_TOKEN_HERE', // Replace with your OpenClaw gateway token
  reconnectInterval: 3000, // 3 seconds between reconnection attempts
  maxReconnectAttempts: 10
};

/**
 * Get WebSocket URL with priority system:
 * 1. localStorage 'websocket_url' (runtime override)
 * 2. Environment variable VITE_WEBSOCKET_URL
 * 3. Default 'ws://localhost:18789'
 */
function getWebSocketUrl() {
  // Check localStorage first for runtime override
  const localStorageUrl = localStorage.getItem('websocket_url');
  if (localStorageUrl && localStorageUrl.trim() !== '') {
    console.log('[ws] Using WebSocket URL from localStorage:', localStorageUrl);
    return localStorageUrl.trim();
  }
  
  // Fall back to environment variable
  const envUrl = import.meta.env.VITE_WEBSOCKET_URL;
  if (envUrl) {
    console.log('[ws] Using WebSocket URL from environment variable:', envUrl);
    return envUrl;
  }
  
  // Default to localhost
  const defaultUrl = 'ws://localhost:18789';
  console.log('[ws] Using default WebSocket URL:', defaultUrl);
  return defaultUrl;
}

let reconnectAttempts = 0;

/**
 * Initialize WebSocket connection
 */
export function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    console.log('[ws] WebSocket already connected or connecting');
    return;
  }

  // Load token from localStorage before connecting
  const savedToken = localStorage.getItem('openclaw_token');
  if (savedToken && savedToken.trim() !== '') {
    CONFIG.token = savedToken;
    console.log('[ws] Using token from localStorage (first 8 chars:', savedToken.substring(0, 8) + '...)');
  } else {
    // No token configured - show error in UI
    console.error('[ws] No token configured. Please set openclaw_token in localStorage.');
    
    // Update UI if available
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = 'Error: OpenClaw token not configured. Please set in browser console with: localStorage.setItem("openclaw_token", "your-token")';
      statusDiv.style.color = '#ff6b6b';
    }
    
    return;
  }

  const wsUrl = getWebSocketUrl();
  currentWebSocketUrl = wsUrl; // Store the URL for later reference
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

/**
 * Handle WebSocket connection open
 */
function handleOpen() {
  console.log('[ws] Connected to OpenClaw gateway');
  isConnected = true;
  reconnectAttempts = 0;
  
  // Don't send anything yet - wait for challenge first
  console.log('[ws] Waiting for connect.challenge...');
}

/**
 * Handle incoming messages from OpenClaw
 */
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
        // Check if this is a history response by ID prefix
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

/**
 * Handle event messages from OpenClaw
 */
function handleEvent(data) {
  switch (data.event) {
    case 'connect.challenge':
      console.log('[ws] Connection challenge received, sending auth request');
      
      // Use token-based authentication for all connections (both local and remote)
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
      // Chat message from agent - trigger lip sync
      handleChatEvent(data);
      break;
    
    case 'health':
      // Periodic health check from gateway - silently ignore
      break;
    
    case 'tick':
      // Regular tick event - update conversation history panel
      console.log('[ws] Tick event received, updating conversation history');
      if (window.fetchConversationHistory) {
        window.fetchConversationHistory(0);
      }
      break;
    
    case 'agent':
      // Agent lifecycle events - silently ignore
      break;
    
    default:
      console.log('[ws] Unknown event type:', data.event);
  }
}

/**
 * Handle chat event from OpenClaw
 */
function handleChatEvent(data) {
  console.log('[ws] Chat event received:', data);
  
  // Check for deduplication using runId
  const runId = data.payload?.runId;
  if (runId && processedRunIds.has(runId)) {
    console.log('[ws] Ignoring duplicate event with runId:', runId);
    return;
  }
  
  // Filter: Only process messages from main agent/session
  const sessionKey = data.payload?.sessionKey || data.sessionKey;
  const state = data.payload?.state;
  
  // Only accept messages from main agent: "agent:main:main" or "main"
  // Also check state is "final" to ignore typing/delta messages
  const isValidSession = sessionKey === 'agent:main:main' || sessionKey === 'main';
  
  if (!isValidSession) {
    console.log('[ws] Ignoring message from non-main agent:', { sessionKey, state });
    return;
  }
  
  if (state !== 'final') {
    console.log('[ws] Ignoring non-final message (still typing):', { sessionKey, state });
    return;
  }
  
  // Extract text from message content
  const messageContent = data.payload?.message?.content;
  if (messageContent && messageContent.length > 0) {
    // Find the actual text content (skip thinking content)
    const textContent = messageContent.find(item => item.type === 'text');
    const rawText = textContent ? textContent.text : null;
    
    if (rawText) {
      console.log('[ws] Chat message from main agent (raw):', rawText);
      
      // Filter out system messages
      // Skip HEARTBEAT messages
      if (rawText.includes('HEARTBEAT') || rawText.includes('HEARTBEAT_OK')) {
        console.log('[ws] Skipping HEARTBEAT system message');
        return;
      }
      // Skip "New session started" messages
      if (rawText.includes('New session started') || rawText.includes('✅')) {
        console.log('[ws] Skipping session system message');
        return;
      }
      // Skip messages asking to read HEARTBEAT.md
      if (rawText.includes('Read HEARTBEAT.md')) {
        console.log('[ws] Skipping HEARTBEAT instruction message');
        return;
      }
      // Skip session instruction messages (from user role)
      if (rawText.includes('/new or /reset') || rawText.includes('Do not mention internal steps')) {
        console.log('[ws] Skipping session instruction message');
        return;
      }
      // Skip system instruction blocks
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
      // Skip raw JSON responses (agent responses that haven't been parsed)
      if (rawText.trim().startsWith('{') && 
          (rawText.includes("'text'") || rawText.includes('"text"')) &&
          (rawText.includes("'animation'") || rawText.includes('"animation"')) &&
          (rawText.includes("'expression'") || rawText.includes('"expression"'))) {
        console.log('[ws] Skipping raw JSON response');
        return;
      }
      
      // Try to parse as JSON to extract just the text field
      const parsedResponse = parseAgentResponse(rawText);
      let textToSpeak;
      
      if (parsedResponse && parsedResponse.text) {
        // Valid JSON response - extract text field
        textToSpeak = parsedResponse.text;
        console.log('[ws] Extracted text from JSON:', textToSpeak);
        
        // Execute animation and expression commands if present
        if (parsedResponse.animation || parsedResponse.expression) {
          executeAgentCommand(parsedResponse);
        }
      } else {
        // Invalid JSON or no text field - use raw text
        textToSpeak = rawText;
        console.log('[ws] Using raw text (not JSON):', textToSpeak);
      }
      
      // Mark this runId as processed
      if (runId) {
        processedRunIds.add(runId);
      }
      
      // Enable messaging panel when reply is received
      if (window.enableMessaging) {
        window.enableMessaging();
      }
      if (window.resetMessagingPanel) {
        window.resetMessagingPanel();
      }
      
      // Only trigger lip sync if we didn't already execute full agent command
      if (!parsedResponse || !parsedResponse.animation || !parsedResponse.expression) {
        // Trigger lip sync with message
        if (window.lipSyncSystem && textToSpeak) {
          window.lipSyncSystem.startSpeaking(textToSpeak);
          
          // Update status if DOM is available
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

/**
 * Get platform string
 */
function getPlatform() {
  const userAgent = navigator.userAgent;
  if (userAgent.indexOf('Win') !== -1) return 'windows';
  if (userAgent.indexOf('Mac') !== -1) return 'macos';
  if (userAgent.indexOf('Linux') !== -1) return 'linux';
  if (userAgent.indexOf('Android') !== -1) return 'android';
  if (userAgent.indexOf('iOS') !== -1) return 'ios';
  return 'unknown';
}

/**
 * Handle agent response from OpenClaw
 */
function handleAgentResponse(data) {
  console.log('[ws] Agent response received:', data);
  
  // Check if response is OK
  if (!data.ok) {
    console.error('[ws] Error in response:', data);
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = 'Error: ' + (data.payload?.error || 'Unknown error');
      statusDiv.style.color = '#ff6b6b';
    }
    return;
  }
  
  // Handle different response types
  if (data.payload?.type === 'hello-ok') {
    // Connection successful
    console.log('[ws] Connection successful, authenticated as:', data.payload.auth?.role);
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = 'Connected to OpenClaw';
      statusDiv.style.color = '#4CAF50';
    }
    
    // Flush any queued messages
    flushMessageQueue();
    
  } else if (data.payload?.result?.payloads && data.payload.result.payloads.length > 0) {
    // Check for deduplication using runId
    const runId = data.payload?.runId || data.payload?.result?.meta?.systemPromptReport?.generatedAt;
    if (runId && processedRunIds.has(runId)) {
      console.log('[ws] Ignoring duplicate res with runId:', runId);
      return;
    }
    
    // Filter: Only process responses from main agent/session
    // Check multiple possible locations for sessionKey due to different response structures
    const sessionKey = data.payload?.result?.meta?.agentMeta?.sessionKey || 
                       data.payload?.result?.meta?.systemPromptReport?.sessionKey ||
                       data.payload?.result?.sessionKey || 
                       data.sessionKey;
    const state = data.payload?.result?.state;
    
    // Only accept messages from main agent: "agent:main:main" or "main"
    const isValidSession = sessionKey === 'agent:main:main' || sessionKey === 'main';
    
    if (!isValidSession) {
      console.log('[ws] Ignoring response from non-main agent:', { sessionKey, state });
      return;
    }
    
    // Found AI reply in result.payloads array - EXTRACT JUST THE TEXT
    const replyText = data.payload.result.payloads[0]?.text;
    if (replyText) {
      console.log('[ws] AI reply from main agent:', replyText);
      
      // Mark this runId as processed
      if (runId) {
        processedRunIds.add(runId);
      }
      
      // Try to parse JSON response from agent
      const parsedResponse = parseAgentResponse(replyText);
      
      if (parsedResponse) {
        // Valid JSON response - execute coordinated sequence
        executeAgentCommand(parsedResponse);
      } else {
        // Invalid JSON - treat as plain text (this is the fix for JSON display issue)
        console.warn('[ws] Response is not valid JSON, treating as plain text');
        console.log('[ws] Plain text reply:', replyText);
        
        // Enable messaging panel when reply is received
        if (window.enableMessaging) {
          window.enableMessaging();
        }
        if (window.resetMessagingPanel) {
          window.resetMessagingPanel();
        }
        
        // Trigger lip sync with AI's reply (plain text, not JSON)
        if (window.lipSyncSystem) {
          window.lipSyncSystem.startSpeaking(replyText);
          
          // Update status if DOM is available
          const statusDiv = document.getElementById('status');
          if (statusDiv) {
            const displayText = replyText.length > 50 ? replyText.substring(0, 50) + '...' : replyText;
            statusDiv.textContent = 'Speaking: ' + displayText;
          }
        }
      }
    }
    
  } else if (data.payload?.status === 'accepted') {
    // Request accepted but not finished yet
    console.log('[ws] Request accepted, waiting for reply...');
    
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = 'Processing request...';
    }
  } else {
    // Other response types (health, etc.)
    console.log('[ws] Response data:', data.payload);
  }
}

/**
 * Parse agent's JSON response
 * @param {string} text - The response text from agent
 * @returns {object|null} - Parsed command object or null if invalid
 */
function parseAgentResponse(text) {
  try {
    // Try to parse as JSON (handles double quotes)
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e1) {
      // If that fails, try to handle single quotes (replace them with double quotes)
      // This is a simple fix for agents that send JSON with single quotes
      console.log('[ws] Standard JSON parse failed, trying single quote handling');
      const fixedText = text
        .replace(/'/g, '"')  // Replace all single quotes with double quotes
        .replace(/""/g, '""'); // Preserve escaped quotes
      parsed = JSON.parse(fixedText);
    }
    
    // Validate structure
    if (!parsed.text || typeof parsed.text !== 'string') {
      console.warn('[ws] Invalid JSON response: missing or invalid text field');
      return null;
    }
    
    // Validate animation if present
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
        parsed.animation = { file: 'idle_loop.vrma', timing: 'during' }; // Use default
      }
    }
    
    // Validate expression if present
    if (parsed.expression && parsed.expression.name) {
      const validExpressions = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'blink'];
      
      if (!validExpressions.includes(parsed.expression.name)) {
        console.warn('[ws] Invalid expression:', parsed.expression.name);
        parsed.expression = { name: 'neutral', timing: 'during' }; // Use default
      }
    }
    
    // Validate timing values
    const validTimings = ['before', 'during', 'after', null];
    
    if (parsed.animation && !validTimings.includes(parsed.animation.timing)) {
      console.warn('[ws] Invalid animation timing:', parsed.animation.timing);
      parsed.animation.timing = 'during'; // Default to during
    }
    
    if (parsed.expression && !validTimings.includes(parsed.expression.timing)) {
      console.warn('[ws] Invalid expression timing:', parsed.expression.timing);
      parsed.expression.timing = 'during'; // Default to during
    }
    
    console.log('[ws] Parsed agent command:', parsed);
    return parsed;
    
  } catch (error) {
    console.warn('[ws] Failed to parse JSON response:', error);
    return null;
  }
}

/**
 * Execute agent command with coordinated animation, expression, and speech timing
 * @param {object} command - Parsed command from agent
 */
async function executeAgentCommand(command) {
  console.log('[ws] Executing agent command:', command);
  
  const statusDiv = document.getElementById('status');
  
  // Enable messaging panel
  if (window.enableMessaging) {
    window.enableMessaging();
  }
  if (window.resetMessagingPanel) {
    window.resetMessagingPanel();
  }
  
  // Set agent command active flag to prevent idle loop from overriding animations
  if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
    window.lipSyncSystem.setAgentCommandActive(true);
    console.log('[ws] Agent command active - idle loop prevented');
  }
  
  // Get asset base URL
  const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || './assets/';
  
  // Step 1: Play "before" animations and expressions
  if (command.animation && command.animation.timing === 'before') {
    console.log('[ws] Playing animation BEFORE speaking:', command.animation.file);
    if (statusDiv) {
      statusDiv.textContent = 'Playing animation before speaking...';
    }
    
    if (window.startSmoothTransition) {
      // Play animation once and wait for it to complete
      // THREE.LoopOnce = 2200 (numeric value since THREE is not imported here)
      const action = await window.startSmoothTransition(
        `${ASSET_BASE_URL}VRMA/${command.animation.file}`,
        { loopMode: 2200 }
      );
      console.log('[ws] Before animation started, action:', action);
      
      // Always wait a minimum of 5 seconds for "before" animations
      // This ensures the animation has time to play regardless of waitForActionEnd behavior
      console.log('[ws] Waiting minimum 5 seconds for before animation...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Also try to wait for the 'finished' event if available
      if (action && window.waitForActionEnd) {
        try {
          await window.waitForActionEnd(action, 60000, false); // 60 second timeout
          console.log('[ws] Before animation finished event received');
        } catch (e) {
          console.warn('[ws] Before animation wait timed out or failed (this is OK):', e);
        }
      }
      
      // Additional delay to ensure animation is completely done
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
  
  // Step 2: Start speaking with "during" animations and expressions
  if (command.animation && command.animation.timing === 'during') {
    console.log('[ws] Playing animation DURING speaking:', command.animation.file);
    if (window.startSmoothTransition) {
      // Wait for animation to load and start before speaking
      await window.startSmoothTransition(`${ASSET_BASE_URL}VRMA/${command.animation.file}`);
      // Add a small delay to ensure animation is fully blended in
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  if (command.expression && command.expression.timing === 'during') {
    console.log('[ws] Applying expression DURING speaking:', command.expression.name);
    if (window.applyFacialExpression) {
      window.applyFacialExpression(command.expression.name);
    }
  }
  
  // Start lip sync with the text - properly await it
  if (command.text && window.lipSyncSystem) {
    console.log('[ws] Starting lip sync with text:', command.text.substring(0, 30) + '...');
    
    // Hide all panels before speaking
    if (window.hideAllPanels) {
      window.hideAllPanels();
    }
    
    if (statusDiv) {
      const displayText = command.text.length > 50 ? command.text.substring(0, 50) + '...' : command.text;
      statusDiv.textContent = 'Speaking: ' + displayText;
    }
    
    // Call startSpeaking and wait for it to complete
    window.lipSyncSystem.startSpeaking(command.text);
    
    // Wait for lip sync to complete - check periodically with extra safety delay
    // Use a longer delay to ensure all lines are processed
    await new Promise((resolve) => {
      let notTalkingCount = 0;
      const checkInterval = setInterval(() => {
        if (!window.lipSyncSystem.isTalking()) {
          notTalkingCount++;
          // Wait for 10 consecutive checks of not talking to ensure really done
          // This handles multi-line pauses
          if (notTalkingCount >= 10) {
            clearInterval(checkInterval);
            console.log('[ws] Lip sync confirmed complete after 10 checks');
            resolve();
          }
        } else {
          notTalkingCount = 0; // Reset counter if talking again
        }
      }, 100);
    });
    
    // Extra safety delay to ensure last line finishes processing
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Restore panels after speaking completes
    if (window.restorePanels) {
      window.restorePanels();
    }
  }
  
  // Step 3: Play "after" animations and expressions
  if (command.animation && command.animation.timing === 'after') {
    console.log('[ws] Playing animation AFTER speaking:', command.animation.file);
    if (statusDiv) {
      statusDiv.textContent = 'Playing animation after speaking...';
    }
    
    if (window.startSmoothTransition) {
      // Play animation once and wait for it to complete
      // THREE.LoopOnce = 2200 (numeric value since THREE is not imported here)
      const action = await window.startSmoothTransition(
        `${ASSET_BASE_URL}VRMA/${command.animation.file}`,
        { loopMode: 2200 }
      );
      console.log('[ws] After animation started, action:', action);
      
      // Always wait a minimum of 5 seconds for "after" animations
      // This ensures the animation has time to play regardless of waitForActionEnd behavior
      console.log('[ws] Waiting minimum 5 seconds for after animation...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Also try to wait for the 'finished' event if available
      if (action && window.waitForActionEnd) {
        try {
          await window.waitForActionEnd(action, 60000, false); // 60 second timeout
          console.log('[ws] After animation finished event received');
        } catch (e) {
          console.warn('[ws] After animation wait timed out or failed (this is OK):', e);
        }
      }
      
      // Additional delay to ensure animation is completely done
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
    
    // Wait 2 seconds then reset expression to neutral
    setTimeout(() => {
      console.log('[ws] Resetting expression to neutral');
      if (window.resetExpressionToNeutral) {
        window.resetExpressionToNeutral();
      }
    }, 2000);
  }
  
  // Return to idle loop after all actions complete
  console.log('[ws] Returning to idle loop with neutral expression');
  if (window.loadIdleLoop) {
    await window.loadIdleLoop();
  }
  
  if (window.resetExpressionToNeutral) {
    window.resetExpressionToNeutral();
  }
  
  // Reset agent command active flag to allow idle loop again
  if (window.lipSyncSystem && window.lipSyncSystem.setAgentCommandActive) {
    window.lipSyncSystem.setAgentCommandActive(false);
    console.log('[ws] Agent command complete - idle loop allowed again');
  }
}

/**
 * Handle history response from OpenClaw
 */
function handleHistoryResponse(data) {
  console.log('\n========== WEBSOCKET HISTORY RESPONSE START ==========');
  console.log('[ws] History response received');
  console.log('[ws] Response OK:', data.ok);
  console.log('[ws] Response ID:', data.id);
  console.log('[ws] Payload type:', data.payload?.type);
  console.log('[ws] Payload keys:', Object.keys(data.payload || {}));
  
  // Check if response is OK
  if (!data.ok) {
    console.error('[ws] ERROR: Response not OK');
    console.error('[ws] Error details:', data.payload?.error || data);
    return;
  }
  
  // Extract messages and metadata
  const messages = data.payload?.messages || [];
  const totalCount = data.payload?.totalCount || 0;
  const hasMore = data.payload?.hasMore || false;
  
  console.log('\n[ws] HISTORY METADATA:');
  console.log('  Messages in this batch:', messages.length);
  console.log('  Total messages available:', totalCount);
  console.log('  Has more messages:', hasMore);
  console.log('  Request ID:', data.id);
  
  console.log('\n[ws] ALL MESSAGES IN THIS BATCH:');
  messages.forEach((msg, index) => {
    console.log(`\n  [Message ${index + 1}/${messages.length}]`);
    console.log('    Role:', msg.role);
    console.log('    Timestamp:', msg.timestamp);
    console.log('    Session key:', msg.sessionKey || 'N/A');
    console.log('    Content array length:', Array.isArray(msg.content) ? msg.content.length : 'N/A');
    
    // Show content structure
    if (Array.isArray(msg.content)) {
      msg.content.forEach((item, idx) => {
        console.log(`      Content[${idx}]: type=${item.type}, text length=${item.text ? item.text.length : 0}`);
        if (item.text) {
          console.log(`      Text preview: ${item.text.substring(0, 100)}${item.text.length > 100 ? '...' : ''}`);
        }
      });
    } else {
      console.log('    Content structure:', typeof msg.content);
    }
  });
  
  console.log('\n========== WEBSOCKET HISTORY RESPONSE END ==========\n');
  
  // Display messages in history panel if the function is available
  if (window.displayHistoryMessages) {
    window.displayHistoryMessages(messages, totalCount, hasMore);
  } else {
    console.warn('[ws] displayHistoryMessages function not available');
  }
}

/**
 * Handle speak command from OpenClaw
 */
function handleSpeakCommand(data) {
  console.log('[ws] Speak command:', data.text);
  
  // Trigger lip sync via global function
  if (window.lipSyncSystem && data.text) {
    window.lipSyncSystem.startSpeaking(data.text);
    sendStatus('speaking');
  }
}

/**
 * Handle animate command from OpenClaw
 */
function handleAnimateCommand(data) {
  console.log('[ws] Animate command:', data.animation);
  
  // Get asset base URL
  const ASSET_BASE_URL = import.meta.env.VITE_ASSET_BASE_URL || './assets/';
  
  // Trigger animation via global function
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

/**
 * Handle express command from OpenClaw
 */
function handleExpressCommand(data) {
  console.log('[ws] Express command:', data.expression);
  
  // Trigger facial expression via global function
  if (window.applyFacialExpression && data.expression) {
    window.applyFacialExpression(data.expression);
    sendStatus('expressing', { expression: data.expression });
  }
}

/**
 * Handle WebSocket error
 */
function handleError(error) {
  console.error('[ws] WebSocket error:', error);
  isConnected = false;
}

/**
 * Handle WebSocket close
 */
function handleClose(event) {
  console.log('[ws] WebSocket closed:', event.code, event.reason);
  isConnected = false;
  
  if (reconnectAttempts < CONFIG.maxReconnectAttempts) {
    scheduleReconnect();
  } else {
    console.error('[ws] Max reconnection attempts reached');
  }
}

/**
 * Schedule reconnection attempt
 */
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

/**
 * Send message to OpenClaw
 */
export function sendMessage(data) {
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

/**
 * Queue message for later sending
 */
function queueMessage(data) {
  messageQueue.push(data);
  if (messageQueue.length > 50) {
    messageQueue.shift(); // Limit queue size
  }
}

/**
 * Flush queued messages
 */
function flushMessageQueue() {
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    sendMessage(message);
  }
}

/**
 * Send status update to OpenClaw
 */
export function sendStatus(state, details = {}) {
  sendMessage({
    type: 'status',
    state: state,
    timestamp: Date.now(),
    ...details
  });
}

/**
 * Check if WebSocket is connected
 */
export function isWebSocketConnected() {
  return isConnected;
}

/**
 * Close WebSocket connection
 */
export function closeWebSocket() {
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
 * Set WebSocket URL at runtime
 * Stores the URL in localStorage and optionally reconnects
 * @param {string} url - The WebSocket URL (e.g., 'ws://192.168.1.100:18789')
 * @param {boolean} reconnect - Whether to reconnect immediately (default: false)
 */
export function setWebSocketUrl(url, reconnect = false) {
  if (!url || typeof url !== 'string') {
    console.error('[ws] Invalid WebSocket URL provided');
    return false;
  }
  
  // Store in localStorage for persistence
  localStorage.setItem('websocket_url', url);
  console.log('[ws] WebSocket URL set to:', url);
  
  // Clear current connection and reconnect if requested
  if (reconnect) {
    console.log('[ws] Reconnecting with new URL...');
    closeWebSocket();
    setTimeout(() => {
      initWebSocket();
    }, 500);
  }
  
  return true;
}

/**
 * Get current WebSocket URL
 * @returns {string} The current WebSocket URL
 */
export function getWebSocketUrlInfo() {
  const url = getWebSocketUrl();
  console.log('[ws] Current WebSocket URL:', url);
  console.log('[ws] URL source:', 
    localStorage.getItem('websocket_url') ? 'localStorage' : 
    import.meta.env.VITE_WEBSOCKET_URL ? 'environment variable' : 'default'
  );
  return url;
}

// Don't auto-initialize - let user configure token first
// Initialization happens when token is provided and valid

// Export functions for manual control
export { initWebSocket as connect };
