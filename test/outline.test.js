import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOutline } from '../server/outline.js';

test('MindManager: 添付のスペース形式を8件・4階層に復元し、重複文字を別項目として保持', () => {
  const text = readFileSync(
    new URL('../test-support/mindmanager-copy.txt', import.meta.url),
    'utf8',
  );
  const nodes = parseOutline(text);
  assert.deepEqual(
    nodes.map((n) => n.parentIndex),
    [null, 0, 1, 2, 2, 2, 1, 0],
  );
  assert.equal(nodes[0].text, 'サブトピック');
  assert.equal(nodes[7].text, '２段目のトピック＃２');
});
test('MindManager: TAB・スペース混在、CRLF、空行、共通字下げ、複数のルートを保持', () => {
  assert.deepEqual(
    parseOutline('\uFEFF\t親 topic\r\n\t\t子\r\n\t  同階層\r\n\r\n\t別の親\r\n').map((n) => [
      n.text,
      n.parentIndex,
    ]),
    [
      ['親 topic', null],
      ['子', 0],
      ['同階層', 0],
      ['別の親', null],
    ],
  );
});
test('MindManager: 不正な字下げ・空入力・上限超過を部分追加せず拒否', () => {
  for (const raw of [
    '',
    '  ',
    '  親\n子',
    '親\n    子\n  戻れない位置',
    'a\0b',
    'a'.repeat(501),
    'x\n'.repeat(501),
  ])
    assert.throws(() => parseOutline(raw));
});
