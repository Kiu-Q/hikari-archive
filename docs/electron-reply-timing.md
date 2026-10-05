# Electron reply timing

Timing is collected automatically for HTTP replies, including greeting, touch,
conversation, events and awareness. Filter the Electron DevTools console for
`[reply-timing]`. Each request has one ID, including any formatting repair request.
Snapshots are logged when the response arrives, when speech actually starts,
and when presentation ends. The latest 200 requests are saved locally across
restarts; timing records contain no prompts, replies, images, tokens or audio.

The start is immediately before the first HTTP call. The endpoint is the first
native audio `playing` event, rather than synthesis completion or calling `play()`.
Time before the HTTP call (such as waiting to send) is outside this measurement.

- `totalToSpeechMs`: first HTTP send → first actual speech playback.
- `agentReplyMs`: sum of HTTP request durations, including response-body parsing
  and repair attempts. Includes gateway/network latency, not just model inference.
- `firstAgentReplyMs` and `repairHttpMs`: initial HTTP duration and repair HTTP durations.
- `audioRenderingMs`: first chunk's synthesis-service call → audio bytes ready.
  Includes service queue/IPC/transport, not just internal TTS engine computation.
- `otherWaitingMs`: total minus agent HTTP and first chunk audio rendering.
  Includes parsing, startup readiness, queues, animation loading, audio setup,
  volume setup and waiting for playback to start.
- `waitsMs`: measured command/speech queues, animation preparation, audio setup,
  volume setup and playback-start delay. Queue waits can overlap synthesis;
  these detailed values must not be summed as an additional total.
- `spans`: each HTTP attempt and each chunk's render start/end/duration.
  Chunks render concurrently; summing render durations overstates wall time.
- `marks`: event timestamps in milliseconds relative to the first HTTP send.
  Later chunks and presentation completion can occur after `speech_started`.

For replies with no speech, failed requests or cancellation, speech latency stays
`null`. `response_received` without a speech snapshot can also indicate that an
awareness response was intentionally not presented. Status `completed` describes
presentation completion; use `speech_started` to confirm audio actually started.
No internal model/TTS timings are inferred from the renderer observations.

Export for later analysis from Electron DevTools:

```js
copy(window.hikariReplyTimings.exportJSON())
```

Inspect or clear stored measurements:

```js
window.hikariReplyTimings.getRecords()
window.hikariReplyTimings.clear()
```
