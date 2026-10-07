import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../electron/app.js', import.meta.url), 'utf8');
const eventSource = source.slice(source.indexOf('async function sendEventToAgent('), source.indexOf('// CORE MODULE -'));
function harness() {
  const requests = [], spoken = [];
  const context = vm.createContext({
    agentRequestQueue: [], isAgentRequestInProgress: false,
    window: { sendAgentMessage() {}, lipSyncSystem: { startSpeaking: async text => spoken.push(text) } },
    logger: { info() {}, warn() {}, error() {} },
    document: { getElementById: () => null },
    AgentApiModule: {
      sendAgentMessageRaw: message => new Promise(resolve => requests.push({ message, resolve })),
      parseAgentResponse: text => ({ text }), executeAgentCommand: async command => spoken.push(command.text)
    }
  });
  vm.runInContext(eventSource, context);
  return { context, requests, spoken, send: context.sendEventToAgent };
}

test('history closed before its HTTP reply arrives is not presented and releases the event queue', async () => {
  const h = harness();
  let open = true;
  const request = h.send('panel_toggle', 'History opened', { shouldPresent: () => open });
  assert.equal(h.requests.length, 1);
  open = false; h.requests[0].resolve('The history panel is open');
  await request;
  assert.deepEqual(h.spoken, []);
  assert.equal(h.context.isAgentRequestInProgress, false);
  assert.equal(h.context.window._agentRequestPending, false);
});

test('a stale history event queued behind another event never makes its HTTP request', async () => {
  const h = harness();
  const first = h.send('other', 'Current reply');
  let open = true;
  const queued = h.send('panel_toggle', 'History opened', { shouldPresent: () => open });
  open = false;
  h.requests[0].resolve('Current reply');
  await Promise.all([first, queued]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.spoken, ['Current reply']);
});
