import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newWorkshop } from '../server/store.js';
import { Notion } from '../server/notion.js';
import { access, expire } from '../server/domain.js';

// In-memory contract fixture. No production Notion token, database or network call.
const title = (content) => ({ title: [{ plain_text: content, text: { content } }] });
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const state = {
    calls: [],
    fail: false,
    status: '進行中',
    date: null,
    name: 'Notionから追加',
    edited: 'v1',
    children: true,
    members: [{ email: 'editor@example.test', role: '編集者', group: 'A班' }],
  };
  const page = () => ({
    id: 'remote-page',
    last_edited_time: state.edited,
    properties: {
      名前: title(state.name),
      終了日: { date: state.date ? { start: state.date } : null },
      ステータス: { status: { name: state.status } },
    },
  });
  const transport = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1/', ''),
      body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ path, method: init.method, body });
    if (state.fail) return { ok: false, status: 503 };
    let data;
    if (path === 'data_sources/master')
      data = {
        properties: {
          名前: { type: 'title' },
          終了日: { type: 'date' },
          ステータス: { type: 'status' },
        },
      };
    else if (path === 'data_sources/master/query') data = { results: [page()] };
    else if (path === 'blocks/remote-page/children')
      data = {
        results: state.children
          ? [{ type: 'child_database', id: 'child-db', child_database: { title: '参加者一覧' } }]
          : [],
      };
    else if (path === 'databases/child-db')
      data = { id: 'child-db', data_sources: [{ id: 'participants' }] };
    else if (path === 'data_sources/participants')
      data = {
        properties: Object.fromEntries(
          Object.entries({
            名前: 'title',
            選択: 'select',
            グループ: 'select',
            OTP認証結果: 'select',
            OTP認証日時: 'date',
          }).map(([k, type]) => [k, { type }]),
        ),
      };
    else if (path === 'data_sources/participants/query')
      data = {
        results: state.members.map((m, i) => ({
          id: `person-${i}`,
          properties: {
            名前: title(m.email),
            選択: { select: { name: m.role } },
            グループ: { select: m.group ? { name: m.group } : null },
            OTP認証結果: { select: { name: '認証済' } },
          },
        })),
      };
    else if (path === 'pages/remote-page' && init.method === 'PATCH') {
      state.status = body.properties.ステータス.status.name;
      state.name = body.properties.名前.title[0].text.content;
      state.date = body.properties.終了日.date?.start || null;
      state.edited += '-updated';
      data = page();
    } else if (path === 'pages/remote-page') data = page();
    else if (
      path === 'pages' &&
      body.parent.type === 'data_source_id' &&
      body.parent.data_source_id === 'master'
    )
      data = page();
    else if (path === 'databases' && init.method === 'POST') {
      state.children = true;
      data = { id: 'child-db', data_sources: [{ id: 'participants' }] };
    } else if (path === 'pages' && body.parent.data_source_id === 'participants') {
      state.members.push({
        email: body.properties.名前.title[0].text.content,
        role: body.properties.選択.select.name,
        group: body.properties.グループ.select?.name,
      });
      data = { id: 'new-person' };
    } else throw Error(`Unexpected test request: ${path}`);
    return { ok: true, status: 200, json: async () => data };
  };
  const notion = new Notion(
    store,
    { notionToken: 'test-only-never-real', notionSource: 'master' },
    transport,
  );
  return { store, state, notion };
}
test('Notion側で追加されたWS・子参加者DB・グループを安定IDで取り込む', async (t) => {
  const f = fixture(t);
  await f.notion.sync();
  let ws = f.store.all('workshops')[0];
  assert.equal(ws.name, 'Notionから追加');
  assert.equal(ws.notion.pageId, 'remote-page');
  assert.equal(ws.members['editor@example.test'].role, '編集者');
  assert.ok(Object.values(ws.teams).some((t) => t.name === 'A班'));
  assert.equal(f.store.get('users', 'editor@example.test').admin, false);
  const revision = ws.revision;
  await f.notion.sync();
  ws = f.store.all('workshops')[0];
  assert.equal(f.store.all('workshops').length, 1);
  assert.equal(ws.revision, revision);
  assert.equal(
    f.state.calls.some((c) => c.method !== 'GET' && !c.path.endsWith('/query')),
    false,
  );
});
test('Notion更新とアプリの未同期変更は衝突として保持し、明示解決まで上書きしない', async (t) => {
  const f = fixture(t);
  await f.notion.sync();
  let ws = f.store.all('workshops')[0];
  ws.name = 'アプリの変更';
  ws.dirty = true;
  f.store.put('workshops', ws.id, ws);
  f.state.edited = 'v2';
  f.state.name = 'Notion側の変更';
  await f.notion.sync();
  ws = f.store.get('workshops', ws.id);
  assert.equal(ws.name, 'アプリの変更');
  assert.equal(ws.notion.conflict.remote.name, 'Notion側の変更');
  assert.equal(f.state.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.throws(
    () => access(f.store, ws, { email: 'editor@example.test' }),
    (e) => e.status === 503,
  );
  await f.notion.resolve(ws.id, 'notion');
  ws = f.store.get('workshops', ws.id);
  assert.equal(ws.name, 'Notion側の変更');
  assert.equal(ws.dirty, false);
  assert.equal(ws.notion.conflict, undefined);
});
test('期限超過は破棄として永続化し、次の同期でNotionに反映', async (t) => {
  const f = fixture(t);
  await f.notion.sync();
  let ws = f.store.all('workshops')[0];
  ws.endDate = '2000-01-01';
  f.store.put('workshops', ws.id, ws);
  expire(f.store, ws);
  assert.equal(ws.dirty, true);
  await f.notion.sync();
  assert.equal(f.state.status, '破棄（閲覧不可）');
  assert.equal(f.store.get('workshops', ws.id).dirty, false);
});
test('同期失敗は記録して閲覧を止め、回復後は再開。権限変更も反映', async (t) => {
  const f = fixture(t);
  await f.notion.sync();
  let ws = f.store.all('workshops')[0];
  f.state.fail = true;
  await assert.rejects(() => f.notion.sync());
  ws = f.store.get('workshops', ws.id);
  assert.ok(ws.notion.error);
  assert.throws(
    () => access(f.store, ws, { email: 'editor@example.test' }),
    (e) => e.status === 503,
  );
  f.state.fail = false;
  f.state.members[0].role = '閲覧者';
  await f.notion.sync();
  ws = f.store.get('workshops', ws.id);
  assert.equal(ws.notion.error, undefined);
  assert.equal(ws.members['editor@example.test'].role, '閲覧者');
});
test('アプリ新規WSはNotionページ配下に子参加者DBを生成し、必要な型を渡す', async (t) => {
  const f = fixture(t),
    ws = newWorkshop('アプリ新規', 'admin@example.test');
  f.state.children = false;
  f.state.members = [];
  f.store.put('workshops', ws.id, ws);
  await f.notion.publishNew(ws);
  const create = f.state.calls.find((c) => c.path === 'databases' && c.method === 'POST');
  assert.equal(create.body.parent.page_id, 'remote-page');
  assert.equal(create.body.is_inline, true);
  assert.ok(create.body.initial_data_source.properties.グループ.select);
  assert.equal(f.store.get('workshops', ws.id).notion.provisioning, false);
  assert.equal(f.state.members[0].role, '管理者');
});
test('ページ作成結果不明時は自動再送せず、二重作成を防止', async (t) => {
  const f = fixture(t),
    ws = newWorkshop('曖昧な作成', 'admin@example.test');
  f.store.put('workshops', ws.id, ws);
  f.state.fail = true;
  await assert.rejects(() => f.notion.publishNew(ws));
  assert.equal(f.store.get('workshops', ws.id).createAttempt, true);
  const count = f.state.calls.length;
  await assert.rejects(() => f.notion.publishNew(f.store.get('workshops', ws.id)));
  assert.equal(f.state.calls.length, count);
});

test('Notion接続状態は未設定・同期待ち・失敗・陳腐化・正常を区別し、公開状態へ詳細を出さない', async (t) => {
  const f = fixture(t);
  assert.equal(new Notion(f.store, {}).connectionState().state, 'unconfigured');
  assert.equal(f.notion.connectionState().state, 'pending');
  await f.notion.sync();
  assert.equal(f.notion.connectionState().state, 'ready');
  f.store.put('kv', 'notion-sync', { at: Date.now() - 61000, error: null });
  assert.equal(f.notion.connectionState().state, 'stale');
  f.store.put('kv', 'notion-sync', { at: Date.now(), error: 'private detail' });
  const state = f.notion.connectionState();
  assert.equal(state.state, 'error');
  assert.equal(state.error, undefined);
  assert.equal(state.workshops, undefined);
});
