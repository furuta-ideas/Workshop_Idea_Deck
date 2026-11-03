import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePNG } from '../server/png.js';
import { testPNG } from '../test-support/fixtures.js';
test('PNGは16:9・構造・CRC・展開サイズを検証し、不正データを拒否', () => {
  const image = testPNG();
  assert.equal(validatePNG(image).width, 16);
  assert.equal(validatePNG(image).height, 9);
  assert.throws(() => validatePNG(testPNG(10, 10)));
  const b = Buffer.from(image, 'base64');
  b[30] ^= 1;
  assert.throws(() => validatePNG(b.toString('base64')));
  assert.throws(() => validatePNG('data:image/png;base64,' + image));
  assert.throws(() => validatePNG(image.slice(0, -20)));
});
