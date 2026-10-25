import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { MusicBeatDetector } from './music-beat.js';

export class MusicBeatService {
  constructor({ executable, spawn = nodeSpawn, available = () => process.platform === 'darwin' && existsSync(executable),
    excludePids = () => [process.pid], onSignal = () => {}, onStatus = () => {}, now = () => Date.now(),
    mediaPlaying = async () => false, startupTimeoutMs = 30_000, silentTimeoutMs = 15_000 } = {}) {
    Object.assign(this, { executable, spawn, available, excludePids, onSignal, onStatus, now, mediaPlaying, startupTimeoutMs, silentTimeoutMs });
    this.detector = new MusicBeatDetector(); this.child = null;
    this.status = { state: 'off' }; this.starting = null;
  }
  setStatus(status) { this.status = status; this.onStatus(status); return status; }
  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(this.status);
    if (!this.available()) return Promise.resolve(this.setStatus({ state: 'error', reason: 'Music sway requires macOS 14.2 or later and the native helper.' }));
    this.detector.reset();
    this.setStatus({ state: 'starting' });
    let child;
    try { child = this.spawn(this.executable, this.excludePids().map(String), { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return Promise.resolve(this.setStatus({ state: 'error', reason: 'Could not start music analysis.' })); }
    this.child = child;
    let buffer = '', ready = false, audible = false, quietSince = null, checking = false;
    const pending = new Promise(resolve => {
      const settle = status => { clearTimeout(this.startupTimer); resolve(status); };
      this.settleStart = settle;
      this.startupTimer = setTimeout(() => {
        if (this.child !== child) return;
        this.stop({ state: 'error', reason: 'System audio access is needed. Allow Hikari in macOS System Audio Recording settings, then try again.' });
      }, this.startupTimeoutMs);
      const fail = reason => {
        if (this.child !== child) return;
        this.stop({ state: 'error', reason });
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 65536) { fail('Music analysis returned invalid data.'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0 && this.child === child) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let frame; try { frame = JSON.parse(line); } catch { continue; }
          if (frame.type === 'error') {
            fail(frame.stage === 'unsupported' ? 'Music sway requires macOS 14.2 or later.'
              : 'System audio capture could not start. Allow Hikari in System Audio Recording settings, then try again.');
          } else if (frame.type === 'ready') {
            ready = true; settle(this.setStatus({ state: 'listening' }));
          } else if (frame.type === 'frame' && ready && Number.isFinite(frame.level) && Number.isFinite(frame.bass)) {
            const signal = this.detector.update(frame, this.now());
            if (signal.active && this.status.warning) this.setStatus({ state: 'listening' });
            this.onSignal(signal);
            audible ||= signal.active;
            if (signal.active) quietSince = null;
            else quietSince ??= this.now();
            // Some macOS permission failures yield silent PCM without an error.
            // Diagnose that only when external media is actually running.
            if (!audible && quietSince !== null && this.now() - quietSince >= this.silentTimeoutMs && !checking) {
              checking = true;
              Promise.resolve().then(() => this.mediaPlaying()).then(playing => {
                if (this.child === child && !audible && playing) this.setStatus({ state: 'listening',
                  warning: 'No audio captured. If music is playing, check Hikari’s System Audio Recording permission.' });
              }).catch(() => {}).finally(() => { checking = false; quietSince = this.now(); });
            }
          }
        }
      });
      child.once('error', () => fail('Could not start music analysis.'));
      child.once('close', () => fail('Music analysis stopped. Toggle Music beat sway to try again.'));
      this.exclusionTimer = setInterval(() => {
        if (this.child === child && !child.stdin.destroyed) child.stdin.write(JSON.stringify(this.excludePids()) + '\n');
      }, 1000);
    }).finally(() => {
      if (this.starting === pending) { this.starting = null; this.settleStart = null; }
    });
    this.starting = pending;
    return pending;
  }
  stop(status = { state: 'off' }) {
    clearTimeout(this.startupTimer); clearInterval(this.exclusionTimer);
    const child = this.child; this.child = null;
    if (child) {
      child.stdin.end(); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500); timer.unref?.();
      child.once('close', () => clearTimeout(timer));
    }
    this.detector.reset();
    this.onSignal({ active: false, level: 0, beat: 0, lastBeatAt: null, intervalMs: null, updatedAt: this.now() });
    this.setStatus(status); this.settleStart?.(status);
    this.starting = null; this.settleStart = null;
    return status;
  }
}
