import { desktopCapturer as je, systemPreferences as j, shell as Te, app as v, screen as U, nativeImage as ct, ipcMain as y, session as ut, BrowserWindow as $e, powerMonitor as qe } from "electron";
import S from "path";
import { fileURLToPath as dt } from "url";
import { readdirSync as ht, existsSync as V } from "fs";
import { execFile as Ge, spawn as xe } from "node:child_process";
import { existsSync as de } from "node:fs";
import _ from "node:path";
import { promisify as Ve } from "node:util";
import { fileURLToPath as pt } from "node:url";
const _e = Object.freeze({
  accessibilityPermission: !1,
  // get-windows' native helper has its own macOS TCC identity. Keep it from
  // requesting Screen Recording; Electron's desktopCapturer owns that access.
  screenRecordingPermission: !1
}), ke = {
  enabledByDefault: !1,
  idleReturn: {
    minimumIdleMs: 90 * 1e3,
    greetingCooldownMs: 300 * 1e3
  },
  activity: {
    // Short, deliberate bursts should still produce an observation while the
    // pause keeps every individual key from becoming its own candidate.
    typingPauseMs: 1500,
    minimumTypingKeys: 3,
    scrollPauseMs: 800,
    minimumWheelEvents: 3,
    clickObservationDelayMs: 500
  },
  media: {
    // Core Audio is sampled instead of captured. Requiring two consecutive
    // samples filters short notification sounds while still noticing playback
    // within a few seconds.
    pollIntervalMs: 2e3,
    debounceSamples: 2
  },
  screen: {
    comparisonWidth: 320,
    comparisonHeight: 180,
    minorChangeThreshold: 0.03,
    significantChangeThreshold: 0.08,
    majorChangeThreshold: 0.25,
    // Keyboard activity is already a strong signal. Do not require a large
    // pixel diff as well: a few characters often change far below 3% of a
    // full editor window.
    typingChangeThreshold: 0,
    // Allow an active-window transition to settle before taking a comparison
    // snapshot. Semantic snapshots can remain larger than diff thumbnails.
    stableWindowDebounceMs: 300,
    semanticSnapshotWidth: 1120,
    semanticSnapshotJpegQuality: 72
  },
  observation: {
    minimumCandidateIntervalMs: 4e3,
    minimumAgentAnalysisIntervalMs: 4e3,
    candidateMaxAgeMs: 1e4
  },
  reaction: {
    normalSpeechCooldownMs: 2e4,
    importantSpeechCooldownMs: 15e3,
    normalBudgetCount: 6,
    normalBudgetWindowMs: 600 * 1e3
  },
  dedupe: {
    sameContextReactionCooldownMs: 9e4
  },
  hikariInteraction: {
    suppressionMs: 1500
  },
  memory: {
    recentCandidateLimit: 20,
    recentReactionLimit: 10
  },
  debug: !0
}, ne = 2 * 1024 * 1024, ge = 1920;
function F(t, e) {
  return Object.assign(new Error(e), { code: t });
}
function ft({ getSources: t, getDisplay: e, getPermissionStatus: i = () => "granted", platform: n = process.platform, now: s = () => Date.now(), captureTimeoutMs: r = 15e3 }) {
  let a = !1;
  return {
    async capture() {
      if (a) throw F("CAPTURE_BUSY", "A screenshot is already being captured.");
      a = !0;
      try {
        if (n === "darwin" && i() !== "granted")
          throw F("SCREEN_PERMISSION_REQUIRED", "Allow Screen Recording for Hikari in macOS Settings, then capture again.");
        const o = e();
        if (!o?.size?.width || !o?.size?.height) throw F("CAPTURE_UNAVAILABLE", "The current display is unavailable.");
        const l = Math.min(1, ge / Math.max(o.size.width, o.size.height));
        let u, c;
        try {
          c = await Promise.race([
            t({
              types: ["screen"],
              fetchWindowIcons: !1,
              thumbnailSize: { width: Math.max(1, Math.round(o.size.width * l)), height: Math.max(1, Math.round(o.size.height * l)) }
            }),
            new Promise((C, K) => {
              u = setTimeout(() => K(F("CAPTURE_TIMEOUT", "Screen capture timed out. Check Screen Recording permission and try again.")), r);
            })
          ]);
        } finally {
          clearTimeout(u);
        }
        let d = c.find((C) => String(C.display_id) === String(o.id))?.thumbnail;
        if (!d || d.isEmpty()) throw F("CAPTURE_UNAVAILABLE", "No screenshot was returned for the current display.");
        let f = d.getSize();
        if (Math.max(f.width, f.height) > ge) {
          const C = ge / Math.max(f.width, f.height);
          d = d.resize({ width: Math.round(f.width * C), height: Math.round(f.height * C), quality: "good" });
        }
        let m;
        for (const C of [80, 65, 50])
          if (m = d.toJPEG(C), m.length <= ne) break;
        if (!m?.length || m.length > ne) throw F("SCREENSHOT_TOO_LARGE", "The screenshot is too large. Try capturing a smaller display.");
        f = d.getSize();
        const A = d.resize({ width: Math.min(320, f.width), quality: "good" }).toJPEG(65);
        return {
          mimeType: "image/jpeg",
          width: f.width,
          height: f.height,
          capturedAt: s(),
          dataUrl: `data:image/jpeg;base64,${m.toString("base64")}`,
          thumbnailDataUrl: `data:image/jpeg;base64,${A.toString("base64")}`
        };
      } finally {
        a = !1;
      }
    }
  };
}
function mt(t) {
  if (typeof t != "string") return null;
  const e = t.trim();
  return e === "1" ? !0 : e === "0" ? !1 : null;
}
function gt(t) {
  try {
    const e = JSON.parse(String(t ?? "").trim());
    if (e?.available !== !0) return { available: !1, running: !1, volume: null, muted: null };
    const i = e.volume == null ? null : Number(e.volume);
    return {
      available: !0,
      running: !!e.running,
      volume: Number.isFinite(i) && i >= 0 && i <= 1 ? i : null,
      muted: typeof e.muted == "boolean" ? e.muted : null,
      deviceId: Number.isSafeInteger(e.deviceId) && e.deviceId > 0 ? e.deviceId : null
    };
  } catch {
    return null;
  }
}
class wt {
  constructor({ debounceSamples: e = 2 } = {}) {
    this.debounceSamples = Math.max(1, Math.floor(Number(e) || 1)), this.reset();
  }
  reset() {
    this.stablePlaying = !1, this.pendingPlaying = null, this.pendingCount = 0;
  }
  observe(e) {
    if (typeof e != "boolean") return null;
    if (e === this.stablePlaying)
      return this.pendingPlaying = null, this.pendingCount = 0, null;
    if (this.pendingPlaying === e ? this.pendingCount += 1 : (this.pendingPlaying = e, this.pendingCount = 1), this.pendingCount < this.debounceSamples) return null;
    const i = this.stablePlaying ? "playing" : "stopped";
    return this.stablePlaying = e, this.pendingPlaying = null, this.pendingCount = 0, {
      previousState: i,
      state: e ? "playing" : "stopped"
    };
  }
}
const he = {
  revision: 0,
  updatedAt: 0,
  desktop: {
    appName: "",
    bundleId: "",
    windowTitle: "",
    windowId: null,
    windowBounds: null,
    contextUpdatedAt: 0,
    contextStale: !0,
    pointer: { x: null, y: null, displayId: null, updatedAt: 0, stale: !0 },
    activity: { typing: !1, scrolling: !1, clicking: !1, lastInputAt: 0, idleForMs: 0, idle: !1, updatedAt: 0, stale: !0 },
    screen: { changeLevel: "unknown", changeAt: 0, changeStale: !0, lastSummary: "", summaryAt: 0, summaryStale: !0, summaryContextKey: "", available: !1, visionAvailable: !1 }
  },
  browser: { available: !1, activeTab: null, tabs: [], updatedAt: 0 },
  audio: {
    microphone: { enabled: !1, permission: "unknown", voiceActive: !1, lastSpeechAt: 0 },
    wake: { active: !1, expiresAt: 0 },
    stt: { status: "unavailable", language: "", lastAddressedAt: 0 },
    system: { available: !1, captureAvailable: !1, running: !1, volume: null, muted: null, level: null, classification: "unknown", confidence: 0, updatedAt: 0 }
  },
  hikari: { speaking: !1, listening: !1, thinking: !1, dragging: !1, directInteraction: !1, currentBehavior: "idle", attentionTarget: "none", semanticReaction: null, updatedAt: 0, stale: !0 }
};
function Ee(t) {
  return structuredClone(t);
}
function yt() {
  return Ee(he);
}
function bt({ typingSession: t, scrollSession: e, clickSession: i, lastInputAt: n = 0 } = {}, s = Date.now()) {
  const r = n ? Math.max(0, s - n) : 0;
  return {
    typing: !!t,
    scrolling: !!e,
    clicking: !!i,
    lastInputAt: n,
    idleForMs: r,
    idle: r >= 6e4
  };
}
function Ke(t, e) {
  if (!e || typeof e != "object" || Array.isArray(e)) return t;
  for (const [i, n] of Object.entries(e))
    n && typeof n == "object" && !Array.isArray(n) && t[i] && typeof t[i] == "object" ? Ke(t[i], n) : t[i] = n;
  return t;
}
function vt(t, e, i = Date.now()) {
  const n = Ke(Ee(t || he), Je(e));
  return e?.hikari && typeof e.hikari == "object" && e.hikari.updatedAt === void 0 && e.hikari.stale === void 0 && (n.hikari.updatedAt = i, n.hikari.stale = !1), n.revision = Math.max(Number(n.revision) || 0, Number(t?.revision) || 0) + 1, n.updatedAt = i, n;
}
const St = /* @__PURE__ */ new Set(["speaking", "listening", "thinking", "dragging", "directInteraction", "currentBehavior", "attentionTarget", "semanticReaction"]);
function Tt(t) {
  if (!t || typeof t != "object" || Array.isArray(t)) return {};
  const e = {};
  if (t.hikari && typeof t.hikari == "object" && !Array.isArray(t.hikari)) {
    e.hikari = {};
    for (const [i, n] of Object.entries(t.hikari))
      St.has(i) && (["speaking", "listening", "thinking", "dragging", "directInteraction"].includes(i) && typeof n == "boolean" ? e.hikari[i] = n : i === "currentBehavior" && typeof n == "string" ? e.hikari[i] = n.slice(0, 64) : i === "attentionTarget" && ["none", "user-pointer", "screen-center"].includes(n) ? e.hikari[i] = n : i === "semanticReaction" && (n === null || typeof n == "string") && (e.hikari[i] = typeof n == "string" ? n.slice(0, 64) : null));
    Object.keys(e.hikari).length || delete e.hikari;
  }
  return typeof t.audio?.microphone?.voiceActive == "boolean" && (e.audio = { microphone: { voiceActive: t.audio.microphone.voiceActive } }), e;
}
const At = he;
function Je(t, e = At) {
  if (!t || typeof t != "object" || Array.isArray(t)) return {};
  const i = {};
  for (const [n, s] of Object.entries(t)) {
    if (n === "__proto__" || n === "constructor" || n === "prototype" || !(n in e)) continue;
    const r = e[n];
    if (r && typeof r == "object" && !Array.isArray(r)) {
      s && typeof s == "object" && !Array.isArray(s) && (i[n] = Je(s, r));
      continue;
    }
    if (Array.isArray(r)) {
      Array.isArray(s) && (i[n] = s.slice(0, 50).map((a) => se(a)).filter((a) => a !== void 0));
      continue;
    }
    r === null ? s === null ? i[n] = null : typeof s == "string" ? i[n] = s.slice(0, 1e3) : typeof s == "number" && Number.isFinite(s) ? i[n] = s : s && typeof s == "object" && !Array.isArray(s) && (i[n] = se(s)) : typeof r == "number" ? typeof s == "number" && Number.isFinite(s) && (i[n] = s) : typeof r == "boolean" ? typeof s == "boolean" && (i[n] = s) : typeof r == "string" && typeof s == "string" && (i[n] = s.slice(0, 1e3));
  }
  return i;
}
function se(t, e = 0) {
  if (!(e > 4)) {
    if (t === null || typeof t == "boolean") return t;
    if (typeof t == "number") return Number.isFinite(t) ? t : void 0;
    if (typeof t == "string") return t.slice(0, 1e3);
    if (Array.isArray(t)) return t.slice(0, 50).map((i) => se(i, e + 1)).filter((i) => i !== void 0);
    if (t && typeof t == "object") {
      const i = {};
      for (const [n, s] of Object.entries(t).slice(0, 50)) {
        if (["__proto__", "constructor", "prototype"].includes(n)) continue;
        const r = se(s, e + 1);
        r !== void 0 && (i[n] = r);
      }
      return i;
    }
  }
}
function Ct(t, e = Date.now(), { screenSummaryMaxAgeMs: i = 12e4, screenChangeMaxAgeMs: n = 12e4, pointerMaxAgeMs: s = 2e3, activityMaxAgeMs: r = 3e3, contextMaxAgeMs: a = 5e3 } = {}) {
  const o = Ee(t || he), l = o.desktop?.activity;
  l && (l.idleForMs = l.lastInputAt ? Math.max(0, e - l.lastInputAt) : 0, l.stale = !l.updatedAt || e - l.updatedAt > r, l.stale && (l.typing = l.scrolling = l.clicking = !1)), o.desktop && (o.desktop.contextStale = !o.desktop.contextUpdatedAt || e - o.desktop.contextUpdatedAt > a);
  const u = o.desktop?.screen;
  u && (u.changeStale = !u.changeAt || e - u.changeAt > n, u.changeStale && (u.changeLevel = "unknown")), u?.summaryAt && e - u.summaryAt > i && (u.lastSummary = "", u.summaryAt = 0, u.summaryStale = !0, u.summaryContextKey = ""), u && !u.summaryAt && (u.summaryStale = !0);
  const c = o.desktop?.pointer;
  c && (!c.updatedAt || e - c.updatedAt > s) && (c.x = null, c.y = null, c.displayId = null, c.stale = !0);
  const h = o.audio?.system;
  h && (h.stale = !h.updatedAt || e - h.updatedAt > 15e3);
  const d = o.hikari;
  return d && (d.stale = !d.updatedAt || e - d.updatedAt > 6e4, d.stale && (d.speaking = d.listening = d.thinking = d.dragging = d.directInteraction = !1, d.semanticReaction = null, d.currentBehavior = "idle", d.attentionTarget = "none")), o.audio?.wake?.expiresAt && e >= o.audio.wake.expiresAt && (o.audio.wake = { active: !1, expiresAt: 0 }), o;
}
class It {
  constructor({ minimumIdleMs: e = 9e4, greetingCooldownMs: i = 3e5, now: n = () => Date.now() } = {}) {
    this.minimumIdleMs = Math.max(6e4, e), this.greetingCooldownMs = i, this.now = n, this.reset();
  }
  reset() {
    this.lastInputAt = this.now(), this.lastReturnAt = -1 / 0;
  }
  record(e, i = this.now()) {
    const n = Math.max(0, i - this.lastInputAt);
    return this.lastInputAt = i, n < this.minimumIdleMs || i - this.lastReturnAt < this.greetingCooldownMs ? null : (this.lastReturnAt = i, { idleDurationMs: n, inputType: e, resumedAt: i, eventCount: 1 });
  }
}
const Re = { low: 0, normal: 1, important: 2 }, Mt = 24, xt = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", kt = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", Et = /* @__PURE__ */ new Set([
  "com.apple.notificationcenterui",
  "com.apple.WindowManager",
  "com.apple.dock",
  "com.apple.controlcenter",
  "com.apple.systemuiserver"
]), we = Ve(Ge);
function q(t) {
  return typeof t == "string" ? t.trim() : "";
}
function Ye(t) {
  if (!t) return null;
  const e = Number(t.x), i = Number(t.y), n = Number(t.width), s = Number(t.height);
  return [e, i, n, s].every(Number.isFinite) ? { x: e, y: i, width: n, height: s } : null;
}
function Ne(t) {
  if (!t?.owner) return null;
  const e = Number(t.id);
  return {
    appName: q(t.owner.name) || "Unknown application",
    bundleId: q(t.owner.bundleId),
    windowTitle: q(t.title),
    windowId: Number.isFinite(e) ? e : null,
    processId: Number.isFinite(Number(t.owner.processId)) ? Number(t.owner.processId) : null,
    bounds: Ye(t.bounds)
  };
}
function Pt(t, e) {
  if (!t || q(t.windowTitle) || !e) return t;
  const i = q(e.name);
  return i ? { ...t, windowTitle: i } : t;
}
function re(t) {
  if (!t) return "";
  const e = t.bundleId || t.appName || "unknown", i = t.windowId ?? (t.windowTitle || "unknown");
  return `${e}:${i}`;
}
function ye(t, e) {
  return !!(t && e && re(t) === re(e));
}
function B(t) {
  return t ? {
    appName: t.appName,
    bundleId: t.bundleId,
    windowTitle: t.windowTitle
  } : null;
}
function _t(t) {
  const e = /^window:(\d+):/.exec(t || "");
  return e ? Number(e[1]) : null;
}
function D(t) {
  const e = t?.getSize?.();
  return e && e.width > 0 && e.height > 0 ? e : null;
}
function Rt(t, e, i) {
  return !t || t.isEmpty() ? null : t.resize({ width: e, height: i, quality: "good" });
}
function Le(t, e, i) {
  return !!(i && t >= i.x && e >= i.y && t < i.x + i.width && e < i.y + i.height);
}
function Nt(t, e, i = ke.screen) {
  const n = D(t?.image), s = D(e?.image);
  if (!n || !s || n.width !== s.width || n.height !== s.height)
    return null;
  const r = t.image.getBitmap(), a = e.image.getBitmap();
  if (r.length !== a.length) return null;
  const o = s.width, l = s.height, u = 2;
  let c = 0, h = 0;
  for (let m = 0; m < l; m += u)
    for (let A = 0; A < o; A += u) {
      if (Le(A, m, t.mask) || Le(A, m, e.mask)) continue;
      const C = (m * o + A) * 4, K = Math.abs(r[C] - a[C]), I = Math.abs(r[C + 1] - a[C + 1]), Z = Math.abs(r[C + 2] - a[C + 2]);
      Math.max(Z, I, K) >= Mt && (c += 1), h += 1;
    }
  if (h === 0) return null;
  const d = c / h;
  let f = "none";
  return d >= i.majorChangeThreshold ? f = "major" : d >= i.significantChangeThreshold ? f = "significant" : d >= i.minorChangeThreshold && (f = "minor"), {
    ratio: d,
    level: f,
    significant: d >= i.significantChangeThreshold
  };
}
function Y() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `awareness-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
class Lt {
  constructor({
    emitCandidate: e,
    getHikariBounds: i,
    config: n = ke,
    activeWindowProvider: s,
    openWindowsProvider: r,
    captureSourcesProvider: a,
    mediaPlaybackProvider: o
  } = {}) {
    this.config = n, this.emitCandidate = typeof e == "function" ? e : () => {
    }, this.getHikariBounds = typeof i == "function" ? i : () => null, this.activeWindowProvider = s || null, this.openWindowsProvider = r || null, this.captureSourcesProvider = a || ((l) => je.getSources(l)), this.mediaPlaybackProvider = o || null, this.mediaPlaybackTracker = new wt({
      debounceSamples: this.config.media?.debounceSamples
    }), this.enabled = !1, this.inputHook = null, this.currentContext = null, this.pendingContext = null, this.comparisonHistory = /* @__PURE__ */ new Map(), this.snapshots = /* @__PURE__ */ new Map(), this.lastDirectInteractionAt = 0, this.lastCandidateAt = 0, this.pendingCandidate = null, this.observationChain = Promise.resolve(), this.typingSession = null, this.scrollSession = null, this.clickSession = null, this.contextTimer = null, this.contextSettleTimer = null, this.pendingCandidateTimer = null, this.mediaPlaybackTimer = null, this.mediaPlaybackPollRunning = !1, this.lastInputAt = 0, this.idleReturnTracker = new It(this.config.idleReturn), this.status = {
      enabled: !1,
      inputMonitoringAvailable: !1,
      screenCaptureAvailable: !1,
      screenCaptureStatus: process.platform === "darwin" ? "unknown" : "granted",
      activeWindowAvailable: !1,
      mediaPlaybackAvailable: !1,
      errors: {}
    }, this.handleKeydown = () => this.recordKeyboardActivity(), this.handleMousedown = () => this.recordClickActivity(), this.handleWheel = () => this.recordWheelActivity();
  }
  debug(e, i, n) {
    this.config.debug && (n === void 0 ? console.info(`[AWARENESS ${e}] ${i}`) : console.info(`[AWARENESS ${e}] ${i}`, n));
  }
  getStatus() {
    return {
      ...this.status,
      errors: { ...this.status.errors }
    };
  }
  getActivityState(e = Date.now()) {
    return bt(this, e);
  }
  async getGreetingContext() {
    const e = (async () => {
      this.activeWindowProvider || await this.initializeActiveWindowProvider();
      const r = await this.getActiveContext();
      let a = r && !this.isHikariContext(r) ? r : this.currentContext;
      if (!a && this.openWindowsProvider) {
        const o = await this.openWindowsProvider();
        a = (Array.isArray(o) ? o : []).map(Ne).find((l) => l && !this.isHikariContext(l) && !Et.has(l.bundleId)) || null;
      }
      return B(a);
    })().catch((r) => (this.debug("GREETING", "foreground context unavailable", r?.message || r), null)), i = (async () => {
      if (!this.ensureMediaPlaybackProvider()) return null;
      const r = await this.mediaPlaybackProvider();
      return typeof r == "boolean" ? r ? "playing" : "stopped" : null;
    })().catch((r) => (this.debug("GREETING", "media context unavailable", r?.message || r), null)), [n, s] = await Promise.all([
      e,
      i
    ]);
    return { activeWindow: n, mediaPlaybackState: s };
  }
  async setEnabled(e) {
    return e ? await this.start() : this.stop(), this.getStatus();
  }
  async start() {
    return this.enabled ? this.getStatus() : (this.enabled = !0, this.status.enabled = !0, this.status.errors = {}, this.idleReturnTracker.reset(), this.refreshScreenCaptureStatus(), await this.initializeActiveWindowProvider(), await this.initializeInputMonitoring(), await this.initializeContextAndBaseline(), this.initializeMediaPlaybackMonitoring(), this.debug("STATUS", "desktop awareness enabled", this.getStatus()), this.getStatus());
  }
  stop() {
    for (const e of [this.typingSession, this.scrollSession, this.clickSession])
      e?.timer && clearTimeout(e.timer);
    if (this.inputHook) {
      this.inputHook.removeListener("keydown", this.handleKeydown), this.inputHook.removeListener("mousedown", this.handleMousedown), this.inputHook.removeListener("wheel", this.handleWheel);
      try {
        this.inputHook.stop();
      } catch (e) {
        this.debug("STATUS", "input hook stop failed", e?.message || e);
      }
    }
    this.enabled = !1, this.status.enabled = !1, this.inputHook = null, this.currentContext = null, this.pendingContext = null, this.typingSession = null, this.scrollSession = null, this.clickSession = null, this.pendingCandidate = null, this.mediaPlaybackTracker.reset(), this.mediaPlaybackPollRunning = !1, this.comparisonHistory.clear();
    for (const e of this.snapshots.keys()) this.deleteSnapshot(e);
    for (const e of [this.contextTimer, this.contextSettleTimer, this.pendingCandidateTimer, this.mediaPlaybackTimer])
      e && clearTimeout(e);
    this.contextTimer = null, this.contextSettleTimer = null, this.pendingCandidateTimer = null, this.mediaPlaybackTimer = null, this.debug("STATUS", "desktop awareness disabled");
  }
  noteDirectInteraction() {
    this.lastDirectInteractionAt = Date.now(), this.pendingCandidate = null, this.pendingCandidateTimer && clearTimeout(this.pendingCandidateTimer), this.pendingCandidateTimer = null, this.debug("POLICY", "direct Hikari interaction suppression started");
  }
  refreshScreenCaptureStatus() {
    if (process.platform !== "darwin") {
      this.status.screenCaptureAvailable = !0, this.status.screenCaptureStatus = "granted", delete this.status.errors.screenCapture;
      return;
    }
    try {
      const e = j.getMediaAccessStatus("screen");
      this.status.screenCaptureStatus = e, this.status.screenCaptureAvailable = e === "granted", this.status.screenCaptureAvailable ? delete this.status.errors.screenCapture : this.status.errors.screenCapture = e;
    } catch (e) {
      this.status.screenCaptureAvailable = !1, this.status.screenCaptureStatus = "unknown", this.status.errors.screenCapture = e?.message || String(e);
    }
  }
  refreshInputMonitoringStatus() {
    if (this.inputHook)
      return this.status.inputMonitoringAvailable = !0, delete this.status.errors.inputMonitoring, !0;
    if (process.platform !== "darwin") return this.status.inputMonitoringAvailable;
    const e = j.isTrustedAccessibilityClient(!1);
    return this.status.inputMonitoringAvailable = !1, this.status.errors.inputMonitoring = e ? "Keyboard monitor is not running." : "Accessibility permission is denied.", e;
  }
  async refreshPermissionStatus() {
    this.refreshScreenCaptureStatus();
    const e = this.refreshInputMonitoringStatus();
    return this.enabled && e && !this.inputHook && await this.initializeInputMonitoring(), this.getStatus();
  }
  /**
   * macOS does not expose an Electron API that can grant Screen Recording
   * permission. The supported flow is to open Apple's Privacy pane and let
   * the user grant access, then refresh the status when they return.
   */
  async requestScreenCapturePermission() {
    this.refreshScreenCaptureStatus();
    let e = !1, i = null, n = !1;
    if (process.platform === "darwin" && !this.status.screenCaptureAvailable) {
      n = !0;
      try {
        await this.captureSourcesProvider({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: !1
        }), delete this.status.errors.screenCaptureProbe;
      } catch (s) {
        this.status.errors.screenCaptureProbe = s?.message || String(s), this.debug("SCREEN", "permission probe failed", this.status.errors.screenCaptureProbe);
      }
      this.refreshScreenCaptureStatus();
    }
    if (process.platform === "darwin" && !this.status.screenCaptureAvailable)
      try {
        await Te.openExternal(xt), e = !0;
      } catch (s) {
        i = s?.message || String(s), this.status.errors.screenCaptureSettings = i;
      }
    return this.refreshScreenCaptureStatus(), {
      ...this.getStatus(),
      settingsOpened: e,
      permissionKind: "screen",
      probeAttempted: n,
      requiresUserAction: process.platform === "darwin" && !this.status.screenCaptureAvailable,
      error: i
    };
  }
  async requestInputMonitoringPermission() {
    let e = !1, i = !1, n = null;
    if (process.platform === "darwin" && !this.inputHook && (i = !0, j.isTrustedAccessibilityClient(!0) && await this.initializeInputMonitoring()), process.platform === "darwin" && !this.status.inputMonitoringAvailable)
      try {
        await Te.openExternal(kt), e = !0;
      } catch (s) {
        n = s?.message || String(s), this.status.errors.inputMonitoringSettings = n;
      }
    return this.refreshInputMonitoringStatus(), {
      ...this.getStatus(),
      settingsOpened: e,
      permissionKind: "inputMonitoring",
      promptAttempted: i,
      requiresUserAction: process.platform === "darwin" && !this.status.inputMonitoringAvailable,
      error: n
    };
  }
  async initializeActiveWindowProvider() {
    if (this.activeWindowProvider) {
      this.status.activeWindowAvailable = !0;
      return;
    }
    try {
      if (process.platform === "darwin" && v.isPackaged) {
        const n = _.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "get-windows",
          "main"
        );
        this.activeWindowProvider = async () => {
          const s = ["--no-accessibility-permission", "--no-screen-recording-permission"], { stdout: r } = await we(n, s, { encoding: "utf8" });
          return JSON.parse(r);
        }, this.openWindowsProvider = async () => {
          const s = [
            "--no-accessibility-permission",
            "--no-screen-recording-permission",
            "--open-windows-list"
          ], { stdout: r } = await we(n, s, { encoding: "utf8" });
          return JSON.parse(r);
        }, this.status.activeWindowAvailable = !0;
        return;
      }
      const { activeWindow: e, openWindows: i } = await import("./index-imCoeF09.js");
      this.activeWindowProvider = () => e(_e), this.openWindowsProvider = () => i(_e), this.status.activeWindowAvailable = !0;
    } catch (e) {
      this.status.activeWindowAvailable = !1, this.status.errors.activeWindow = e?.message || String(e), this.debug("STATUS", "active-window support unavailable", this.status.errors.activeWindow);
    }
  }
  async initializeInputMonitoring() {
    if (this.inputHook) {
      this.status.inputMonitoringAvailable = !0, delete this.status.errors.inputMonitoring;
      return;
    }
    if (process.platform === "darwin" && !j.isTrustedAccessibilityClient(!1)) {
      this.status.inputMonitoringAvailable = !1, this.status.errors.inputMonitoring = "Accessibility permission is denied.";
      return;
    }
    try {
      const { uIOhook: e } = await import("./index-BIO8bREU.js").then((i) => i.i);
      this.inputHook = e, e.on("keydown", this.handleKeydown), e.on("mousedown", this.handleMousedown), e.on("wheel", this.handleWheel), e.start(), this.status.inputMonitoringAvailable = !0, delete this.status.errors.inputMonitoring;
    } catch (e) {
      this.inputHook && (this.inputHook.removeListener("keydown", this.handleKeydown), this.inputHook.removeListener("mousedown", this.handleMousedown), this.inputHook.removeListener("wheel", this.handleWheel)), this.inputHook = null, this.status.inputMonitoringAvailable = !1, this.status.errors.inputMonitoring = e?.message || String(e), this.debug("STATUS", "global input monitoring unavailable", this.status.errors.inputMonitoring);
    }
  }
  initializeMediaPlaybackMonitoring() {
    this.ensureMediaPlaybackProvider() && this.pollMediaPlayback();
  }
  ensureMediaPlaybackProvider() {
    if (process.platform !== "darwin")
      return this.status.mediaPlaybackAvailable = !1, this.status.errors.mediaPlayback = "System audio activity detection is currently available on macOS only.", !1;
    if (!this.mediaPlaybackProvider) {
      const i = (v.isPackaged ? [_.join(process.resourcesPath, "media-state", "media-state")] : [
        _.join(v.getAppPath(), "tools", "media-state", "media-state"),
        _.resolve(process.cwd(), "tools", "media-state", "media-state")
      ]).find((n) => de(n));
      if (!i)
        return this.status.mediaPlaybackAvailable = !1, this.status.errors.mediaPlayback = "Media-state helper is missing. Run npm run build.", !1;
      this.mediaPlaybackProvider = async () => {
        const { stdout: n } = await we(i, [], {
          encoding: "utf8",
          timeout: Math.max(1e3, this.config.media.pollIntervalMs)
        }), s = mt(n);
        if (s === null) throw new Error("Media-state helper returned an invalid result.");
        return s;
      };
    }
    return this.status.mediaPlaybackAvailable = !0, delete this.status.errors.mediaPlayback, !0;
  }
  async pollMediaPlayback() {
    if (!(!this.enabled || !this.mediaPlaybackProvider || this.mediaPlaybackPollRunning)) {
      this.mediaPlaybackPollRunning = !0;
      try {
        const e = await this.mediaPlaybackProvider();
        if (!this.enabled) return;
        if (this.status.mediaPlaybackAvailable = typeof e == "boolean", !this.status.mediaPlaybackAvailable) throw new Error("Media playback state was unavailable.");
        delete this.status.errors.mediaPlayback;
        const i = this.mediaPlaybackTracker.observe(e);
        i && await this.handleMediaPlaybackTransition(i);
      } catch (e) {
        this.status.mediaPlaybackAvailable = !1, this.status.errors.mediaPlayback = e?.message || String(e), this.debug("MEDIA", "playback-state query failed", this.status.errors.mediaPlayback);
      } finally {
        this.mediaPlaybackPollRunning = !1, this.enabled && (this.mediaPlaybackTimer = setTimeout(
          () => this.pollMediaPlayback(),
          this.config.media.pollIntervalMs
        ));
      }
    }
  }
  async handleMediaPlaybackTransition(e) {
    let i = await this.getActiveContext();
    (!i || this.isHikariContext(i)) && (i = this.currentContext);
    const n = e.state === "playing", s = {
      id: Y(),
      timestamp: Date.now(),
      trigger: n ? "media_playback_started" : "media_playback_stopped",
      activity: {},
      media: {
        ...e,
        source: "system_audio_output"
      },
      context: B(i),
      visualChange: null,
      priority: n ? "important" : "low"
    };
    this.debug("MEDIA", `${e.previousState} -> ${e.state}`), this.offerCandidate(s, null);
  }
  async initializeContextAndBaseline() {
    const e = await this.getActiveContext();
    if (!e || this.isHikariContext(e)) return;
    const i = await this.captureContext(e), n = i?.context || e;
    this.currentContext = n, i?.comparison && this.rememberComparison(n, i.comparison), this.debug("CONTEXT", `${n.appName} / ${n.windowTitle || "(untitled window)"}`);
  }
  isHikariContext(e) {
    return e?.processId === process.pid || e?.bundleId === "com.electron.hikari";
  }
  isDirectInteractionSuppressed(e = Date.now()) {
    return e - this.lastDirectInteractionAt < this.config.hikariInteraction.suppressionMs;
  }
  recordInputActivity(e, i) {
    this.lastInputAt = i;
    const n = this.idleReturnTracker.record(e, i);
    n && this.observeIdleReturn(n).catch((s) => this.debug("IDLE", "return context unavailable", s?.message || s));
  }
  async observeIdleReturn(e) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    const i = await this.getActiveContext();
    !this.enabled || this.isHikariContext(i) || this.offerCandidate({
      id: Y(),
      timestamp: e.resumedAt,
      trigger: "idle_return",
      activity: e,
      context: B(i || this.currentContext),
      visualChange: null,
      priority: "important"
    }, null);
  }
  recordKeyboardActivity() {
    if (!this.enabled) return;
    const e = Date.now();
    this.recordInputActivity("typing", e), this.debug("RAW", "keyboard activity"), this.scheduleContextInspection(), this.typingSession || (this.typingSession = { startedAt: e, lastAt: e, count: 0, timer: null }), this.typingSession.lastAt = e, this.typingSession.count += 1, this.typingSession.timer && clearTimeout(this.typingSession.timer), this.typingSession.timer = setTimeout(() => this.endTypingSession(), this.config.activity.typingPauseMs);
  }
  endTypingSession() {
    const e = this.typingSession;
    if (this.typingSession = null, !e || e.count < this.config.activity.minimumTypingKeys) {
      this.debug("SESSION", "typing session rejected: too few keys", e?.count || 0);
      return;
    }
    const i = {
      durationMs: Math.max(0, e.lastAt - e.startedAt),
      eventCount: e.count
    };
    this.debug("SESSION", "typing session ended", i), this.queueObservation("typing_session_end", i);
  }
  recordWheelActivity() {
    if (!this.enabled) return;
    const e = Date.now();
    this.recordInputActivity("scrolling", e), this.debug("RAW", "wheel activity"), this.scheduleContextInspection(), this.scrollSession || (this.scrollSession = { startedAt: e, lastAt: e, count: 0, timer: null }), this.scrollSession.lastAt = e, this.scrollSession.count += 1, this.scrollSession.timer && clearTimeout(this.scrollSession.timer), this.scrollSession.timer = setTimeout(() => this.endScrollSession(), this.config.activity.scrollPauseMs);
  }
  endScrollSession() {
    const e = this.scrollSession;
    if (this.scrollSession = null, !e || e.count < this.config.activity.minimumWheelEvents) {
      this.debug("SESSION", "scroll session rejected: too few wheel events", e?.count || 0);
      return;
    }
    const i = {
      durationMs: Math.max(0, e.lastAt - e.startedAt),
      eventCount: e.count
    };
    this.debug("SESSION", "scroll session ended", i), this.queueObservation("scroll_session_end", i);
  }
  recordClickActivity() {
    if (!this.enabled) return;
    const e = Date.now();
    this.recordInputActivity("clicking", e), this.debug("RAW", "mouse click activity"), this.scheduleContextInspection(), this.clickSession || (this.clickSession = { startedAt: e, lastAt: e, count: 0, timer: null }), this.clickSession.lastAt = e, this.clickSession.count += 1, this.clickSession.timer && clearTimeout(this.clickSession.timer), this.clickSession.timer = setTimeout(() => this.endClickSession(), this.config.activity.clickObservationDelayMs);
  }
  endClickSession() {
    const e = this.clickSession;
    if (this.clickSession = null, !e) return;
    const i = {
      durationMs: Math.max(0, e.lastAt - e.startedAt),
      eventCount: e.count
    };
    this.debug("SESSION", "click activity settled", i), this.queueObservation("click_caused_screen_change", i);
  }
  scheduleContextInspection() {
    this.contextTimer && clearTimeout(this.contextTimer), this.contextTimer = setTimeout(
      () => this.inspectPossibleContextChange(),
      this.config.screen.stableWindowDebounceMs
    );
  }
  async inspectPossibleContextChange() {
    if (this.contextTimer = null, !this.enabled || this.isDirectInteractionSuppressed()) return;
    const e = await this.getActiveContext();
    !e || this.isHikariContext(e) || ye(e, this.currentContext) || (this.pendingContext = e, this.contextSettleTimer && clearTimeout(this.contextSettleTimer), this.contextSettleTimer = setTimeout(
      () => this.commitStableContextChange(),
      this.config.screen.stableWindowDebounceMs
    ));
  }
  async commitStableContextChange() {
    if (this.contextSettleTimer = null, !this.enabled || !this.pendingContext || this.isDirectInteractionSuppressed()) return;
    const e = await this.getActiveContext();
    if (!e || this.isHikariContext(e) || !ye(e, this.pendingContext)) return;
    const i = this.currentContext;
    this.pendingContext = null;
    const n = await this.captureContext(e), s = n?.context || e;
    this.currentContext = s, n?.comparison && this.rememberComparison(s, n.comparison);
    const r = !!(i && (i.bundleId || i.appName) !== (s.bundleId || s.appName)), a = r ? "application_changed" : "window_changed";
    this.debug("CONTEXT", `${s.appName} / ${s.windowTitle || "(untitled window)"}`), this.offerCandidate({
      id: Y(),
      timestamp: Date.now(),
      trigger: a,
      activity: r ? { fromApp: i?.appName || null, toApp: s.appName } : { fromWindow: i?.windowTitle || null, toWindow: s.windowTitle },
      context: B(s),
      visualChange: null,
      priority: "normal"
    }, n?.semantic);
  }
  queueObservation(e, i) {
    this.observationChain = this.observationChain.catch((n) => this.debug("ERROR", "previous observation failed", n?.message || n)).then(() => this.observeSession(e, i));
  }
  async observeSession(e, i) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) {
      this.debug("POLICY", `${e} dropped: direct interaction or awareness disabled`);
      return;
    }
    const n = await this.getActiveContext();
    if (!n || this.isHikariContext(n)) return;
    if (!ye(n, this.currentContext)) {
      this.scheduleContextInspection(), this.debug("POLICY", `${e} deferred: context is changing`);
      return;
    }
    const s = await this.captureContext(n), r = s?.context || n;
    if (this.currentContext = r, !s?.comparison) {
      if (!this.status.screenCaptureAvailable && e !== "click_caused_screen_change") {
        const d = e === "scroll_session_end" ? "low" : "normal";
        this.debug("SCREEN", `${e} continuing without screenshot permission`), this.offerCandidate({
          id: Y(),
          timestamp: Date.now(),
          trigger: e,
          activity: i,
          context: B(r),
          visualChange: null,
          priority: d
        }, null);
      } else
        this.debug("SCREEN", `${e} rejected: screenshot unavailable`);
      return;
    }
    const a = re(r), o = this.comparisonHistory.get(a);
    if (this.rememberComparison(r, s.comparison), !o) {
      this.debug("SCREEN", `${e} established comparison baseline`);
      return;
    }
    const l = Nt(o, s.comparison, this.config.screen);
    if (!l) return;
    this.debug("SCREEN", `change: ${(l.ratio * 100).toFixed(1)}%`, l.level);
    const u = e === "typing_session_end" ? this.config.screen.typingChangeThreshold : e === "scroll_session_end" ? this.config.screen.minorChangeThreshold : this.config.screen.significantChangeThreshold;
    if (l.ratio < u) {
      this.debug("CANDIDATE", `${e} rejected: visual change below threshold`);
      return;
    }
    let c = e === "scroll_session_end" ? l.ratio >= this.config.screen.significantChangeThreshold ? "normal" : "low" : "normal";
    l.ratio >= this.config.screen.majorChangeThreshold && (c = "important");
    const h = {
      id: Y(),
      timestamp: Date.now(),
      trigger: e,
      activity: i,
      context: B(r),
      visualChange: {
        ratio: l.ratio,
        level: l.level
      },
      priority: c
    };
    this.offerCandidate(h, s.semantic);
  }
  async getActiveContext() {
    if (!this.activeWindowProvider) return null;
    try {
      const e = await this.activeWindowProvider(), i = Ne(e);
      return this.status.activeWindowAvailable = !!i, i && delete this.status.errors.activeWindow, i;
    } catch (e) {
      return this.status.activeWindowAvailable = !1, this.status.errors.activeWindow = e?.message || String(e), this.debug("CONTEXT", "active-window query failed", this.status.errors.activeWindow), null;
    }
  }
  async captureContext(e) {
    if (this.refreshScreenCaptureStatus(), !this.status.screenCaptureAvailable) return null;
    const i = this.config.screen.semanticSnapshotWidth, n = e.bounds?.width && e.bounds?.height ? e.bounds.width / e.bounds.height : 16 / 9, s = Math.max(1, Math.round(i / n));
    try {
      const r = await this.captureSourcesProvider({
        types: ["window"],
        thumbnailSize: { width: i, height: s },
        fetchWindowIcons: !1
      }), a = e.windowId == null ? null : r.find((m) => _t(m.id) === e.windowId), o = a ? Pt(e, a) : e, l = r.find((m) => e.windowTitle && q(m.name) === e.windowTitle), u = a || l;
      if (u?.thumbnail && !u.thumbnail.isEmpty()) {
        const m = this.prepareCapture(u.thumbnail, null);
        return m ? { ...m, context: o } : null;
      }
      const c = e.bounds ? U.getDisplayMatching(e.bounds) : U.getPrimaryDisplay(), h = await this.captureSourcesProvider({
        types: ["screen"],
        thumbnailSize: {
          width: Math.max(1, Math.round(c.size.width * Math.min(1, i / c.size.width))),
          height: Math.max(1, Math.round(c.size.height * Math.min(1, i / c.size.width)))
        },
        fetchWindowIcons: !1
      }), d = h.find((m) => String(m.display_id) === String(c.id)) || h[0];
      if (!d?.thumbnail || d.thumbnail.isEmpty()) return null;
      const f = this.prepareCapture(d.thumbnail, this.getDisplayMask(c, d.thumbnail));
      return f ? { ...f, context: o } : null;
    } catch (r) {
      return this.status.screenCaptureAvailable = !1, this.status.errors.screenCapture = r?.message || String(r), this.debug("SCREEN", "capture failed", this.status.errors.screenCapture), null;
    }
  }
  prepareCapture(e, i) {
    const n = Rt(
      e,
      this.config.screen.comparisonWidth,
      this.config.screen.comparisonHeight
    );
    if (!n) return null;
    const s = D(e), r = i && s ? {
      x: Math.floor(i.x * this.config.screen.comparisonWidth / s.width),
      y: Math.floor(i.y * this.config.screen.comparisonHeight / s.height),
      width: Math.ceil(i.width * this.config.screen.comparisonWidth / s.width),
      height: Math.ceil(i.height * this.config.screen.comparisonHeight / s.height)
    } : null;
    return {
      comparison: { image: n, mask: r },
      semantic: i ? Dt(e, i) : e
    };
  }
  getDisplayMask(e, i) {
    const n = Ye(this.getHikariBounds()), s = D(i);
    if (!n || !s || !e?.bounds) return null;
    const r = n.x - e.bounds.x, a = n.y - e.bounds.y;
    return {
      x: Math.floor(r * s.width / e.bounds.width),
      y: Math.floor(a * s.height / e.bounds.height),
      width: Math.ceil(n.width * s.width / e.bounds.width),
      height: Math.ceil(n.height * s.height / e.bounds.height)
    };
  }
  rememberComparison(e, i) {
    const n = re(e);
    for (this.comparisonHistory.delete(n), this.comparisonHistory.set(n, i); this.comparisonHistory.size > this.config.memory.recentCandidateLimit; )
      this.comparisonHistory.delete(this.comparisonHistory.keys().next().value);
  }
  offerCandidate(e, i) {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return;
    if (this.pruneSnapshots(), i && !i.isEmpty()) {
      const r = e.timestamp + this.config.observation.candidateMaxAgeMs;
      this.snapshots.set(e.id, {
        image: i,
        expiresAt: r,
        timer: setTimeout(() => this.deleteSnapshot(e.id), Math.max(0, r - Date.now()))
      });
    }
    const n = Date.now(), s = this.config.observation.minimumCandidateIntervalMs - (n - this.lastCandidateAt);
    if (s <= 0) {
      let r = e;
      this.pendingCandidate && (this.shouldReplaceCandidate(this.pendingCandidate, e) ? this.deleteSnapshot(this.pendingCandidate.id) : (r = this.pendingCandidate, this.deleteSnapshot(e.id)), this.pendingCandidate = null, this.pendingCandidateTimer && clearTimeout(this.pendingCandidateTimer), this.pendingCandidateTimer = null), this.emitNow(r);
      return;
    }
    !this.pendingCandidate || this.shouldReplaceCandidate(this.pendingCandidate, e) ? (this.pendingCandidate && this.deleteSnapshot(this.pendingCandidate.id), this.pendingCandidate = e) : this.deleteSnapshot(e.id), this.pendingCandidateTimer || (this.pendingCandidateTimer = setTimeout(() => {
      this.pendingCandidateTimer = null;
      const r = this.pendingCandidate;
      this.pendingCandidate = null, r && Date.now() - r.timestamp <= this.config.observation.candidateMaxAgeMs && this.emitNow(r);
    }, s));
  }
  shouldReplaceCandidate(e, i) {
    const n = Re[e.priority] ?? 0, s = Re[i.priority] ?? 0;
    return s > n || s === n && i.timestamp >= e.timestamp;
  }
  emitNow(e) {
    this.enabled && (this.lastCandidateAt = Date.now(), this.debug("CANDIDATE", "accepted", e), this.emitCandidate(e));
  }
  async captureScreen() {
    if (!this.enabled || this.isDirectInteractionSuppressed()) return null;
    let e = await this.getActiveContext();
    if ((!e || this.isHikariContext(e)) && (e = this.currentContext), !this.enabled || this.isDirectInteractionSuppressed() || !e || this.isHikariContext(e)) return null;
    let i, n;
    try {
      n = await Promise.race([
        this.captureContext(e),
        new Promise((o) => {
          i = setTimeout(() => o(null), 15e3);
        })
      ]);
    } finally {
      clearTimeout(i);
    }
    if (!this.enabled || this.isDirectInteractionSuppressed() || !n?.semantic) return null;
    let s = n.semantic, r = D(s);
    if (!r) return null;
    if (Math.max(r.width, r.height) > 1920) {
      const o = 1920 / Math.max(r.width, r.height);
      s = s.resize({ width: Math.max(1, Math.round(r.width * o)), height: Math.max(1, Math.round(r.height * o)), quality: "good" }), r = D(s);
    }
    let a;
    for (const o of [this.config.screen.semanticSnapshotJpegQuality || 72, 50, 35])
      if (a = s.toJPEG(o), a.length <= ne) break;
    return !a?.length || a.length > ne || !r ? null : {
      mimeType: "image/jpeg",
      width: r.width,
      height: r.height,
      capturedAt: Date.now(),
      context: B(n.context || e),
      dataUrl: `data:image/jpeg;base64,${a.toString("base64")}`
    };
  }
  requestSnapshot(e) {
    this.pruneSnapshots();
    const i = this.snapshots.get(e);
    if (!i) return null;
    this.deleteSnapshot(e);
    const n = D(i.image);
    if (!n) return null;
    const s = this.config.screen.semanticSnapshotJpegQuality || 72, r = i.image.toJPEG(s);
    return {
      candidateId: e,
      mimeType: "image/jpeg",
      width: n.width,
      height: n.height,
      dataUrl: `data:image/jpeg;base64,${r.toString("base64")}`
    };
  }
  pruneSnapshots() {
    const e = Date.now();
    for (const [i, n] of this.snapshots)
      n.expiresAt <= e && this.deleteSnapshot(i);
    for (; this.snapshots.size > this.config.memory.recentCandidateLimit; )
      this.deleteSnapshot(this.snapshots.keys().next().value);
  }
  deleteSnapshot(e) {
    const i = this.snapshots.get(e);
    i?.timer && clearTimeout(i.timer), this.snapshots.delete(e);
  }
}
function Dt(t, e) {
  const i = D(t);
  if (!i || !e) return t;
  const n = Buffer.from(t.getBitmap());
  for (let s = Math.max(0, e.y); s < Math.min(i.height, e.y + e.height); s += 1)
    for (let r = Math.max(0, e.x); r < Math.min(i.width, e.x + e.width); r += 1) {
      const a = (s * i.width + r) * 4;
      n[a] = 0, n[a + 1] = 0, n[a + 2] = 0, n[a + 3] = 255;
    }
  return ct.createFromBitmap(n, { width: i.width, height: i.height });
}
const X = "http://127.0.0.1:8010", Ot = 24e4, Wt = 3e3, Ut = 185e3, Bt = 32 * 1024 * 1024, Ht = "/opt/homebrew/bin/python3.11", zt = "/health", be = _.dirname(pt(import.meta.url));
function Ft() {
  const t = [
    _.resolve(be, "../tools/companion-tts"),
    _.resolve(be, "../../tools/companion-tts"),
    _.resolve(be, "../../../tools/companion-tts")
  ];
  return t.find((e) => de(_.join(e, "tts.py"))) ?? t[0];
}
function $() {
  const t = new Error("Local TTS service was disposed");
  return t.name = "AbortError", t;
}
function ae(t, e) {
  return e.aborted ? Promise.reject($()) : new Promise((i, n) => {
    const s = () => n($());
    e.addEventListener("abort", s, { once: !0 }), Promise.resolve(t).then(i, n).finally(() => {
      e.removeEventListener("abort", s);
    });
  });
}
function ve(t) {
  return typeof t?.ok == "boolean" ? t.ok : Number.isInteger(t?.status) && t.status >= 200 && t.status < 300;
}
async function Xe(t, e, i) {
  const n = Number(t.headers?.get?.("content-length"));
  if (Number.isFinite(n) && n > e)
    throw new Error("Local TTS response exceeded the allowed size");
  if (!t.body?.getReader) {
    const c = new Uint8Array(await ae(t.arrayBuffer(), i));
    if (c.byteLength > e) throw new Error("Local TTS response exceeded the allowed size");
    return c;
  }
  const s = t.body.getReader(), r = [];
  let a = 0;
  const o = () => {
    s.cancel().catch(() => {
    });
  };
  i.addEventListener("abort", o, { once: !0 });
  try {
    for (; ; ) {
      const { done: c, value: h } = await ae(s.read(), i);
      if (c) break;
      if (a += h.byteLength, a > e)
        throw o(), new Error("Local TTS response exceeded the allowed size");
      r.push(h);
    }
  } finally {
    i.removeEventListener("abort", o);
    try {
      s.releaseLock();
    } catch {
    }
  }
  const l = new Uint8Array(a);
  let u = 0;
  for (const c of r)
    l.set(c, u), u += c.byteLength;
  return l;
}
async function De(t, e) {
  const i = await Xe(t, 65536, e);
  try {
    return JSON.parse(new TextDecoder().decode(i));
  } catch {
    throw new Error("Local TTS adapter returned invalid JSON");
  }
}
function jt(t) {
  if (!t || typeof t != "object")
    throw new TypeError("Synthesis request must be an object");
  if (typeof t.text != "string")
    throw new TypeError("Synthesis text must be a string");
  const e = t.text.trim(), i = Array.from(e).length;
  if (i < 1 || i > 500)
    throw new RangeError("Synthesis text must contain 1 to 500 characters");
  const n = t.speed;
  if (typeof n != "number" || !Number.isFinite(n) || n < 0.5 || n > 2)
    throw new RangeError("Synthesis speed must be between 0.5 and 2");
  return { text: e, speed: n };
}
function $t(t) {
  if (!t || typeof t != "object" || Array.isArray(t))
    throw new Error("Local TTS adapter returned invalid speech metadata");
  const { audio_url: e, duration_seconds: i, sample_rate: n, channels: s, voice: r } = t;
  if (typeof e != "string" || !/^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(e) || typeof i != "number" || !Number.isFinite(i) || i <= 0 || i > 600 || !Number.isInteger(n) || n < 8e3 || n > 192e3 || !Number.isInteger(s) || s < 1 || s > 2 || r !== "custom_voice")
    throw new Error("Local TTS adapter returned invalid speech metadata");
  const a = new URL(e, X);
  if (a.origin !== X || a.pathname !== e || a.search || a.hash)
    throw new Error("Local TTS adapter returned an unsafe audio path");
  return { audioUrl: e, durationSeconds: i, sampleRate: n, channels: s, voice: r };
}
function qt(t, e, i) {
  if (t.byteLength < 44 || String.fromCharCode(...t.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...t.subarray(8, 12)) !== "WAVE")
    throw new Error("Local TTS adapter returned invalid WAV audio");
  const n = new DataView(t.buffer, t.byteOffset, t.byteLength);
  if (n.getUint32(4, !0) + 8 !== t.byteLength)
    throw new Error("Local TTS adapter returned invalid WAV audio");
  let s = 12, r = !1, a = !1;
  for (; s + 8 <= t.byteLength; ) {
    const o = String.fromCharCode(...t.subarray(s, s + 4)), l = n.getUint32(s + 4, !0), u = s + 8, c = u + l;
    if (c > t.byteLength) throw new Error("Local TTS adapter returned invalid WAV audio");
    if (o === "fmt ") {
      if (l < 16) throw new Error("Local TTS adapter returned invalid WAV audio");
      const h = n.getUint16(u + 2, !0), d = n.getUint32(u + 4, !0);
      if (h !== i || d !== e)
        throw new Error("Local TTS metadata did not match its WAV audio");
      r = !0;
    } else o === "data" && (a = !0);
    s = c + l % 2;
  }
  if (s !== t.byteLength || !r || !a)
    throw new Error("Local TTS adapter returned invalid WAV audio");
}
function Gt(t = {}) {
  const e = t.fetch ?? t.fetchImpl ?? globalThis.fetch, i = t.spawn ?? xe, n = t.toolDir ?? Ft(), s = t.pythonPath ?? process.env.HIKARI_TTS_PYTHON ?? Ht, r = t.synthesisTimeoutMs ?? t.requestTimeoutMs ?? Ut, a = t.healthTimeoutMs ?? Wt, o = t.startupTimeoutMs ?? Ot, l = t.pollIntervalMs ?? 500, u = t.maxAudioBytes ?? Bt;
  for (const [g, w] of Object.entries({ requestTimeoutMs: r, healthTimeoutMs: a, startupTimeoutMs: o, pollIntervalMs: l, maxAudioBytes: u }))
    if (!Number.isFinite(w) || w <= 0) throw new RangeError(`${g} must be a positive number`);
  if (typeof e != "function") throw new TypeError("A fetch implementation is required");
  if (typeof i != "function") throw new TypeError("A spawn implementation is required");
  let c = !1, h = null, d = Promise.resolve(), f = null;
  const m = /* @__PURE__ */ new Set(), A = /* @__PURE__ */ new Set();
  let C;
  const K = new Promise((g) => {
    C = g;
  });
  function I() {
    if (c) throw $();
  }
  function Z(g) {
    return Promise.race([
      g,
      K.then(() => {
        throw $();
      })
    ]);
  }
  async function fe(g, w, b, E = r) {
    I();
    const N = new AbortController();
    m.add(N);
    let L = !1;
    const J = setTimeout(() => {
      L = !0, N.abort();
    }, E);
    try {
      const z = await ae(e(g, { ...w, signal: N.signal }), N.signal);
      return I(), await ae(b(z, N.signal), N.signal);
    } catch (z) {
      throw c ? $() : L ? new Error("Local TTS request timed out") : z;
    } finally {
      clearTimeout(J), m.delete(N);
    }
  }
  function ee() {
    return f ? f.failure || f.exited ? new Error("Local TTS adapter process exited unexpectedly") : typeof f.process.exitCode == "number" ? new Error("Local TTS adapter process exited unexpectedly") : null : null;
  }
  function tt() {
    if (I(), f && !ee()) return;
    let g;
    try {
      g = i(s, ["-u", "tts.py", "serve"], {
        cwd: n,
        stdio: "ignore",
        windowsHide: !0
      });
    } catch {
      throw new Error("Unable to start the local TTS adapter");
    }
    if (!g || typeof g.once != "function")
      throw new Error("Unable to start the local TTS adapter");
    const w = { process: g, failure: null, exited: !1 };
    g.once("error", () => {
      w.failure = !0;
    }), g.once("exit", () => {
      w.exited = !0;
    }), f = w;
  }
  async function me() {
    try {
      return await fe(`${X}${zt}`, { method: "GET" }, async (g, w) => {
        if (!ve(g)) return !1;
        const b = await De(g, w);
        return b?.ready === !0 && b?.voice === "custom_voice";
      }, a);
    } catch {
      if (c) throw $();
      return !1;
    }
  }
  function it(g) {
    I();
    let w;
    const b = new Promise((E) => {
      w = setTimeout(E, g), A.add(w);
    });
    return Z(b).finally(() => {
      clearTimeout(w), A.delete(w);
    });
  }
  async function nt(g) {
    for (; ; ) {
      I();
      const w = ee();
      if (w) throw w;
      if (await me()) return;
      I();
      const b = ee();
      if (b) throw b;
      const E = g - Date.now();
      if (E <= 0) throw new Error("Local TTS adapter did not become ready before the startup timeout");
      await it(Math.min(l, E));
    }
  }
  async function st(g = !1) {
    I();
    const w = Date.now() + o;
    !g && await me() || (I(), tt(), await nt(w));
  }
  async function rt() {
    if (h) {
      if (await h, I(), await me()) return;
      h = null;
    }
    return h || (h = st(h === null && f !== null).catch((w) => {
      throw h = null, w;
    })), h;
  }
  async function at(g) {
    I(), await rt(), I();
    const w = ee();
    if (w) throw w;
    try {
      const b = await fe(`${X}/v1/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: g.text, speed: g.speed, cache: !0 })
      }, async (L, J) => {
        if (!ve(L)) throw new Error("Local TTS speech request failed");
        return $t(await De(L, J));
      });
      I();
      const E = new URL(b.audioUrl, X).href;
      return {
        audio: await fe(E, { method: "GET" }, async (L, J) => {
          if (!ve(L)) throw new Error("Local TTS audio request failed");
          const z = await Xe(L, u, J);
          return qt(z, b.sampleRate, b.channels), z;
        }),
        durationSeconds: b.durationSeconds,
        sampleRate: b.sampleRate,
        channels: b.channels,
        voice: b.voice
      };
    } catch (b) {
      throw c || (h = null), b;
    }
  }
  function ot(g) {
    let w;
    try {
      I(), w = jt(g);
    } catch (E) {
      return Promise.reject(E);
    }
    const b = d.then(() => (I(), at(w)));
    return d = b.then(() => {
    }, () => {
    }), Z(b);
  }
  function lt() {
    if (!c) {
      c = !0, C();
      for (const g of m) g.abort();
      for (const g of A) clearTimeout(g);
      if (A.clear(), f && !f.exited && !f.failure && f.process.exitCode == null)
        try {
          f.process.kill("SIGTERM");
        } catch {
        }
    }
  }
  return { synthesize: ot, dispose: lt };
}
const Oe = 500, Ae = 1024, Vt = 32 * 1024 * 1024, Kt = 45e4;
function Jt(t) {
  if (!t || typeof t != "object")
    throw new TypeError("Synthesis request must be an object");
  if (typeof t.text != "string")
    throw new TypeError("Synthesis text must be a string");
  const e = t.text.trim(), i = Array.from(e).length;
  if (i < 1 || i > Oe)
    throw new RangeError(`Synthesis text must contain 1 to ${Oe} characters`);
  if (typeof t.speed != "number" || !Number.isFinite(t.speed) || t.speed < 0.5 || t.speed > 2)
    throw new RangeError("Synthesis speed must be between 0.5 and 2");
  return { text: e, speed: t.speed };
}
function x(t, { code: e, status: i, statusText: n, bodySnippet: s, cause: r } = {}) {
  const a = new Error(t, r === void 0 ? void 0 : { cause: r });
  return e && (a.code = e), i !== void 0 && (a.status = i), n && (a.statusText = String(n).slice(0, 128)), s && (a.bodySnippet = s.slice(0, Ae)), a;
}
async function Qe(t, e) {
  const i = Number(t.headers?.get?.("content-length"));
  if (Number.isFinite(i) && i > e)
    throw x("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
  if (t.body?.getReader) {
    const n = t.body.getReader(), s = [];
    let r = 0;
    try {
      for (; ; ) {
        const { done: l, value: u } = await n.read();
        if (l) break;
        if (r += u.byteLength, r > e)
          throw await n.cancel().catch(() => {
          }), x("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
        s.push(u);
      }
    } finally {
      n.releaseLock?.();
    }
    const a = new Uint8Array(r);
    let o = 0;
    for (const l of s)
      a.set(l, o), o += l.byteLength;
    return a;
  }
  if (typeof t.arrayBuffer == "function") {
    const n = await t.arrayBuffer();
    if (n.byteLength > e)
      throw x("Response exceeded the allowed size", { code: "RESPONSE_TOO_LARGE" });
    return new Uint8Array(n);
  }
  return new Uint8Array();
}
async function Yt(t) {
  try {
    const e = await Qe(t, Ae);
    return new TextDecoder().decode(e).slice(0, Ae).trim();
  } catch (e) {
    return e?.code === "RESPONSE_TOO_LARGE" ? "[error response truncated]" : "";
  }
}
async function Xt(t, e) {
  const i = await Yt(t), n = Number.isInteger(t.status) ? t.status : void 0, s = `${e} request failed${n === void 0 ? "" : ` (HTTP ${n})`}` + (i ? `: ${i}` : "");
  throw x(s, {
    code: `${e.toUpperCase()}_HTTP_ERROR`,
    status: n,
    statusText: t.statusText,
    bodySnippet: i
  });
}
function Qt(t, e, i) {
  if (typeof t != "number" || !Number.isFinite(t) || t <= 0 || t > 600)
    throw x("TTS service returned invalid audio duration", { code: "INVALID_TTS_METADATA" });
  if (!Number.isInteger(e) || e < 8e3 || e > 192e3)
    throw x("TTS service returned invalid sample rate", { code: "INVALID_TTS_METADATA" });
  if (!Number.isInteger(i) || i < 1 || i > 2)
    throw x("TTS service returned invalid channel count", { code: "INVALID_TTS_METADATA" });
}
function Zt(t, e, i) {
  const n = () => {
    throw x("TTS service returned invalid WAV audio", { code: "INVALID_TTS_AUDIO" });
  };
  t.byteLength < 44 && n();
  const s = (u, c) => String.fromCharCode(...t.subarray(u, u + c));
  (s(0, 4) !== "RIFF" || s(8, 4) !== "WAVE") && n();
  const r = new DataView(t.buffer, t.byteOffset, t.byteLength);
  r.getUint32(4, !0) + 8 !== t.byteLength && n();
  let a = 12, o = !1, l = !1;
  for (; a + 8 <= t.byteLength; ) {
    const u = s(a, 4), c = r.getUint32(a + 4, !0), h = a + 8, d = h + c;
    if (d > t.byteLength && n(), u === "fmt ") {
      if (c < 16 && n(), r.getUint16(h + 2, !0) !== i || r.getUint32(h + 4, !0) !== e)
        throw x("TTS metadata does not match its WAV audio", { code: "TTS_METADATA_MISMATCH" });
      o = !0;
    }
    u === "data" && (l = !0), a = d + c % 2;
  }
  (a !== t.byteLength || !o || !l) && n();
}
function ei(t, e, i) {
  const n = new AbortController();
  i.add(n);
  const s = () => n.abort(t?.reason);
  t?.aborted ? s() : t?.addEventListener("abort", s, { once: !0 });
  const r = e > 0 ? setTimeout(() => n.abort(x("TTS request timed out", { code: "TTS_TIMEOUT" })), e) : null;
  return {
    signal: n.signal,
    dispose() {
      r && clearTimeout(r), t?.removeEventListener("abort", s), i.delete(n);
    }
  };
}
function ti({
  fetchImpl: t = globalThis.fetch,
  endpoint: e = "/api/tts",
  timeoutMs: i = Kt,
  maxAudioBytes: n = Vt
} = {}) {
  if (typeof t != "function") throw new TypeError("A fetch implementation is required");
  const s = /* @__PURE__ */ new Set();
  let r = !1;
  return {
    async synthesize(a, { signal: o } = {}) {
      if (r) throw x("TTS client is disposed", { code: "SERVICE_DISPOSED" });
      const l = Jt(a), u = ei(o, i, s);
      try {
        const c = await t(e, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/wav" },
          body: JSON.stringify(l),
          signal: u.signal
        });
        c.ok || await Xt(c, "TTS");
        const h = c.headers?.get?.("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (h && h !== "audio/wav" && h !== "audio/x-wav" && h !== "application/octet-stream")
          throw x("TTS service returned a non-WAV response", { code: "INVALID_TTS_AUDIO" });
        const d = Number(c.headers?.get?.("x-audio-duration")), f = Number(c.headers?.get?.("x-audio-sample-rate")), m = Number(c.headers?.get?.("x-audio-channels"));
        Qt(d, f, m);
        const A = await Qe(c, n);
        return Zt(A, f, m), { audio: A, durationSeconds: d, sampleRate: f, channels: m, voice: "custom_voice" };
      } finally {
        u.dispose();
      }
    },
    dispose() {
      if (!r) {
        r = !0;
        for (const a of s) a.abort(x("TTS client is disposed", { code: "SERVICE_DISPOSED" }));
      }
    }
  };
}
const ii = 45e4;
function ni(t) {
  const e = t.toLowerCase().replace(/^\[|\]$/g, "");
  if (e === "localhost" || e === "::1") return !0;
  const i = e.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!(i && Number(i[1]) === 127 && i.slice(1).every((n) => Number(n) <= 255));
}
function si(t) {
  if (typeof t != "string" || t.trim().length === 0 || t.length > 2048)
    throw new TypeError("Remote TTS requires a configured loopback URL");
  let e;
  try {
    e = new URL(t.trim());
  } catch (i) {
    throw new TypeError("Remote TTS URL must be a valid loopback HTTP URL", { cause: i });
  }
  if (e.protocol !== "http:" || e.username || e.password || e.search || e.hash || !ni(e.hostname))
    throw new TypeError("Remote TTS URL must use HTTP on a loopback address");
  return e.toString().replace(/\/+$/, "");
}
function ri({
  url: t,
  fetch: e = globalThis.fetch,
  timeoutMs: i = ii
} = {}) {
  if (!Number.isFinite(i) || i <= 0 || i > 9e5)
    throw new RangeError("Remote TTS timeout must be between 1 and 900000 milliseconds");
  const n = si(t), s = ti({
    fetchImpl: e,
    endpoint: `${n}/api/tts`,
    timeoutMs: i
  });
  return {
    synthesize(r, a) {
      return s.synthesize(r, a);
    },
    dispose() {
      s.dispose();
    }
  };
}
const ai = Ve(Ge);
function oi(t) {
  const e = /^(\d+)\s+((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(String(t ?? ""));
  if (!e) return null;
  const i = Number(e[1]), n = Number(e[2]);
  return Number.isSafeInteger(i) && i > 0 && Number.isFinite(n) && n >= 0 && n <= 1 ? { deviceId: i, scalar: n } : null;
}
class li {
  constructor({ helperPath: e, execute: i = ai, fadeMs: n = 350, mediaPlaying: s } = {}) {
    this.helperPath = e, this.execute = i, this.fadeMs = n, this.mediaPlaying = s || (async () => String(await this.call([])).trim() === "1"), this.active = null, this.nextSessionId = 1, this.chain = Promise.resolve();
  }
  serialize(e) {
    const i = this.chain.catch(() => {
    }).then(e);
    return this.chain = i.catch(() => {
    }), i;
  }
  async call(e) {
    return (await this.execute(this.helperPath, e, {
      encoding: "utf8",
      timeout: 3e3
    }))?.stdout ?? "";
  }
  async readVolume() {
    return oi(await this.call(["volume-get"]));
  }
  async ramp(e, i) {
    await this.call([
      "volume-ramp",
      String(e),
      String(Math.max(0, Math.min(1, i))),
      String(this.fadeMs)
    ]);
  }
  begin({ canBoost: e = !0 } = {}) {
    return this.serialize(async () => {
      this.active && await this.restoreActive();
      const i = String(this.nextSessionId++), n = { sessionId: i, voiceGain: 0.9, mediaDucked: !1 };
      if (this.active = { sessionId: i, duck: null }, !this.helperPath) return n;
      try {
        if (!await this.mediaPlaying() || (n.voiceGain = 0.45, !e)) return n;
        const r = await this.readVolume();
        if (!r || r.scalar <= 0.01) return n;
        const a = r.scalar * 0.7, o = { ...r, targetScalar: a };
        return this.active.duck = o, await this.ramp(r.deviceId, a), { sessionId: i, voiceGain: 0.45 / 0.7, mediaDucked: !0 };
      } catch {
        return await this.restoreActive({ allowPartialRamp: !0 }), this.active = { sessionId: i, duck: null }, n;
      }
    });
  }
  end(e) {
    return this.serialize(async () => {
      !this.active || this.active.sessionId !== e || await this.restoreActive();
    });
  }
  restore() {
    return this.serialize(() => this.restoreActive());
  }
  async restoreActive({ allowPartialRamp: e = !1 } = {}) {
    const i = this.active;
    if (this.active = null, !!i?.duck)
      try {
        const n = await this.readVolume();
        if (!n || n.deviceId !== i.duck.deviceId) return;
        const s = Math.abs(n.scalar - i.duck.targetScalar) <= 5e-3, r = n.scalar >= Math.min(
          i.duck.targetScalar,
          i.duck.scalar
        ) - 5e-3 && n.scalar <= Math.max(
          i.duck.targetScalar,
          i.duck.scalar
        ) + 5e-3;
        if (!s && !(e && r)) return;
        await this.ramp(i.duck.deviceId, i.duck.scalar);
      } catch {
      }
  }
}
class ci {
  constructor({ executable: e = "", spawn: i = xe, platform: n = process.platform, locale: s = process.env.HIKARI_STT_LOCALE || "", timeoutMs: r = 45e3 } = {}) {
    this.executable = e, this.spawn = i, this.platform = n, this.locale = s, this.timeoutMs = r, this.running = !1;
  }
  getStatus() {
    const e = this.platform === "darwin" && !!(this.executable && de(this.executable));
    return { available: e, status: e ? "ready" : "unavailable", language: this.locale || "system", backend: "apple-speech-on-device", reason: e ? "" : "native_speech_helper_missing" };
  }
  async transcribe(e) {
    const i = this.getStatus();
    if (!i.available) throw new Error(i.reason);
    if (this.running) throw new Error("transcription_busy");
    if (!(e instanceof Float32Array) || e.length < 1600 || e.length > 16e5) throw new TypeError("Expected 0.1 to 100 seconds of 16 kHz mono audio");
    this.running = !0;
    const n = ui(e, 16e3);
    try {
      return await new Promise((s, r) => {
        const a = this.locale ? ["--locale", this.locale] : [], o = this.spawn(this.executable, a, { stdio: ["pipe", "pipe", "pipe"] });
        let l = "", u = "";
        const c = setTimeout(() => {
          o.kill("SIGKILL"), r(new Error("transcription_timeout"));
        }, this.timeoutMs);
        o.stdout.setEncoding("utf8"), o.stderr.setEncoding("utf8"), o.stdout.on("data", (h) => {
          l += h, l.length > 65536 && o.kill("SIGKILL");
        }), o.stderr.on("data", (h) => {
          u += h.slice(0, 4096);
        }), o.once("error", (h) => {
          clearTimeout(c), r(h);
        }), o.once("close", (h) => {
          clearTimeout(c);
          let d;
          try {
            d = JSON.parse(l);
          } catch {
            d = null;
          }
          h !== 0 || !d || d.error ? r(new Error(d?.error || u.trim() || `speech_exit_${h}`)) : s(String(d.text || "").trim());
        }), o.stdin.end(n);
      });
    } finally {
      this.running = !1, n.fill(0), e.fill(0);
    }
  }
}
function ui(t, e = 16e3) {
  const i = Buffer.alloc(44 + t.length * 2);
  i.write("RIFF", 0), i.writeUInt32LE(36 + t.length * 2, 4), i.write("WAVE", 8), i.write("fmt ", 12), i.writeUInt32LE(16, 16), i.writeUInt16LE(1, 20), i.writeUInt16LE(1, 22), i.writeUInt32LE(e, 24), i.writeUInt32LE(e * 2, 28), i.writeUInt16LE(2, 32), i.writeUInt16LE(16, 34), i.write("data", 36), i.writeUInt32LE(t.length * 2, 40);
  for (let n = 0; n < t.length; n++) i.writeInt16LE(Math.round(Math.max(-1, Math.min(1, t[n])) * 32767), 44 + n * 2);
  return i;
}
function di(t, e) {
  if (![
    t.x,
    t.y,
    t.width,
    t.height,
    e.x,
    e.y,
    e.width,
    e.height
  ].every(Number.isFinite) || t.width <= 0 || t.height <= 0 || e.width <= 0 || e.height <= 0)
    throw new TypeError("Invalid window bounds");
  const i = Math.min(1, e.width / t.width, e.height / t.height), n = Math.max(1, Math.floor(t.width * i)), s = Math.max(1, Math.floor(t.height * i));
  return {
    x: Math.max(e.x, Math.min(Math.round(t.x), e.x + e.width - n)),
    y: Math.max(e.y, Math.min(Math.round(t.y), e.y + e.height - s)),
    width: n,
    height: s
  };
}
function Pe(t, e, i = t.getBounds()) {
  const n = e.getDisplayMatching(i), s = di(i, n.workArea), r = t.getBounds();
  return Object.keys(s).some((a) => s[a] !== r[a]) && t.setBounds(s), t.getBounds();
}
function hi(t, e) {
  let i = !1;
  const n = () => {
    if (!(i || t.isDestroyed())) {
      i = !0;
      try {
        Pe(t, e);
      } finally {
        i = !1;
      }
    }
  };
  t.on("move", n), t.on("resize", n), e.on("display-metrics-changed", n), e.on("display-removed", n), t.once("closed", () => {
    e.removeListener("display-metrics-changed", n), e.removeListener("display-removed", n);
  }), n();
}
class pi {
  constructor() {
    this.reset();
  }
  reset() {
    this.average = 0, this.previousBass = 0, this.lastFrameAt = null, this.lastBeatAt = null, this.beat = 0, this.intervals = [], this.rawIntervals = [], this.intervalMs = null, this.targetIntervalMs = null, this.lastAudibleAt = null;
  }
  learnTempo(e) {
    if (e < 300 || e > 4500) return;
    this.rawIntervals.push(e), this.rawIntervals = this.rawIntervals.slice(-3);
    const i = (l) => [...l].sort((u, c) => u - c)[Math.floor(l.length / 2)], n = i(this.rawIntervals);
    if (this.intervalMs !== null && this.rawIntervals.length === 3 && this.rawIntervals.every((l) => Math.abs(l / n - 1) < 0.08) && Math.abs(n / this.intervalMs - 1) > 0.12 && n <= 1500) this.intervals = [n, n, n];
    else if (this.intervalMs !== null) {
      const l = Math.round(e / this.intervalMs);
      l >= 2 && l <= 3 && Math.abs(e / l / this.intervalMs - 1) < 0.12 && (e /= l);
    }
    if (e > 1500 || (this.intervals.push(e), this.intervals = this.intervals.slice(-9), this.intervals.length < 3)) return;
    const r = i(this.intervals), a = this.intervals.filter((l) => Math.abs(l / r - 1) < 0.12), o = a.reduce((l, u) => l + u, 0) / a.length;
    this.intervalMs === null ? this.intervalMs = this.targetIntervalMs = o : (Math.abs(o / this.targetIntervalMs - 1) > 0.03 && (this.targetIntervalMs = o), this.intervalMs += (this.targetIntervalMs - this.intervalMs) * 0.2, Math.abs(this.intervalMs / this.targetIntervalMs - 1) < 5e-3 && (this.intervalMs = this.targetIntervalMs));
  }
  update(e, i = Date.now()) {
    const n = Math.max(0, Math.min(1, Number(e.level) || 0)), s = Math.max(0, Math.min(1, Number(e.bass) || 0)), r = this.lastFrameAt === null ? 40 : Math.max(1, Math.min(200, i - this.lastFrameAt));
    return this.lastFrameAt !== null && i - this.lastFrameAt > 1500 && this.reset(), n >= 2e-3 && (this.lastAudibleAt !== null && i - this.lastAudibleAt > 8e3 && this.reset(), this.lastAudibleAt = i), s > Math.max(4e-3, this.average * 1.5) && s > this.previousBass * 1.12 && (this.lastBeatAt === null || i - this.lastBeatAt >= 240) && (this.lastBeatAt !== null && this.learnTempo(i - this.lastBeatAt), this.lastBeatAt = i, this.beat++), this.average += (s - this.average) * (1 - Math.exp(-r / 1400)), this.previousBass = s, this.lastFrameAt = i, {
      level: n,
      beat: this.beat,
      lastBeatAt: this.lastBeatAt,
      intervalMs: this.intervalMs,
      active: this.lastAudibleAt !== null && i - this.lastAudibleAt < 4e3,
      updatedAt: i
    };
  }
}
class fi {
  constructor({
    executable: e,
    spawn: i = xe,
    available: n = () => process.platform === "darwin" && de(e),
    excludePids: s = () => [process.pid],
    onSignal: r = () => {
    },
    onStatus: a = () => {
    },
    now: o = () => Date.now(),
    mediaPlaying: l = async () => !1,
    startupTimeoutMs: u = 3e4,
    silentTimeoutMs: c = 15e3
  } = {}) {
    Object.assign(this, { executable: e, spawn: i, available: n, excludePids: s, onSignal: r, onStatus: a, now: o, mediaPlaying: l, startupTimeoutMs: u, silentTimeoutMs: c }), this.detector = new pi(), this.child = null, this.status = { state: "off" }, this.starting = null;
  }
  setStatus(e) {
    return this.status = e, this.onStatus(e), e;
  }
  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(this.status);
    if (!this.available()) return Promise.resolve(this.setStatus({ state: "error", reason: "Music sway requires macOS 14.2 or later and the native helper." }));
    this.detector.reset(), this.setStatus({ state: "starting" });
    let e;
    try {
      e = this.spawn(this.executable, this.excludePids().map(String), { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return Promise.resolve(this.setStatus({ state: "error", reason: "Could not start music analysis." }));
    }
    this.child = e;
    let i = "", n = !1, s = !1, r = null, a = !1;
    const o = new Promise((l) => {
      const u = (h) => {
        clearTimeout(this.startupTimer), l(h);
      };
      this.settleStart = u, this.startupTimer = setTimeout(() => {
        this.child === e && this.stop({ state: "error", reason: "System audio access is needed. Allow Hikari in macOS System Audio Recording settings, then try again." });
      }, this.startupTimeoutMs);
      const c = (h) => {
        this.child === e && this.stop({ state: "error", reason: h });
      };
      e.stdout.setEncoding("utf8"), e.stderr.setEncoding("utf8"), e.stdin.on("error", () => {
      }), e.stderr.on("data", () => {
      }), e.stdout.on("data", (h) => {
        if (this.child !== e) return;
        if (i += h, i.length > 65536) {
          c("Music analysis returned invalid data.");
          return;
        }
        let d;
        for (; (d = i.indexOf(`
`)) >= 0 && this.child === e; ) {
          const f = i.slice(0, d);
          i = i.slice(d + 1);
          let m;
          try {
            m = JSON.parse(f);
          } catch {
            continue;
          }
          if (m.type === "error")
            c(m.stage === "unsupported" ? "Music sway requires macOS 14.2 or later." : "System audio capture could not start. Allow Hikari in System Audio Recording settings, then try again.");
          else if (m.type === "ready")
            n = !0, u(this.setStatus({ state: "listening" }));
          else if (m.type === "frame" && n && Number.isFinite(m.level) && Number.isFinite(m.bass)) {
            const A = this.detector.update(m, this.now());
            A.active && this.status.warning && this.setStatus({ state: "listening" }), this.onSignal(A), s ||= A.active, A.active ? r = null : r ??= this.now(), !s && r !== null && this.now() - r >= this.silentTimeoutMs && !a && (a = !0, Promise.resolve().then(() => this.mediaPlaying()).then((C) => {
              this.child === e && !s && C && this.setStatus({
                state: "listening",
                warning: "No audio captured. If music is playing, check Hikari’s System Audio Recording permission."
              });
            }).catch(() => {
            }).finally(() => {
              a = !1, r = this.now();
            }));
          }
        }
      }), e.once("error", () => c("Could not start music analysis.")), e.once("close", () => c("Music analysis stopped. Toggle Music beat sway to try again.")), this.exclusionTimer = setInterval(() => {
        this.child === e && !e.stdin.destroyed && e.stdin.write(JSON.stringify(this.excludePids()) + `
`);
      }, 1e3);
    }).finally(() => {
      this.starting === o && (this.starting = null, this.settleStart = null);
    });
    return this.starting = o, o;
  }
  stop(e = { state: "off" }) {
    clearTimeout(this.startupTimer), clearInterval(this.exclusionTimer);
    const i = this.child;
    if (this.child = null, i) {
      i.stdin.end(), i.kill("SIGTERM");
      const n = setTimeout(() => i.kill("SIGKILL"), 1500);
      n.unref?.(), i.once("close", () => clearTimeout(n));
    }
    return this.detector.reset(), this.onSignal({ active: !1, level: 0, beat: 0, lastBeatAt: null, intervalMs: null, updatedAt: this.now() }), this.setStatus(e), this.settleStart?.(e), this.starting = null, this.settleStart = null, e;
  }
}
const oe = process.env.HIKARI_SOFTWARE_GL;
let H = oe === "1", Ce = H ? "HIKARI_SOFTWARE_GL=1" : oe === "0" ? "auto fallback disabled by HIKARI_SOFTWARE_GL=0" : "platform default";
if (oe !== "0" && oe !== "1" && process.platform === "linux")
  try {
    H = !ht("/dev/dri").some((t) => /^renderD\d+$/.test(t)), Ce = H ? "no /dev/dri render node" : "/dev/dri render node present";
  } catch (t) {
    H = t.code === "ENOENT", Ce = H ? "no /dev/dri directory" : `GPU probe failed (${t.code})`;
  }
H && (v.commandLine.appendSwitch("ignore-gpu-blocklist"), v.commandLine.appendSwitch("use-angle", "swiftshader"), v.commandLine.appendSwitch("enable-unsafe-swiftshader"));
console.info(`[gpu] ${H ? "Software rendering (SwiftShader)" : "Default GPU rendering"}: ${Ce}`);
const mi = dt(import.meta.url), k = S.dirname(mi), We = process.env.NODE_ENV === "development" || !V(S.join(k, "../dist/index.html"));
let p = null, M = null, O = null, W = null, Ue = !1, Ie = yt(), le = null, ce = null, Me = null, ue = null, Se = null, G = null, pe = !1, te = null, ie = "";
const gi = ft({
  getSources: (t) => je.getSources(t),
  getDisplay: () => p && !p.isDestroyed() ? U.getDisplayMatching(p.getBounds()) : null,
  getPermissionStatus: () => j.getMediaAccessStatus("screen")
});
function R(t) {
  Ie = vt(Ie, t), p && !p.isDestroyed() && !p.webContents.isDestroyed() && p.webContents.send("world-state:patch", t);
}
async function Be() {
  const t = M;
  if (!t) return;
  t.activeWindowProvider || await t.initializeActiveWindowProvider(), t.refreshScreenCaptureStatus();
  let e = await t.getActiveContext().catch(() => null);
  if (e && t.isHikariContext(e)) {
    const r = await t.openWindowsProvider?.().catch(() => null);
    e = (Array.isArray(r) ? r : []).map((a) => ({
      appName: a?.owner?.name || "",
      bundleId: a?.owner?.bundleId || "",
      windowTitle: a?.title || "",
      windowId: Number.isFinite(Number(a?.id)) ? Number(a.id) : null,
      bounds: a?.bounds || null,
      processId: Number(a?.owner?.processId) || null
    })).find((a) => a.appName && !t.isHikariContext(a)) || null;
  }
  const i = e ? `${e.bundleId || e.appName || "unknown"}:${e.windowId ?? e.windowTitle ?? "unknown"}` : "", n = !!(ie && i && i !== ie);
  ie = i || ie;
  const s = Date.now();
  R({ desktop: {
    appName: e?.appName || "",
    bundleId: e?.bundleId || "",
    windowTitle: e?.windowTitle || "",
    windowId: e?.windowId ?? null,
    windowBounds: e?.bounds || null,
    contextUpdatedAt: s,
    contextStale: !e,
    screen: n ? { available: !!t.getStatus().screenCaptureAvailable, visionAvailable: !!t.getStatus().screenCaptureAvailable, changeLevel: "unknown", changeAt: 0, changeStale: !0, lastSummary: "", summaryAt: 0, summaryStale: !0, summaryContextKey: "" } : { available: !!t.getStatus().screenCaptureAvailable, visionAvailable: !!t.getStatus().screenCaptureAvailable }
  }, browser: { available: !1 } });
}
function He() {
  if (!M) return;
  const t = Math.max(0, (Number(qe.getSystemIdleTime()) || 0) * 1e3);
  R({ desktop: { activity: { ...M.getActivityState(), idleForMs: t, idle: t >= 6e4, updatedAt: Date.now(), stale: !1 } } });
}
async function ze(t) {
  if (process.platform !== "darwin" || !t.ensureMediaPlaybackProvider()) {
    R({ audio: { system: { available: !1, updatedAt: Date.now() } } });
    return;
  }
  try {
    const [e, i] = await Promise.all([
      Q().call(["audio-state"]).catch(() => ""),
      Q().readVolume().catch(() => null)
    ]), n = gt(e);
    R({ audio: { system: {
      available: n?.available ?? !1,
      stale: !1,
      captureAvailable: G?.status.state === "listening",
      running: n?.running ?? !1,
      volume: n?.volume ?? i?.scalar ?? null,
      muted: n?.muted ?? null,
      level: null,
      classification: "unknown",
      confidence: 0,
      updatedAt: Date.now()
    } } });
  } catch {
    R({ audio: { system: { available: !1, updatedAt: Date.now() } } });
  }
}
function wi() {
  le || ce || ue || (Be(), He(), ze(M), ce = setInterval(() => {
    Be();
  }, 1500), ue = setInterval(He, 500), Me = setInterval(() => {
    ze(M);
  }, 5e3), le = setInterval(() => {
    const t = U.getCursorScreenPoint();
    if (!(!te || Math.abs(t.x - te.x) >= 4 || Math.abs(t.y - te.y) >= 4)) return;
    te = t;
    const i = U.getDisplayNearestPoint(t);
    R({ desktop: { pointer: { ...t, displayId: i?.id ?? null, updatedAt: Date.now(), stale: !1 } } });
  }, 100));
}
function Ze() {
  clearInterval(le), clearInterval(ce), clearInterval(ue), clearInterval(Me), le = null, ce = null, ue = null, Me = null;
}
function et() {
  if (!Se) {
    const t = v.isPackaged ? [S.join(process.resourcesPath, "voice-stt", "voice-stt")] : [
      S.join(v.getAppPath(), "tools", "voice-stt", "voice-stt"),
      S.resolve(k, "../../tools/voice-stt/voice-stt"),
      S.resolve(k, "../tools/voice-stt/voice-stt")
    ];
    Se = new ci({ executable: process.env.HIKARI_SPEECH_HELPER || t.find((e) => V(e)) || t[0] });
  }
  return Se;
}
function Q() {
  if (!W) {
    const t = v.isPackaged ? [S.join(process.resourcesPath, "media-state", "media-state")] : [
      S.join(v.getAppPath(), "tools", "media-state", "media-state"),
      S.resolve(k, "../tools/media-state/media-state")
    ];
    W = new li({
      helperPath: t.find((e) => V(e)),
      // The voice player's own AudioContext opens the output device before
      // playback. Exclude Hikari's processes so it cannot count as media.
      mediaPlaying: async () => String(await W.call([
        "playing-except",
        String(process.pid),
        ...v.getAppMetrics().map((e) => String(e.pid))
      ])).trim() === "1"
    });
  }
  return W;
}
function yi() {
  if (!O && process.env.HIKARI_SERVICE_URL && (O = ri({ url: process.env.HIKARI_SERVICE_URL })), !O) {
    const t = v.isPackaged ? [S.join(process.resourcesPath, "companion-tts")] : [
      S.join(v.getAppPath(), "tools/companion-tts"),
      S.resolve(k, "../tools/companion-tts"),
      S.resolve(k, "../../tools/companion-tts")
    ], e = process.env.HIKARI_TTS_TOOL_DIR || t.find(
      (i) => V(S.join(i, "tts.py"))
    ) || t[0];
    O = Gt({ toolDir: e });
  }
  return O;
}
function bi() {
  if (!G) {
    const t = v.isPackaged ? [S.join(process.resourcesPath, "music-beat", "music-beat")] : [S.join(v.getAppPath(), "tools/music-beat/music-beat"), S.resolve(k, "../tools/music-beat/music-beat")], e = (i, n) => {
      p && !p.isDestroyed() && !p.webContents.isDestroyed() && p.webContents.send(i, n);
    };
    G = new fi({
      executable: t.find((i) => V(i)) || t[0],
      excludePids: () => [process.pid, ...v.getAppMetrics().map((i) => i.pid)],
      mediaPlaying: () => Q().mediaPlaying(),
      onSignal: (i) => e("music-beat:signal", i),
      onStatus: (i) => e("music-beat:status", i)
    });
  }
  return G;
}
function T(t) {
  return !!(p && !p.isDestroyed() && t.sender === p.webContents);
}
function P() {
  return M || (M = new Lt({
    getHikariBounds: () => p && !p.isDestroyed() ? p.getBounds() : null,
    emitCandidate: (t) => {
      const e = t.context || {}, i = `${e.bundleId || e.appName || "unknown"}:${t.windowId ?? e.windowId ?? e.windowTitle ?? "unknown"}`, n = [e.appName, e.windowTitle].filter(Boolean).join(" — "), s = t.timestamp || Date.now(), r = Math.max(0, (Number(qe.getSystemIdleTime()) || 0) * 1e3), a = t.trigger === "typing_session_end" ? "a typing session was observed" : t.trigger === "scroll_session_end" ? "a scrolling session was observed" : "desktop activity changed", o = { desktop: {
        appName: e.appName || "",
        bundleId: e.bundleId || "",
        windowTitle: e.windowTitle || "",
        windowId: e.windowId ?? t.windowId ?? null,
        contextUpdatedAt: s,
        contextStale: !e.appName,
        activity: {
          ...M?.getActivityState?.() || {},
          idleForMs: r,
          idle: r >= 6e4,
          updatedAt: s,
          stale: !1
        },
        screen: {
          available: !!M?.getStatus().screenCaptureAvailable,
          visionAvailable: !!M?.getStatus().screenCaptureAvailable
        }
      } };
      (t.visualChange || ["application_changed", "window_changed", "typing_session_end", "scroll_session_end", "click_caused_screen_change"].includes(t.trigger)) && (o.desktop.screen = {
        ...o.desktop.screen,
        changeLevel: t.visualChange?.level || "unknown",
        changeAt: s,
        changeStale: !1,
        lastSummary: n ? `Active window: ${n}; ${a}. Window content was not interpreted.` : `${a}. Window content was not interpreted.`,
        summaryAt: s,
        summaryStale: !1,
        summaryContextKey: i
      }), (t.media?.state === "playing" || t.media?.state === "stopped") && (o.audio = { system: { available: !0, running: t.media.state === "playing", updatedAt: s, stale: !1 } }), R(o), p && !p.isDestroyed() && !p.webContents.isDestroyed() && p.webContents.send("awareness:candidate", t);
    }
  }), M);
}
function Fe() {
  p = new $e({
    width: 600,
    height: 900,
    transparent: !0,
    frame: !1,
    alwaysOnTop: !0,
    resizable: !0,
    webPreferences: {
      preload: V(S.join(k, "preload.js")) ? S.join(k, "preload.js") : S.resolve(k, "../preload.js"),
      contextIsolation: !0,
      nodeIntegration: !1,
      webSecurity: !We,
      backgroundThrottling: !1,
      autoplayPolicy: "no-user-gesture-required"
    }
  }), hi(p, U), We ? (p.loadURL("http://localhost:5174/electron/index.html"), p.webContents.openDevTools({ mode: "detach" })) : p.loadFile(S.join(k, "../dist/index.html")), p.once("closed", () => {
    G?.stop(), M?.stop(), Ze(), pe = !1, W?.restore(), O?.dispose(), O = null, p = null;
  });
}
y.handle("tts:synthesize", async (t, e) => {
  if (!T(t)) throw new TypeError("Invalid voice request");
  return yi().synthesize(e);
});
y.handle("music-beat:set-enabled", (t, e) => {
  if (!T(t) || typeof e != "boolean") throw new TypeError("Invalid music analysis request");
  const i = bi();
  return e ? i.start() : i.stop();
});
y.handle("music-beat:open-permission", async (t) => {
  if (!T(t)) throw new TypeError("Invalid music permission request");
  await Te.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture");
});
y.handle("world-state:get", (t) => {
  if (!T(t)) throw new TypeError("Invalid world-state request");
  return Ct(Ie);
});
y.handle("voice:set-enabled", (t, e) => {
  if (!T(t) || typeof e != "boolean") throw new TypeError("Invalid voice request");
  pe = e;
  const i = process.platform === "darwin" ? j.getMediaAccessStatus("microphone") : "unknown", n = et().getStatus();
  return R({ audio: { microphone: { enabled: e, permission: i }, stt: { status: n.status, language: "auto" } } }), { enabled: e, permission: i, stt: n };
});
y.handle("voice:transcribe", async (t, e) => {
  if (!T(t) || !pe) throw new TypeError("Voice listening is disabled");
  if (!(e instanceof Float32Array)) throw new TypeError("Invalid voice audio segment");
  return et().transcribe(new Float32Array(e));
});
y.handle("world-state:renderer-patch", (t, e) => {
  if (!T(t) || !e || typeof e != "object") throw new TypeError("Invalid world-state update");
  const i = Tt(e);
  if (!Object.keys(i).length) throw new TypeError("Invalid world-state update");
  R(i);
});
y.handle("audio:begin-reply", async (t, e) => {
  if (!T(t) || typeof e?.canBoost != "boolean")
    throw new TypeError("Invalid reply-audio request");
  return Q().begin(e);
});
y.handle("audio:end-reply", async (t, e) => {
  if (!T(t) || typeof e != "string")
    throw new TypeError("Invalid reply-audio request");
  await Q().end(e);
});
y.handle("get-window-position", () => {
  if (!p) return { x: 0, y: 0 };
  const t = p.getPosition();
  return { x: t[0], y: t[1] };
});
y.handle("set-window-position", (t, e, i) => {
  if (!p) return !1;
  if (!T(t) || ![e, i].every(Number.isFinite)) throw new TypeError("Invalid window position");
  return Pe(p, U, { ...p.getBounds(), x: Math.round(e), y: Math.round(i) });
});
y.handle("get-window-bounds", () => p ? p.getBounds() : { width: 0, height: 0, x: 0, y: 0 });
y.handle("set-window-bounds", (t, e, i, n, s) => {
  if (!p) return !1;
  if (!T(t) || ![e, i, n, s].every(Number.isFinite)) throw new TypeError("Invalid window bounds");
  return Pe(p, U, {
    x: Math.round(e),
    y: Math.round(i),
    width: Math.max(200, Math.round(n)),
    height: Math.max(300, Math.round(s))
  });
});
y.handle("set-ignore-mouse-events", (t, e, i) => p ? (p.setIgnoreMouseEvents(e, { forward: i !== !1 }), !0) : !1);
y.handle("awareness:set-enabled", async (t, e) => {
  if (!T(t) || typeof e != "boolean")
    throw new TypeError("Invalid desktop-awareness request");
  return P().setEnabled(e);
});
y.handle("awareness:get-status", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness request");
  return P().refreshPermissionStatus();
});
y.handle("awareness:get-greeting-context", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness request");
  return P().getGreetingContext();
});
y.handle("awareness:refresh-status", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness request");
  return P().refreshPermissionStatus();
});
y.handle("awareness:request-screen-capture", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness request");
  return P().requestScreenCapturePermission();
});
y.handle("awareness:request-input-monitoring", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness request");
  return P().requestInputMonitoringPermission();
});
y.handle("screen:capture", async (t) => {
  if (!T(t)) throw new TypeError("Invalid screenshot request");
  try {
    return { ok: !0, attachment: await gi.capture() };
  } catch (e) {
    return { ok: !1, error: { code: e.code || "CAPTURE_FAILED", message: e.message || "Screenshot capture failed." } };
  }
});
y.handle("awareness:request-snapshot", (t, e) => {
  if (!T(t) || typeof e != "string" || !e.trim())
    throw new TypeError("Invalid desktop-awareness snapshot request");
  return P().requestSnapshot(e);
});
y.handle("awareness:capture-screen", async (t) => {
  if (!T(t)) throw new TypeError("Invalid desktop-awareness capture request");
  return P().captureScreen();
});
y.on("awareness:direct-interaction", (t) => {
  T(t) && P().noteDirectInteraction();
});
v.whenReady().then(() => {
  P(), ut.defaultSession.setPermissionRequestHandler((t, e, i, n) => {
    const s = e === "media" && n?.mediaTypes?.includes("audio") && !n?.mediaTypes?.includes("video");
    i(!!(s && pe));
  }), Fe(), wi(), ke.enabledByDefault && M.start(), v.on("activate", () => {
    $e.getAllWindows().length === 0 && Fe();
  });
});
v.on("window-all-closed", () => {
  M?.stop(), Ze(), process.platform !== "darwin" && v.quit();
});
v.on("before-quit", (t) => {
  if (G?.stop(), W?.active && !Ue) {
    t.preventDefault(), Ue = !0, W.restore().finally(() => {
      W = null, v.quit();
    });
    return;
  }
  M?.stop(), O?.dispose();
});
