import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(toolsDirectory, 'voice-stt', 'main.swift');
const outputPath = path.join(toolsDirectory, 'voice-stt', 'voice-stt');
const moduleCachePath = process.env.HIKARI_SWIFT_MODULE_CACHE || '/private/tmp/hikari-swift-module-cache';
mkdirSync(path.dirname(outputPath), { recursive: true });
mkdirSync(moduleCachePath, { recursive: true });
const result = spawnSync('swiftc', [sourcePath, '-module-cache-path', moduleCachePath, '-framework', 'Speech', '-framework', 'AVFoundation', '-o', outputPath], { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Unable to build Apple Speech helper.\n');
  if (process.env.HIKARI_REQUIRE_NATIVE_STT === '1') process.exit(result.status || 1);
  process.stderr.write('Continuing without local speech recognition; the app will show Voice Listening as unavailable.\n');
  process.exit(0);
}
chmodSync(outputPath, 0o755);
console.log(`Built ${path.relative(process.cwd(), outputPath)}`);
