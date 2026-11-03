import { crc32, inflateSync } from 'node:zlib';
import { requireThat, Fault } from './domain.js';

export function validatePNG(base64) {
  requireThat(
    typeof base64 === 'string' &&
      base64.length < 11 * 1024 * 1024 &&
      /^[A-Za-z0-9+/=]+$/.test(base64),
    'PNGデータを確認してください',
  );
  const b = Buffer.from(base64, 'base64');
  requireThat(
    b.length > 45 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    'PNG画像のみ利用できます',
  );
  let pos = 8,
    width,
    height,
    depth,
    color,
    interlace,
    ended = false,
    palette = false;
  const compressed = [];
  while (pos < b.length) {
    requireThat(pos + 12 <= b.length, 'PNGの構造が不正です');
    const n = b.readUInt32BE(pos),
      type = b.toString('ascii', pos + 4, pos + 8);
    requireThat(
      n <= b.length - pos - 12 &&
        crc32(b.subarray(pos + 4, pos + 8 + n)) === b.readUInt32BE(pos + 8 + n),
      'PNGの整合性を確認できません',
    );
    if (pos === 8) {
      requireThat(type === 'IHDR' && n === 13, 'PNGヘッダーが不正です');
      width = b.readUInt32BE(pos + 8);
      height = b.readUInt32BE(pos + 12);
      depth = b[pos + 16];
      color = b[pos + 17];
      interlace = b[pos + 20];
      requireThat(
        width > 0 &&
          height > 0 &&
          width <= 8192 &&
          height <= 8192 &&
          Math.abs(width / height - 16 / 9) < 0.01,
        '画像は横16:9である必要があります',
      );
      requireThat(
        { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[
          color
        ]?.includes(depth) &&
          b[pos + 18] === 0 &&
          b[pos + 19] === 0 &&
          interlace <= 1,
        'PNG形式に対応していません',
      );
    } else requireThat(type !== 'IHDR', 'PNGヘッダーが重複しています');
    if (type === 'PLTE') palette = n > 0 && n % 3 === 0 && n <= 768;
    if (type === 'IDAT') compressed.push(b.subarray(pos + 8, pos + 8 + n));
    pos += n + 12;
    if (type === 'IEND') {
      requireThat(n === 0 && pos === b.length, 'PNGの末尾が不正です');
      ended = true;
      break;
    }
  }
  requireThat(
    ended && compressed.length && (color !== 3 || palette),
    'PNGの画像データがありません',
  );
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color],
    passes = interlace
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];
  const rows = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)),
      h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) {
      const row = Math.ceil((w * depth * channels) / 8) + 1;
      for (let i = 0; i < h; i++) rows.push(row);
      expected += row * h;
    }
  }
  requireThat(expected <= 64 * 1024 * 1024, '画像の展開サイズが大きすぎます');
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch {
    throw new Fault(400, 'PNGの画像データが不正です');
  }
  requireThat(decoded.length === expected, 'PNGの画素データが不正です');
  pos = 0;
  for (const row of rows) {
    requireThat(decoded[pos] <= 4, 'PNGのフィルターが不正です');
    pos += row;
  }
  return { base64: b.toString('base64'), width, height, createdAt: new Date().toISOString() };
}
