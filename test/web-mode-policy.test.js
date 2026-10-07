import assert from 'node:assert/strict';
import test from 'node:test';

import { isWebAnimationAllowed } from '../shared/web-mode-policy.js';

test('blocks all sitting and walking filename prefixes regardless of case or extension', () => {
  for (const name of [
    'sit.vrma',
    'sitWave.vrma',
    'sit_down.vrma',
    'sit_up',
    'sitting_pose.vrma',
    'WALK.vrma',
    'walk_left.vrma',
    'walkRight.vrma',
    'walking_loop.vrma',
    'idle_sit.vrma', 'IDLE_WALK.vrma'
  ]) {
    assert.equal(isWebAnimationAllowed(name), false, name);
  }
});

test('blocks seated startup clips in filenames and full URLs with query strings or fragments', () => {
  for (const value of [
    './VRMA/sit_down.vrma?cache=4#pose',
    'https://assets.example/VRMA/sitWave.vrma?v=2#main',
    'https://assets.example/VRMA/walk_right.vrma?build=9',
    'https://assets.example/VRMA/start_1standUp.vrma?rev=3#start',
    'file:///app/VRMA/START_1STANDUP.VRMA',
    'file:///app/VRMA/idle_sit.vrma', '/VRMA/idle_walk.vrma?rev=4'
  ]) {
    assert.equal(isWebAnimationAllowed(value), false, value);
  }
});

test('allows idle, wave, turn-around, and other non-sit/walk animations', () => {
  for (const value of [
    'idle_loop.vrma',
    '/VRMA/idle_airplane.vrma?rev=2',
    'wave_fast.vrma',
    'wave_both.vrma',
    'start_2turnAround.vrma',
    'turnAround.vrma',
    'hang.vrma',
    'https://assets.example/VRMA/custom.vrma?build=1#clip'
  ]) {
    assert.equal(isWebAnimationAllowed(value), true, value);
  }
});

test('rejects invalid values and URLs without an animation filename', () => {
  for (const value of [null, undefined, 1, {}, '', '   ', 'https://assets.example/', 'https://[', '/animations/']) {
    assert.equal(isWebAnimationAllowed(value), false, String(value));
  }
});
