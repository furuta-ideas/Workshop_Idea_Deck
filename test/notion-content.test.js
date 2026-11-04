import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newWorkshop, newTeam, id } from '../server/store.js';
import { Notion } from '../server/notion.js';
import { historyHeading, sections, settingTitles } from '../server/notion-content.js';
import { totals } from '../server/domain.js';
import { testPNG } from '../test-support/fixtures.js';

// In-memory Notion page. No production token, database or network call.
const rt = (text) => [{ type: 'text', text: { content: text }, plain_text: text }];
const text = (b) =>
  (b[b.type]?.rich_text || []).map((x) => x.plain_text ?? x.text?.content).join('');
const admin = { email: 'admin@example.test', admin: true };

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const node = (blockId, type, value, children = []) => ({
    id: blockId,
    type,
    [type]: { rich_text: rt(value) },
    children,
  });
  const state = {
    calls: [],
    uploads: {},
    roots: [
      node('history', 'heading_2', historyHeading),
      node('template', 'toggle', 'yyyymmdd_hhmmss_ワークショップ名（テンプレート）', [
        node('t-map', 'toggle', 'マインドマップ'),
      ]),
      node('example', 'toggle', '20261108_221400_ビザスクセミナー＿A班（データ記入例）', [
        node('e-map', 'toggle', 'マインドマップ', [node('e-1', 'toggle', '記入例のトピック')]),
      ]),
      node('settings-heading', 'heading_2', 'アプリの設定'),
    ],
    failNext: 0,
    loseNextAppend: false,
  };
  const all = () => {
    const out = [];
    const visit = (list) => {
      for (const b of list) {
        out.push(b);
        visit(b.children);
      }
    };
    visit(state.roots);
    return out;
  };
  const find = (blockId) => all().find((b) => b.id === blockId);
  const serial = (b) => {
    const c = structuredClone(b);
    delete c.children;
    c.has_children = b.children.length > 0;
    return c;
  };
  const transport = async (url, options) => {
    if (String(url).startsWith('https://files.example.notion.so/')) {
      const key = String(url).split('/').pop();
      const bytes = Buffer.from(state.uploads[key], 'base64');
      return { ok: true, headers: new Map(), arrayBuffer: async () => bytes };
    }
    const path = new URL(url).pathname.replace('/v1/', ''),
      method = options.method,
      body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    state.calls.push({ path, method, body });
    if (state.failNext > 0) {
      state.failNext--;
      return { ok: false, status: 503 };
    }
    let data;
    if (path === 'file_uploads') data = { id: 'upload-' + id() };
    else if (/^file_uploads\/.+\/send$/.test(path)) {
      const uploadId = path.split('/')[1];
      const file = body.get('file');
      state.uploads[uploadId] = Buffer.from(await file.arrayBuffer()).toString('base64');
      data = {};
    } else if (path === 'pages/page') data = { id: 'page', last_edited_time: 'v1' };
    else {
      const m = /^blocks\/([^/]+)(\/children)?$/.exec(path);
      assert.ok(m, path);
      const [, key, child] = m;
      const list = key === 'page' ? state.roots : find(key)?.children;
      if (method === 'GET') data = { results: list.filter((b) => !b.in_trash).map(serial) };
      else if (child) {
        const build = (value) => {
          const type = value.type;
          const { children = [], ...content } = value[type];
          const b = { id: 'b-' + id(), type, [type]: content, children: children.map(build) };
          if (type === 'image' && content.file_upload)
            b.image = {
              ...content,
              type: 'file',
              file: { url: 'https://files.example.notion.so/' + content.file_upload.id },
            };
          return b;
        };
        const created = body.children.map(build);
        const pos = body.position;
        const at =
          pos?.type === 'start'
            ? 0
            : pos?.type === 'after_block'
              ? list.findIndex((b) => b.id === pos.after_block.id) + 1
              : list.length;
        list.splice(at, 0, ...created);
        if (state.loseNextAppend && key === 'page') {
          state.loseNextAppend = false;
          throw Error('response lost after commit');
        }
        data = { results: created.map(serial) };
      } else {
        const b = find(key);
        if (body.in_trash) b.in_trash = true;
        data = serial(b);
      }
    }
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  };
  const n = new Notion(store, { notionToken: 'test-only', notionSource: 'master' }, transport);
  const ws = newWorkshop('ビザスクセミナー', 'admin@example.test'),
    team = Object.values(ws.teams)[0],
    other = newTeam('B班');
  ws.teams[other.id] = other;
  team.rootText = '深刻な労働力不足を解決する';
  team.nodes = [
    { id: 'n1', text: '現場の困りごと', parent: 'theme', group: 1 },
    { id: 'n2', text: '夜間の巡回が大変', parent: 'n1', group: 0 },
    { id: 'n3', text: '点検記録が紙', parent: 'n1', group: 0 },
    { id: 'n4', text: '未来の働き方', parent: 'theme', group: 2 },
  ];
  ws.notion = { pageId: 'page', baseEdited: 'v1', checkedAt: Date.now() };
  store.put('workshops', ws.id, ws);
  const f = {
    store,
    n,
    ws,
    team,
    state,
    find,
    png: testPNG(16, 9),
    facilitator: '# ファシリテータ\n\n短く問いかけます。',
    consumed: null,
    entries: () =>
      state.roots.filter(
        (b) => b.type === 'toggle' && /^\d{8}_\d{6}_[^（]*$/.test(text(b)) && !b.in_trash,
      ),
    section: (entry, title) => entry.children.find((b) => text(b) === title),
    save: async (payload = {}, now = Date.now()) => {
      const w = store.get('workshops', ws.id);
      return n.content.change(
        admin,
        w.id,
        {
          action: 'discussion',
          payload: { teamId: team.id, snapshot: true, ...payload },
          revision: w.revision,
          requestId: id(),
        },
        { now },
      );
    },
    flush: () => n.content.flushScheduled(ws.id, Date.now() + 1),
    live: () => store.get('workshops', ws.id),
  };
  n.settingsProvider = () => [
    { key: 'ai:pressReleasePrompt', value: 'プレスリリース用の指示' },
    { key: 'ai:imagePrompt', value: '企画シート用の指示' },
    { key: 'ai:facilitator', value: f.facilitator },
  ];
  n.settingsConsumer = (rows) => (f.consumed = rows);
  return f;
}

test('Notion履歴: 「記録を保存」でテンプレートの直下に1件追加し、全セクションを人が読める形で書く', async (t) => {
  const f = fixture(t);
  let w = f.live();
  w.votes.cards[admin.email] = { n2: 3 };
  w.teams[f.team.id].deck = ['n2'];
  f.store.put('workshops', w.id, w);
  w = await f.save({
    headline: '夜の街を守る',
    who: '自治体',
    features: ['すぐ使える', '記録が残る', '誰でも'],
    pressRelease: '見出し\n\n本文です。',
    transcript: '議論のメモ',
  });
  assert.equal(w.documentSync.queued, true);
  w = await f.flush();
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.queued, false);
  assert.ok(w.documentSync.at);
  const entries = f.entries();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.match(text(entry), /^\d{8}_\d{6}_ビザスクセミナー＿A班$/);
  assert.equal(
    f.state.roots.indexOf(entry),
    f.state.roots.findIndex((b) => b.id === 'template') + 1,
  );
  assert.deepEqual(entry.children.map(text), Object.values(sections));
  assert.equal(text(f.section(entry, sections.world).children[0]), '深刻な労働力不足を解決する');
  const map = f.section(entry, sections.map);
  assert.deepEqual(map.children.map(text), ['現場の困りごと', '未来の働き方']);
  assert.deepEqual(map.children[0].children.map(text), ['夜間の巡回が大変', '点検記録が紙']);
  assert.equal(map.children[0].toggle.color, 'green_background');
  assert.deepEqual(f.section(entry, sections.press).children.map(text), ['見出し', '本文です。']);
  const outline = f.section(entry, sections.outline).children.map(text);
  assert.ok(outline.includes('一言で言うと：夜の街を守る'));
  assert.ok(outline.includes('特長2：記録が残る'));
  const settings = f.section(entry, sections.settings);
  assert.deepEqual(settings.children.map(text), Object.values(settingTitles));
  const votes = JSON.parse(text(settings.children[3].children[0]));
  assert.equal(votes.cards[0].text, '夜間の巡回が大変 #VOTES:3');
  assert.equal(votes.cards[0].notionBlockId, map.children[0].children[0].id);
  assert.equal(votes.deck[0].id, 'n2');
  assert.match(text(settings.children[1].children[0]), /企画シート用の指示/);
  assert.doesNotMatch(JSON.stringify(entry), /@example\.test/);
  // Our own write is not "restored" by an ordinary read.
  const revision = f.live().revision;
  await f.n.content.pull(f.live(), undefined, false);
  assert.equal(f.live().revision, revision);
});

test('Notion履歴: 保存のたびに新しい履歴が一番上に増え、通常の編集ではNotionへ書かない', async (t) => {
  const f = fixture(t);
  await f.save({}, Date.UTC(2026, 10, 8, 1, 0, 0));
  await f.flush();
  const w = f.live();
  const before = f.state.calls.filter((c) => c.method !== 'GET').length;
  await f.n.content.change(admin, w.id, {
    action: 'createTopic',
    payload: { teamId: f.team.id, anchorId: 'theme', placement: 'child', text: '追加' },
    revision: w.revision,
    requestId: id(),
  });
  assert.equal(f.state.calls.filter((c) => c.method !== 'GET').length, before);
  assert.equal(!!f.live().documentSync.queued, false);
  await f.save({}, Date.UTC(2026, 10, 8, 2, 30, 5));
  await f.flush();
  assert.deepEqual(f.entries().map(text), [
    '20261108_113005_ビザスクセミナー＿A班',
    '20261108_100000_ビザスクセミナー＿A班',
  ]);
});

test('Notion履歴: Notionで直した最新の履歴をマスターとしてマップ・本文・票・デッキへ復元する', async (t) => {
  const f = fixture(t);
  let w = f.live();
  w.votes.cards[admin.email] = { n2: 2 };
  f.store.put('workshops', w.id, w);
  await f.save({ pressRelease: '元の原稿' });
  await f.flush();
  const entry = f.entries()[0];
  const map = f.section(entry, sections.map);
  map.children[0].children[0].toggle.rich_text = rt('Notionで直したトピック');
  f.section(entry, sections.press).children[0].paragraph.rich_text = rt('Notionで直した原稿');
  f.section(entry, sections.outline).children[0].paragraph.rich_text =
    rt('一言で言うと：Notionの一言');
  const code = f.section(entry, sections.settings).children[3].children[0];
  const votes = JSON.parse(text(code));
  votes.cards[0].text = 'x #VOTES:7';
  votes.deck = [{ id: votes.cards[0].id, notionBlockId: votes.cards[0].notionBlockId }];
  code.code.rich_text = rt(JSON.stringify(votes));
  await f.n.content.pull(f.live(), undefined, false);
  w = f.live();
  const team = w.teams[f.team.id];
  const edited = team.nodes.find((n) => n.text === 'Notionで直したトピック');
  assert.equal(edited.id, 'n2'); // the app's card ID survives
  assert.equal(edited.parent, 'n1');
  assert.equal(team.discussion.pressRelease, 'Notionで直した原稿');
  assert.equal(team.discussion.headline, 'Notionの一言');
  assert.equal(totals(w, 'cards').n2, 7);
  assert.deepEqual(team.deck, ['n2']);
  assert.equal(w.documentSync.readError, null);
});

test('Notion履歴: 空のサーバーでも最新の履歴から復元し、テンプレートと記入例は読まない', async (t) => {
  const f = fixture(t);
  const w = f.live();
  w.votes.cards[admin.email] = { n3: 4 };
  w.teams[f.team.id].deck = ['n3'];
  f.store.put('workshops', w.id, w);
  await f.save({ who: '点検員' });
  await f.flush();
  const store = new Store(':memory:');
  t.after(() => store.close());
  const fresh = newWorkshop('ビザスクセミナー', admin.email);
  const team = Object.values(fresh.teams)[0];
  fresh.notion = { pageId: 'page', checkedAt: Date.now() };
  store.put('workshops', fresh.id, fresh);
  const notion = new Notion(store, f.n.config, f.n.transport);
  await notion.content.pull(fresh, undefined, true);
  const restored = store.get('workshops', fresh.id).teams[team.id];
  assert.deepEqual(
    restored.nodes.map((n) => n.text),
    ['現場の困りごと', '夜間の巡回が大変', '点検記録が紙', '未来の働き方'],
  );
  assert.ok(!restored.nodes.some((n) => n.text === '記入例のトピック'));
  assert.equal(restored.rootText, '深刻な労働力不足を解決する');
  assert.equal(restored.discussion.who, '点検員');
  assert.deepEqual(restored.deck, ['n3']);
  assert.equal(totals(store.get('workshops', fresh.id), 'cards').n3, 4);
});

test('Notion履歴: 画像を適用すると画像付きの履歴を追加し、Notionから画像も復元する', async (t) => {
  const f = fixture(t);
  let w = f.live();
  w.teams[f.team.id].image = { base64: f.png, width: 16, height: 9 };
  f.store.put('workshops', w.id, w);
  f.n.content.schedule(f.live(), f.team.id, 'image');
  await f.flush();
  const image = f.section(f.entries()[0], sections.image).children[0];
  assert.equal(image.type, 'image');
  assert.equal(f.state.uploads[image.image.file_upload.id], f.png);
  w = f.live();
  w.teams[f.team.id].image = null;
  f.store.put('workshops', w.id, w);
  await f.n.content.pull(f.live(), undefined, true);
  assert.equal(f.live().teams[f.team.id].image.base64, f.png);
});

test('Notion履歴: 一時的な失敗は30秒後から自動再送し、途中で途切れた履歴は二重に残さない', async (t) => {
  const f = fixture(t);
  await f.save();
  f.state.failNext = 1;
  const start = Date.now() + 10;
  let w = await f.n.content.flushScheduled(f.ws.id, start);
  assert.equal(w.documentSync.retryable, true);
  assert.equal(w.documentSync.queued, true);
  assert.equal(f.n.content.due(start + 29999), undefined);
  assert.equal(f.n.content.due(start + 30000)?.id, f.ws.id);
  f.state.loseNextAppend = true;
  w = await f.n.content.flushScheduled(f.ws.id, start + 30000);
  assert.equal(w.documentSync.retryable, true);
  w = await f.n.content.flushScheduled(f.ws.id, start + 10 ** 6);
  assert.equal(w.documentSync.error, null);
  assert.equal(f.entries().length, 1);
});

test('Notion履歴: 長いファシリテータmdも途中で切らずに書き、読み込める', async (t) => {
  const f = fixture(t);
  f.facilitator = Array.from({ length: 150 }, (_, i) => `段落${i + 1}`).join('\n\n');
  await f.save();
  await f.flush();
  const settings = f.section(f.entries()[0], sections.settings);
  assert.equal(settings.children[0].children.length, 150);
  await f.n.content.pull(f.live(), undefined, true);
  assert.equal(f.consumed.find((r) => r.key === 'ai:facilitator').value, f.facilitator);
});

test('Notion履歴: 投票結果JSONが壊れていても読込みエラーとして表示し、保存の送信は止めない', async (t) => {
  const f = fixture(t);
  await f.save();
  await f.flush();
  const code = f.section(f.entries()[0], sections.settings).children[3].children[0];
  code.code.rich_text = rt('{壊れたJSON');
  await f.n.content.pull(f.live(), undefined, true);
  assert.match(f.live().documentSync.readError, /JSON/);
  await f.save({}, Date.now() + 2000);
  const w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 3000);
  assert.equal(w.documentSync.error, null);
  assert.equal(f.entries().length, 2);
});

test('Notion履歴: 「記録を保存」を押さなくても議論の変更は1分後に1件にまとめて履歴へ書く', async (t) => {
  const f = fixture(t);
  const act = async (action, payload, now) => {
    const w = f.live();
    return f.n.content.change(admin, w.id, { action, payload: { teamId: f.team.id, ...payload }, revision: w.revision, requestId: id() }, { now });
  };
  const t0 = Date.UTC(2026, 10, 8, 1, 0, 0);
  await act('discussion', { transcript: '録音した議論' }, t0);
  await act('discussion', { headline: '一言の案' }, t0 + 5000);
  const s = f.live().documentSync;
  assert.equal(s.queued, true);
  assert.equal(s.dueAt, t0 + 60000);
  assert.equal(f.n.content.outbox(f.ws.id).length, 1);
  await f.flush();
  assert.equal(f.entries().length, 1);
  const entry = f.entries()[0];
  assert.match(JSON.stringify(f.section(entry, sections.memo)), /録音した議論/);
  assert.match(JSON.stringify(f.section(entry, sections.outline)), /一言の案/);
});

test('Notion履歴: 新しいデッキにする前のデッキを未送信の入力ごと履歴に残す', async (t) => {
  const f = fixture(t);
  const w = f.live();
  await f.n.content.change(admin, w.id, { action: 'clearIdea', payload: { teamId: f.team.id, headline: '前のデッキの案', transcript: '前の議論' }, revision: w.revision, requestId: id() });
  assert.equal(f.live().teams[f.team.id].discussion.headline, '');
  await f.flush();
  assert.equal(f.entries().length, 1);
  assert.match(JSON.stringify(f.section(f.entries()[0], sections.outline)), /前のデッキの案/);
});

test('Notion設定: 設定を保存すると「アプリの設定」に最新の設定情報を1つだけ置き換えて書く', async (t) => {
  const f = fixture(t);
  const save = async (payload) => {
    const w = f.live();
    await f.n.content.change(admin, w.id, { action: 'settings', payload, revision: w.revision, requestId: id() });
    await f.n.content.flushScheduled(f.ws.id, Date.now() + 5000);
  };
  await save({ textScale: 130, character: 'leafy' });
  await save({ textScale: 150 });
  const boxes = f.state.roots.filter((b) => b.type === 'toggle' && text(b) === '設定情報（アプリの最新設定）' && !b.in_trash);
  assert.equal(boxes.length, 1);
  const body = JSON.stringify(boxes[0].children);
  assert.match(body, /③の文字サイズ：150%/);
  assert.match(body, /リーフィー（女の子）/);
  assert.match(body, /企画シート用の指示/);
  assert.match(body, /ファシリテータ/);
  const heading = f.state.roots.findIndex((b) => /^heading_/.test(b.type) && text(b) === 'アプリの設定');
  assert.ok(heading >= 0);
  assert.equal(f.state.roots.filter((b) => !b.in_trash)[f.state.roots.filter((b) => !b.in_trash).findIndex((b) => text(b) === 'アプリの設定') + 1], boxes[0]);
  assert.equal(f.entries().length, 0);
});
