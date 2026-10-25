# Hikari World State

`electron/main.js` owns the authoritative in-memory `HikariWorldState`. Desktop context, activity, pointer movement, system output, and Phase 1 awareness observations update it in the main process. Awareness observations are patched before `awareness:candidate` is sent, so the renderer and agent see the same event context.

The preload exposes a narrow `worldState` API: `get()` returns a time-expired snapshot, `onPatch(callback)` subscribes to changes, and `patchHikari()` / `patchMicrophone()` accept only renderer-owned Hikari status and voice activity. The renderer keeps a defensive mirror in `WorldStateStore`; local Hikari transitions update that mirror immediately and are sent to main for canonical publication.

Fields carry observation timestamps and explicit `stale` indicators. Short-lived pointer, activity, screen-change, system-audio, and Hikari activity values expire at read/agent-context boundaries. `serializeWorldStateForAgent()` emits only a short structured summary: it omits pointer coordinates and stale screen summaries, and never claims screen contents were interpreted. Full microphone capture, transcription, and visual understanding remain separate capabilities.

```text
desktop awareness + main polling ──patch──▶ main WorldState
                                               │
                                     safe get / patch / subscribe IPC
                                               ▼
                                       preload ──▶ renderer mirror
                                                        │
                                                        └── compact agent context
```
