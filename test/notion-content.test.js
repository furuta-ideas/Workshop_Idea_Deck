import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newWorkshop, newTeam, id } from '../server/store.js';
import { Notion } from '../server/notion.js';
import { stageTitles } from '../server/notion-content.js';
import { totals } from '../server/domain.js';
const rt = (text) => [{ type: 'text', text: { content: text }, plain_text: text }];
const text = (b) =>
  (b[b.type]?.rich_text || []).map((x) => x.text?.content || x.plain_text || '').join('');
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
    store.put('workshops', w.id, w);
    return w;
  };
  const change = async (action, payload) => {
    const w = store.get('workshops', ws.id);
    return n.content.change({ email: 'admin@example.test', admin: true }, w.id, {
      action,
      payload,
      revision: w.revision,
      requestId: id(),
    });
  };
  return { store, n, ws, team, other, state, find, load, change };
}
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
  assert.ok(w.teams[f.team.id].nodes.find((n) => n.id === 'fourth'));
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
