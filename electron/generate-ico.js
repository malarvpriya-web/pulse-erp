/**
 * Generates a purple lightning bolt ICO file for Windows desktop app.
 * Run: node electron/generate-ico.js
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── PNG helpers ── */
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

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px,py,ax,ay,bx,by), d2 = sign(px,py,bx,by,cx,cy), d3 = sign(px,py,cx,cy,ax,ay);
  return !((d1<0||d2<0||d3<0) && (d1>0||d2>0||d3>0));
}

function makePNG(size) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size,0); ihdrData.writeUInt32BE(size,4);
  ihdrData[8]=8; ihdrData[9]=6; // RGBA
  const ihdr = makeChunk('IHDR', ihdrData);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    const fy = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const fx = x / (size - 1);
      const cr = 0.22;
      const ax = Math.max(cr - fx, 0, fx - (1 - cr));
      const ay = Math.max(cr - fy, 0, fy - (1 - cr));
      const inBounds = Math.sqrt(ax*ax + ay*ay) <= cr;

      let r, g, b, a;
      if (!inBounds) {
        r=0; g=0; b=0; a=0; // transparent outside
      } else {
        r=124; g=58; b=237; a=255; // purple bg
        // Lightning bolt (two triangles)
        const inUpper = inTri(fx,fy, 0.58,0.08, 0.22,0.54, 0.60,0.50);
        const inLower = inTri(fx,fy, 0.40,0.50, 0.78,0.92, 0.42,0.92);
        if (inUpper || inLower) { r=255; g=255; b=255; }
      }
      row[1 + x*4]   = r;
      row[1 + x*4+1] = g;
      row[1 + x*4+2] = b;
      row[1 + x*4+3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw);
  return Buffer.concat([sig, ihdr, makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
}

/* ── Build ICO with 16x16, 32x32, 48x48, 256x256 ── */
const SIZES = [16, 32, 48, 256];
const pngs = SIZES.map(s => makePNG(s));

// ICO header: 6 bytes
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);  // reserved
icoHeader.writeUInt16LE(1, 2);  // type: icon
icoHeader.writeUInt16LE(SIZES.length, 4); // image count

// Directory entries: 16 bytes each
const dirSize = SIZES.length * 16;
let offset = 6 + dirSize;

const dirs = [];
pngs.forEach((png, i) => {
  const s = SIZES[i];
  const entry = Buffer.alloc(16);
  entry[0] = s === 256 ? 0 : s;  // width (0 = 256)
  entry[1] = s === 256 ? 0 : s;  // height
  entry[2] = 0;  // color count
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);     // color planes
  entry.writeUInt16LE(32, 6);    // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  dirs.push(entry);
});

const icoData = Buffer.concat([icoHeader, ...dirs, ...pngs]);
const outPath = join(__dirname, 'icon.ico');
writeFileSync(outPath, icoData);
console.log(`Generated ${outPath} (${icoData.length} bytes) with sizes: ${SIZES.join(', ')}`);
