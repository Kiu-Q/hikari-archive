// Centralized tuning defaults for Phase 1 desktop awareness.
// Keep this module free of Electron/native imports so it can be shared by the
// main-process and renderer-side awareness code.
export const awarenessConfig = {
  enabledByDefault: false,

  idleReturn: {
    minimumIdleMs: 90 * 1000,
    greetingCooldownMs: 5 * 60 * 1000
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
    pollIntervalMs: 2000,
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
    minimumCandidateIntervalMs: 4000,
    minimumAgentAnalysisIntervalMs: 4000,
    candidateMaxAgeMs: 10000
  },

  reaction: {
    normalSpeechCooldownMs: 20000,
    importantSpeechCooldownMs: 15000,

    normalBudgetCount: 6,
    normalBudgetWindowMs: 10 * 60 * 1000
  },

  dedupe: {
    sameContextReactionCooldownMs: 90000
  },

  hikariInteraction: {
    suppressionMs: 1500
  },

  memory: {
    recentCandidateLimit: 20,
    recentReactionLimit: 10
  },

  debug: true
};
