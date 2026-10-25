import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function handleTouchEvent(');
const handler = source.slice(start, source.indexOf('    /**\n     * Save camera settings', start));

test('an ignored touch does not change expression, status, messaging controls or animation state', async () => {
  let pending = true;
  const calls = [];
  const context = vm.createContext({
    currentVrm: {}, lastTouchTime: 0, TOUCH_DEBOUNCE_MS: 200, isSitAnimationActive: true,
    statusDiv: { textContent: 'Speaking' },
    window: {
      isAgentInteractionPending: () => pending,
      disableMessaging: () => calls.push('disable'),
      setMessagingThinking: () => calls.push('thinking'),
      sendAgentMessage: message => calls.push(message),
    },
    logger: { info() {}, error() {} },
    noteDirectHikariInteraction: () => calls.push('interaction'),
    applyFacialExpression: () => calls.push('expression'),
    identifyBodyPart: () => 'head', loadIdleLoop: async () => {},
  });
  vm.runInContext(handler, context);
  await context.handleTouchEvent({});
  assert.deepEqual(calls, []);
  assert.equal(context.statusDiv.textContent, 'Speaking');
  assert.equal(context.lastTouchTime, 0);
  assert.equal(context.isSitAnimationActive, true);
  pending = false;
  await context.handleTouchEvent({});
  assert.deepEqual(calls, ['interaction', 'expression', 'disable', 'thinking', 'User touched your head']);
});
