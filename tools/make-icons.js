"use strict";

/*
  Erzeugt die App-Icons von Travelfy (PNG) ohne Abhaengigkeiten:
  gelbe Sonne mit dunklem Papierflieger - dasselbe Motiv wie das Logo
  in der Kopfzeile und favicon.svg.

  Aufruf: node tools/make-icons.js   (schreibt nach public/icons/)
*/

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.join(__dirname, "..", "public", "icons");

const YELLOW = [0xF5, 0xC5, 0x18];
const RING = [0x9C, 0x74, 0x00];
const DARK = [0x2D, 0x29, 0x15];
const SHADE = [0x6A, 0x62, 0x44];
const CREAM = [0xFB, 0xF7, 0xE6];

// Papierflieger im 32er-Raster (wie das SVG-Logo)
const PLANE = [[6, 16.5], [25.5, 8], [20.5, 24], [15.3, 19.4], [12, 23], [12.4, 17.4]];
const WING = [[12.4, 17.4], [25.5, 8], [15.3, 19.4]];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Farbe an Punkt (u, v) im 32er-Raster; maskable = volle Flaeche, Motiv kleiner. */
function colorAt(u, v, { maskable, square }) {
  if (maskable) {
    // Sichere Zone: Motiv auf 70 % verkleinert, Hintergrund vollflaechig gelb
    const s = 0.7;
    const x = (u - 16) / s + 16;
    const y = (v - 16) / s + 16;
    if (inPolygon(x, y, WING)) return SHADE;
    if (inPolygon(x, y, PLANE)) return DARK;
    return YELLOW;
  }
  if (square) {
    // iOS: volle Flaeche (iOS rundet selbst), cremefarbener Rand
    const d = Math.hypot(u - 16, v - 16);
    if (d > 15) return CREAM;
  }
  const d = Math.hypot(u - 16, v - 16);
  if (d > 15) return null;
  if (d > 13.6) return RING;
  if (inPolygon(u, v, WING)) return SHADE;
  if (inPolygon(u, v, PLANE)) return DARK;
  return YELLOW;
}

function render(size, opts = {}) {
  const SS = 4; // Kantenglaettung durch Ueberabtastung
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // Filter: none
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size) * 32;
          const v = ((py + (sy + 0.5) / SS) / size) * 32;
          const c = colorAt(u, v, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const covered = a / 255;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = covered ? Math.round(r / covered) : 0;
      raw[o + 1] = covered ? Math.round(g / covered) : 0;
      raw[o + 2] = covered ? Math.round(b / covered) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, raw);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // Bittiefe
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "favicon-32.png": render(32),
  "icon-192.png": render(192),
  "icon-512.png": render(512),
  "icon-maskable-512.png": render(512, { maskable: true }),
  "apple-touch-icon.png": render(180, { square: true }),
};
for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`${name}: ${data.length} Bytes`);
}
