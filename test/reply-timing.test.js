import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplyTimingRecorder } from '../electron/reply-timing.js';

function harness(limit = 200) {
  let clock = 0;
  const values = new Map(), logs = [];
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const recorder = createReplyTimingRecorder({ now: () => clock, storage, log: record => logs.push(record), limit });
  return { recorder, storage, values, logs, at(value) { clock = value; } };
}

test('request-to-first-playback separates HTTP, first audio render and residual waits without double-counting queue overlap', () => {
  const h = harness(), trace = h.recorder.begin();
  const http = trace.span('agent_http', 0);
  h.at(100); http('received'); trace.responseReady('not stored transcript');
  const audio = trace.span('audio_render', 0), queue = trace.span('command_queue');
  h.at(130); audio('ready'); trace.mark('first_audio_ready');
  h.at(160); queue(); trace.mark('speech_queued');
  h.at(170); trace.mark('speech_queue_released'); trace.mark('audio_setup_started');
  h.at(180); trace.mark('audio_setup_finished'); const animation = trace.span('animation_prepare');
  h.at(200); animation(); trace.mark('volume_setup_started');
  h.at(210); trace.mark('volume_setup_finished'); trace.mark('playback_requested');
  h.at(220); trace.speechStarted();
  const record = h.recorder.getRecords()[0];
  assert.equal(record.totalToSpeechMs, 220);
  assert.equal(record.agentReplyMs, 100);
  assert.equal(record.audioRenderingMs, 30);
  assert.equal(record.otherWaitingMs, 90);
  assert.deepEqual(record.waitsMs, { commandQueue: 60, speechQueue: 10, audioSetup: 10, animationPrepare: 20, volumeSetup: 10, playbackStart: 10 });
  h.at(900); trace.speechStarted(); trace.finish('completed');
  assert.equal(h.recorder.getRecords()[0].totalToSpeechMs, 220);
  assert.equal(h.recorder.getRecords()[0].marks.finished, 900);
  assert.equal(h.recorder.exportJSON().includes('not stored transcript'), false);
});

test('formatting repair HTTP attempts and parallel chunk rendering are reported individually', () => {
  const h = harness(), trace = h.recorder.begin('greeting');
  const first = trace.span('agent_http', 0); h.at(100); first();
  h.at(110); const repair = trace.span('agent_http', 1); h.at(160); repair(); trace.responseReady('reply');
  assert.equal(h.recorder.consume('reply'), trace);
  const audio = trace.span('audio_render', 0), second = trace.span('audio_render', 1);
  h.at(180); audio('ready'); h.at(190); trace.speechStarted();
  h.at(240); second('ready'); trace.finish('completed');
  const record = h.recorder.getRecords()[0];
  assert.equal(record.httpAttempts, 2);
  assert.equal(record.firstAgentReplyMs, 100);
  assert.equal(record.repairHttpMs, 50);
  assert.equal(record.audioRenderingMs, 20);
  assert.equal(record.otherWaitingMs, 20);
  assert.equal(record.spans.at(-1).durationMs, 80);
});

test('failed or nonspoken responses never invent speech latency; records persist with a bounded history', () => {
  const h = harness(2);
  for (const outcome of ['http_failed', 'no_speech', 'cancelled']) {
    const trace = h.recorder.begin(); const http = trace.span('agent_http'); h.at(100); http(outcome); trace.finish(outcome);
  }
  assert.equal(h.recorder.getRecords().length, 2);
  assert.equal(h.recorder.getRecords()[0].totalToSpeechMs, null);
  assert.equal(h.recorder.getRecords()[0].otherWaitingMs, null);
  const restored = createReplyTimingRecorder({ storage: h.storage });
  assert.deepEqual(restored.getRecords(), h.recorder.getRecords());
  restored.clear(); assert.deepEqual(restored.getRecords(), []);
});

test('identical replies still retain their individual request timing', () => {
  const h = harness(), a = h.recorder.begin('greeting'), b = h.recorder.begin('touch');
  a.responseReady('same'); b.responseReady('same');
  assert.equal(h.recorder.consume('same'), a);
  assert.equal(h.recorder.consume('same'), b);
});
