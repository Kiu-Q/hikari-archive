import { awarenessConfig } from './awareness-config.js';
import { normalizeJapaneseText } from './agent-response-contract.js';

const STORAGE_KEY = 'desktop_awareness_enabled';
const PRIORITY_RANK = { low: 0, normal: 1, important: 2 };

// Awareness analysis is deliberately interruptible.  Keep this predicate
// shared with the HTTP wrapper so an expected cancellation is not reported as
// a failed request while genuine awareness errors remain visible.
export function isExpectedAwarenessAbort(error, requestType) {
  return requestType === 'awareness' && error?.name === 'AbortError';
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function awarenessDedupeKey(candidate) {
  return [
    candidate?.trigger || '',
    candidate?.context?.bundleId || candidate?.context?.appName || '',
    normalizeTitle(candidate?.context?.windowTitle)
  ].join('|');
}

function stripCodeFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export function parseAwarenessResponse(value) {
  const cleaned = stripCodeFence(value);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      parsed = JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }

  if (parsed?.react === false) return { react: false };
  if (parsed?.react !== true || typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
  const response = {
    react: true,
    text: parsed.text.trim(),
    text_ja: normalizeJapaneseText(parsed.text_ja),
    animation: parsed.animation || null,
    expression: parsed.expression || null
  };
  return response;
}

export function buildAwarenessPrompt(candidate, recentReactions = []) {
  const activity = candidate.activity || {};
  const context = candidate.context || {};
  const media = candidate.media || {};
  const recent = recentReactions.length
    ? recentReactions.map((item) => `- ${item.reactionText}`).join('\n')
    : '- None';
  const triggerGuidance = candidate.trigger === 'media_playback_started'
    ? `The start of media playback is usually worth one natural reaction when Hikari is idle.
The signal only proves that system audio output is active. Do not claim or guess the track, title, or content unless that information is explicitly present above.`
    : candidate.trigger === 'typing_session_end'
      ? `A meaningful typing burst (especially 8 or more events) is usually worth one brief,
supportive or contextual reaction when Hikari is idle. Do not claim to know what was typed;
only use the application and window context shown above.`
      : '';

  return `Desktop awareness event:

Trigger: ${candidate.trigger}
Active application: ${context.appName || 'Unknown'}
Active window: ${context.windowTitle || 'Unknown'}
Activity duration: ${Number.isFinite(activity.durationMs) ? `${Math.round(activity.durationMs / 100) / 10}s` : 'Unknown'}
Activity event count: ${Number.isFinite(activity.eventCount) ? activity.eventCount : 'Unknown'}
Visual change: ${Number.isFinite(candidate.visualChange?.ratio) ? `${Math.round(candidate.visualChange.ratio * 1000) / 10}% (${candidate.visualChange.level})` : 'Not measured'}
Media playback state: ${media.state || 'Not observed'}
Media playback source: ${media.source || 'Not observed'}

Recent proactive Hikari reactions:
${recent}

You are Hikari, the user's desktop companion. You passively noticed this action.
Decide whether it is worth proactively reacting. Prefer silence. React only when the
observation is meaningfully interesting, helpful, surprising, concerning, contextual,
or socially natural. Do not narrate obvious actions, repeatedly ask questions, or say
that the user merely clicked, typed, scrolled, or switched applications. If reacting,
keep it short, usually one sentence, and follow Hikari's existing personality.
${triggerGuidance}

Return only one JSON object. Silence:
{"react":false}

Reaction:
{"react":true,"text":"...","text_ja":"...","expression":{"name":"neutral","timing":"during"},"animation":{"file":"...","timing":"during"}}

The expression and animation fields are optional. Do not add markdown.`;
}

export class AwarenessController {
  constructor({
    api,
    logger,
    sendAgentMessageRaw,
    parseAgentResponse,
    executeAgentCommand,
    addHistoryMessage,
    isAgentBusy,
    isSpeaking,
    config = awarenessConfig
  }) {
    this.api = api;
    this.logger = logger;
    this.sendAgentMessageRaw = sendAgentMessageRaw;
    this.parseAgentResponse = parseAgentResponse;
    this.executeAgentCommand = executeAgentCommand;
    this.addHistoryMessage = addHistoryMessage;
    this.isAgentBusy = isAgentBusy;
    this.isSpeaking = isSpeaking;
    this.config = config;

    this.enabled = false;
    this.analysisRunning = false;
    this.pendingCandidate = null;
    this.lastAnalysisAt = 0;
    this.lastSpeechAt = 0;
    this.lastDirectInteractionAt = 0;
    this.userConversationDepth = 0;
    this.reactionTimes = [];
    this.recentCandidates = [];
    this.recentReactions = [];
    this.unsubscribeCandidate = null;
    this.pendingTimer = null;
    this.permissionRefreshTimer = null;
    this.analysisAbortController = null;
    this.handlePermissionWindowFocus = () => this.schedulePermissionRefresh();
    this.handlePermissionVisibilityChange = () => {
      if (!document.hidden) this.schedulePermissionRefresh();
    };
  }

  debug(stage, message, detail) {
    if (!this.config.debug) return;
    const prefix = `[AWARENESS ${stage}]`;
    if (detail === undefined) this.logger.info('awareness', `${prefix} ${message}`);
    else this.logger.info('awareness', `${prefix} ${message}`, detail);
  }

  async init() {
    const toggle = document.getElementById('desktopAwarenessToggle');
    const enabled = localStorage.getItem(STORAGE_KEY) === null
      ? this.config.enabledByDefault
      : localStorage.getItem(STORAGE_KEY) === 'true';

    if (!this.api) {
      if (toggle) toggle.disabled = true;
      this.renderStatus(null, 'Unavailable');
      return;
    }

    this.unsubscribeCandidate = this.api.onCandidate((candidate) => this.handleCandidate(candidate));
    if (toggle) {
      toggle.checked = enabled;
      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        try {
          await this.setEnabled(toggle.checked);
        } finally {
          toggle.disabled = false;
        }
      });
    }

    const permissionButton = document.getElementById('desktopAwarenessScreenPermission');
    if (permissionButton) {
      permissionButton.addEventListener('click', () => {
        void this.requestScreenCapturePermission();
      });
    }
    const inputPermissionButton = document.getElementById('desktopAwarenessInputPermission');
    if (inputPermissionButton) {
      inputPermissionButton.addEventListener('click', () => {
        void this.requestInputMonitoringPermission();
      });
    }
    window.addEventListener('focus', this.handlePermissionWindowFocus);
    document.addEventListener('visibilitychange', this.handlePermissionVisibilityChange);

    await this.setEnabled(enabled);
  }

  destroy() {
    this.unsubscribeCandidate?.();
    this.unsubscribeCandidate = null;
    this.analysisAbortController?.abort();
    this.analysisAbortController = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.permissionRefreshTimer) clearTimeout(this.permissionRefreshTimer);
    this.permissionRefreshTimer = null;
    window.removeEventListener('focus', this.handlePermissionWindowFocus);
    document.removeEventListener('visibilitychange', this.handlePermissionVisibilityChange);
  }

  async setEnabled(enabled) {
    if (!enabled) {
      this.enabled = false;
      this.clearPending();
      this.analysisAbortController?.abort();
    }
    try {
      const status = await this.api.setEnabled(Boolean(enabled));
      this.enabled = Boolean(status?.enabled);
      localStorage.setItem(STORAGE_KEY, String(this.enabled));
      const toggle = document.getElementById('desktopAwarenessToggle');
      if (toggle) toggle.checked = this.enabled;
      if (!this.enabled) this.clearPending();
      this.renderStatus(status);
      this.debug('STATUS', this.enabled ? 'enabled' : 'disabled', status);
      return status;
    } catch (error) {
      this.enabled = false;
      localStorage.setItem(STORAGE_KEY, 'false');
      const toggle = document.getElementById('desktopAwarenessToggle');
      if (toggle) toggle.checked = false;
      this.renderStatus(null, 'Error');
      this.logger.error('awareness', 'Failed to change desktop awareness state:', error);
      return null;
    }
  }

  renderStatus(status, override) {
    const element = document.getElementById('desktopAwarenessStatus');
    const permissionButton = document.getElementById('desktopAwarenessScreenPermission');
    const inputPermissionButton = document.getElementById('desktopAwarenessInputPermission');
    if (override) {
      if (element) element.textContent = override;
      if (permissionButton) permissionButton.hidden = true;
      if (inputPermissionButton) inputPermissionButton.hidden = true;
      return;
    }
    if (!status?.enabled) {
      if (element) element.textContent = 'Off';
      if (permissionButton) permissionButton.hidden = true;
      if (inputPermissionButton) inputPermissionButton.hidden = true;
      return;
    }
    const limited = !status.inputMonitoringAvailable ||
      !status.activeWindowAvailable ||
      !status.screenCaptureAvailable ||
      status.mediaPlaybackAvailable === false;
    if (element) {
      element.textContent = limited ? 'On (limited)' : 'On';
      element.title = limited
        ? Object.entries(status.errors || {}).map(([key, value]) => `${key}: ${value}`).join('\n')
        : 'Desktop awareness is active';
    }
    if (permissionButton) {
      const screenPermissionMissing = status.screenCaptureAvailable === false;
      permissionButton.hidden = !screenPermissionMissing;
      permissionButton.disabled = false;
      permissionButton.textContent = status.settingsOpened && status.permissionKind === 'screen'
        ? 'Refresh Screen Recording Status'
        : 'Open Screen Recording Settings';
      permissionButton.title = screenPermissionMissing
        ? 'macOS requires you to allow screen recording for the exact Hikari/Electron app, then return here and refresh.'
        : '';
    }
    if (inputPermissionButton) {
      const inputPermissionMissing = status.inputMonitoringAvailable === false;
      inputPermissionButton.hidden = !inputPermissionMissing;
      inputPermissionButton.disabled = false;
      inputPermissionButton.textContent = status.settingsOpened && status.permissionKind === 'inputMonitoring'
        ? 'Refresh Keyboard Monitoring Status'
        : 'Open Keyboard Monitoring Settings';
      inputPermissionButton.title = inputPermissionMissing
        ? 'macOS requires you to allow keyboard monitoring for the exact Hikari/Electron app, then return here and refresh.'
        : '';
    }
  }

  schedulePermissionRefresh() {
    if (!this.enabled || !this.api?.refreshStatus) return;
    if (this.permissionRefreshTimer) clearTimeout(this.permissionRefreshTimer);
    this.permissionRefreshTimer = setTimeout(() => {
      this.permissionRefreshTimer = null;
      void this.refreshStatus();
    }, 300);
  }

  async refreshStatus() {
    if (!this.api?.refreshStatus) return null;
    try {
      const status = await this.api.refreshStatus();
      if (status) this.renderStatus(status);
      return status;
    } catch (error) {
      this.logger.error('awareness', 'Failed to refresh desktop awareness status:', error);
      return null;
    }
  }

  async requestScreenCapturePermission() {
    if (!this.api?.requestScreenCapturePermission) return null;
    const button = document.getElementById('desktopAwarenessScreenPermission');
    if (button) {
      button.disabled = true;
      button.textContent = 'Opening Screen Recording Settings…';
    }
    try {
      const status = await this.api.requestScreenCapturePermission();
      this.renderStatus(status);
      if (status?.settingsOpened) this.debug('PERMISSION', 'opened macOS Screen Recording settings');
      return status;
    } catch (error) {
      this.logger.error('awareness', 'Failed to open Screen Recording settings:', error);
      this.renderStatus(null, 'Permission Error');
      return null;
    }
  }

  async requestInputMonitoringPermission() {
    if (!this.api?.requestInputMonitoringPermission) return null;
    const button = document.getElementById('desktopAwarenessInputPermission');
    if (button) {
      button.disabled = true;
      button.textContent = 'Opening Keyboard Monitoring Settings…';
    }
    try {
      const status = await this.api.requestInputMonitoringPermission();
      this.renderStatus(status);
      if (status?.settingsOpened) this.debug('PERMISSION', 'opened macOS Keyboard Monitoring settings');
      return status;
    } catch (error) {
      this.logger.error('awareness', 'Failed to open Keyboard Monitoring settings:', error);
      this.renderStatus(null, 'Permission Error');
      return null;
    }
  }

  noteDirectHikariInteraction() {
    this.lastDirectInteractionAt = Date.now();
    this.clearPending();
    this.analysisAbortController?.abort();
    this.api?.noteDirectInteraction();
    this.debug('POLICY', 'pending candidate dropped: direct Hikari interaction');
  }

  onUserMessageStarted() {
    this.userConversationDepth += 1;
    this.clearPending();
    this.analysisAbortController?.abort();
    this.debug('POLICY', 'awareness yielded to a direct user message');
  }

  onUserMessageFinished() {
    this.userConversationDepth = Math.max(0, this.userConversationDepth - 1);
  }

  clearPending() {
    this.pendingCandidate = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  handleCandidate(candidate) {
    if (!this.enabled || !candidate?.id || !candidate?.timestamp) return;
    this.recentCandidates.push(candidate);
    this.recentCandidates = this.recentCandidates.slice(-this.config.memory.recentCandidateLimit);

    if (this.analysisRunning) {
      this.keepBestPending(candidate);
      return;
    }
    void this.considerCandidate(candidate);
  }

  async considerCandidate(candidate) {
    const now = Date.now();
    const age = now - candidate.timestamp;
    if (age > this.config.observation.candidateMaxAgeMs) {
      this.debug('POLICY', 'candidate dropped: stale', { trigger: candidate.trigger, age });
      return;
    }

    if (now - this.lastDirectInteractionAt < this.config.hikariInteraction.suppressionMs) {
      this.debug('POLICY', 'candidate dropped: direct-interaction suppression');
      return;
    }

    if (candidate.priority === 'low') {
      this.debug('POLICY', 'candidate retained as context only: low priority', candidate.trigger);
      return;
    }

    if (this.userConversationDepth > 0 || this.isAgentBusy?.() || this.isSpeaking?.()) {
      this.debug('POLICY', 'candidate dropped: Hikari is busy', candidate.trigger);
      return;
    }

    const dedupeKey = awarenessDedupeKey(candidate);
    const duplicate = this.recentReactions.some((reaction) => (
      reaction.key === dedupeKey &&
      now - reaction.timestamp < this.config.dedupe.sameContextReactionCooldownMs
    ));
    if (duplicate) {
      this.debug('POLICY', 'candidate dropped: duplicate', dedupeKey);
      return;
    }

    const analysisWait = this.config.observation.minimumAgentAnalysisIntervalMs - (now - this.lastAnalysisAt);
    if (analysisWait > 0) {
      this.keepBestPending(candidate);
      this.schedulePending(analysisWait);
      this.debug('POLICY', 'candidate waiting for analysis interval', analysisWait);
      return;
    }

    const speechCooldown = candidate.priority === 'important'
      ? this.config.reaction.importantSpeechCooldownMs
      : this.config.reaction.normalSpeechCooldownMs;
    if (now - this.lastSpeechAt < speechCooldown) {
      this.debug('POLICY', 'candidate dropped: spoken reaction cooldown');
      return;
    }

    this.trimReactionBudget(now);
    if (candidate.priority !== 'important' && this.reactionTimes.length >= this.config.reaction.normalBudgetCount) {
      this.debug('POLICY', `candidate dropped: reaction budget ${this.reactionTimes.length}/${this.config.reaction.normalBudgetCount}`);
      return;
    }

    await this.analyzeCandidate(candidate);
  }

  keepBestPending(candidate) {
    if (!this.pendingCandidate) {
      this.pendingCandidate = candidate;
      return;
    }
    const currentRank = PRIORITY_RANK[this.pendingCandidate.priority] ?? 0;
    const incomingRank = PRIORITY_RANK[candidate.priority] ?? 0;
    if (incomingRank > currentRank || (incomingRank === currentRank && candidate.timestamp >= this.pendingCandidate.timestamp)) {
      this.pendingCandidate = candidate;
    }
  }

  schedulePending(delay = 250) {
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.drainPending();
    }, Math.max(0, delay));
  }

  drainPending() {
    if (this.analysisRunning || !this.pendingCandidate) return;
    const candidate = this.pendingCandidate;
    this.pendingCandidate = null;
    void this.considerCandidate(candidate);
  }

  trimReactionBudget(now = Date.now()) {
    const cutoff = now - this.config.reaction.normalBudgetWindowMs;
    this.reactionTimes = this.reactionTimes.filter((timestamp) => timestamp >= cutoff);
  }

  async analyzeCandidate(candidate) {
    this.analysisRunning = true;
    this.lastAnalysisAt = Date.now();
    this.analysisAbortController = new AbortController();
    this.debug('POLICY', 'candidate accepted for agent analysis', candidate.trigger);

    try {
      // The current OpenClaw transport accepts string message content only.
      // requestSnapshot remains available for a later verified multimodal path.
      const prompt = buildAwarenessPrompt(candidate, this.recentReactions);
      const reply = await this.sendAgentMessageRaw(prompt, {
        signal: this.analysisAbortController.signal,
        requestType: 'awareness'
      });
      const decision = parseAwarenessResponse(reply);
      if (!decision) {
        this.debug('AGENT', 'invalid awareness response; staying silent');
        return;
      }
      if (!decision.react) {
        this.debug('AGENT', 'react=false');
        return;
      }

      if (!this.enabled || this.userConversationDepth > 0 || this.isAgentBusy?.() || this.isSpeaking?.()) {
        this.debug('RESULT', 'reaction dropped because awareness is disabled or Hikari became busy');
        return;
      }

      const command = this.parseAgentResponse(JSON.stringify({
        text: decision.text,
        text_ja: decision.text_ja || '',
        expression: decision.expression,
        animation: decision.animation
      }));
      if (!command?.text) {
        this.debug('AGENT', 'reaction failed existing response validation');
        return;
      }

      await this.executeAgentCommand(command);

      const reactedAt = Date.now();
      this.lastSpeechAt = reactedAt;
      if (candidate.priority !== 'important') this.reactionTimes.push(reactedAt);
      this.recentReactions.push({
        key: awarenessDedupeKey(candidate),
        trigger: candidate.trigger,
        appName: candidate.context?.appName || '',
        windowTitle: candidate.context?.windowTitle || '',
        timestamp: reactedAt,
        reactionText: command.text
      });
      this.recentReactions = this.recentReactions.slice(-this.config.memory.recentReactionLimit);
      this.debug('RESULT', 'spoken reaction completed', command.text);
    } catch (error) {
      if (error?.name === 'AbortError') this.debug('AGENT', 'awareness request aborted for direct conversation');
      else this.logger.error('awareness', 'Awareness analysis failed:', error);
    } finally {
      this.analysisRunning = false;
      this.analysisAbortController = null;
      this.drainPending();
    }
  }
}
