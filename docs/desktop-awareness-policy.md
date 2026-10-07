# Desktop awareness decisions

When desktop awareness and Environment Reactions are enabled, every accepted event automatically captures the current foreground window, or its display if window capture is unavailable. Hikari sends the image together with the event metadata in the first awareness request. The agent chooses one of two outcomes:

- Reply with `{"reply":true,...}` using the shared bilingual response format.
- Stay silent with `{"reply":false}`.

Capture and analysis do not open the screenshot composer, alter drafts, show progress messages, or add screenshot/history entries. Only the reply uses normal presentation. Captures stay in memory and are attached only to that awareness request.

The agent cannot request another capture. If capture is unavailable, the initial request says so and lets the agent decide from metadata. It does not open permission settings. Direct interaction, a user conversation, disabling awareness/reactions, or Hikari becoming busy prevents sending or presenting stale results. Existing cooldowns and reaction budgets apply to the reply. Legacy `react` decisions remain accepted for compatibility.
