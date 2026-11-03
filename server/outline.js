import { requireThat } from './domain.js';

// MindManager text clipboard uses indentation: tabs or (in the supplied file) two spaces.
export function parseOutline(raw) {
  requireThat(typeof raw === 'string' && raw.length <= 512000, '貼り付ける文字が大きすぎます');
  requireThat(
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw),
    '貼り付ける文字に不正な制御文字があります',
  );
  const lines = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim());
  requireThat(lines.length > 0 && lines.length <= 500, 'トピックは1〜500件で貼り付けてください');
  const nodes = [],
    stack = [];
  let base;
  for (const line of lines) {
    const prefix = /^[ \t]*/.exec(line)[0];
    let indent = 0;
    for (const c of prefix) indent += c === '\t' ? 2 - (indent % 2) : 1;
    base ??= indent;
    requireThat(indent >= base, '先頭のトピックより浅いインデントがあります');
    indent -= base;
    const text = line.slice(prefix.length).trim();
    requireThat([...text].length <= 500, '各トピックは500文字以内です');
    while (stack.length && stack.at(-1).indent > indent) stack.pop();
    if (stack.length && stack.at(-1).indent === indent) stack.pop();
    else if (nodes.length && indent > 0) {
      // A deeper line belongs to the immediately preceding line; a dedent must
      // return to an indentation already used by its ancestors.
      requireThat(
        stack.at(-1)?.index === nodes.length - 1,
        'インデントの戻り位置を確認してください',
      );
    }
    requireThat(indent === 0 || stack.length, '親となるトピックがありません');
    nodes.push({ text, parentIndex: stack.length ? stack.at(-1).index : null });
    stack.push({ indent, index: nodes.length - 1 });
  }
  return nodes;
}
