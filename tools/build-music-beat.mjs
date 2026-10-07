import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const directory = fileURLToPath(new URL('./music-beat/', import.meta.url));
const output = `${directory}music-beat`;
const built = spawnSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-fobjc-arc', '-fblocks',
  '-mmacosx-version-min=13.0', `${directory}main.m`, '-framework', 'CoreAudio', '-framework', 'Foundation',
  '-Wl,-sectcreate,__TEXT,__info_plist,' + directory + 'Info.plist', '-o', output], { encoding: 'utf8' });
if (built.status !== 0) {
  process.stderr.write(built.stderr || 'Unable to build music beat analyser.\n');
  process.exit(built.status || 1);
}
const signed = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.electron.hikari.music-beat', output], { encoding: 'utf8' });
if (signed.status !== 0) { process.stderr.write(signed.stderr); process.exit(signed.status || 1); }
chmodSync(output, 0o755);
console.log('Built tools/music-beat/music-beat');
