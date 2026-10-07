import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'out/build-resources');
const iconset = path.join(directory, 'Hikari.iconset');
await mkdir(iconset, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `${command} failed`);
}
try {
  const source = path.join(directory, 'Hikari.png');
  run('sips', ['-s', 'format', 'png', path.join(root, 'favicon.ico'), '--out', source]);
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
    run('sips', ['-z', String(size * 2), String(size * 2), source, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(directory, 'Hikari.icns')]);
  console.log('Built macOS Hikari icon');
} finally {
  await rm(iconset, { recursive: true, force: true });
}
