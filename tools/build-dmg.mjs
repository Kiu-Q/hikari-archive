import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('DMG builds require macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const arch = process.arch;
const buildEnvironment = { ...process.env };
// Forge's ZIP extraction currently exits early under Node 26. Use an installed
// stable Node for packaging while leaving the application's Electron runtime alone.
if (Number(process.versions.node.split('.')[0]) >= 26) {
  const candidates = [process.env.HIKARI_PACKAGE_NODE, '/opt/homebrew/opt/node@24/bin/node', '/usr/local/bin/node'];
  const stableNode = candidates.filter(Boolean).find(candidate => {
    const result = spawnSync(candidate, ['-p', 'Number(process.versions.node.split(".")[0])'], { encoding: 'utf8' });
    const major = Number(result.stdout?.trim());
    return result.status === 0 && major >= 20 && major < 26;
  });
  if (!stableNode) throw new Error('Packaging requires Node 20–24. Set HIKARI_PACKAGE_NODE to its executable.');
  buildEnvironment.PATH = `${path.dirname(stableNode)}${path.delimiter}${buildEnvironment.PATH || ''}`;
  console.log(`Packaging with ${stableNode}`);
}
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: buildEnvironment, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code})`)));
  });
}

await run('npm', ['run', 'package', '--', `--arch=${arch}`]);
const application = path.join(root, `out/Hikari-darwin-${arch}/Hikari.app`);
await run('codesign', ['--verify', '--deep', '--strict', application]);
const outputDirectory = path.join(root, 'out/make');
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `Hikari-${metadata.version}-${arch}.dmg`);
const stage = await mkdtemp(path.join(os.tmpdir(), 'hikari-dmg-'));
try {
  await run('ditto', [application, path.join(stage, 'Hikari.app')]);
  await symlink('/Applications', path.join(stage, 'Applications'));
  await run('hdiutil', ['create', '-volname', 'Hikari', '-srcfolder', stage, '-format', 'UDZO', '-ov', '-o', output]);
  await run('hdiutil', ['verify', output]);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  await writeFile(`${output}.sha256`, `${hash.digest('hex')}  ${path.basename(output)}\n`);
  console.log(`DMG ready: ${output} (${Math.round((await stat(output)).size / 1024 / 1024)} MB)`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
