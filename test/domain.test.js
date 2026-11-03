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
  assert.equal(result.teams[tId].nodes.find((n) => n.id === child.id).parent, null);
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
