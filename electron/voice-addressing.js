const DEFAULT_WAKE_WORDS = ['hikari'];

function normalizeTranscript(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function suppressSelfVoice({ speaking, now = Date.now(), tailUntil = 0 }) {
  return Boolean(speaking || now < tailUntil);
}

export class VoiceAddressingGate {
  constructor({ wakeWords = DEFAULT_WAKE_WORDS, wakeDurationMs = 8000, followUpDurationMs = 0 } = {}) {
    this.wakeWords = wakeWords.map(normalizeTranscript).filter(Boolean);
    this.wakeDurationMs = wakeDurationMs;
    this.followUpDurationMs = followUpDurationMs;
    this.wakeExpiresAt = 0;
    this.followUpExpiresAt = 0;
  }

  process(transcript, now = Date.now()) {
    const normalized = normalizeTranscript(transcript);
    const match = this.wakeWords.map(escapeRegExp).join('|');
    const invocation = match ? new RegExp(`^(?:(?:hey|hi|okay|ok)\\s+)?(?:${match})(?=$|[\\s,:;.!?，、。！？—-])[，、。！？,:;.!?\\s—-]*`, 'i').exec(normalized) : null;
    if (invocation) {
      const remainder = normalized.slice(invocation[0].length).trim();
      if (!remainder) {
        this.wakeExpiresAt = now + this.wakeDurationMs;
        return { addressed: false, wakeActivated: true, wakeExpiresAt: this.wakeExpiresAt, text: '' };
      }
      this.wakeExpiresAt = 0;
      this.followUpExpiresAt = this.followUpDurationMs > 0 ? now + this.followUpDurationMs : 0;
      return { addressed: true, wakeActivated: false, wakeExpiresAt: 0, text: remainder };
    }

    if (now < this.wakeExpiresAt) {
      this.wakeExpiresAt = 0;
      this.followUpExpiresAt = this.followUpDurationMs > 0 ? now + this.followUpDurationMs : 0;
      return { addressed: Boolean(normalized), wakeActivated: false, wakeExpiresAt: 0, text: normalized };
    }
    this.wakeExpiresAt = 0;
    if (this.followUpDurationMs > 0 && now < this.followUpExpiresAt && normalized.length <= 100) {
      this.followUpExpiresAt = now + this.followUpDurationMs;
      return { addressed: Boolean(normalized), wakeActivated: false, wakeExpiresAt: 0, text: normalized };
    }
    this.followUpExpiresAt = 0;
    return { addressed: false, wakeActivated: false, wakeExpiresAt: 0, text: '' };
  }

  armFollowUp(now = Date.now()) {
    this.followUpExpiresAt = this.followUpDurationMs > 0 ? now + this.followUpDurationMs : 0;
    return this.followUpExpiresAt;
  }

  reset() {
    this.wakeExpiresAt = 0;
    this.followUpExpiresAt = 0;
  }
}

export { normalizeTranscript };
