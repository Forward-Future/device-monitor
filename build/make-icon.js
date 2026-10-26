// Renders the app icon (a gauge on a dark rounded tile) to PNG with no dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 4; // supersampling for anti-aliasing
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = a / (SS * SS) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const BG = hex('#1a1a19'), TRACK = hex('#383835'), CPU = hex('#3987e5'), GPU = hex('#d95926'), ACCENT = hex('#9085e9');

// Gauge: 270° track with a 3-color sweep (CPU/GPU/accent) and a needle hub.
function gauge(u, v, { tile = true } = {}) {
  const x = u - 0.5, y = v - 0.5;
  if (tile) {
    const k = 0.42, rad = 0.12; // rounded square
    const qx = Math.max(Math.abs(x) - (k - rad), 0), qy = Math.max(Math.abs(y) - (k - rad), 0);
    if (Math.hypot(qx, qy) > rad) return [0, 0, 0, 0];
  }
  const d = Math.hypot(x, y);
  let ang = Math.atan2(y, x) * 180 / Math.PI; // 0 = right, 90 = down
  let t = (ang - 135 + 360) % 360;             // 0..270 along the arc, starting bottom-left
  const R = tile ? 0.27 : 0.36, W = tile ? 0.065 : 0.1;
  if (Math.abs(d - R) < W / 2 && t <= 270) {
    if (t < 95) return [...CPU, 1];
    if (t < 185) return [...ACCENT, 1];
    if (t < 205) return [...GPU, 1];
    return [...TRACK, tile ? 1 : 1];
  }
  if (d < (tile ? 0.045 : 0.07)) return [...hex('#f0efec'), 1];
  // needle pointing at ~205°
  const na = (135 + 205) * Math.PI / 180, nx = Math.cos(na), ny = Math.sin(na);
  const along = x * nx + y * ny, across = Math.abs(-x * ny + y * nx);
  if (along > 0 && along < R - W && across < (tile ? 0.018 : 0.03)) return [...hex('#f0efec'), 1];
  return tile ? [...BG, 1] : [0, 0, 0, 0];
}

const out = __dirname;
fs.writeFileSync(path.join(out, 'icon.png'), png(1024, (u, v) => gauge(u, v)));   // macOS needs >= 512px; Windows .ico is derived from it
fs.writeFileSync(path.join(out, 'tray.png'), png(32, (u, v) => gauge(u, v, { tile: false })));
// macOS menu bar "template" icon: black + alpha only (the OS tints it); the track is drawn fainter.
const template = (u, v) => { const [r, g, b, a] = gauge(u, v, { tile: false }); if (!a) return [0, 0, 0, 0]; return [0, 0, 0, r === TRACK[0] && g === TRACK[1] && b === TRACK[2] ? 0.35 : 1]; };
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(18, template));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), png(36, template));
console.log('icons written to', out);
