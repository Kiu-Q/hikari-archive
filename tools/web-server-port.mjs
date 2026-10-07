import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function portIsBusy(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Port ${port} check timed out`)); });
  });
}

/** Stop only a Node server/index.js process belonging to this checkout. */
export async function prepareWebServerPort({ cwd, port = 3000, timeoutMs = 10_000, log = console.log }) {
  if (!await portIsBusy(port)) return;
  const refusal = `Port ${port} is in use by another application. Hikari left it running; stop that application before retrying.`;
  const root = await realpath(cwd);
  let owners;
  try {
    const { stdout } = await execute('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 });
    owners = [...new Set(stdout.trim().split(/\s+/).map(Number))];
  } catch (error) {
    // The old process may have exited between the connection and lsof checks.
    if (!await portIsBusy(port)) return;
    throw new Error(`${refusal} Could not verify the port owner (${error.code}).`);
  }
  if (!owners.length || owners.some(pid => !Number.isInteger(pid) || pid <= 1)) throw new Error(refusal);

  // Verify every owner before sending any signal. A matching filename alone
  // must never authorize stopping a server in a different project directory.
  for (const pid of owners) {
    const [{ stdout: command }, { stdout: directory }] = await Promise.all([
      execute('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }),
      execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 }),
    ]);
    const args = command.trim();
    const separator = args.indexOf(' ');
    const executable = args.slice(0, separator);
    const script = args.slice(separator + 1).trim();
    const directoryName = directory.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (path.basename(executable) !== 'node' ||
        !['server/index.js', path.join(root, 'server/index.js')].includes(script) ||
        directoryName !== root) throw new Error(refusal);
  }

  log(`Restarting the existing Hikari web server on port ${port}…`);
  for (const pid of owners) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + timeoutMs;
  while (await portIsBusy(port)) {
    if (Date.now() >= deadline) throw new Error(`The previous Hikari server has not released port ${port}. Wait a moment and retry.`);
    await delay(100);
  }
}
