import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(toolsDirectory, 'media-state', 'main.c');
const outputPath = path.join(toolsDirectory, 'media-state', 'media-state');
mkdirSync(path.dirname(outputPath), { recursive: true });

const result = spawnSync('xcrun', [
  'clang',
  '-O2',
  '-Wall',
  '-Wextra',
  sourcePath,
  '-framework',
  'CoreAudio',
  '-framework',
  'CoreFoundation',
  '-o',
  outputPath
], { encoding: 'utf8' });

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Unable to build media-state helper.\n');
  process.exit(result.status || 1);
}

chmodSync(outputPath, 0o755);
console.log(`Built ${path.relative(process.cwd(), outputPath)}`);
