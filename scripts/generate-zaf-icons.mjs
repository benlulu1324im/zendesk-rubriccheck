import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Pure-Node PNG encoder for razor-sharp Zendesk Marketplace icons:
// - logo.png: 320x320 opaque square (Zendesk Marketplace requires NO pre-rounded corners)
// - logo-small.png: 128x128 transparent PNG-24

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0; // filter None
    rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const t = c1 / c2;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function inShield(nx, ny) {
  // Normalized coordinates [-1, 1], shield centered
  if (ny < -0.58 || ny > 0.64) return false;
  if (ny < -0.34) {
    // Top peaked roof from (0, -0.58) to (+/-0.54, -0.34)
    const maxX = ((ny - -0.58) / (-0.34 - -0.58)) * 0.54;
    return Math.abs(nx) <= maxX;
  }
  if (ny <= 0.08) {
    return Math.abs(nx) <= 0.54;
  }
  // Curved bottom taper to (0, 0.64)
  const t = (ny - 0.08) / (0.64 - 0.08);
  const maxX = 0.54 * Math.cos((t * Math.PI) / 2) ** 0.85;
  return Math.abs(nx) <= maxX;
}

function renderBrandIcon(size, transparentBg) {
  const rgba = Buffer.alloc(size * size * 4);
  const bgR = 13, bgG = 92, bgB = 72; // #0D5C48 botanical forest
  const shieldFillR = 9, shieldFillG = 69, shieldFillB = 54;
  const whiteR = 255, whiteG = 255, whiteB = 255;
  const mintR = 124, mintG = 227, mintB = 196; // #7CE3C4

  const samples = 4; // 4x4 supersampling for crisp anti-aliasing
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = ((x + (sx + 0.5) / samples) / size) * 2 - 1;
          const ny = ((y + (sy + 0.5) / samples) / size) * 2 - 1;

          const d1 = distToSegment(nx, ny, -0.24, 0.03, -0.06, 0.22);
          const d2 = distToSegment(nx, ny, -0.06, 0.22, 0.28, -0.16);
          const checkDist = Math.min(d1, d2);

          const outer = inShield(nx, ny);
          const inner = inShield(nx * 1.15, ny * 1.15);

          let r = bgR, g = bgG, b = bgB, a = transparentBg ? 0 : 255;
          if (outer && !inner) {
            r = transparentBg ? bgR : whiteR;
            g = transparentBg ? bgG : whiteG;
            b = transparentBg ? bgB : whiteB;
            a = 255;
          } else if (inner) {
            r = transparentBg ? bgR : shieldFillR;
            g = transparentBg ? bgG : shieldFillG;
            b = transparentBg ? bgB : shieldFillB;
            a = 255;
          }
          if (checkDist < 0.068) {
            r = transparentBg ? whiteR : mintR;
            g = transparentBg ? whiteG : mintG;
            b = transparentBg ? whiteB : mintB;
            a = 255;
          }

          rAcc += r * (a / 255);
          gAcc += g * (a / 255);
          bAcc += b * (a / 255);
          aAcc += a;
        }
      }
      const total = samples * samples;
      const alpha = Math.round(aAcc / total);
      const idx = (y * size + x) * 4;
      if (alpha > 0) {
        const inv = 255 / aAcc;
        rgba[idx] = Math.min(255, Math.round(rAcc * inv));
        rgba[idx + 1] = Math.min(255, Math.round(gAcc * inv));
        rgba[idx + 2] = Math.min(255, Math.round(bAcc * inv));
      }
      rgba[idx + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.resolve('zaf-app', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'logo.png'), renderBrandIcon(320, false));
fs.writeFileSync(path.join(outDir, 'logo-small.png'), renderBrandIcon(128, true));
console.log('Generated zaf-app/assets/logo.png (320x320) and logo-small.png (128x128)');
