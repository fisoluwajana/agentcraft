// Minimal PNG encoder (8-bit RGB, no dependencies) plus a tiny pixel canvas for maps.
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 3x5 digits, one string per row, '#' = pixel.
const DIGITS = {
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '.##', '..#', '###'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
};

export class Canvas {
  constructor(w, h, bg = [0, 0, 0]) {
    this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x, y, c) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.px.set(c, (y * this.w + x) * 3); }
  get(x, y) { const i = (y * this.w + x) * 3; return [this.px[i], this.px[i + 1], this.px[i + 2]]; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  blend(x, y, c, a) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const o = this.get(x, y); this.set(x, y, o.map((v, k) => Math.round(v * (1 - a) + c[k] * a))); }
  line(x0, y0, x1, y1, c, a = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.blend(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c, a);
  }
  dot(x, y, r, c, ring = [255, 255, 255]) {
    for (let j = -r - 1; j <= r + 1; j++) for (let i = -r - 1; i <= r + 1; i++) {
      const d = Math.hypot(i, j);
      if (d <= r) this.set(x + i, y + j, c); else if (d <= r + 1) this.set(x + i, y + j, ring);
    }
  }
  // Number label on a dark box, scale s.
  label(x, y, n, s = 2, fg = [255, 255, 255], bg = [20, 20, 20]) {
    const str = String(n);
    const w = (str.length * 4 - 1) * s + 2 * s, h = 5 * s + 2 * s;
    this.rect(x, y, w, h, bg);
    [...str].forEach((ch, k) => DIGITS[ch]?.forEach((row, r) => [...row].forEach((p, c) => { if (p === '#') this.rect(x + s + (k * 4 + c) * s, y + s + r * s, s, s, fg); })));
    return { w, h };
  }
  png() { return encodePng(this.w, this.h, this.px); }
}
