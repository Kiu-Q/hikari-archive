import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export function parseOutputVolume(value) {
  const match = /^(\d+)\s+((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(String(value ?? ''));
  if (!match) return null;
  const deviceId = Number(match[1]);
  const scalar = Number(match[2]);
  return Number.isSafeInteger(deviceId) && deviceId > 0 &&
    Number.isFinite(scalar) && scalar >= 0 && scalar <= 1
    ? { deviceId, scalar }
    : null;
}

export class ReplyVolumeService {
  constructor({ helperPath, execute = execFile, fadeMs = 350 } = {}) {
    this.helperPath = helperPath;
    this.execute = execute;
    this.fadeMs = fadeMs;
    this.active = null;
    this.nextSessionId = 1;
    this.chain = Promise.resolve();
  }

  serialize(operation) {
    const result = this.chain.catch(() => {}).then(operation);
    this.chain = result.catch(() => {});
    return result;
  }

  async call(args) {
    const result = await this.execute(this.helperPath, args, {
      encoding: 'utf8',
      timeout: 3000
    });
    return result?.stdout ?? '';
  }

  async readVolume() {
    return parseOutputVolume(await this.call(['volume-get']));
  }

  async ramp(deviceId, scalar) {
    await this.call([
      'volume-ramp',
      String(deviceId),
      String(Math.max(0, Math.min(1, scalar))),
      String(this.fadeMs)
    ]);
  }

  begin({ canBoost = true } = {}) {
    return this.serialize(async () => {
      if (this.active) await this.restoreActive();

      const sessionId = String(this.nextSessionId++);
      // Keep speech at 90% of its normal level when there is no media to duck,
      // or when Web Audio cannot compensate for the system output reduction.
      const fallback = { sessionId, voiceGain: 0.9, mediaDucked: false };
      this.active = { sessionId, duck: null };
      if (!this.helperPath || !canBoost) return fallback;

      try {
        const mediaPlaying = String(await this.call([])).trim() === '1';
        if (!mediaPlaying) return fallback;

        const volume = await this.readVolume();
        if (!volume || volume.scalar <= 0.01) return fallback;
        const targetScalar = volume.scalar * 0.7;
        const duck = { ...volume, targetScalar };
        this.active.duck = duck;
        await this.ramp(volume.deviceId, targetScalar);
        // Keep media at 70% and speech at 90% of its normal output level.
        return { sessionId, voiceGain: 0.9 / 0.7, mediaDucked: true };
      } catch {
        await this.restoreActive({ allowPartialRamp: true });
        this.active = { sessionId, duck: null };
        return fallback;
      }
    });
  }

  end(sessionId) {
    return this.serialize(async () => {
      if (!this.active || this.active.sessionId !== sessionId) return;
      await this.restoreActive();
    });
  }

  restore() {
    return this.serialize(() => this.restoreActive());
  }

  async restoreActive({ allowPartialRamp = false } = {}) {
    const active = this.active;
    this.active = null;
    if (!active?.duck) return;

    try {
      const current = await this.readVolume();
      // Preserve a user's volume adjustment or a newly selected output
      // device instead of overwriting their choice after the reply.
      if (!current || current.deviceId !== active.duck.deviceId) return;
      const atTarget = Math.abs(current.scalar - active.duck.targetScalar) <= 0.005;
      const betweenRampEndpoints = current.scalar >= Math.min(
        active.duck.targetScalar,
        active.duck.scalar
      ) - 0.005 && current.scalar <= Math.max(
        active.duck.targetScalar,
        active.duck.scalar
      ) + 0.005;
      if (!atTarget && !(allowPartialRamp && betweenRampEndpoints)) return;
      await this.ramp(active.duck.deviceId, active.duck.scalar);
    } catch {
      // Playback must still finish if the device disappears mid-reply.
    }
  }
}
