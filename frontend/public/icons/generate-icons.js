/**
 * Run with: node frontend/public/icons/generate-icons.js
 * Generates purple lightning bolt PWA icons.
 * Creates: icon-192.png and icon-512.png
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── CRC-32 ── */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ((c ^ 0xffffffff) >>> 0);
}
function makeChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([lb, tb, data, cb]);
}

/* ── Point-in-triangle test ── */
function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px,py,ax,ay,bx,by);
  const d2 = sign(px,py,bx,by,cx,cy);
  const d3 = sign(px,py,cx,cy,ax,ay);
  const hasN = (d1<0)||(d2<0)||(d3<0);
  const hasP = (d1>0)||(d2>0)||(d3>0);
  return !(hasN && hasP);
}

/* ── Lightning bolt: two filled triangles forming a Zap shape ── */
function isLightning(fx, fy) {
  // Upper-right triangle (top half of bolt)
  const upper = inTri(fx, fy,
    0.60, 0.05,   // top-right
    0.28, 0.52,   // bottom-left
    0.62, 0.48    // bottom-right
  );
  // Lower-left triangle (bottom half of bolt)
  const lower = inTri(fx, fy,
    0.38, 0.52,   // top-left
    0.72, 0.95,   // bottom-right
    0.40, 0.95    // bottom-left
  );
  return upper || lower;
}

/* ── Build RGBA PNG ── */
function createPNG(size) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // RGBA
  const ihdr = makeChunk('IHDR', ihdrData);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter none
    const fy = y / (size - 1);

    for (let x = 0; x < size; x++) {
      const fx = x / (size - 1);

      // Rounded square mask (radius = 22%)
      const cr = 0.22;
      const rx = Math.max(cr - fx, 0, fx - (1 - cr));
      const ry = Math.max(cr - fy, 0, fy - (1 - cr));
      const inBounds = Math.sqrt(rx*rx + ry*ry) <= cr;

      let r, g, b, a;
      if (!inBounds) {
        // Transparent outside rounded square
        r = 0; g = 0; b = 0; a = 0;
      } else if (isLightning(fx, fy)) {
        // White lightning bolt
        r = 255; g = 255; b = 255; a = 255;
      } else {
        // Purple background #7c3aed
        r = 124; g = 58; b = 237; a = 255;
      }

      row[1 + x*4]     = r;
      row[1 + x*4 + 1] = g;
      row[1 + x*4 + 2] = b;
      row[1 + x*4 + 3] = a;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

for (const size of [192, 512]) {
  const png = createPNG(size);
  const outPath = join(__dirname, `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`Created icon-${size}.png (${png.length} bytes)`);
}
console.log('Done — lightning bolt PWA icons generated.');
