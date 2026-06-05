'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ─── PNG encoding ─────────────────────────────────────────────────────────
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const byte of buf) {
    let b = (c ^ byte) & 0xFF;
    for (let j = 0; j < 8; j++) b = b & 1 ? 0xEDB88320 ^ (b >>> 1) : b >>> 1;
    c = (c >>> 8) ^ b;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([lenBuf, t, data, crcBuf]);
}

function encodePng(rgba, size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // row[0] = 0 (filter: None)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = 1 + x * 4;
      row[d] = rgba[s]; row[d+1] = rgba[s+1]; row[d+2] = rgba[s+2]; row[d+3] = rgba[s+3];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Drawing primitives ───────────────────────────────────────────────────
function blendPixel(rgba, size, px, py, R, G, B, a) {
  if (px < 0 || py < 0 || px >= size || py >= size || a <= 0) return;
  const i = (py * size + px) * 4;
  const fa = a / 255, ia = 1 - fa, ea = rgba[i+3] / 255;
  const oa = fa + ea * ia;
  if (oa < 0.001) return;
  rgba[i]   = (R * fa + rgba[i]   * ea * ia) / oa + .5 | 0;
  rgba[i+1] = (G * fa + rgba[i+1] * ea * ia) / oa + .5 | 0;
  rgba[i+2] = (B * fa + rgba[i+2] * ea * ia) / oa + .5 | 0;
  rgba[i+3] = oa * 255 + .5 | 0;
}

// Rounded rectangle via shader-style SDF
function drawRoundedRect(rgba, size, x0, y0, x1, y1, cornerR, R, G, B) {
  const cx = (x0 + x1) * .5, cy = (y0 + y1) * .5;
  const hw = (x1 - x0) * .5 - cornerR, hh = (y1 - y0) * .5 - cornerR;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const qx = Math.abs(px + .5 - cx) - hw, qy = Math.abs(py + .5 - cy) - hh;
      const sdf = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2)
                + Math.min(Math.max(qx, qy), 0) - cornerR;
      const a = Math.max(0, Math.min(1, .5 - sdf));
      if (a > 0) blendPixel(rgba, size, px, py, R, G, B, a * 255 + .5 | 0);
    }
  }
}

// Circular arc opening upward from (cx, cy); halfDeg = half angular spread in degrees
function drawArc(rgba, size, cx, cy, rIn, rOut, halfDeg, R, G, B) {
  const x0 = Math.max(0, (cx - rOut - 1) | 0), x1 = Math.min(size, (cx + rOut + 2) | 0);
  const y0 = Math.max(0, (cy - rOut - 1) | 0), y1 = Math.min(size, (cy + 2) | 0);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dx = px + .5 - cx, dy = py + .5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < rIn - .5 || dist > rOut + .5) continue;
      const ang = Math.abs(Math.atan2(dx, -dy) * 180 / Math.PI);
      if (ang > halfDeg + .5) continue;
      let a = 1;
      if (dist < rIn  + .5) a = Math.min(a, dist  - rIn  + .5);
      if (dist > rOut - .5) a = Math.min(a, rOut   - dist + .5);
      if (ang  > halfDeg - .5) a = Math.min(a, halfDeg + .5 - ang);
      blendPixel(rgba, size, px, py, R, G, B, a * 255 + .5 | 0);
    }
  }
}

function drawCircle(rgba, size, cx, cy, r, R, G, B) {
  const x0 = Math.max(0, (cx - r - 1) | 0), x1 = Math.min(size, (cx + r + 2) | 0);
  const y0 = Math.max(0, (cy - r - 1) | 0), y1 = Math.min(size, (cy + r + 2) | 0);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dist = Math.sqrt((px + .5 - cx) ** 2 + (py + .5 - cy) ** 2);
      const a = Math.max(0, Math.min(1, r - dist + .5));
      if (a > 0) blendPixel(rgba, size, px, py, R, G, B, a * 255 + .5 | 0);
    }
  }
}

// ─── Icon designs ─────────────────────────────────────────────────────────
// Bright background + blue broadcast signal (3 arcs + dot)
const BG = [245, 249, 255];
const FG = [37, 99, 235];

function makeAppIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const pad = size * .08, cr = size * .22;
  drawRoundedRect(rgba, size, pad, pad, size - pad, size - pad, cr, ...BG);

  const cx = size / 2, cy = size * .63;
  const th = size * .055, sp = 58;
  drawArc(rgba, size, cx, cy, size * .09,  size * .09  + th, sp, ...FG);
  drawArc(rgba, size, cx, cy, size * .205, size * .205 + th, sp, ...FG);
  drawArc(rgba, size, cx, cy, size * .325, size * .325 + th, sp, ...FG);
  drawCircle(rgba, size, cx, cy, size * .04, ...FG);
  return encodePng(rgba, size);
}

// Tray icon: transparent background, signal arcs only
function makeTrayIcon(size, color = [255, 255, 255]) {
  const rgba = new Uint8Array(size * size * 4);
  const cx = size / 2, cy = size * .68;
  const th = Math.max(1, size * .13), sp = 60;
  drawArc(rgba, size, cx, cy, size * .10, size * .10 + th, sp, ...color);
  drawArc(rgba, size, cx, cy, size * .27, size * .27 + th, sp, ...color);
  drawCircle(rgba, size, cx, cy, size * .07, ...color);
  return encodePng(rgba, size);
}

// ─── ICO encoder ──────────────────────────────────────────────────────────
function encodeIco(entries) {
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = e[0];
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([hdr, ...dirs, ...entries.map(e => e.data)]);
}

// ─── Main ─────────────────────────────────────────────────────────────────
const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

process.stdout.write('Generating app icons');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const appPngs = {};
for (const s of sizes) { appPngs[s] = makeAppIcon(s); process.stdout.write('.'); }
process.stdout.write('\n');

// Tray: blue for Windows/Linux, black template for macOS
fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'),        makeTrayIcon(16, FG));
fs.writeFileSync(path.join(assetsDir, 'tray-icon@2x.png'),     makeTrayIcon(32, FG));
fs.writeFileSync(path.join(assetsDir, 'tray-icon-mac.png'),    makeTrayIcon(16, [0, 0, 0]));
fs.writeFileSync(path.join(assetsDir, 'tray-icon-mac@2x.png'), makeTrayIcon(32, [0, 0, 0]));
console.log('✓ tray-icon.png / @2x  (blue)');
console.log('✓ tray-icon-mac.png / @2x  (black template)');

// App PNG fallback for BrowserWindow
fs.writeFileSync(path.join(assetsDir, 'app-icon.png'), appPngs[256]);

// Windows .ico (16, 32, 48, 256)
fs.writeFileSync(path.join(assetsDir, 'app-icon.ico'),
  encodeIco([16, 32, 48, 256].map(s => ({ size: s, data: appPngs[s] }))));
console.log('✓ app-icon.ico  (Windows)');

// macOS .icns via iconutil
const iconsetDir = path.join(assetsDir, 'app-icon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });
[
  ['icon_16x16.png',      16], ['icon_16x16@2x.png',   32],
  ['icon_32x32.png',      32], ['icon_32x32@2x.png',   64],
  ['icon_128x128.png',   128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png',   256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png',   512], ['icon_512x512@2x.png', 1024],
].forEach(([name, s]) => fs.writeFileSync(path.join(iconsetDir, name), appPngs[s]));

try {
  execSync(
    `iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'app-icon.icns')}"`,
    { stdio: 'inherit' }
  );
  console.log('✓ app-icon.icns  (macOS)');
} catch {
  console.warn('! iconutil not available — skipping .icns (macOS only tool)');
}
fs.rmSync(iconsetDir, { recursive: true });
