import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newWorkshop, newTeam, id } from '../server/store.js';
import { Notion } from '../server/notion.js';
import { stageTitles } from '../server/notion-content.js';
import { totals } from '../server/domain.js';
import { readFileSync } from 'node:fs';
const rt = (text) => [{ type: 'text', text: { content: text }, plain_text: text }];
const text = (b) =>
  (b[b.type]?.rich_text || []).map((x) => x.text?.content || x.plain_text || '').join('');
function pause(f, match) {
  let enter, release;
  const ready = new Promise((r) => {
      enter = r;
    }),
    wait = new Promise((r) => {
      release = r;
    });
  f.state.gate = { match, enter, wait };
  return { ready, release };
}
async function queue(f, action, payload, now) {
  const w = f.store.get('workshops', f.ws.id);
  return f.n.content.change(
    { email: 'admin@example.test', admin: true },
    w.id,
    { action, payload, revision: w.revision, requestId: id() },
    { now },
  );
}
function fixture(t, legacy = false) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const block = (id, type, value, children = []) => ({
    id,
    type,
    [type]: {
      rich_text: rt(value),
      color: 'default',
      ...(type.startsWith('heading_') ? { is_toggleable: !id.startsWith('phase') } : {}),
    },
    children,
  });
  const roots = [
    block('unrelated', 'paragraph', '参加者一覧は保持'),
    ...stageTitles.flatMap((s, i) => [
      block('phase' + (i + 1), 'heading_2', s),
      ...(i === 0
        ? [
            block('main', 'heading_2', 'メイン', [
              block('first', 'heading_3', '1階層', [
                block('second', 'heading_4', '2階層', [
                  block('third', 'toggle', '3階層', [
                    block('fourth', 'toggle', 'さらに深い階層'),
                    block('detail', 'bulleted_list_item', '箇条書きも保持'),
                  ]),
                ]),
              ]),
            ]),
          ]
        : []),
    ]),
  ];
  if (!legacy) {
    const main = roots[2];
    const toggle = (b) => {
      const content = b[b.type];
      delete b[b.type];
      b.type = 'toggle';
      b.toggle = { rich_text: content.rich_text, color: content.color };
      b.children.forEach(toggle);
    };
    toggle(main);
    roots.splice(2, 1, block('team-a', 'toggle', 'チーム：A班', [main]));
  }
  const state = { roots, calls: [], version: 1, failPatch: false, loseAppend: false };
  const find = (id) => {
    let found;
    const visit = (list) => {
      for (const b of list) {
        if (b.id === id) found = b;
        visit(b.children);
      }
    };
    visit(roots);
    return found;
  };
  const serial = (b) => {
    const c = structuredClone(b);
    delete c.children;
    c.has_children = b.children.length > 0;
    return c;
  };
  const transport = async (url, options) => {
    const path = new URL(url).pathname.replace('/v1/', ''),
      body = options.body && JSON.parse(options.body),
      method = options.method;
    state.calls.push({ path, method, body });
    if (state.gate?.match({ path, method, body })) {
      const gate = state.gate;
      state.gate = null;
      gate.enter();
      await gate.wait;
    }
    if (path === 'pages/page')
      return {
        ok: true,
        json: async () => ({ id: 'page', last_edited_time: 'v' + state.version }),
      };
    const m = /^blocks\/([^/]+)(\/children)?$/.exec(path);
    assert.ok(m, path);
    const [, key, child] = m;
    const b = find(key),
      list = key === 'page' ? roots : b?.children;
    let data;
    if (method === 'GET')
      data = child ? { results: list.filter((x) => !x.archived).map(serial) } : serial(b);
    else if (child) {
      const created = body.children.map((value) => {
        const next = { ...structuredClone(value), id: id(), children: [] };
        next[next.type].color ||= 'default';
        list.push(next);
        return next;
      });
      const pos = body.position;
      for (const n of created) {
        list.splice(list.indexOf(n), 1);
        const at =
          pos?.type === 'start'
            ? 0
            : pos?.type === 'after_block'
              ? list.findIndex((x) => x.id === pos.after_block.id) + 1
              : list.length;
        list.splice(at, 0, n);
      }
      state.version++;
      state.appendCount = (state.appendCount || 0) + 1;
      if (state.loseAppend || state.loseAppendAt === state.appendCount) {
        state.loseAppend = false;
        throw Error('response lost after commit');
      }
      data = { results: state.appendReadback ? [] : created.map(serial) };
    } else {
      if (state.failPatch) {
        state.failPatch = false;
        return { ok: false, status: 503 };
      }
      if (body.archived !== undefined) return { ok: false, status: 400 };
      if (body.in_trash) b.archived = true;
      else if (body[b.type]) b[b.type] = { ...b[b.type], ...structuredClone(body[b.type]) };
      else Object.assign(b, structuredClone(body));
      state.version++;
      if (state.losePatch) {
        state.losePatch = false;
        throw Error('response lost after patch');
      }
      data = serial(b);
    }
    return { ok: true, status: 200, json: async () => data };
  };
  const n = new Notion(store, { notionToken: 'test-only', notionSource: 'master' }, transport),
    ws = newWorkshop('同期テスト', 'admin@example.test'),
    team = Object.values(ws.teams)[0],
    other = newTeam('B班');
  ws.teams[other.id] = other;
  team.nodes = [{ id: 'old', text: '以前のアプリ内容', parent: null, group: 0 }];
  ws.notion = { pageId: 'page', baseEdited: 'v1', checkedAt: Date.now() };
  store.put('workshops', ws.id, ws);
  const load = async () => {
    let w = store.get('workshops', ws.id);
    await n.content.pull(w, 'v' + state.version, true);
    return store.get('workshops', w.id);
  };
  const change = async (action, payload) => {
    const w = store.get('workshops', ws.id);
    return n.content.change(
      { email: 'admin@example.test', admin: true },
      w.id,
      {
        action,
        payload,
        revision: w.revision,
        requestId: id(),
      },
      { immediate: true },
    );
  };
  return { store, n, ws, team, other, state, find, load, change };
}
test('Notion本文: MindManager貼付けを一括予約し、Notionのトグルと再読込みでも8項目の階層を保持', async (t) => {
  const f = fixture(t);
  const original = await f.load();
  const calls = f.state.calls.length;
  const copied = readFileSync(
    new URL('../test-support/mindmanager-copy.txt', import.meta.url),
    'utf8',
  );
  let w = await queue(
    f,
    'pasteOutline',
    { teamId: f.team.id, anchorId: 'main', placement: 'child', text: copied },
    1000,
  );
  assert.equal(f.state.calls.length, calls);
  assert.equal(w.documentSync.generation, 1);
  const inserted = w.teams[f.team.id].nodes.filter(
    (n) => !original.teams[f.team.id].nodes.some((old) => old.id === n.id),
  );
  assert.equal(inserted.length, 8);
  const expected = inserted.map((n) => ({ id: n.id, text: n.text, parent: n.parent }));
  w = await f.n.content.flushScheduled(w.id, 11001);
  assert.equal(w.documentSync.error, null);
  assert.ok(
    expected.every((n) => w.teams[f.team.id].nodes.find((x) => x.id === n.id).notionBlockId),
  );
  w = await f.load();
  assert.deepEqual(
    w.teams[f.team.id].nodes
      .filter((n) => expected.some((x) => x.id === n.id))
      .map((n) => ({ id: n.id, text: n.text, parent: n.parent })),
    expected,
  );
});

test('Notion上下移動: トグルの兄弟順と子孫・論理ID・票を保ち、再送と新規取込みでも復元', async (t) => {
  const f = fixture(t);
  await f.load();
  let w = await queue(
    f,
    'pasteOutline',
    { teamId: f.team.id, anchorId: 'theme', placement: 'child', text: 'A\n\tA子\nB\n\tB子\nC' },
    1000,
  );
  w = await f.n.content.flushScheduled(w.id, 11001);
  const byText = (text) => w.teams[f.team.id].nodes.find((n) => n.text === text),
    a = byText('A'),
    b = byText('B'),
    c = byText('C');
  const originalB = b.notionBlockId;
  w.votes.cards['admin@example.test'] = { [c.id]: 2 };
  w.teams[f.team.id].deck = [c.id];
  f.store.put('workshops', w.id, w);
  w = await queue(
    f,
    'reorderTopic',
    { teamId: f.team.id, id: c.id, targetId: a.id, position: 'before' },
    12000,
  );
  const expected = w.teams[f.team.id].nodes.map(({ id, text, parent }) => ({ id, text, parent }));
  f.state.loseAppend = true;
  w = await f.n.content.flushScheduled(w.id, 22001);
  assert.ok(w.documentSync.error);
  await f.n.content.requestRetry(w.id, 23000);
  w = await f.n.content.flushScheduled(w.id, 23001);
  assert.equal(w.documentSync.error, null);
  assert.deepEqual(
    f
      .find('team-a')
      .children.filter((n) => !n.archived)
      .map(text),
    ['メイン', 'C', 'A', 'B'],
  );
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === b.id).notionBlockId, originalB);
  assert.equal(
    (await f.n.content.read(w)).sections[1].roots
      .find((n) => n.id === 'team-a')
      .children.filter((n) => text(n) === 'C').length,
    1,
  );
  const imported = structuredClone(w);
  imported.teams[f.team.id].nodes = [];
  f.store.put('workshops', w.id, imported);
  f.store.del('kv', `notion-content:${w.id}`);
  w = await f.load();
  assert.deepEqual(
    w.teams[f.team.id].nodes.map(({ id, text, parent }) => ({ id, text, parent })),
    expected,
  );
});

test('Notion取消: 10秒待機中の枝削除を戻すと子孫を保持し、Notionへ削除を送らない', async (t) => {
  const f = fixture(t),
    original = await f.load();
  await queue(f, 'deleteNode', { teamId: f.team.id, id: 'first' }, 1000);
  let w = await queue(f, 'undoMap', { teamId: f.team.id }, 2000);
  assert.deepEqual(w.teams[f.team.id].nodes, original.teams[f.team.id].nodes);
  w = await f.n.content.flushScheduled(w.id, 12001);
  assert.equal(w.documentSync.error, null);
  assert.equal(
    f.state.calls.some((c) => c.body?.in_trash),
    false,
  );
});

test('Notion取消: 削除送信中にCtrl+Z相当を保存し、次の背景送信で同じ論理IDと階層を復元', async (t) => {
  const f = fixture(t),
    original = await f.load();
  const logical = (w) =>
    w.teams[f.team.id].nodes.map(({ id, text, parent, group }) => ({ id, text, parent, group }));
  let w = await queue(f, 'deleteNode', { teamId: f.team.id, id: 'first' }, 1000);
  const gate = pause(f, (c) => c.method === 'PATCH' && c.body?.in_trash);
  const sending = f.n.content.flushScheduled(w.id, 11001);
  await gate.ready;
  w = await queue(f, 'undoMap', { teamId: f.team.id }, 12000);
  assert.deepEqual(logical(w), logical(original));
  gate.release();
  await sending;
  w = f.store.get('workshops', w.id);
  assert.equal(w.documentSync.queued, true);
  assert.deepEqual(logical(w), logical(original));
  w = await f.n.content.flushScheduled(w.id, 22001);
  assert.equal(w.documentSync.error, null);
  assert.notEqual(w.teams[f.team.id].nodes.find((n) => n.id === 'first').notionBlockId, 'first');
  assert.deepEqual(logical(await f.load()), logical(original));
});

test('Notion本文: 見出し2/3/4/トグル・箇条書きの階層を起動時に取り込み、旧ローカル内容をバックアップ', async (t) => {
  const f = fixture(t, true),
    w = await f.load(),
    nodes = w.teams[f.team.id].nodes;
  assert.equal(w.documentSync.error, null);
  assert.equal(nodes.length, 6);
  assert.equal(nodes[0].parent, 'theme');
  assert.equal(nodes.find((n) => n.id === 'first').parent, 'main');
  assert.equal(nodes.find((n) => n.id === 'second').parent, 'first');
  assert.equal(nodes.find((n) => n.id === 'third').parent, 'second');
  assert.equal(nodes.find((n) => n.id === 'detail').parent, 'third');
  assert.equal(w.teams[f.other.id].nodes.length, 0);
  assert.equal(
    f.store.get('kv', `notion-import-backup:${w.id}:${f.team.id}`).team.nodes[0].id,
    'old',
  );
  assert.equal(f.state.calls.filter((c) => c.method !== 'GET').length, 0);
  const rev = w.revision;
  assert.equal((await f.load()).revision, rev);
});
test('Notion本文: アプリの文字・追加・枝移動・削除を即時反映し、IDと子を保護。②③④にメール・個票を書かない', async (t) => {
  const f = fixture(t);
  await f.load();
  let w = await f.change('node', { teamId: f.team.id, id: 'first', text: '編集した1階層' });
  assert.equal(w.documentSync.error, null);
  assert.equal(text(f.find('first')), '編集した1階層');
  w = await f.change('createTopic', {
    teamId: f.team.id,
    anchorId: 'main',
    placement: 'child',
    text: '新しい子',
  });
  assert.equal(w.documentSync.error, null);
  const node = w.teams[f.team.id].nodes.find((n) => n.text === '新しい子');
  assert.ok(node.notionBlockId);
  assert.equal(f.find('main').children.at(-1).id, node.notionBlockId);
  w = await f.change('reparent', { teamId: f.team.id, id: 'third', parent: 'main' });
  assert.equal(w.documentSync.error, null);
  assert.equal(f.find('third').archived, true);
  const moved = w.teams[f.team.id].nodes.find((n) => n.id === 'third');
  assert.notEqual(moved.notionBlockId, 'third');
  assert.equal(f.find(moved.notionBlockId).children.length, 2);
  w = await f.change('deleteNode', { teamId: f.team.id, id: 'third' });
  assert.equal(w.documentSync.error, null);
  assert.equal(
    w.teams[f.team.id].nodes.some((n) => n.id === 'fourth'),
    false,
  );
  assert.equal(text(f.find('unrelated')), '参加者一覧は保持');
  const codes = f.n.content.all(f.n.content.state(w).doc).filter((b) => b.type === 'code');
  assert.equal(codes.length, 6);
  for (const code of codes) {
    assert.ok(JSON.parse(text(code)).schema);
    assert.doesNotMatch(text(code), /@example\.test/);
  }
});
test('Notion本文: 外部編集を再読込みし、不正JSONは全体を巻き戻して保護', async (t) => {
  const f = fixture(t);
  await f.load();
  let w = await f.change('discussion', { teamId: f.team.id, what: 'アプリの案' });
  assert.equal(w.documentSync.error, null);
  f.find('first').toggle.rich_text = rt('Notionで編集した案');
  f.state.version++;
  w = await f.load();
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, 'Notionで編集した案');
  const code = f.n.content.record(f.n.content.state(w).doc, w.teams[f.team.id], 3).code;
  f.find(code.id).code.rich_text = rt('{invalid');
  f.find('first').toggle.rich_text = rt('この変更も適用しない');
  f.state.version++;
  const before = structuredClone(w.teams);
  w = await f.load();
  assert.match(w.documentSync.error, /JSON/);
  assert.deepEqual(w.teams, before);
});
test('Notion本文: Notionで変更された同一トピックを上書きせず409で新内容を取り込む', async (t) => {
  const f = fixture(t);
  await f.load();
  f.find('first').toggle.rich_text = rt('外部の変更');
  f.state.version++;
  await assert.rejects(
    () => f.change('node', { teamId: f.team.id, id: 'first', text: '上書き不可' }),
    (e) => e.status === 409,
  );
  assert.equal(text(f.find('first')), '外部の変更');
  assert.equal(
    f.store.get('workshops', f.ws.id).teams[f.team.id].nodes.find((n) => n.id === 'first').text,
    '外部の変更',
  );
});
test('Notion本文: 送信失敗はローカル保存と未同期表示を維持し、再同期で回復。追加の応答消失も重複させない', async (t) => {
  const f = fixture(t);
  await f.load();
  f.state.failPatch = true;
  let w = await f.change('node', { teamId: f.team.id, id: 'first', text: '未同期の案' });
  assert.equal(w.documentSync.pending, true);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, '未同期の案');
  await f.n.content.pull(w, 'v100', true);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, '未同期の案');
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.pending, false);
  f.state.loseAppend = true;
  w = await f.change('createTopic', {
    teamId: f.team.id,
    anchorId: 'main',
    placement: 'child',
    text: '追加は一度だけ',
  });
  assert.equal(w.documentSync.pending, true);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.error, null);
  assert.equal(f.find('main').children.filter((b) => text(b) === '追加は一度だけ').length, 1);
});
test('Notion記録: 合計票とデッキ・議論をNotionから復元し、個票と二重に集計しない', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  w = await f.change('discussion', { teamId: f.team.id, what: '最初の案' });
  const snapshot = f.n.content.state(w).doc,
    team = w.teams[f.team.id],
    p2 = f.n.content.record(snapshot, team, 2).code,
    p3 = f.n.content.record(snapshot, team, 3).code,
    p4 = f.n.content.record(snapshot, team, 4).code;
  const record2 = JSON.parse(text(p2));
  record2.totals = { main: 7 };
  record2.deck = ['main'];
  f.find(p2.id).code.rich_text = rt(JSON.stringify(record2));
  const record3 = JSON.parse(text(p3));
  record3.discussion.what = 'Notionの議論';
  f.find(p3.id).code.rich_text = rt(JSON.stringify(record3));
  const record4 = JSON.parse(text(p4));
  record4.totalVotes = 4;
  f.find(p4.id).code.rich_text = rt(JSON.stringify(record4));
  f.state.version++;
  w = await f.load();
  assert.equal(totals(w, 'cards').main, 7);
  assert.deepEqual(w.teams[f.team.id].deck, ['main']);
  assert.equal(w.teams[f.team.id].discussion.what, 'Notionの議論');
  assert.equal(totals(w, 'ideas')[team.id], 4);
  w.timers.cards = { endsAt: Date.now() + 60000 };
  f.store.put('workshops', w.id, w);
  w = await f.change('vote', { phase: 'cards', target: 'main', delta: 1 });
  assert.equal(totals(w, 'cards').main, 8);
  w = await f.load();
  assert.equal(totals(w, 'cards').main, 8);
});

test('Notion本文: 更新応答の消失を再確認して回復し、新しいDBでも論理ID・デッキを復元する', async (t) => {
  const f = fixture(t);
  await f.load();
  f.state.losePatch = true;
  let w = await f.change('node', { teamId: f.team.id, id: 'first', text: '応答だけ消失' });
  assert.equal(w.documentSync.pending, true);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.error, null);
  w = await f.change('createTopic', {
    teamId: f.team.id,
    anchorId: 'main',
    placement: 'child',
    text: '復元する追加カード',
  });
  const node = w.teams[f.team.id].nodes.find((n) => n.text === '復元する追加カード'),
    p2 = f.n.content.record(f.n.content.state(w).doc, w.teams[f.team.id], 2).code,
    r = JSON.parse(text(p2));
  r.totals[node.id] = 3;
  r.deck = [node.id];
  f.find(p2.id).code.rich_text = rt(JSON.stringify(r));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const notion = new Notion(store, f.n.config, f.n.transport),
    fresh = newWorkshop('再起動', 'admin@example.test');
  fresh.notion = { pageId: 'page', checkedAt: Date.now() };
  await notion.content.pull(fresh, 'new', true);
  assert.equal(fresh.documentSync.error, null);
  const restored = Object.values(fresh.teams)[0];
  assert.equal(restored.nodes.find((n) => n.text === '復元する追加カード').id, node.id);
  assert.deepEqual(restored.deck, [node.id]);
  assert.equal(totals(fresh, 'cards')[node.id], 3);
});

test('Notion本文: 追加応答にブロックがない場合も実際の子一覧から照合して二重作成しない', async (t) => {
  const f = fixture(t);
  await f.load();
  f.state.appendReadback = true;
  let w = await f.change('createTopic', {
    teamId: f.team.id,
    anchorId: 'main',
    placement: 'child',
    text: '読返しで特定する',
  });
  assert.equal(w.documentSync.error, null);
  assert.equal(f.find('main').children.filter((b) => text(b) === '読返しで特定する').length, 1);
  w = await f.load();
  assert.equal(w.documentSync.error, null);
});

test('Notion本文: 削除は現行APIのin_trash指定を使い、旧archived指定を送信しない', async (t) => {
  const f = fixture(t);
  await f.load();
  const w = await f.change('deleteNode', { teamId: f.team.id, id: 'fourth' });
  assert.equal(w.documentSync.error, null);
  assert.ok(f.state.calls.some((c) => c.body?.in_trash === true));
  assert.ok(f.state.calls.every((c) => c.body?.archived === undefined));
  assert.equal(f.find('fourth').archived, true);
});

test('Notion本文: 枝移動の旧コピー整理だけが失敗しても、再試行で論理IDと子孫を保つ', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  const ids = w.teams[f.team.id].nodes.map((n) => n.id).sort();
  f.state.failPatch = true;
  w = await f.change('reparent', { teamId: f.team.id, id: 'third', parent: 'main' });
  assert.equal(w.documentSync.pending, true);
  assert.ok(f.n.content.state(w).archiveAttempt);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.pending, false);
  assert.deepEqual(w.teams[f.team.id].nodes.map((n) => n.id).sort(), ids);
  w = await f.load();
  assert.deepEqual(w.teams[f.team.id].nodes.map((n) => n.id).sort(), ids);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'third').parent, 'main');
});

test('Notion本文: 省略した色・書式をAPIが保持しても、自分の保存を外部変更と誤判定しない', async (t) => {
  const f = fixture(t);
  await f.load();
  let w = await f.change('createTopic', {
    teamId: f.team.id,
    anchorId: 'main',
    placement: 'child',
    text: '往復確認',
  });
  assert.equal(w.documentSync.error, null);
  const node = w.teams[f.team.id].nodes.find((n) => n.text === '往復確認');
  let revision = w.revision;
  w = await f.load();
  assert.equal(w.revision, revision);
  w = await f.change('node', { teamId: f.team.id, id: node.id, text: '更新した往復確認' });
  revision = w.revision;
  w = await f.load();
  assert.equal(w.revision, revision);
  w = await f.change('deleteNode', { teamId: f.team.id, id: node.id });
  assert.equal(w.documentSync.error, null);
  assert.ok(!w.teams[f.team.id].nodes.some((n) => n.id === node.id));
});

test('Notion本文: 旧見出しをチーム別のトグルだけに移行し、本文・論理ID・階層・投票・デッキを保つ', async (t) => {
  const f = fixture(t, true);
  let w = await f.load();
  const original = w.teams[f.team.id].nodes.map(({ notionBlockId, ...n }) => n);
  w.teams[f.team.id].deck = ['main'];
  w.notionVoteBaseline = { cards: { main: 2 }, ideas: {} };
  f.store.put('workshops', w.id, w);
  w = await f.n.content.push(w);
  assert.equal(w.documentSync.error, null);
  const doc = f.n.content.state(w).doc;
  assert.equal(doc.sections[1].roots.length, 2);
  const check = (b) => {
    assert.equal(b.type, 'toggle');
    b.children.forEach(check);
  };
  doc.sections[1].roots.forEach(check);
  assert.deepEqual(doc.sections[1].roots.map(text), ['チーム：A班', 'チーム：B班']);
  assert.equal(f.find('main').archived, true);
  assert.equal(text(f.find('unrelated')), '参加者一覧は保持');
  w = await f.load();
  assert.deepEqual(
    w.teams[f.team.id].nodes.map(({ notionBlockId, ...n }) => n),
    original,
  );
  assert.deepEqual(w.teams[f.team.id].deck, ['main']);
  assert.equal(totals(w, 'cards').main, 2);
  const writes = f.state.calls.filter((c) => c.method !== 'GET').length;
  w = await f.n.content.push(w);
  assert.equal(w.documentSync.error, null);
  assert.equal(f.state.calls.filter((c) => c.method !== 'GET').length, writes);
  const freshStore = new Store(':memory:');
  t.after(() => freshStore.close());
  const freshNotion = new Notion(freshStore, f.n.config, f.n.transport),
    fresh = newWorkshop('再取込み', 'admin@example.test');
  fresh.notion = { pageId: 'page', checkedAt: Date.now() };
  await freshNotion.content.pull(fresh, 'after-migration', true);
  assert.equal(fresh.documentSync.error, null);
  const restored = Object.values(fresh.teams)[0];
  assert.deepEqual(
    restored.nodes.map(({ notionBlockId, ...n }) => n),
    original,
  );
  assert.deepEqual(restored.deck, ['main']);
  assert.equal(totals(fresh, 'cards').main, 2);
});

test('Notion本文: トグル移行の途中で追加応答を失っても、再開で重複せず全階層を保持する', async (t) => {
  const f = fixture(t, true);
  let w = await f.load();
  const original = w.teams[f.team.id].nodes.map(({ notionBlockId, ...n }) => n);
  f.state.loseAppendAt = 3;
  w = await f.n.content.push(w);
  assert.equal(w.documentSync.pending, true);
  assert.ok(f.n.content.state(w).attempt);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.error, null);
  w = await f.load();
  assert.deepEqual(
    w.teams[f.team.id].nodes.map(({ notionBlockId, ...n }) => n),
    original,
  );
  assert.equal(
    f.n.content.teamRoots(w, f.n.content.state(w).doc, w.teams[f.team.id]).roots.length,
    1,
  );
  assert.equal(
    f.n.content.all(f.n.content.state(w).doc).filter((b) => text(b) === '1階層').length,
    1,
  );
});

test('Notion本文: トグルの各チームを別のマップに読み、空チームにも専用のトグルを作る', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  w = await f.n.content.push(w);
  const doc = f.n.content.state(w).doc,
    otherRoot = doc.sections[1].roots.find((b) => text(b) === 'チーム：B班');
  assert.ok(otherRoot);
  f.find(otherRoot.id).children.push({
    id: 'b-topic',
    type: 'toggle',
    toggle: { rich_text: rt('B班専用'), color: 'default' },
    children: [],
  });
  f.state.version++;
  w = await f.load();
  assert.equal(w.teams[f.other.id].nodes[0].text, 'B班専用');
  assert.equal(w.teams[f.other.id].nodes[0].parent, 'theme');
  assert.ok(!w.teams[f.team.id].nodes.some((n) => n.text === 'B班専用'));
});

test('Notion待機同期: 操作はAPI通信なしで保存し、最後の変更から10秒経過後だけ最新内容を送信する', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  const user = { email: 'admin@example.test', admin: true },
    change = async (value, now) => {
      w = await f.n.content.change(
        user,
        w.id,
        {
          action: 'node',
          payload: { teamId: f.team.id, id: 'first', text: value },
          revision: w.revision,
          requestId: id(),
        },
        { now },
      );
    };
  const calls = f.state.calls.length;
  await change('最初の編集', 1000);
  assert.equal(w.documentSync.dueAt, 11000);
  assert.equal(w.documentSync.queued, true);
  assert.equal(f.state.calls.length, calls);
  assert.equal(
    f.store.get('workshops', w.id).teams[f.team.id].nodes.find((n) => n.id === 'first').text,
    '最初の編集',
  );
  await change('まとめて保存する最終版', 9000);
  assert.equal(w.documentSync.dueAt, 19000);
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.n.content.due(18999), undefined);
  await f.n.content.flushScheduled(w.id, 18999);
  assert.equal(f.state.calls.length, calls);
  await f.n.content.pull(w, 'external-version', true);
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.n.content.due(19000).id, w.id);
  w = await f.n.content.flushScheduled(w.id, 19000);
  assert.equal(w.documentSync.pending, false);
  assert.equal(text(f.find('first')), 'まとめて保存する最終版');
  assert.equal(
    f.state.calls.filter((c) => c.method === 'PATCH' && c.path === 'blocks/first').length,
    1,
  );
  const after = f.state.calls.length;
  await f.n.content.flushScheduled(w.id, 30000);
  assert.equal(f.state.calls.length, after);
});

test('Notion待機同期: 入力中の活動で待機を延長し、再送と権限違反で不要な延長をしない', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  const user = { email: 'admin@example.test', admin: true },
    body = {
      action: 'node',
      payload: { teamId: f.team.id, id: 'first', text: '編集中' },
      revision: w.revision,
      requestId: id(),
    };
  w = await f.n.content.change(user, w.id, body, { now: 1000 });
  w = await f.n.content.change(user, w.id, body, { now: 9000 });
  assert.equal(w.documentSync.dueAt, 11000);
  const calls = f.state.calls.length;
  const revision = w.revision;
  f.n.content.activity(user, w.id, f.team.id, 10000);
  w = f.store.get('workshops', w.id);
  assert.equal(w.documentSync.dueAt, 20000);
  assert.equal(w.revision, revision);
  assert.equal(f.state.calls.length, calls);
  assert.throws(
    () => f.n.content.activity(user, w.id, f.other.id, 15000),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () =>
      f.n.content.change(
        user,
        w.id,
        {
          ...body,
          requestId: id(),
          revision: w.revision,
          payload: { teamId: f.other.id, text: '越境', id: 'bad' },
        },
        { now: 16000 },
      ),
    (e) => e.status === 403,
  );
  assert.equal(f.store.get('workshops', w.id).documentSync.dueAt, 20000);
});

test('Notion待機同期: 同期待ち中に作成して削除したトピックはNotionに作成しない', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  const user = { email: 'admin@example.test', admin: true };
  w = await f.n.content.change(
    user,
    w.id,
    {
      action: 'createTopic',
      payload: { teamId: f.team.id, anchorId: 'main', placement: 'child', text: '一時入力' },
      revision: w.revision,
      requestId: id(),
    },
    { now: 1000 },
  );
  const node = w.teams[f.team.id].nodes.find((n) => n.text === '一時入力');
  w = await f.n.content.change(
    user,
    w.id,
    {
      action: 'deleteNode',
      payload: { teamId: f.team.id, id: node.id },
      revision: w.revision,
      requestId: id(),
    },
    { now: 2000 },
  );
  w = await f.n.content.flushScheduled(w.id, 12000);
  assert.equal(w.documentSync.pending, false);
  assert.ok(!f.state.calls.some((c) => JSON.stringify(c.body || {}).includes('一時入力')));
});

test('Notion待機同期: 通信失敗は入力を保持し自動再送を止め、再試行で回復する', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  w = await f.n.content.change(
    { email: 'admin@example.test', admin: true },
    w.id,
    {
      action: 'node',
      payload: { teamId: f.team.id, id: 'first', text: '失敗しても保存済み' },
      revision: w.revision,
      requestId: id(),
    },
    { now: 1000 },
  );
  f.state.failPatch = true;
  w = await f.n.content.flushScheduled(w.id, 11000);
  assert.equal(w.documentSync.pending, true);
  assert.equal(w.documentSync.queued, true);
  assert.equal(w.documentSync.syncing, false);
  assert.ok(w.documentSync.error);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, '失敗しても保存済み');
  assert.equal(f.n.content.due(90000), undefined);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.pending, false);
  assert.equal(text(f.find('first')), '失敗しても保存済み');
});

test('Notion待機同期: 再起動でも予約を失わず、送信途中の状態を10秒待機へ復旧する', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  w = await f.n.content.change(
    { email: 'admin@example.test', admin: true },
    w.id,
    {
      action: 'node',
      payload: { teamId: f.team.id, id: 'first', text: '再起動前の編集' },
      revision: w.revision,
      requestId: id(),
    },
    { now: 1000 },
  );
  const restarted = new Notion(f.store, f.n.config, f.n.transport);
  restarted.content.recoverScheduled(5000);
  assert.equal(restarted.content.due(11000).id, w.id);
  w.documentSync = { ...w.documentSync, queued: false, syncing: true };
  f.store.put('workshops', w.id, w);
  restarted.content.recoverScheduled(20000);
  assert.equal(restarted.content.due(29999), undefined);
  w = await restarted.content.flushScheduled(w.id, 30000);
  assert.equal(w.documentSync.pending, false);
  assert.equal(text(f.find('first')), '再起動前の編集');
});

test('Notion待機同期: 同期待ちの間のNotion外部更新は上書きせずローカル編集を保持する', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  w = await f.n.content.change(
    { email: 'admin@example.test', admin: true },
    w.id,
    {
      action: 'node',
      payload: { teamId: f.team.id, id: 'first', text: 'ローカルの編集' },
      revision: w.revision,
      requestId: id(),
    },
    { now: 1000 },
  );
  f.find('first').toggle.rich_text = rt('Notionからの編集');
  f.state.version++;
  w = await f.n.content.flushScheduled(w.id, 11000);
  assert.match(w.documentSync.error, /別途更新/);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, 'ローカルの編集');
  assert.equal(text(f.find('first')), 'Notionからの編集');
  assert.equal(f.n.content.due(90000), undefined);
});

test('Notionバックグラウンド: 送信を止めたまま追加・編集・移動・削除を保存し、完了しても新しい編集を消さない', async (t) => {
  const f = fixture(t);
  await f.load();
  await queue(f, 'node', { teamId: f.team.id, id: 'first', text: '送信開始時の内容' }, 1000);
  const sending = pause(f, (c) => c.method === 'PATCH' && c.path === 'blocks/first');
  const job = f.n.content.flushScheduled(f.ws.id, 11000);
  await sending.ready;
  const calls = f.state.calls.length;
  let w = await queue(
    f,
    'createTopic',
    { teamId: f.team.id, anchorId: 'main', placement: 'child', text: '送信中の追加' },
    12000,
  );
  const created = w.teams[f.team.id].nodes.find((n) => n.text === '送信中の追加');
  await queue(f, 'node', { teamId: f.team.id, id: 'first', text: '送信中に変更した最新版' }, 12100);
  await queue(f, 'reparent', { teamId: f.team.id, id: 'second', parent: 'main' }, 12200);
  w = await queue(f, 'deleteNode', { teamId: f.team.id, id: 'fourth' }, 12300);
  assert.equal(f.state.calls.length, calls);
  assert.equal(w.documentSync.syncing, true);
  const revision = w.revision;
  sending.release();
  await job;
  w = f.store.get('workshops', w.id);
  assert.equal(w.revision, revision);
  assert.equal(
    w.teams[f.team.id].nodes.find((n) => n.id === 'first').text,
    '送信中に変更した最新版',
  );
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'second').parent, 'main');
  assert.ok(!w.teams[f.team.id].nodes.some((n) => n.id === 'fourth'));
  assert.ok(w.teams[f.team.id].nodes.some((n) => n.id === created.id));
  assert.equal(w.documentSync.pending, true);
  assert.equal(text(f.find('first')), '送信開始時の内容');
  w = await f.n.content.flushScheduled(w.id, 22300);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.pending, false);
  assert.equal(text(f.find('first')), '送信中に変更した最新版');
  assert.ok(w.teams[f.team.id].nodes.find((n) => n.id === created.id).notionBlockId);
  const restored = await f.load();
  assert.deepEqual(restored.teams, w.teams);
});

test('Notionバックグラウンド: 通信失敗後も編集を保存し、旧送信を回復してから最新版をまとめて送る', async (t) => {
  const f = fixture(t);
  await f.load();
  await queue(f, 'node', { teamId: f.team.id, id: 'first', text: '失敗する送信の内容' }, 1000);
  const gate = pause(f, (c) => c.method === 'PATCH' && c.path === 'blocks/first');
  f.state.failPatch = true;
  const job = f.n.content.flushScheduled(f.ws.id, 11000);
  await gate.ready;
  await queue(f, 'node', { teamId: f.team.id, id: 'first', text: '失敗中にも入力した内容' }, 12000);
  gate.release();
  await job;
  let w = await queue(
    f,
    'node',
    { teamId: f.team.id, id: 'third', text: '障害中にも編集を継続' },
    13000,
  );
  assert.ok(w.documentSync.error);
  assert.equal(f.n.content.due(50000), undefined);
  w = await f.n.content.retry(w);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.pending, true);
  assert.equal(
    w.teams[f.team.id].nodes.find((n) => n.id === 'first').text,
    '失敗中にも入力した内容',
  );
  w = await f.n.content.flushScheduled(w.id, 50000);
  assert.equal(w.documentSync.pending, false);
  assert.equal(text(f.find('first')), '失敗中にも入力した内容');
  assert.equal(text(f.find('third')), '障害中にも編集を継続');
});

test('Notionバックグラウンド: 追加応答消失後の新編集を、再起動・回復で重複させず保持する', async (t) => {
  const f = fixture(t);
  await f.load();
  let w = await queue(
    f,
    'createTopic',
    { teamId: f.team.id, anchorId: 'main', placement: 'child', text: '応答を失う追加' },
    1000,
  );
  const node = w.teams[f.team.id].nodes.find((n) => n.text === '応答を失う追加');
  f.state.loseAppend = true;
  w = await f.n.content.flushScheduled(w.id, 11000);
  assert.ok(w.documentSync.error);
  w = await queue(f, 'node', { teamId: f.team.id, id: node.id, text: '失敗後の新しい文字' }, 12000);
  const restarted = new Notion(f.store, f.n.config, f.n.transport);
  w = await restarted.content.retry(w);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.pending, true);
  w = await restarted.content.flushScheduled(w.id, 22000);
  assert.equal(w.documentSync.pending, false);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === node.id).text, '失敗後の新しい文字');
  const id = w.teams[f.team.id].nodes.find((n) => n.id === node.id).notionBlockId;
  assert.equal(text(f.find(id)), '失敗後の新しい文字');
  assert.equal(
    f.state.calls.filter((c) => c.body?.children?.some((b) => text(b) === '応答を失う追加')).length,
    1,
  );
});

test('Notionバックグラウンド: 長い読取りの途中に編集しても、古い読取り結果で編集を上書きしない', async (t) => {
  const f = fixture(t);
  let w = await f.load();
  f.find('first').toggle.rich_text = rt('Notion側の変更');
  f.state.version++;
  const gate = pause(f, (c) => c.method === 'GET' && c.path === 'blocks/main/children');
  const reading = f.n.content.pull(w, 'changed', true);
  await gate.ready;
  w = await queue(
    f,
    'node',
    { teamId: f.team.id, id: 'first', text: '読取り中の新しい入力' },
    1000,
  );
  const revision = w.revision;
  gate.release();
  await reading;
  w = f.store.get('workshops', w.id);
  assert.equal(w.revision, revision);
  assert.equal(w.teams[f.team.id].nodes.find((n) => n.id === 'first').text, '読取り中の新しい入力');
  w = await f.n.content.flushScheduled(w.id, 11000);
  assert.match(w.documentSync.error, /別途更新/);
  assert.equal(text(f.find('first')), 'Notion側の変更');
});
