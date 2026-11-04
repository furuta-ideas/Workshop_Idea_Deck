import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, newWorkshop, newTeam } from '../server/store.js';
import { access, expiry, mutate, updateMeta, view, totals, markdown } from '../server/domain.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workshop-domain-'));
  const store = new Store(join(dir, 'test.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const admin = { email: 'admin@example.test', admin: true },
    editor = { email: 'editor@example.test' },
    viewer = { email: 'viewer@example.test' };
  const ws = newWorkshop('テストWS', admin.email),
    team = Object.values(ws.teams)[0],
    other = newTeam('B班');
  ws.teams[other.id] = other;
  ws.members[editor.email] = { role: '編集者', teamId: team.id };
  ws.members[viewer.email] = { role: '閲覧者', teamId: team.id };
  for (let i = 0; i < 7; i++)
    team.nodes.push({ id: id(), text: `気づき${i}`, parent: null, group: i % 4 });
  store.put('workshops', ws.id, ws);
  const act = (
    user,
    action,
    payload,
    revision = store.get('workshops', ws.id).revision,
    requestId = id(),
  ) => mutate(store, user, ws.id, { action, payload, revision, requestId });
  return { store, admin, editor, viewer, ws, team, other, act };
}

test('編集者は自チームから①②の投票を開始・加算・取消でき、閲覧者と他チームは拒否', (t) => {
  const f = setup(t),
    target = f.team.nodes[0].id;
  f.act(f.editor, 'timer', { phase: 'cards', teamId: f.team.id });
  let w = f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 });
  assert.equal(w.votes.cards[f.editor.email][target], 1);
  w = f.act(f.editor, 'vote', { phase: 'cards', target, delta: -1 });
  assert.equal(w.votes.cards[f.editor.email][target], 0);
  assert.throws(() => f.act(f.editor, 'timer', { phase: 'cards', teamId: f.other.id }));
  assert.throws(() => f.act(f.viewer, 'timer', { phase: 'cards', teamId: f.team.id }));
  assert.throws(() => f.act(f.editor, 'timer', { phase: 'ideas', teamId: f.team.id }));
});

test('企画の一言・３つの特長・原稿を保存し、行数と文字数を検証する', (t) => {
  const f = setup(t);
  const w = f.act(f.editor, 'discussion', {
    teamId: f.team.id,
    headline: '新しい提案',
    features: ['簡単に使える', 'すぐに始められる', '地域で続けられる'],
    pressRelease: '企画原稿',
  });
  assert.equal(w.teams[f.team.id].discussion.headline, '新しい提案');
  assert.deepEqual(w.teams[f.team.id].discussion.features, [
    '簡単に使える',
    'すぐに始められる',
    '地域で続けられる',
  ]);
  assert.throws(() =>
    f.act(f.editor, 'discussion', { teamId: f.team.id, features: ['1', '2', '3', '4'] }),
  );
  assert.throws(() =>
    f.act(f.editor, 'discussion', { teamId: f.team.id, features: ['改行\n不可'] }),
  );
  assert.throws(() =>
    f.act(f.editor, 'discussion', { teamId: f.team.id, headline: 'あ'.repeat(101) }),
  );
});
test('閲覧者は全てのデータ変更を拒否、他チームの編集も拒否', (t) => {
  const f = setup(t);
  for (const action of ['node', 'deck', 'discussion', 'vote', 'settings', 'addTeam', 'timer'])
    assert.throws(
      () => f.act(f.viewer, action, { teamId: f.team.id }),
      (e) => e.status === 403,
    );
  assert.throws(
    () => f.act(f.editor, 'node', { teamId: f.other.id, text: '越境' }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => f.act(f.editor, 'settings', {}),
    (e) => e.status === 403,
  );
});

test('マップ貼付け: 枝の後ろへ親子関係・色を一括追加し、同階層追加と再送でも重複しない', (t) => {
  const f = setup(t),
    anchor = f.team.nodes[0];
  const initial = f.store.get('workshops', f.ws.id);
  initial.teams[f.team.id].nodes[0].group = 4;
  f.store.put('workshops', initial.id, initial);
  const payload = {
    teamId: f.team.id,
    anchorId: anchor.id,
    placement: 'child',
    text: '親\n\t子\n\t\t孫\n別の親',
  };
  const requestId = id(),
    revision = initial.revision;
  let saved = f.act(f.editor, 'pasteOutline', payload, revision, requestId);
  const nodes = saved.teams[f.team.id].nodes;
  assert.deepEqual(
    nodes.slice(1, 5).map((n) => n.text),
    ['親', '子', '孫', '別の親'],
  );
  assert.deepEqual(
    nodes.slice(1, 5).map((n) => n.parent),
    [anchor.id, nodes[1].id, nodes[2].id, anchor.id],
  );
  assert.ok(nodes.slice(1, 5).every((n) => n.group === 4));
  saved = f.act(f.editor, 'pasteOutline', payload, revision, requestId);
  assert.equal(saved.teams[f.team.id].nodes.length, 11);
  saved = f.act(f.editor, 'pasteOutline', { ...payload, placement: 'sibling', text: '同階層' });
  assert.equal(saved.teams[f.team.id].nodes[5].parent, null);
});

test('マップ貼付け: 不正入力・他班・閲覧者・上限超過を原子的に拒否', (t) => {
  const f = setup(t),
    payload = { teamId: f.team.id, anchorId: 'theme', placement: 'child', text: '親\n\t子' };
  const before = JSON.stringify(f.store.get('workshops', f.ws.id));
  for (const [user, p] of [
    [f.viewer, payload],
    [f.editor, { ...payload, teamId: f.other.id }],
    [f.editor, { ...payload, text: '親\n' + ' '.repeat(3) + '子\n 孫' }],
    [f.editor, { ...payload, text: 'a\n'.repeat(500) }],
    [f.editor, { ...payload, anchorId: 'missing' }],
  ])
    assert.throws(() => f.act(user, 'pasteOutline', p));
  assert.equal(JSON.stringify(f.store.get('workshops', f.ws.id)), before);
});
test('完了・破棄・期限は既存ログインにも即時適用、管理者は管理上の閲覧を維持', (t) => {
  const f = setup(t);
  for (const status of ['完了（変更不可）', '破棄（閲覧不可）']) {
    const ws = f.store.get('workshops', f.ws.id);
    ws.status = status;
    f.store.put('workshops', ws.id, ws);
    assert.throws(
      () => f.act(f.admin, 'node', { teamId: f.team.id, text: '変更' }),
      (e) => e.status === 403,
    );
    assert.doesNotThrow(() => access(f.store, ws, f.admin));
    if (status === '完了（変更不可）') assert.doesNotThrow(() => access(f.store, ws, f.viewer));
    else
      assert.throws(
        () => access(f.store, ws, f.viewer),
        (e) => e.status === 403,
      );
  }
  const ws = f.store.get('workshops', f.ws.id);
  ws.status = '進行中';
  ws.endDate = '2000-01-01';
  f.store.put('workshops', ws.id, ws);
  assert.throws(
    () => access(f.store, ws, f.editor),
    (e) => e.status === 403,
  );
  assert.equal(f.store.get('workshops', ws.id).status, '破棄（閲覧不可）');
  assert.equal(expiry('2026-11-03'), Date.parse('2026-11-03T14:59:59.999Z'));
});
test('Notionの権限確認が古い・失敗・競合中なら参加者にはフェイルクローズ', (t) => {
  const f = setup(t);
  for (const notion of [
    { checkedAt: 0 },
    { checkedAt: Date.now(), error: 'failed' },
    { checkedAt: Date.now(), conflict: {} },
  ]) {
    const ws = f.store.get('workshops', f.ws.id);
    ws.notion = notion;
    assert.throws(
      () => access(f.store, ws, f.editor),
      (e) => e.status === 503,
    );
    assert.doesNotThrow(() => access(f.store, ws, f.admin));
  }
});
test('投票は時間外を拒否、複数投票・取消・予算・再送を整合させる', (t) => {
  const f = setup(t),
    target = f.team.nodes[0].id;
  assert.throws(
    () => f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 }),
    (e) => e.status === 409,
  );
  f.act(f.admin, 'timer', { phase: 'cards' });
  const key = id();
  f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 }, 0, key);
  f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 }, 0, key);
  assert.equal(totals(f.store.get('workshops', f.ws.id), 'cards')[target], 1);
  for (let i = 0; i < 9; i++) f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 }, 0);
  assert.throws(
    () => f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 }),
    (e) => e.status === 409,
  );
  f.act(f.editor, 'vote', { phase: 'cards', target, delta: -1 });
  assert.equal(totals(f.store.get('workshops', f.ws.id), 'cards')[target], 9);
  assert.throws(() => f.act(f.admin, 'settings', { budgets: { cards: 8 } }));
  f.act(f.admin, 'timer', { phase: 'cards', stop: true });
  assert.throws(
    () => f.act(f.editor, 'vote', { phase: 'cards', target, delta: -1 }),
    (e) => e.status === 409,
  );
});
test('デッキは得票済み・重複なし・最大5枚、取消で0票になったカードは外れる', (t) => {
  const f = setup(t),
    ids = f.team.nodes.map((n) => n.id);
  assert.throws(() => f.act(f.editor, 'deck', { teamId: f.team.id, ids: [ids[0]] }));
  f.act(f.admin, 'timer', { phase: 'cards' });
  for (const target of ids) f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 });
  assert.throws(() => f.act(f.editor, 'deck', { teamId: f.team.id, ids: ids.slice(0, 6) }));
  assert.throws(() => f.act(f.editor, 'deck', { teamId: f.team.id, ids: [ids[0], ids[0]] }));
  f.act(f.editor, 'deck', { teamId: f.team.id, ids: ids.slice(0, 5) });
  f.act(f.editor, 'vote', { phase: 'cards', target: ids[0], delta: -1 });
  assert.equal(f.store.get('workshops', f.ws.id).teams[f.team.id].deck.length, 4);
});
test('親子の循環を拒否・競合更新は409・不正入力は全体をロールバック', (t) => {
  const f = setup(t),
    [a, b] = f.team.nodes;
  f.act(f.editor, 'node', { teamId: f.team.id, id: b.id, text: b.text, parent: a.id });
  assert.throws(() =>
    f.act(f.editor, 'node', { teamId: f.team.id, id: a.id, text: a.text, parent: b.id }),
  );
  assert.throws(
    () => f.act(f.editor, 'node', { teamId: f.team.id, text: '古い更新' }, 1),
    (e) => e.status === 409,
  );
  const before = f.store.get('workshops', f.ws.id);
  assert.throws(() =>
    f.act(f.editor, 'discussion', { teamId: f.team.id, what: '有効', who: 'あ'.repeat(41) }),
  );
  assert.deepEqual(f.store.get('workshops', f.ws.id), before);
});
test('議論の再開と履歴、文字数制約、個人別投票の非公開', (t) => {
  const f = setup(t);
  f.act(f.editor, 'discussion', {
    teamId: f.team.id,
    running: true,
    what: '地域のつながり',
    who: '新しい住民',
    how: '週末の交流会',
    keywords: '地域',
    points: '地域で気軽に話せる',
    transcript: '記録1',
  });
  f.act(f.editor, 'discussion', { teamId: f.team.id, running: false });
  f.act(f.editor, 'discussion', { teamId: f.team.id, running: true, transcript: '記録1\n記録2' });
  const ws = f.store.get('workshops', f.ws.id);
  assert.equal(ws.teams[f.team.id].discussion.rounds.length, 1);
  assert.match(markdown(ws, ws.teams[f.team.id]), /\*\*地域\*\*/);
  const v = view(ws, f.editor);
  assert.equal(v.members, undefined);
  assert.equal(v.votes.cards[f.viewer.email], undefined);
  ws.teams[f.other.id].nodes = [
    { id: 'private-node', text: '他チームの下書き', parent: null, group: 0 },
  ];
  ws.teams[f.other.id].discussion.transcript = '他チームの生の議論';
  const isolated = view(ws, f.editor);
  assert.equal(isolated.teams[f.other.id].nodes[0].text, '他チームの下書き');
  assert.equal(isolated.teams[f.other.id].discussion.transcript, '他チームの生の議論');
  assert.throws(
    () => f.act(f.admin, 'node', { teamId: f.other.id, text: '越境' }),
    (e) => e.status === 403,
  );
});
test('自チーム画像へ複数投票でき、参加者取り消しにも予算を適用', (t) => {
  const f = setup(t),
    ws = f.store.get('workshops', f.ws.id);
  ws.teams[f.team.id].image = { base64: 'test-only' };
  f.store.put('workshops', ws.id, ws);
  f.act(f.admin, 'timer', { phase: 'ideas' });
  for (let i = 0; i < 10; i++)
    f.act(f.editor, 'vote', { phase: 'ideas', target: f.team.id, delta: 1 });
  assert.throws(() => f.act(f.editor, 'vote', { phase: 'ideas', target: f.team.id, delta: 1 }));
  f.act(f.editor, 'vote', { phase: 'ideas', target: f.team.id, delta: -1 });
  assert.equal(totals(f.store.get('workshops', ws.id), 'ideas')[f.team.id], 9);
});

test('マップ: 通常追加は末尾に単独、Enter同階層・Insert子、枝移動・単独化・削除・循環拒否', (t) => {
  const f = setup(t),
    tId = f.team.id;
  let result = f.act(f.editor, 'node', { teamId: tId, text: '新しい単独' }),
    nodes = result.teams[tId].nodes;
  const floating = nodes.at(-1);
  assert.equal(floating.parent, null);
  f.act(f.editor, 'reparent', { teamId: tId, id: floating.id, parent: 'theme' });
  result = f.act(f.editor, 'createTopic', {
    teamId: tId,
    text: '子トピック',
    anchorId: floating.id,
    placement: 'child',
  });
  const child = result.teams[tId].nodes.find((n) => n.text === '子トピック');
  assert.equal(child.parent, floating.id);
  result = f.act(f.editor, 'createTopic', {
    teamId: tId,
    text: '同じ階層',
    anchorId: child.id,
    placement: 'sibling',
  });
  const sibling = result.teams[tId].nodes.find((n) => n.text === '同じ階層');
  assert.equal(sibling.parent, floating.id);
  assert.throws(
    () => f.act(f.editor, 'reparent', { teamId: tId, id: floating.id, parent: child.id }),
    (e) => e.status === 400,
  );
  result = f.act(f.editor, 'reparent', { teamId: tId, id: floating.id, parent: null });
  assert.equal(result.teams[tId].nodes.find((n) => n.id === child.id).parent, floating.id);
  result = f.act(f.editor, 'standalone', { teamId: tId, id: floating.id });
  assert.equal(result.teams[tId].nodes.find((n) => n.id === child.id).parent, null);
  f.act(f.editor, 'reparent', { teamId: tId, id: child.id, parent: floating.id });
  result = f.act(f.editor, 'deleteNode', { teamId: tId, id: floating.id });
  assert.equal(
    result.teams[tId].nodes.some((n) => n.id === child.id),
    false,
  );
  assert.ok(!result.teams[tId].nodes.some((n) => n.id === floating.id));
  result = f.act(f.editor, 'topicTheme', { teamId: tId, text: 'チームの中心' });
  assert.equal(result.teams[tId].rootText, 'チームの中心');
  assert.equal(result.theme, f.ws.theme);
});

test('既存マップ移行は中心への接続・文字を保存し、一度だけ実行される', (t) => {
  const f = setup(t),
    old = f.store.get('workshops', f.ws.id);
  delete old.teams[f.team.id].mapVersion;
  f.store.put('workshops', old.id, old);
  f.store.migrateMaps();
  const after = f.store.get('workshops', old.id);
  assert.equal(after.revision, old.revision + 1);
  assert.deepEqual(
    after.teams[f.team.id].nodes.map((n) => n.text),
    f.team.nodes.map((n) => n.text),
  );
  assert.ok(after.teams[f.team.id].nodes.every((n) => n.parent === 'theme'));
  f.store.migrateMaps();
  assert.equal(f.store.get('workshops', old.id).revision, after.revision);
});

test('マップ取消: 親削除は全子孫・関連票・デッキをまとめて消し、1回の取消で同じ順序とIDへ戻る', (t) => {
  const f = setup(t),
    w = f.store.get('workshops', f.ws.id),
    team = w.teams[f.team.id];
  team.nodes = [
    { id: 'p', text: '親', parent: 'theme', group: 1 },
    { id: 'c', text: '子', parent: 'p', group: 2 },
    { id: 'g', text: '孫', parent: 'c', group: 3 },
    { id: 's', text: '隣', parent: 'theme', group: 0 },
  ];
  w.votes.cards = { [f.editor.email]: { p: 2, c: 1, s: 1 }, [f.admin.email]: { g: 1 } };
  w.notionVoteBaseline = { cards: { g: 3 }, ideas: {} };
  team.deck = ['p', 'c', 'g'];
  f.store.put('workshops', w.id, w);
  let result = f.act(f.editor, 'deleteNode', { teamId: team.id, id: 'p' });
  assert.deepEqual(
    result.teams[team.id].nodes.map((n) => n.id),
    ['s'],
  );
  assert.deepEqual(result.teams[team.id].deck, []);
  assert.deepEqual(result.votes.cards[f.editor.email], { s: 1 });
  assert.deepEqual(result.notionVoteBaseline.cards, {});
  result = f.act(f.editor, 'undoMap', { teamId: team.id });
  assert.deepEqual(result.teams[team.id].nodes, team.nodes);
  assert.deepEqual(result.teams[team.id].deck, team.deck);
  assert.deepEqual(result.votes.cards, w.votes.cards);
  assert.deepEqual(result.notionVoteBaseline, w.notionVoteBaseline);
  assert.equal(JSON.stringify(view(result, f.editor)).includes('map-undo:'), false);
});

test('マップ上下移動: 子孫を枝ごと前後へ移し、Undoで順序を戻して循環・越境を拒否', (t) => {
  const f = setup(t),
    w = f.store.get('workshops', f.ws.id),
    team = w.teams[f.team.id];
  team.nodes = [
    { id: 'a', text: 'A', parent: 'theme', group: 0 },
    { id: 'ac', text: 'A子', parent: 'a', group: 0 },
    { id: 'b', text: 'B', parent: 'theme', group: 1 },
    { id: 'bc', text: 'B子', parent: 'b', group: 1 },
    { id: 'c', text: 'C', parent: 'theme', group: 2 },
  ];
  f.store.put('workshops', w.id, w);
  let result = f.act(f.editor, 'reorderTopic', {
    teamId: team.id,
    id: 'a',
    targetId: 'b',
    position: 'after',
  });
  assert.deepEqual(
    result.teams[team.id].nodes.map((n) => n.id),
    ['b', 'bc', 'a', 'ac', 'c'],
  );
  result = f.act(f.editor, 'undoMap', { teamId: team.id });
  assert.deepEqual(result.teams[team.id].nodes, team.nodes);
  assert.throws(() =>
    f.act(f.editor, 'reorderTopic', {
      teamId: team.id,
      id: 'a',
      targetId: 'ac',
      position: 'before',
    }),
  );
  assert.throws(
    () =>
      f.act(f.viewer, 'reorderTopic', {
        teamId: team.id,
        id: 'c',
        targetId: 'a',
        position: 'before',
      }),
    (e) => e.status === 403,
  );
  result = f.act(f.editor, 'reorderTopic', {
    teamId: team.id,
    id: 'c',
    targetId: 'a',
    position: 'before',
  });
  assert.deepEqual(
    result.teams[team.id].nodes.map((n) => n.id),
    ['c', 'a', 'ac', 'b', 'bc'],
  );
});

test('マップ取消: 追加・文字・色・移動・中心名・貼付け・単独化を順に取り消せる', (t) => {
  const f = setup(t),
    teamId = f.team.id,
    original = f.store.get('workshops', f.ws.id).teams[teamId];
  let w = f.act(f.editor, 'createTopic', { teamId, placement: 'main', text: '追加' }),
    added = w.teams[teamId].nodes.at(-1);
  f.act(f.editor, 'node', { teamId, id: added.id, text: '編集', group: 5 });
  f.act(f.editor, 'reparent', { teamId, id: added.id, parent: f.team.nodes[0].id });
  f.act(f.editor, 'topicTheme', { teamId, text: '新しい中心' });
  f.act(f.editor, 'pasteOutline', {
    teamId,
    anchorId: added.id,
    placement: 'child',
    text: '子\n\t孫',
  });
  f.act(f.editor, 'standalone', { teamId, id: added.id });
  for (let i = 0; i < 6; i++) w = f.act(f.editor, 'undoMap', { teamId });
  assert.deepEqual(w.teams[teamId], original);
  assert.throws(() => f.act(f.editor, 'undoMap', { teamId }), /取り消せるマップ操作がありません/);
});

test('マップ取消: 最大20操作・操作IDによる再送保護・Notion物理ID変更の保持', (t) => {
  const f = setup(t),
    teamId = f.team.id,
    nodeId = f.team.nodes[0].id;
  for (let i = 1; i <= 25; i++) f.act(f.editor, 'node', { teamId, id: nodeId, text: '編集' + i });
  const w = f.store.get('workshops', f.ws.id);
  w.teams[teamId].nodes[0].notionBlockId = 'new-physical-id';
  f.store.put('workshops', w.id, w);
  const req = id(),
    revision = w.revision;
  f.act(f.editor, 'undoMap', { teamId }, revision, req);
  let result = f.act(f.editor, 'undoMap', { teamId }, revision, req);
  assert.equal(result.teams[teamId].nodes[0].text, '編集24');
  assert.equal(result.teams[teamId].nodes[0].notionBlockId, 'new-physical-id');
  for (let i = 1; i < 20; i++) result = f.act(f.editor, 'undoMap', { teamId });
  assert.equal(result.teams[teamId].nodes[0].text, '編集5');
  assert.throws(() => f.act(f.editor, 'undoMap', { teamId }), /取り消せるマップ操作がありません/);
});

test('マップ取消: 他者のマップ更新を巻き戻さず、閲覧者・他班の取り消しを拒否', (t) => {
  const f = setup(t),
    teamId = f.team.id;
  f.act(f.editor, 'node', { teamId, id: f.team.nodes[0].id, text: '自分の変更' });
  assert.throws(() => f.act(f.admin, 'undoMap', { teamId }), /取り消せるマップ操作がありません/);
  f.act(f.admin, 'node', { teamId, id: f.team.nodes[1].id, text: '他者の変更' });
  const before = JSON.stringify(f.store.get('workshops', f.ws.id));
  assert.throws(() => f.act(f.editor, 'undoMap', { teamId }), /別の編集/);
  assert.throws(
    () => f.act(f.viewer, 'undoMap', { teamId }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => f.act(f.editor, 'undoMap', { teamId: f.other.id }),
    (e) => e.status === 403,
  );
  assert.equal(JSON.stringify(f.store.get('workshops', f.ws.id)), before);
});

test('マップ取消: 削除後に振り直した票と競合する復元は全体をロールバックし履歴を保持', (t) => {
  const f = setup(t),
    w = f.store.get('workshops', f.ws.id),
    teamId = f.team.id,
    [a, b] = f.team.nodes;
  w.votes.cards[f.editor.email] = { [a.id]: 5 };
  w.timers.cards = { endsAt: Date.now() + 60000, closed: false };
  f.store.put('workshops', w.id, w);
  f.act(f.editor, 'deleteNode', { teamId, id: a.id });
  for (let i = 0; i < 10; i++) f.act(f.editor, 'vote', { phase: 'cards', target: b.id, delta: 1 });
  const before = JSON.stringify(f.store.get('workshops', w.id));
  assert.throws(() => f.act(f.editor, 'undoMap', { teamId }), /投票と競合/);
  assert.equal(JSON.stringify(f.store.get('workshops', w.id)), before);
  for (let i = 0; i < 5; i++) f.act(f.editor, 'vote', { phase: 'cards', target: b.id, delta: -1 });
  assert.ok(f.act(f.editor, 'undoMap', { teamId }).teams[teamId].nodes.some((n) => n.id === a.id));
});

test('③の文字サイズは管理者だけが決められた段階から設定できる', (t) => {
  const f = setup(t);
  const w = f.act(f.admin, 'settings', { textScale: 130 });
  assert.equal(w.textScale, 130);
  assert.throws(() => f.act(f.admin, 'settings', { textScale: 999 }), /文字サイズ/);
  assert.throws(() => f.act(f.editor, 'settings', { textScale: 100 }), /管理者/);
});

test('③デッキのリフレッシュ: 今のデッキを＃1として保存して空にし、＃1へ戻すと＃2も残る', (t) => {
  const f = setup(t),
    ids = f.team.nodes.map((n) => n.id);
  f.act(f.admin, 'timer', { phase: 'cards' });
  for (const target of ids.slice(0, 3)) f.act(f.editor, 'vote', { phase: 'cards', target, delta: 1 });
  f.act(f.editor, 'deck', { teamId: f.team.id, ids: ids.slice(0, 2) });
  // Unsent edits arrive with the refresh and stay with deck #1.
  let w = f.act(f.editor, 'clearIdea', { teamId: f.team.id, headline: '最初の案', transcript: '議論1' });
  let tm = w.teams[f.team.id];
  assert.equal(tm.ideas.length, 1);
  assert.deepEqual(tm.ideas[0].deck, ids.slice(0, 2));
  assert.equal(tm.ideas[0].discussion.headline, '最初の案');
  assert.deepEqual(tm.deck, []);
  assert.equal(tm.discussion.headline, '');
  assert.equal(tm.discussion.transcript, '');
  assert.equal(tm.activeIdeaId, null);
  // Deck #2 with only cards is still kept when switching back to #1.
  f.act(f.editor, 'deck', { teamId: f.team.id, ids: [ids[2]] });
  w = f.act(f.editor, 'restoreIdea', { teamId: f.team.id, ideaId: tm.ideas[0].id, headline: '二つ目' });
  tm = w.teams[f.team.id];
  assert.equal(tm.ideas.length, 2);
  assert.deepEqual(tm.ideas[1].deck, [ids[2]]);
  assert.equal(tm.ideas[1].discussion.headline, '二つ目');
  assert.equal(tm.activeIdeaId, tm.ideas[0].id);
  assert.deepEqual(tm.deck, ids.slice(0, 2));
  assert.equal(tm.discussion.headline, '最初の案');
  // An empty refresh does not add an empty deck.
  w = f.act(f.editor, 'clearIdea', { teamId: f.team.id });
  w = f.act(f.editor, 'clearIdea', { teamId: f.team.id });
  assert.equal(w.teams[f.team.id].ideas.length, 2);
  assert.throws(() => f.act(f.viewer, 'clearIdea', { teamId: f.team.id }));
});
