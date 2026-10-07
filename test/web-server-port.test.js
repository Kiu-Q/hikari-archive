import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareWebServerPort } from '../tools/web-server-port.mjs';

async function fixture(t, { filename = 'server/index.js', ignoreShutdown = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hikari-port-test-'));
  await mkdir(path.dirname(path.join(cwd, filename)), { recursive: true });
  await writeFile(path.join(cwd, filename), `
    const server = require('node:http').createServer((req, res) => res.end('fixture'));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.on('SIGTERM', () => { ${ignoreShutdown ? '' : "server.close(() => process.exit(0));"} });
  `);
  const child = spawn(process.execPath, [filename], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(cwd, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('\n')) resolve(Number(output.trim()));
    });
    child.once('exit', () => reject(new Error('Fixture exited before listening')));
  });
  return { cwd, child, port, exited };
}

const options = { skip: process.platform === 'win32', timeout: 20_000 };
test('a previous Hikari server shuts down gracefully and releases the port for another start', options, async t => {
  const f = await fixture(t);
  await prepareWebServerPort({ cwd: f.cwd, port: f.port, log() {} });
  assert.deepEqual(await f.exited, [0, null]);
  // Checking an already-free port is also safe.
  await prepareWebServerPort({ cwd: f.cwd, port: f.port, log() {} });
});

test('another application in the same directory is left running', options, async t => {
  const f = await fixture(t, { filename: 'other-app.js' });
  await assert.rejects(prepareWebServerPort({ cwd: f.cwd, port: f.port }), /another application/);
  assert.equal(f.child.exitCode, null);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
});

test('a server/index.js from a different checkout is left running', options, async t => {
  const f = await fixture(t);
  await assert.rejects(prepareWebServerPort({ cwd: path.dirname(f.cwd), port: f.port }), /another application/);
  assert.equal(f.child.exitCode, null);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
});

test('a slow server gets a bounded wait without being forcibly killed', options, async t => {
  const f = await fixture(t, { ignoreShutdown: true });
  await assert.rejects(prepareWebServerPort({ cwd: f.cwd, port: f.port, timeoutMs: 150, log() {} }), /has not released port/);
  assert.equal(f.child.exitCode, null);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'fixture');
});
