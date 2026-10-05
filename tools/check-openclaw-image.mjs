// Opt-in smoke check: sends only a generated blue square, never a real screenshot.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
const dimensions = Buffer.alloc(13);
dimensions.writeUInt32BE(64, 0); dimensions.writeUInt32BE(64, 4);
dimensions[8] = 8; dimensions[9] = 2;
const pixels = Buffer.alloc(64 * (1 + 64 * 3));
for (let y = 0; y < 64; y++) {
  for (let x = 0; x < 64; x++) {
    const offset = y * 193 + 1 + x * 3;
    pixels[offset + 1] = 70; pixels[offset + 2] = 255;
  }
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', dimensions), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const config = JSON.parse(readFileSync(join(homedir(), '.openclaw/openclaw.json'), 'utf8'));
const token = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token;
if (typeof token !== 'string') throw new Error('A gateway token is required for the image smoke check.');
const response = await fetch(`http://127.0.0.1:${config.gateway?.port || 18789}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(90000),
  body: JSON.stringify({ model: 'openclaw/default', messages: [{ role: 'user', content: [
    { type: 'text', text: 'This is a synthetic image capability test, not a real desktop screenshot. What solid color fills the attached image? Answer with just the color name in English.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
  ] }] })
});
if (!response.ok) throw new Error(`Image smoke check returned HTTP ${response.status}.`);
const result = await response.json();
const answer = result.choices?.[0]?.message?.content || '';
if (!/\bblue\b|藍|蓝/i.test(answer)) throw new Error('The gateway accepted the image, but visual understanding could not be verified.');
console.log('OPENCLAW_IMAGE_SMOKE_OK: existing chat endpoint and default agent identified the generated blue square.');
