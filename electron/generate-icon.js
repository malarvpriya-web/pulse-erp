/**
 * Generates pixel-perfect purple lightning bolt icons.
 * Run: node electron/generate-icon.js
 * Outputs: electron/icon.ico + frontend/public/icons/icon-192.png + icon-512.png
 */
const { writeFileSync } = require('fs');
const { deflateSync } = require('zlib');
const path = require('path');

/* ── CRC-32 ── */
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ((c ^ 0xffffffff) >>> 0);
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([l, t, data, c]);
}

/* ── Draw lightning bolt as filled polygon via scanline ── */
// Bolt polygon in normalised [0,1] coords — Zap shape
const BOLT = [
  [0.62, 0.02],  // top right
  [0.33, 0.50],  // mid left
  [0.52, 0.50],  // mid centre
  [0.38, 0.98],  // bottom left
  [0.67, 0.50],  // mid right
  [0.48, 0.50],  // mid centre-left
];

function cross2d(ax, ay, bx, by) { return ax * by - ay * bx; }
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/* ── Make one RGBA PNG ── */
function makePNG(size) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(size, 0); hdr.writeUInt32BE(size, 4);
  hdr[8] = 8; hdr[9] = 6; // 8-bit RGBA

  const rows = [];
  const PAD = 1 / size; // anti-alias padding

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    const fy = y / (size - 1);

    for (let x = 0; x < size; x++) {
      const fx = x / (size - 1);

      // Rounded square (radius 20%)
      const cr = 0.20;
      const rx = Math.max(cr - fx, 0, fx - (1 - cr));
      const ry = Math.max(cr - fy, 0, fy - (1 - cr));
      const dist = Math.sqrt(rx * rx + ry * ry);
      const inBg = dist <= cr;

      let r = 0, g = 0, b = 0, a = 0;

      if (inBg) {
        // Purple background
        r = 124; g = 58; b = 237; a = 255;

        // Lightning bolt — check with small sample for soft edge
        const inBolt = pointInPolygon(fx, fy, BOLT);
        if (inBolt) {
          r = 255; g = 255; b = 255; a = 255;
        }
      }

      row[1 + x*4]     = r;
      row[1 + x*4 + 1] = g;
      row[1 + x*4 + 2] = b;
      row[1 + x*4 + 3] = a;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const idat = chunk('IDAT', deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, chunk('IHDR', hdr), idat, iend]);
}

/* ── Build ICO (multi-size) ── */
function makeICO(sizes) {
  const pngs = sizes.map(s => makePNG(s));
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0);
  hdr.writeUInt16LE(1, 2);
  hdr.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const dirs = pngs.map((png, i) => {
    const s = sizes[i];
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([hdr, ...dirs, ...pngs]);
}

const electronDir = __dirname;
const iconsDir = path.join(__dirname, '../frontend/public/icons');

// ICO for Electron (Windows title bar + taskbar)
const ico = makeICO([16, 32, 48, 256]);
writeFileSync(path.join(electronDir, 'icon.ico'), ico);
console.log('✓ electron/icon.ico');

// PNG for PWA
for (const size of [192, 512]) {
  const png = makePNG(size);
  writeFileSync(path.join(iconsDir, `icon-${size}.png`), png);
  console.log(`✓ icons/icon-${size}.png`);
}

console.log('\nAll icons generated with lightning bolt ⚡');
