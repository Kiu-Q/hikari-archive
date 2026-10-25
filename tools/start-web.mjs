import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareWebServerPort } from './web-server-port.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const env = {
  ...process.env,
  HIKARI_PUBLIC_ORIGIN: process.env.HIKARI_PUBLIC_ORIGIN || 'https://node.tailb3abce.ts.net',
};
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = null;
      resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}

try {
  const build = await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'web-local']);
  if (build !== 0 || stopping) {
    process.exitCode = build || 130;
  } else {
    await prepareWebServerPort({ cwd });
    console.log(`Hikari phone access: ${env.HIKARI_PUBLIC_ORIGIN}`);
    // caffeinate follows the server's lifetime, including Ctrl+C shutdown.
    process.exitCode = stopping ? 130 : process.platform === 'darwin'
      ? await run('/usr/bin/caffeinate', ['-i', process.execPath, 'server/index.js'])
      : await run(process.execPath, ['server/index.js']);
  }
} catch (error) {
  console.error(`Could not start Hikari web: ${error.message}`);
  process.exitCode = 1;
}
