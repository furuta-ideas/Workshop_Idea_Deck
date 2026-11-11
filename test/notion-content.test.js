import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newWorkshop, newTeam, id } from '../server/store.js';
import { Notion } from '../server/notion.js';
import { historyHeading, recordHeading, voteTitle } from '../server/notion-content.js';
import { saveIdea } from '../server/ideas.js';
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

// ---- v0.21: the living record -------------------------------------------------------
const flushAll = async (f) => {
  let w;
  for (let i = 0; i < 30; i++) {
    w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 3600000 + i * 60000);
    if (!w.documentSync?.queued || w.documentSync.error) break;
  }
  return w;
};
const visible = (list) => list.filter((b) => !b.in_trash);
const child = (parent, start) => visible(parent.children).find((b) => text(b).startsWith(start));
const group = (f, title) => visible(f.state.roots).find((b) => b.type === 'toggle' && text(b) === title);

test('Notion記録: 班 ＞ ①ワイガヤ・②マインドマップ・デッキ＃ の形で書き、投票のまとめを別に置く', async (t) => {
  const f = fixture(t);
  let w = f.live();
  w.votes.cards[admin.email] = { n2: 3 };
  w.teams[f.team.id].deck = ['n2'];
  f.store.put('workshops', w.id, w);
  await f.save({
    headline: '夜の街を守る',
    who: '自治体',
    features: ['すぐ使える', '記録が残る', '誰でも'],
    pressRelease: '【タイトル】見出し\n本文です。',
    transcript: '#01 10:15:30\n駅前は夜に人手が足りない。\n―――――――― 録音終了 10:20:00 ――――――――',
  });
  w = await flushAll(f);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.queued, false);
  // Heading first, then one toggle per team, then the votes.
  const roots = visible(f.state.roots);
  assert.equal(text(roots[0]), recordHeading);
  assert.deepEqual(roots.slice(1, 4).map(text), ['A班', 'B班', voteTitle]);
  const a = group(f, 'A班');
  assert.deepEqual(visible(a.children).map(text), [
    '① ワイガヤ（音声記録）',
    '② もやもやの言語化：深刻な労働力不足を解決する',
    'デッキ＃1：夜の街を守る',
  ]);
  // ①: each recording's start line and end divider stand on their own.
  assert.deepEqual(child(a, '①').children.map(text), [
    '#01 10:15:30',
    '駅前は夜に人手が足りない。',
    '―――――――― 録音終了 10:20:00 ――――――――',
  ]);
  // ②: the topic tree as toggles, with colours and votes.
  const map = child(a, '②');
  assert.deepEqual(map.children.map(text), ['現場の困りごと', '未来の働き方']);
  assert.deepEqual(map.children[0].children.map(text), ['夜間の巡回が大変（3票）', '点検記録が紙']);
  assert.equal(map.children[0].toggle.color, 'green_background');
  // Deck: cards, outline, press release, picture.
  const deck = child(a, 'デッキ＃1');
  assert.deepEqual(deck.children.map(text), [
    '選択したカード',
    'アイデアの輪郭',
    '模擬プレスリリース',
    'ペーパープロトタイプ',
  ]);
  assert.deepEqual(deck.children[0].children.map(text), ['夜間の巡回が大変（3票）']);
  const outline = deck.children[1].children.map(text);
  assert.ok(outline.includes('一言で言うと：夜の街を守る'));
  assert.ok(outline.includes('特長2：記録が残る'));
  assert.match(text(deck.children[2].children[0]), /本文です。/);
  assert.equal(text(deck.children[3].children[0]), '（画像はまだありません）');
  // A team with nothing yet still has its place; the votes list says so.
  assert.deepEqual(visible(group(f, 'B班').children).map(text), [
    '① ワイガヤ（音声記録）',
    '② もやもやの言語化：ビザスクセミナー',
  ]);
  assert.deepEqual(visible(group(f, voteTitle).children).map(text), [
    '投票結果（得票の多い順）',
    '画像の一覧',
  ]);
  assert.doesNotMatch(JSON.stringify(f.state.roots), /@example\.test/);
  assert.equal(f.entries().length, 0);
});

test('Notion記録: 変わった部分だけを書き直し、何も変わらなければ書かない', async (t) => {
  const f = fixture(t);
  await f.save({ headline: '最初の案', transcript: '最初の記録' });
  await flushAll(f);
  const a = group(f, 'A班');
  const before = { talk: child(a, '①').id, map: child(a, '②').id, deck: child(a, 'デッキ＃1').id };
  // Nothing changed: one read of the page, no write.
  f.state.calls.length = 0;
  const w0 = f.live();
  f.n.content.schedule(w0, f.team.id, 'save');
  await flushAll(f);
  assert.deepEqual(
    f.state.calls.map((c) => c.method),
    ['GET'],
  );
  // Only the voice log changed: only ① is replaced, in the same place.
  await f.save({ transcript: '最初の記録\n続きの記録' });
  await flushAll(f);
  const sections = visible(group(f, 'A班').children);
  assert.deepEqual(sections.map(text), ['① ワイガヤ（音声記録）', '② もやもやの言語化：深刻な労働力不足を解決する', 'デッキ＃1：最初の案']);
  assert.notEqual(sections[0].id, before.talk);
  assert.equal(sections[1].id, before.map);
  assert.equal(sections[2].id, before.deck);
  assert.match(text(sections[0].children[0]), /続きの記録/);
  assert.equal(group(f, 'A班').id, a.id);
  // A new deck: the first one stays as デッキ＃1, the new one is デッキ＃2.
  let w = f.live();
  w = await f.n.content.change(admin, w.id, {
    action: 'clearIdea',
    payload: { teamId: f.team.id },
    revision: w.revision,
    requestId: id(),
  });
  await f.save({ headline: '二つ目の案' });
  await flushAll(f);
  assert.deepEqual(
    visible(group(f, 'A班').children).map(text).slice(2),
    ['デッキ＃1：最初の案', 'デッキ＃2：二つ目の案'],
  );
  // Notion is a record only: an edit made there does not come back to the app.
  child(group(f, 'A班'), '①').children[0].paragraph.rich_text = rt('Notionで書き換え');
  const revision = f.live().revision;
  assert.equal(await f.n.content.pull(f.live(), undefined, true), true);
  assert.equal(f.live().revision, revision);
  assert.match(f.live().teams[f.team.id].discussion.transcript, /続きの記録/);
});

test('Notion記録: 画像はデッキの中と「ペーパープロトの投票」に並び、票が動くと順位だけ書き直す', async (t) => {
  const f = fixture(t);
  let w = f.live();
  const other = Object.values(w.teams)[1];
  for (const [team, headline] of [
    [w.teams[f.team.id], 'A班の案'],
    [other, 'B班の案'],
  ]) {
    team.discussion.headline = headline;
    team.image = { base64: f.png, width: 16, height: 9 };
    saveIdea(f.store, w, team);
  }
  const ideaA = w.teams[f.team.id].ideas[0].id,
    ideaB = other.ideas[0].id;
  w.votes.ideas['p1@example.test'] = { [ideaB]: 2, [ideaA]: 1 };
  f.store.put('workshops', w.id, w);
  f.n.content.schedule(f.live(), f.team.id, 'image');
  w = await flushAll(f);
  assert.equal(w.documentSync.error, null);
  const picture = child(group(f, 'A班'), 'デッキ＃1').children[3].children[0];
  assert.equal(picture.type, 'image');
  assert.equal(f.state.uploads[picture.image.file.url.split('/').pop()], f.png);
  const votes = group(f, voteTitle);
  assert.deepEqual(child(votes, '投票結果').children.map(text), [
    '2票　B班 デッキ＃1：B班の案',
    '1票　A班 デッキ＃1：A班の案',
  ]);
  const gallery = child(votes, '画像の一覧');
  assert.deepEqual(
    gallery.children.map((b) => (b.type === 'image' ? 'image' : text(b))),
    ['A班 デッキ＃1：A班の案', 'image', 'B班 デッキ＃1：B班の案', 'image'],
  );
  // A vote: scheduled by itself; only the ranking is written again (no picture upload).
  f.state.calls.length = 0;
  w = f.live();
  w.timers.ideas = { endsAt: Date.now() + 60000, closed: false };
  f.store.put('workshops', w.id, w);
  await f.n.content.change(admin, w.id, {
    action: 'vote',
    payload: { phase: 'ideas', target: ideaA, delta: 1 },
    revision: w.revision,
    requestId: id(),
  });
  assert.equal(f.live().documentSync.queued, true);
  await flushAll(f);
  assert.deepEqual(child(group(f, voteTitle), '投票結果').children.map(text), [
    '2票　A班 デッキ＃1：A班の案',
    '2票　B班 デッキ＃1：B班の案',
  ]);
  assert.equal(child(group(f, voteTitle), '画像の一覧').id, gallery.id);
  assert.equal(f.state.calls.some((c) => c.path === 'file_uploads'), false);
});

test('Notion記録: 一時的な失敗は自動で再送し、途中で途切れても同じ欄を二重に残さない', async (t) => {
  const f = fixture(t);
  await f.save({ headline: '案', transcript: '記録' });
  // The page read succeeds, the heading is made, then Notion fails for a while.
  f.state.failNext = 0;
  const original = f.state.calls.length;
  let w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 3600000);
  assert.equal(w.documentSync.error, null);
  // Break the next change in the middle of filling a section.
  await f.save({ transcript: '記録\n追加' });
  let seen = 0;
  const count = f.state.calls.length;
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
  // Fail the 3rd call of the run (after the old ① was trashed and the new one created).
  const calls = f.state.calls;
  const push = calls.push.bind(calls);
  calls.push = (c) => {
    seen++;
    if (seen === 4) f.state.failNext = 1;
    return push(c);
  };
  w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 3600000);
  calls.push = push;
  assert.ok(w.documentSync.error);
  assert.equal(w.documentSync.retryable, true);
  assert.equal(w.documentSync.queued, true);
  assert.ok(count > original);
  w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 7200000);
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.queued, false);
  const talks = visible(group(f, 'A班').children).filter((b) => text(b).startsWith('①'));
  assert.equal(talks.length, 1);
  assert.match(text(talks[0].children[0]), /追加/);
});

test('Notion記録: 量が多いときは数回に分けて書き、最後まで書き終える', async (t) => {
  const f = fixture(t);
  let w = f.live();
  const team = w.teams[f.team.id];
  // A deep map (levels beyond grandchildren need extra calls) and several decks.
  for (let i = 0; i < 12; i++) {
    team.nodes.push({ id: `a${i}`, text: `枝${i}`, parent: 'theme', group: 0 });
    team.nodes.push({ id: `b${i}`, text: `子${i}`, parent: `a${i}`, group: 0 });
    team.nodes.push({ id: `c${i}`, text: `孫${i}`, parent: `b${i}`, group: 0 });
  }
  for (let i = 0; i < 6; i++) {
    team.discussion.headline = `案${i + 1}`;
    team.activeIdeaId = null;
    saveIdea(f.store, w, team);
  }
  f.store.put('workshops', w.id, w);
  f.n.content.schedule(f.live(), f.team.id, 'save');
  w = await f.n.content.flushScheduled(f.ws.id, Date.now() + 3600000);
  // The first run stops at its call budget and asks to be continued soon.
  assert.equal(w.documentSync.error, null);
  assert.equal(w.documentSync.queued, true);
  w = await flushAll(f);
  assert.equal(w.documentSync.queued, false);
  const a = group(f, 'A班');
  assert.equal(visible(a.children).filter((b) => text(b).startsWith('デッキ＃')).length, 6);
  const branch = child(a, '②').children.find((b) => text(b) === '枝11');
  assert.equal(text(branch.children[0].children[0]), '孫11');
  assert.equal(visible(a.children).filter((b) => text(b).startsWith('②')).length, 1);
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
  assert.match(body, /①・④の文字サイズ：150%/);
  assert.match(body, /リーフィー（女の子）/);
  assert.match(body, /企画シート用の指示/);
  assert.match(body, /ファシリテータ/);
  const heading = f.state.roots.findIndex((b) => /^heading_/.test(b.type) && text(b) === 'アプリの設定');
  assert.ok(heading >= 0);
  assert.equal(f.state.roots.filter((b) => !b.in_trash)[f.state.roots.filter((b) => !b.in_trash).findIndex((b) => text(b) === 'アプリの設定') + 1], boxes[0]);
  assert.equal(f.entries().length, 0);
});
