/** Renderer-observed latency only; stores no message text, images, audio or tokens. */
export function createReplyTimingRecorder({ now = () => performance.now(), storage, log = () => {}, limit = 200 } = {}) {
  let sequence = 0;
  let records = [];
  const pending = new Map();
  try { records = JSON.parse(storage?.getItem('electron_reply_timings') || '[]').slice(-limit); } catch { records = []; }
  function save(record) {
    const index = records.findIndex(item => item.id === record.id);
    if (index < 0) records.push(record); else records[index] = record;
    records = records.slice(-limit);
    try { storage?.setItem('electron_reply_timings', JSON.stringify(records)); } catch { /* Logging still works when storage is full. */ }
  }
  function begin(kind = 'conversation') {
    const origin = now();
    const id = `${Date.now()}-${++sequence}`;
    const marks = { http_sent: 0 }, spans = [];
    let status = 'requesting';
    const elapsed = () => now() - origin;
    const rounded = value => value == null ? null : Math.round(value * 10) / 10;
    function snapshot() {
      const stop = marks.speech_started;
      const duration = span => Math.max(0, Math.min(span.end ?? (stop ?? elapsed()), stop ?? Infinity) - span.start);
      const agent = spans.filter(item => item.stage === 'agent_http').reduce((sum, item) => sum + duration(item), 0);
      const httpSpans = spans.filter(item => item.stage === 'agent_http');
      const firstAgent = httpSpans[0] ? duration(httpSpans[0]) : 0;
      const firstAudio = spans.find(item => item.stage === 'audio_render' && item.chunk === 0);
      const audio = firstAudio && stop != null ? duration(firstAudio) : null;
      const spanDuration = stage => {
        const item = spans.find(span => span.stage === stage);
        return rounded(item?.end == null ? null : item.end - item.start);
      };
      const between = (start, end) => rounded(marks[start] == null || marks[end] == null ? null : marks[end] - marks[start]);
      return { id, kind, startedAt: new Date(Number(id.split('-')[0])).toISOString(), status,
        totalToSpeechMs: rounded(stop), agentReplyMs: rounded(agent),
        audioRenderingMs: rounded(audio), otherWaitingMs: stop == null ? null : rounded(Math.max(0, stop - agent - (audio || 0))),
        firstAgentReplyMs: rounded(firstAgent), repairHttpMs: rounded(agent - firstAgent),
        httpAttempts: httpSpans.length,
        waitsMs: {
          commandQueue: spanDuration('command_queue'),
          speechQueue: between('speech_queued', 'speech_queue_released'),
          audioSetup: between('audio_setup_started', 'audio_setup_finished'),
          animationPrepare: spanDuration('animation_prepare'),
          volumeSetup: between('volume_setup_started', 'volume_setup_finished'),
          playbackStart: between('playback_requested', 'speech_started'),
        },
        marks: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, rounded(value)])),
        spans: spans.map(item => ({ ...item, start: rounded(item.start), end: rounded(item.end), durationMs: item.end == null ? null : rounded(item.end - item.start) })) };
    }
    function publish() { const record = snapshot(); save(record); log(record); }
    const trace = {
      id,
      mark(name) { if (marks[name] == null) marks[name] = elapsed(); },
      span(stage, chunk) {
        const item = { stage, ...(chunk == null ? {} : { chunk }), start: elapsed() };
        spans.push(item);
        return outcome => {
          if (item.end != null) return;
          item.end = elapsed();
          if (outcome) item.outcome = outcome;
          if (status !== 'requesting') save(snapshot());
        };
      },
      responseReady(reply) {
        trace.mark('agent_ready'); status = 'response_received'; publish();
        const queue = pending.get(reply) || [];
        queue.push(trace); pending.set(reply, queue);
        // Bound responses that callers decide not to present (e.g. silent awareness).
        while (pending.size > limit) pending.delete(pending.keys().next().value);
      },
      speechStarted() {
        if (marks.speech_started != null) return;
        trace.mark('speech_started'); status = 'speaking'; publish();
      },
      finish(outcome) { trace.mark('finished'); status = outcome; publish(); },
      snapshot,
    };
    return trace;
  }
  return {
    begin,
    consume(reply) { const queue = pending.get(reply); const trace = queue?.shift(); if (!queue?.length) pending.delete(reply); return trace; },
    getRecords: () => JSON.parse(JSON.stringify(records)),
    exportJSON: () => JSON.stringify(records, null, 2),
    clear() { records = []; pending.clear(); try { storage?.removeItem('electron_reply_timings'); } catch {} },
  };
}
