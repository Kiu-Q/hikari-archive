import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MusicBeatDetector } from '../electron/music-beat.js';

const helper = fileURLToPath(new URL('../tools/music-beat/music-beat', import.meta.url));
test('native PCM bass analysis preserves a known 120-BPM rhythm', { skip: process.platform !== 'darwin' || !existsSync(helper) }, () => {
  // Self-test uses generated PCM through the real analyser, without capture.
  const frames = execFileSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(JSON.parse);
  const detector = new MusicBeatDetector();
  let signal;
  for (const frame of frames) signal = detector.update(frame, frame.timeMs);
  assert.equal(frames.length, 150);
  assert.equal(signal.beat, 12);
  assert.ok(Math.abs(60000 / signal.intervalMs - 120) < 3);
});
