import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configuration } from '../server/index.js';
import { id, newWorkshop, newTeam, passwordHash } from '../server/store.js';
import { testPNG } from '../test-support/fixtures.js';
import { Fault } from '../server/domain.js';

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workshop-http-')),
    codes = new Map();
  const config = configuration({
    HOST: '127.0.0.1',
    PORT: '0',
    APP_ORIGIN: 'http://localhost:4317',
    DATA_DIR: dir,
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
  });
  const app = createApp(config, { sendOtp: async (email, code) => codes.set(email, code) });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const req = async (path, body, session = {}, headers = {}) => {
    const r = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
        ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const type = r.headers.get('content-type');
    return {
      status: r.status,
      body: type?.includes('json') ? await r.json() : await r.text(),
      cookie: r.headers.get('set-cookie')?.split(';')[0],
      headers: r.headers,
    };
  };
  const login = async (email) => {
    const start = await req('/api/auth/start', { email });
    const r = await req('/api/auth/verify', {
      challenge: start.body.challenge,
      code: codes.get(email),
    });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.body.csrf };
  };
  return { app, req, login, codes };
}

test('HTTP: 新規作成はNotionを待たずアプリ内で完了し、一覧からアーカイブ・削除・復元・完全削除できる', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  // Notion is configured but down: creating a workshop must not depend on it.
  const n = f.app.notion;
  n.config.notionToken = 'fixture';
  n.config.notionSource = 'fixture';
  let notionCalls = 0;
  n.transport = async () => {
    notionCalls++;
    return { ok: false, status: 503, text: async () => '' };
  };
  const requestId = id();
  const made = await f.req('/api/workshops', { name: 'テスト5', requestId }, admin);
  assert.equal(made.status, 201);
  assert.equal(made.body.status, '進行中');
  assert.equal(made.body.notion, null);
  assert.equal(notionCalls, 0);
  // The same create request again (a lost answer) does not make a second workshop.
  assert.equal((await f.req('/api/workshops', { name: 'テスト5', requestId }, admin)).body.id, made.body.id);
  const ws = made.body,
    teamId = Object.keys(ws.teams)[0];
  // Usable at once.
  const act = await f.req(
    `/api/workshops/${ws.id}/action`,
    { action: 'createTopic', payload: { teamId, anchorId: 'theme', placement: 'child', text: '最初のトピック' }, revision: ws.revision, requestId: id() },
    admin,
  );
  assert.equal(act.status, 200);
  const list = async () => (await f.req('/api/workshops', undefined, admin)).body.find((w) => w.id === ws.id);
  const shelf = (state, session = admin) => f.req(`/api/workshops/${ws.id}/shelf`, { state }, session);
  assert.deepEqual([(await list()).deleted, (await list()).archived], [false, false]);
  // Archive and back.
  assert.equal((await shelf('archived')).status, 200);
  assert.equal((await list()).archived, true);
  assert.equal((await shelf('active')).body.archived, false);
  // Delete: kept in the list for the admin, read-only, and restorable.
  assert.equal((await shelf('purge')).status, 409);
  assert.equal((await shelf('deleted')).body.deleted, true);
  assert.equal((await list()).deleted, true);
  assert.equal(
    (await f.req(`/api/workshops/${ws.id}/transcript`, { teamId, text: '書けない' }, admin)).status,
    403,
  );
  // A workshop that was discarded or has expired comes back usable.
  {
    const w = f.app.store.get('workshops', ws.id);
    w.status = '破棄（閲覧不可）';
    w.endDate = '2020-01-01';
    f.app.store.put('workshops', ws.id, w);
  }
  const back = await shelf('active');
  assert.deepEqual([back.body.deleted, back.body.status], [false, '進行中']);
  assert.equal(
    (await f.req(`/api/workshops/${ws.id}/transcript`, { teamId, text: 'また書ける' }, admin)).status,
    200,
  );
  // Only an admin may shelve; a wrong word is refused.
  f.app.store.put('users', 'editor@example.test', { id: id(), email: 'editor@example.test', admin: false, passkeys: [] });
  {
    const w = f.app.store.get('workshops', ws.id);
    w.members['editor@example.test'] = { role: '編集者', teamId: null };
    f.app.store.put('workshops', ws.id, w);
  }
  const editor = await f.login('editor@example.test');
  assert.equal((await shelf('deleted', editor)).status, 403);
  assert.equal((await shelf('gone')).status, 400);
  // Purge: gone for good, only from the deleted ones.
  await shelf('deleted');
  assert.equal((await shelf('purge')).status, 200);
  assert.equal(await list(), undefined);
  assert.ok(!f.app.store.get('workshops', ws.id));
  assert.equal(notionCalls, 0);
});

test('HTTP: マップ操作はNotion通信も記録予約もせず保存し、連続編集できる', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test'),
    ws = newWorkshop('待機同期', 'admin@example.test'),
    team = Object.values(ws.teams)[0];
  ws.notion = { pageId: 'test-page', checkedAt: Date.now() };
  f.app.store.put('workshops', ws.id, ws);
  f.app.store.put('kv', `notion-content:${ws.id}`, { doc: { sections: {} } });
  let externalCalls = 0;
  f.app.notion.transport = async () => {
    externalCalls++;
    throw Error('マップ操作では呼び出さない');
  };
  let current = ws;
  for (const value of ['先に保存する', '続けて保存する']) {
    const response = await f.req(
      `/api/workshops/${ws.id}/action`,
      {
        action: 'node',
        payload: { teamId: team.id, text: value, parent: null, group: 0 },
        revision: current.revision,
        requestId: id(),
      },
      admin,
    );
    assert.equal(response.status, 200);
    assert.equal(!!response.body.documentSync?.queued, false); // v0.14: recorded on save
    current = response.body;
  }
  assert.equal(current.teams[team.id].nodes.length, 2);
  const revision = current.revision;
  assert.equal(
    (await f.req(`/api/workshops/${ws.id}/content-activity`, { teamId: team.id }, admin)).status,
    200,
  );
  assert.equal(f.app.store.get('workshops', ws.id).revision, revision);
  assert.equal(externalCalls, 0);
  const response = await f.req(
    `/api/workshops/${ws.id}/action`,
    {
      action: 'pasteOutline',
      payload: { teamId: team.id, anchorId: 'theme', placement: 'child', text: '親\n\t子' },
      revision: current.revision,
      requestId: id(),
    },
    admin,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.teams[team.id].nodes.length, 4);
  assert.equal(externalCalls, 0);
});

test('HTTP: 直接編集・親削除・取消を続けて保存し、削除した子孫を1操作で復元', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test'),
    w = newWorkshop('取消HTTP', 'admin@example.test'),
    team = Object.values(w.teams)[0];
  team.nodes = [
    { id: 'p', text: '親', parent: 'theme', group: 0 },
    { id: 'c', text: '子', parent: 'p', group: 0 },
  ];
  f.app.store.put('workshops', w.id, w);
  let current = w;
  const act = async (action, payload) => {
    const r = await f.req(
      `/api/workshops/${w.id}/action`,
      {
        action,
        payload: { teamId: team.id, ...payload },
        revision: current.revision,
        requestId: id(),
      },
      admin,
    );
    assert.equal(r.status, 200);
    current = r.body;
    return current;
  };
  await act('node', { id: 'p', text: '編集した親' });
  await act('deleteNode', { id: 'p' });
  assert.equal(current.teams[team.id].nodes.length, 0);
  await act('undoMap', {});
  assert.equal(current.teams[team.id].nodes.length, 2);
  assert.equal(current.teams[team.id].nodes[0].text, '編集した親');
  await act('undoMap', {});
  assert.equal(current.teams[team.id].nodes[0].text, '親');
});

test('HTTP: Notionの読取り・送信が進行中でも編集と活動通知を拒否しない', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test'),
    w = newWorkshop('同期中の編集', 'admin@example.test'),
    team = Object.values(w.teams)[0];
  w.notion = { pageId: 'fixture-page', checkedAt: Date.now() };
  w.documentSync = { pending: true, syncing: true, generation: 1, error: null };
  f.app.store.put('workshops', w.id, w);
  f.app.store.put('kv', `notion-content:${w.id}`, { doc: { sections: {} } });
  f.app.notion.running = Promise.resolve();
  f.app.notion.content.active.set(w.id, Promise.resolve());
  try {
    const response = await f.req(
      `/api/workshops/${w.id}/action`,
      {
        action: 'createTopic',
        payload: { teamId: team.id, placement: 'main', text: '同期完了を待たず保存' },
        revision: w.revision,
        requestId: id(),
      },
      admin,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.documentSync.syncing, true);
    assert.equal(response.body.teams[team.id].nodes[0].text, '同期完了を待たず保存');
    assert.equal(
      (await f.req(`/api/workshops/${w.id}/content-activity`, { teamId: team.id }, admin)).status,
      200,
    );
  } finally {
    f.app.notion.running = null;
    f.app.notion.content.active.clear();
  }
});

test('HTTP: mdは管理者だけ編集可能。全チーム閲覧と越境変更・AIの拒否、分類確認と取り消し', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const ws = newWorkshop('マップ権限テスト', 'admin@example.test'),
    team = Object.values(ws.teams)[0],
    other = newTeam('B班');
  other.nodes = [{ id: 'b1', text: 'B班の気づき', parent: null, group: 1 }];
  ws.teams[other.id] = other;
  team.nodes = [{ id: 'a1', text: 'A班の気づき', parent: null, group: 2 }];
  ws.members['editor@example.test'] = { role: '編集者', teamId: team.id };
  f.app.store.put('workshops', ws.id, ws);
  f.app.store.put('users', 'editor@example.test', {
    id: id(),
    email: 'editor@example.test',
    passkeys: [],
  });
  const editor = await f.login('editor@example.test');
  const settings = await f.req('/api/facilitator', undefined, admin);
  assert.equal(settings.status, 200);
  assert.ok(settings.body.markdown.includes('facilitator-config'));
  assert.equal((await f.req('/api/facilitator', undefined, editor)).status, 403);
  assert.equal(
    (
      await f.req(
        '/api/facilitator',
        { version: settings.body.version, markdown: settings.body.markdown },
        editor,
      )
    ).status,
    403,
  );
  const changed = await f.req(
    '/api/facilitator',
    { version: settings.body.version, markdown: settings.body.markdown + '\nテスト追記' },
    admin,
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (
      await f.req(
        '/api/facilitator',
        { version: settings.body.version, markdown: settings.body.markdown },
        admin,
      )
    ).status,
    409,
  );
  assert.equal((await f.req('/api/facilitator/export', undefined, admin)).status, 200);
  const read = await f.req(`/api/workshops/${ws.id}`, undefined, editor);
  assert.equal(read.body.teams[other.id].nodes[0].text, 'B班の気づき');
  // v0.19: any team may be edited; only a team that does not exist is refused.
  for (const session of [admin, editor]) {
    assert.equal(
      (
        await f.req(
          `/api/workshops/${ws.id}/action`,
          {
            action: 'node',
            payload: { teamId: 'missing-team', text: '存在しない班' },
            revision: ws.revision,
            requestId: id(),
          },
          session,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.req(
          `/api/workshops/${ws.id}/advice`,
          { teamId: 'missing-team', phase: 'ideation', event: 'help_requested' },
          session,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.req(`/api/workshops/${ws.id}/ai`, { teamId: 'missing-team', task: 'questions' }, session))
        .status,
      404,
    );
  }
  const proposal = id();
  f.app.store.put('challenges', proposal, {
    type: 'ai',
    email: 'admin@example.test',
    wsId: ws.id,
    teamId: team.id,
    revision: ws.revision,
    task: 'classify',
    result: { groups: [{ nodeIds: ['a1'] }] },
    expires: Date.now() + 60000,
  });
  assert.equal(f.app.store.get('workshops', ws.id).teams[team.id].nodes[0].group, 2);
  const applied = await f.req(`/api/workshops/${ws.id}/apply`, { proposal }, admin);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.teams[team.id].nodes[0].group, 0);
  const undo = await f.req(
    `/api/workshops/${ws.id}/action`,
    {
      action: 'undoClassification',
      payload: { teamId: team.id },
      revision: applied.body.revision,
      requestId: id(),
    },
    admin,
  );
  assert.equal(undo.body.teams[team.id].nodes[0].group, 2);
});
test('HTTP: OTPの消費・未認証・CSRF・Origin・偽パスキー・本番体験モード拒否', async (t) => {
  const f = await setup(t);
  assert.equal((await f.req('/api/workshops')).status, 401);
  assert.equal((await f.req('/api/demo', { email: 'admin@example.test' })).status, 404);
  const s = await f.req('/api/auth/start', { email: 'admin@example.test' });
  const payload = { challenge: s.body.challenge, code: f.codes.get('admin@example.test') };
  const login = await f.req('/api/auth/verify', payload);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.req('/api/auth/verify', payload)).status, 401);
  assert.equal(
    (await f.req('/api/workshops', { name: 'test' }, { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        '/api/workshops',
        { name: 'test' },
        { cookie: login.cookie, csrf: login.body.csrf },
        { Origin: 'https://attacker.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.req('/api/auth/passkey/verify', { challengeId: 'fake', response: { id: 'fake' } }))
      .status,
    401,
  );
  const unknown = await f.req('/api/auth/start', { email: 'unknown@example.test' });
  assert.equal(unknown.status, 200);
  assert.equal(f.codes.has('unknown@example.test'), false);
});
test('HTTP: 管理API・同時投票30件・上限10票・既存セッションの権限変更', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const created = await f.req('/api/workshops', { name: '並行投票テスト' }, admin);
  assert.equal(created.status, 201);
  const wsId = created.body.id,
    teamId = Object.keys(created.body.teams)[0];
  await f.req(
    `/api/workshops/${wsId}/members`,
    { email: 'editor@example.test', role: '編集者', teamId },
    admin,
  );
  const editor = await f.login('editor@example.test');
  const act = async (action, payload, session = admin) => {
    const ws = (await f.req(`/api/workshops/${wsId}`, undefined, session)).body;
    return f.req(
      `/api/workshops/${wsId}/action`,
      { action, payload, revision: ws.revision, requestId: id() },
      session,
    );
  };
  await act('node', { teamId, text: '同じ案' });
  await act('timer', { phase: 'cards' });
  const target = (await f.req(`/api/workshops/${wsId}`, undefined, editor)).body.teams[teamId]
    .nodes[0].id;
  const attempts = await Promise.all(
    Array.from({ length: 30 }, () =>
      f.req(
        `/api/workshops/${wsId}/action`,
        {
          action: 'vote',
          payload: { phase: 'cards', target, delta: 1 },
          revision: 0,
          requestId: id(),
        },
        editor,
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === 200).length, 10);
  assert.equal(attempts.filter((r) => r.status === 409).length, 20);
  const ws = (await f.req(`/api/workshops/${wsId}`, undefined, editor)).body;
  assert.equal(ws.votes.cards.totals[target], 10);
  assert.equal((await act('settings', { budgets: { cards: 50 } }, editor)).status, 403);
  assert.equal(
    (await f.req('/api/ai/settings', { provider: 'attacker', model: '' }, editor)).status,
    403,
  );
  await f.req(
    `/api/workshops/${wsId}/members`,
    { email: 'editor@example.test', role: '閲覧者', teamId },
    admin,
  );
  assert.equal((await act('node', { teamId, text: '拒否' }, editor)).status, 403);
  const meta = (await f.req(`/api/workshops/${wsId}`, undefined, admin)).body;
  await f.req(
    `/api/workshops/${wsId}/meta`,
    { revision: meta.revision, status: '完了（変更不可）' },
    admin,
  );
  assert.equal(
    (await f.req(`/api/workshops/${wsId}/export?team=${teamId}&format=md`, undefined, editor))
      .status,
    403,
  );
  assert.equal(
    (await f.req(`/api/workshops/${wsId}/export?team=${teamId}&format=md`, undefined, admin))
      .status,
    200,
  );
  assert.equal((await act('node', { teamId, text: '完了後' }, admin)).status, 403);
});
test('HTTP: 認証済というプロフィール値は認証にならず、OTPの試行上限・期限を強制', async (t) => {
  const f = await setup(t);
  f.app.store.put('users', 'member@example.test', {
    email: 'member@example.test',
    id: id(),
    admin: false,
    password: passwordHash('example-password'),
    OTP認証結果: '認証済',
  });
  const wrong = await f.req('/api/auth/start', { email: 'member@example.test', password: 'wrong' });
  assert.equal(wrong.status, 200);
  assert.equal(f.codes.has('member@example.test'), false);
  const s = await f.req('/api/auth/start', { email: 'admin@example.test' });
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.req('/api/auth/verify', { challenge: s.body.challenge, code: '000000' })).status,
      401,
    );
  assert.equal(
    (
      await f.req('/api/auth/verify', {
        challenge: s.body.challenge,
        code: f.codes.get('admin@example.test'),
      })
    ).status,
    401,
  );
  const next = await f.req('/api/auth/start', { email: 'admin@example.test' });
  const c = f.app.store.get('challenges', next.body.challenge);
  c.expires = 0;
  f.app.store.put('challenges', next.body.challenge, c);
  assert.equal(
    (
      await f.req('/api/auth/verify', {
        challenge: next.body.challenge,
        code: f.codes.get('admin@example.test'),
      })
    ).status,
    401,
  );
});
test('HTTP: 終了日を過ぎた既存セッションは閲覧不可・静的資産を配信', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const r = await f.req('/api/workshops', { name: 'expired' }, admin),
    ws = r.body,
    teamId = Object.keys(ws.teams)[0];
  await f.req(
    `/api/workshops/${ws.id}/members`,
    { email: 'viewer@example.test', role: '閲覧者', teamId },
    admin,
  );
  const viewer = await f.login('viewer@example.test');
  const latest = f.app.store.get('workshops', ws.id);
  latest.endDate = '2000-01-01';
  f.app.store.put('workshops', ws.id, latest);
  assert.equal((await f.req(`/api/workshops/${ws.id}`, undefined, viewer)).status, 403);
  assert.equal((await f.req('/api/workshops', undefined, viewer)).body.length, 0);
  assert.equal((await f.req(`/api/workshops/${ws.id}`, undefined, admin)).status, 200);
  for (const path of ['/', '/style.css', '/app.js', '/webauthn.js', '/WorkShop_Top.png'])
    assert.equal((await f.req(path)).status, 200);
  assert.equal((await f.req('/.env')).status, 404);
});
test('外部公開設定にはHTTPSとSecure Cookieを要求', () => {
  assert.throws(() => configuration({ APP_ORIGIN: 'http://example.com' }));
  assert.throws(() => configuration({ APP_ORIGIN: 'https://example.com', SECURE_COOKIE: 'false' }));
  assert.doesNotThrow(() =>
    configuration({ APP_ORIGIN: 'https://example.com', SECURE_COOKIE: 'true' }),
  );
});
test('HTTP: パスワード設定をハッシュ保存し、次の通常ログインで必須、他セッションを失効', async (t) => {
  const f = await setup(t),
    first = await f.login('admin@example.test'),
    second = await f.login('admin@example.test');
  assert.equal(
    (await f.req('/api/password', { password: 'test-password-123' }, first)).status,
    200,
  );
  assert.notEqual(f.app.store.get('users', 'admin@example.test').password, 'test-password-123');
  assert.equal((await f.req('/api/me', undefined, second)).status, 401);
  const missing = await f.req('/api/auth/start', { email: 'admin@example.test' });
  assert.equal(f.app.store.get('challenges', missing.body.challenge), undefined);
  const correct = await f.req('/api/auth/start', {
    email: 'admin@example.test',
    password: 'test-password-123',
  });
  assert.ok(f.app.store.get('challenges', correct.body.challenge));
  assert.equal(
    (
      await f.req(
        '/api/password',
        { password: 'next-password-123', currentPassword: 'wrong' },
        first,
      )
    ).status,
    401,
  );
});
test('HTTP: AI提案は確認前に変更せず、16:9画像の適用・④投票・PNG出力につながる', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const ws = (await f.req('/api/workshops', { name: 'AI適用契約テスト' }, admin)).body,
    teamId = Object.keys(ws.teams)[0];
  let calls = 0;
  f.app.ai.config.providers = [
    {
      id: 'genspark-enterprise',
      label: 'test-only',
      endpoint: 'https://fixture.example.test',
      keyEnv: 'TEST_GATEWAY_KEY',
      approvalReference: 'test-only',
      capabilities: ['image', 'transcribe'],
    },
  ];
  process.env.TEST_GATEWAY_KEY = 'test-only';
  t.after(() => delete process.env.TEST_GATEWAY_KEY);
  f.app.ai.transport = async (_url, request) => {
    calls++;
    const task = JSON.parse(request.body).task;
    return {
      ok: true,
      text: async () =>
        JSON.stringify(task === 'image' ? { pngBase64: testPNG() } : { text: '音声の気づき' }),
    };
  };
  await f.req(
    '/api/ai/settings',
    { provider: 'genspark-enterprise', model: '', imagePrompt: 'テスト専用プロンプト' },
    admin,
  );
  const proposal = await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', teamId }, admin);
  assert.equal(proposal.status, 200);
  assert.equal(f.app.store.get('workshops', ws.id).teams[teamId].image, null);
  const applied = await f.req(
    `/api/workshops/${ws.id}/apply`,
    { proposal: proposal.body.proposal },
    admin,
  );
  assert.equal(applied.status, 200);
  assert.equal(applied.body.teams[teamId].image.width, 16);
  // The image is saved with the current deck, which ④ lists as its own entry.
  assert.equal(applied.body.teams[teamId].ideas.length, 1);
  assert.equal(applied.body.teams[teamId].activeIdeaId, applied.body.teams[teamId].ideas[0].id);
  assert.ok(applied.body.teams[teamId].ideas[0].image.key);
  const timer = await f.req(
    `/api/workshops/${ws.id}/action`,
    {
      action: 'timer',
      payload: { phase: 'ideas' },
      revision: applied.body.revision,
      requestId: id(),
    },
    admin,
  );
  assert.equal(timer.status, 200);
  const vote = await f.req(
    `/api/workshops/${ws.id}/action`,
    {
      action: 'vote',
      payload: { phase: 'ideas', target: teamId, delta: 1 },
      requestId: id(),
    },
    admin,
  );
  assert.equal(vote.status, 200);
  assert.equal(vote.body.votes.ideas.totals[teamId], 1);
  assert.equal(
    (await f.req(`/api/workshops/${ws.id}/apply`, { proposal: proposal.body.proposal }, admin))
      .status,
    400,
  );
  const audio = await f.req(
    `/api/workshops/${ws.id}/ai`,
    { task: 'transcribe', teamId, destination: 'map', audio: 'AA==', mimeType: 'audio/webm' },
    admin,
  );
  assert.equal(audio.status, 200);
  const audioApplied = await f.req(
    `/api/workshops/${ws.id}/apply`,
    { proposal: audio.body.proposal },
    admin,
  );
  assert.equal(audioApplied.body.teams[teamId].nodes[0].text, '音声の気づき');
  assert.equal(audioApplied.body.teams[teamId].discussion.transcript, '');
  assert.equal(calls, 2);
  const current = audioApplied.body;
  const finished = await f.req(
    `/api/workshops/${ws.id}/meta`,
    { revision: current.revision, status: '完了（変更不可）' },
    admin,
  );
  assert.equal(finished.status, 200);
  const image = await f.req(
    `/api/workshops/${ws.id}/export?team=${teamId}&format=png`,
    undefined,
    admin,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('HTTP: Gensparkキーは管理者のみ登録・非公開、模擬原稿は確認して適用する', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  let verified;
  f.app.ai.genspark.verify = async (key) => {
    verified = key;
  };
  const connected = await f.req('/api/ai/connect', { apiKey: 'gsk-test-fixture-secret' }, admin);
  assert.equal(connected.status, 200);
  assert.equal(verified, 'gsk-test-fixture-secret');
  assert.doesNotMatch(JSON.stringify(connected.body), /fixture-secret/);
  assert.doesNotMatch(
    JSON.stringify((await f.req('/api/me', undefined, admin)).body),
    /fixture-secret/,
  );
  assert.equal((await f.req('/api/ai/connect', { apiKey: 'gsk-test-fixture-secret' })).status, 401);
  const ws = (await f.req('/api/workshops', { name: '原稿テスト' }, admin)).body,
    teamId = Object.keys(ws.teams)[0];
  const prompts = await f.req(
    '/api/ai/settings',
    { provider: 'genspark-gsk', model: '', pressReleasePrompt: 'カスタム新聞記事プロンプト' },
    admin,
  );
  assert.match(prompts.body.imagePrompt, /チラシ風/);
  f.app.ai.genspark.run = async (task, input, key, settings) => {
    assert.equal(task, 'pressRelease');
    assert.equal(key, 'gsk-test-fixture-secret');
    assert.equal(settings.pressReleasePrompt, 'カスタム新聞記事プロンプト');
    // The ① voice log is named material, apart from the outline.
    assert.match(input.音声ログ, /駅前は夜に人手が足りない/);
    assert.equal(input.企画内容.transcript, undefined);
    assert.ok(Array.isArray(input.選択したカード));
    return { text: '明日からつながる地域の新しい一歩\n地域の課題を解決する企画構想。' };
  };
  {
    const w = f.app.store.get('workshops', ws.id);
    w.teams[teamId].discussion.transcript = '#01 10:00:00\n駅前は夜に人手が足りない。';
    f.app.store.put('workshops', ws.id, w);
  }
  const proposal = await f.req(
    `/api/workshops/${ws.id}/ai`,
    { task: 'pressRelease', teamId },
    admin,
  );
  assert.equal(proposal.status, 200);
  assert.equal(f.app.store.get('workshops', ws.id).teams[teamId].discussion.pressRelease, '');
  const applied = await f.req(
    `/api/workshops/${ws.id}/apply`,
    { proposal: proposal.body.proposal },
    admin,
  );
  assert.equal(applied.status, 200);
  assert.match(applied.body.teams[teamId].discussion.pressRelease, /明日/);
});

test('HTTP: 既存セッションの管理者権限は最新のメンバーから再計算し、Notionの確認が古くても保つ', async (t) => {
  const f = await setup(t);
  const email = 'member@example.test';
  f.app.store.put('users', email, { id: id(), email, admin: false, passkeys: [] });
  const session = await f.login(email);
  assert.equal((await f.req('/api/me', undefined, session)).body.admin, false);
  assert.equal((await f.req('/api/workshops', undefined, session)).body.length, 0);
  const ws = newWorkshop('同期されたワークショップ', 'admin@example.test');
  ws.notion = { pageId: 'fixture-page', checkedAt: Date.now() };
  ws.members[email] = { role: '管理者', teamId: Object.keys(ws.teams)[0] };
  f.app.store.put('workshops', ws.id, ws);
  assert.equal((await f.req('/api/me', undefined, session)).body.admin, true);
  assert.equal((await f.req('/api/workshops', undefined, session)).body.length, 1);
  assert.equal(f.app.store.get('users', email).admin, false);
  // No Notion check for a long time, or a failed one: the rights stay as last known.
  ws.notion.checkedAt = 0;
  ws.notion.error = 'failed';
  f.app.store.put('workshops', ws.id, ws);
  assert.equal((await f.req('/api/me', undefined, session)).body.admin, true);
  assert.equal((await f.req('/api/workshops', undefined, session)).body.length, 1);
  assert.equal((await f.req(`/api/workshops/${ws.id}`, undefined, session)).status, 200);
  // Taking the role away in the app's member list takes the rights away.
  ws.members[email].role = '閲覧者';
  f.app.store.put('workshops', ws.id, ws);
  assert.equal((await f.req('/api/me', undefined, session)).body.admin, false);
});

test('HTTP: Notion障害中も登録済み利用者はNotionを待たずにOTP認証できる', async (t) => {
  const f = await setup(t);
  Object.assign(f.app.notion.config, {
    notionToken: 'fixture-token',
    notionSource: 'fixture-source',
  });
  let notionCalls = 0;
  f.app.notion.transport = async () => {
    notionCalls++;
    return { ok: false, status: 503 };
  };
  const session = await f.login('admin@example.test');
  const me = await f.req('/api/me', undefined, session);
  assert.equal(me.status, 200);
  // A known address logs in without asking Notion at all.
  assert.equal(notionCalls, 0);
});

test('HTTP: 画像生成中に別の編集があっても結果を捨てず、JPEGはブラウザーで変換したPNGで適用する', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const ws = (await f.req('/api/workshops', { name: '画像生成の競合テスト' }, admin)).body,
    teamId = Object.keys(ws.teams)[0];
  f.app.ai.config.providers = [
    {
      id: 'genspark-enterprise',
      label: 'test-only',
      endpoint: 'https://fixture.example.test',
      keyEnv: 'TEST_GATEWAY_KEY',
      approvalReference: 'test-only',
      capabilities: ['image'],
    },
  ];
  process.env.TEST_GATEWAY_KEY = 'test-only';
  t.after(() => delete process.env.TEST_GATEWAY_KEY);
  let result = { pngBase64: testPNG() };
  f.app.ai.transport = async () => {
    // Someone edits the map while the image is being generated.
    const current = f.app.store.get('workshops', ws.id);
    current.revision++;
    f.app.store.put('workshops', ws.id, current);
    return { ok: true, text: async () => JSON.stringify(result) };
  };
  const proposal = await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', teamId }, admin);
  assert.equal(proposal.status, 200);
  const latest = await f.req(`/api/workshops/${ws.id}`, undefined, admin);
  await f.req(
    `/api/workshops/${ws.id}/action`,
    {
      action: 'createTopic',
      payload: { teamId, text: '確認中の編集', placement: 'child', anchorId: 'theme' },
      revision: latest.body.revision,
      requestId: id(),
    },
    admin,
  );
  const applied = await f.req(`/api/workshops/${ws.id}/apply`, { proposal: proposal.body.proposal }, admin);
  assert.equal(applied.status, 200);
  assert.ok(applied.body.teams[teamId].image);
  result = { imageBase64: '/9j/4AAQ', mime: 'image/jpeg' };
  const jpeg = await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', teamId }, admin);
  assert.equal(jpeg.status, 200);
  assert.equal(
    (await f.req(`/api/workshops/${ws.id}/apply`, { proposal: jpeg.body.proposal }, admin)).status,
    400,
  );
  const converted = await f.req(
    `/api/workshops/${ws.id}/apply`,
    { proposal: jpeg.body.proposal, pngBase64: testPNG() },
    admin,
  );
  assert.equal(converted.status, 200);
});

test('HTTP: OTPでログインした同じブラウザー・同じメールは24時間OTPなしで入れ、別メールや期限切れは再びOTP', async (t) => {
  const f = await setup(t);
  f.app.store.put('users', 'editor@example.test', { id: id(), email: 'editor@example.test', admin: false, passkeys: [] });
  const s = await f.req('/api/auth/start', { email: 'admin@example.test' });
  const login = await f.req('/api/auth/verify', { challenge: s.body.challenge, code: f.codes.get('admin@example.test') });
  const cookies = login.headers.getSetCookie();
  const trust = cookies.find((c) => c.startsWith('wid_trust=')).split(';')[0];
  assert.match(cookies.find((c) => c.startsWith('wid_session=')), /Max-Age=86(400|39\d)/);
  // After logging out, the same email on the same browser logs in without a code.
  f.codes.clear();
  const again = await f.req('/api/auth/start', { email: 'admin@example.test' }, { cookie: trust });
  assert.equal(again.status, 200);
  assert.equal(again.body.trusted, true);
  assert.equal(f.codes.size, 0);
  const session = { cookie: again.cookie, csrf: again.body.csrf };
  assert.equal((await f.req('/api/me', undefined, session)).body.email, 'admin@example.test');
  // Another email, no pass, or an expired pass need a code.
  for (const [email, cookie] of [['editor@example.test', trust], ['admin@example.test', undefined]]) {
    const r = await f.req('/api/auth/start', { email }, { cookie });
    assert.equal(r.body.trusted, undefined);
    assert.ok(r.body.challenge);
  }
  for (const row of f.app.store.db.prepare('SELECT id FROM challenges').all()) {
    const c = f.app.store.get('challenges', row.id);
    if (c?.type === 'otp-trust') f.app.store.put('challenges', row.id, { ...c, expires: Date.now() - 1 });
  }
  const expired = await f.req('/api/auth/start', { email: 'admin@example.test' }, { cookie: trust });
  assert.equal(expired.body.trusted, undefined);
  assert.ok(expired.body.challenge);
});

test('HTTP: QR参加はOTPが通ったメールを編集者として自動登録し、どの班でも編集できる。音声ログは満杯で古い部分を要約に圧縮', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  let ws = (await f.req('/api/workshops', { name: 'QR参加テスト' }, admin)).body;
  ws = (
    await f.req(
      `/api/workshops/${ws.id}/action`,
      { action: 'addTeam', payload: { name: 'B班' }, revision: ws.revision, requestId: id() },
      admin,
    )
  ).body;
  const [teamA, teamB] = Object.keys(ws.teams);
  const qr = await f.req(`/api/workshops/${ws.id}/qr-data`, undefined, admin);
  // The join screen: a short address and the workshop's 6-digit number.
  assert.equal(qr.body.url, 'http://localhost:4317/j');
  assert.equal(qr.body.code.length, 6);
  assert.ok(Number(qr.body.code) >= 100000);
  assert.equal((await f.req(`/api/workshops/${ws.id}/qr-data`, undefined, admin)).body.code, qr.body.code);
  assert.equal((await f.req('/j')).status, 200);
  // An SVG drawn from the code's squares: no PNG encoder (it fails on Cloudflare Workers).
  assert.match(qr.body.dataUrl, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(qr.body.dataUrl.split(',')[1], 'base64').toString();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok((svg.match(/h1v1h-1z/g) || []).length > 200);
  // The list picture: nothing for an empty workshop, then its mind map, then a generated image.
  assert.equal((await f.req(`/api/workshops/${ws.id}/thumb`, undefined, admin)).status, 404);
  {
    const w = f.app.store.get('workshops', ws.id);
    w.teams[teamA].nodes.push(
      { id: 't1', text: '駅前の<人手>不足', parent: 'theme', group: 1 },
      { id: 't2', text: '夜間の見守り', parent: 't1', group: 0 },
    );
    f.app.store.put('workshops', ws.id, w);
    const map = await f.req(`/api/workshops/${ws.id}/thumb`, undefined, admin);
    assert.ok(map.headers.get('content-type').startsWith('image/svg+xml'));
    assert.ok(map.body.startsWith('<svg ') && map.body.includes('viewBox="0 0 400 400"'));
    assert.match(map.body, /駅前の&lt;人手&gt;不足/);
    assert.match(map.body, /夜間の見守り/);
    assert.equal((await f.req(`/api/workshops/${ws.id}/thumb`)).status, 401);
    w.teams[teamA].nodes = [];
    f.app.store.put('workshops', ws.id, w);
  }
  // An address nobody registered: the code alone makes it an editor, logged in at once.
  const email = 'guest@example.test';
  assert.equal((await f.req('/api/join/start', { email, code: '000000' })).status, 403);
  const start = await f.req('/api/join/start', { email, code: qr.body.code });
  assert.equal(start.status, 200);
  // A guest of this workshop only gets a 2-digit code, and three tries.
  assert.equal(start.body.digits, 2);
  assert.equal(f.codes.get(email).length, 2);
  const wrong = f.codes.get(email) === '10' ? '11' : '10';
  assert.equal(
    (await f.req('/api/join/verify', { challenge: start.body.challenge, code: wrong })).status,
    401,
  );
  // An address known from another workshop is a guest here too: 2 digits (its session will
  // be for this workshop only).
  {
    const elsewhere = newWorkshop('以前のボード', 'admin@example.test');
    elsewhere.members['returning@example.test'] = { role: '編集者', teamId: null };
    f.app.store.put('workshops', elsewhere.id, elsewhere);
    const again = await f.req('/api/join/start', { email: 'returning@example.test', code: qr.body.code });
    assert.equal(again.body.digits, 2);
    f.app.store.del('workshops', elsewhere.id);
  }
  // An admin's address never gets the short code: it keeps its ordinary login.
  const strong = await f.req('/api/join/start', { email: 'admin@example.test', code: qr.body.code });
  assert.equal(strong.body.digits, 6);
  assert.equal(f.codes.get('admin@example.test').length, 6);
  {
    const tries = await f.req('/api/join/start', { email: 'tries@example.test', code: qr.body.code });
    const bad = f.codes.get('tries@example.test') === '10' ? '11' : '10';
    for (let i = 0; i < 3; i++)
      assert.equal((await f.req('/api/join/verify', { challenge: tries.body.challenge, code: bad })).status, 401);
    // The right code after three wrong ones is refused too.
    assert.equal(
      (await f.req('/api/join/verify', { challenge: tries.body.challenge, code: f.codes.get('tries@example.test') })).status,
      401,
    );
  }
  const verify = await f.req('/api/join/verify', {
    challenge: start.body.challenge,
    code: f.codes.get(email),
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.status, 'approved');
  assert.equal(verify.body.workshopId, ws.id);
  assert.equal(verify.body.guest, true);
  const cookies = verify.headers.getSetCookie();
  // A guest gets no 24-hour pass for the ordinary login.
  assert.equal(cookies.some((c) => c.startsWith('wid_trust=')), false);
  const guest = {
    cookie: cookies.find((c) => c.startsWith('wid_session=')).split(';')[0],
    csrf: verify.body.csrf,
  };
  // The guest's session is for this workshop only — even where the same address is a member
  // of another one, and even if that address were an admin there.
  {
    const elsewhere = newWorkshop('別のボード', 'admin@example.test');
    elsewhere.members[email] = { role: '管理者', teamId: null };
    f.app.store.put('workshops', elsewhere.id, elsewhere);
    const mine = await f.req('/api/me', undefined, guest);
    assert.equal(mine.body.scope, ws.id);
    assert.equal(mine.body.admin, false);
    assert.deepEqual(
      (await f.req('/api/workshops', undefined, guest)).body.map((w) => w.id),
      [ws.id],
    );
    assert.equal((await f.req(`/api/workshops/${elsewhere.id}`, undefined, guest)).status, 403);
    assert.equal(
      (await f.req(`/api/workshops/${elsewhere.id}/transcript`, { teamId: Object.keys(elsewhere.teams)[0], text: 'x' }, guest)).status,
      403,
    );
    assert.equal((await f.req('/api/workshops', { name: '勝手に作成' }, guest)).status, 403);
    assert.equal((await f.req('/api/join-url', { url: 'https://x.gd/evil' }, guest)).status, 403);
    f.app.store.del('workshops', elsewhere.id);
  }
  // The short address the admin registers is what the join screen shows.
  assert.equal((await f.req('/api/join-url', { url: 'http://x.gd/abc' }, admin)).status, 400);
  assert.equal((await f.req('/api/join-url', { url: 'https://x.gd/sXAuq' }, admin)).body.url, 'https://x.gd/sXAuq');
  const shown = await f.req(`/api/workshops/${ws.id}/qr-data`, undefined, admin);
  assert.equal(shown.body.url, 'https://x.gd/sXAuq');
  assert.equal(shown.body.code, qr.body.code);
  const adminMe = (await f.req('/api/me', undefined, admin)).body;
  assert.deepEqual(adminMe.join, { page: 'http://localhost:4317/j', url: 'https://x.gd/sXAuq', standard: '' });
  assert.equal(adminMe.scope, undefined);
  assert.equal((await f.req('/api/join-url', { url: '' }, admin)).body.url, '');
  assert.equal((await f.req(`/api/workshops/${ws.id}/qr-data`, undefined, admin)).body.url, 'http://localhost:4317/j');
  const stored = f.app.store.get('workshops', ws.id);
  assert.deepEqual(stored.members[email], { role: '編集者', teamId: null, local: true });
  assert.equal((await f.req('/api/me', undefined, guest)).body.admin, false);
  const seen = await f.req(`/api/workshops/${ws.id}`, undefined, guest);
  assert.equal(seen.body.role, '編集者');
  // No team assignment: the new editor writes in both teams.
  let revision = seen.body.revision;
  for (const teamId of [teamA, teamB]) {
    const r = await f.req(
      `/api/workshops/${ws.id}/action`,
      { action: 'node', payload: { teamId, text: 'どの班でも書ける' }, revision, requestId: id() },
      guest,
    );
    assert.equal(r.status, 200);
    revision = r.body.revision;
  }
  // A picture pasted onto a topic of the mind map is kept beside the workshop data.
  {
    const w = f.app.store.get('workshops', ws.id);
    w.teams[teamA].nodes.push({ id: 'pic', text: '写真つき', parent: 'theme', group: 0 });
    f.app.store.put('workshops', ws.id, w);
    const png = testPNG();
    const put = await f.req(`/api/workshops/${ws.id}/node-image`, { teamId: teamA, nodeId: 'pic', image: png, width: 16, height: 9 }, guest);
    assert.equal(put.status, 200);
    const node = put.body.teams[teamA].nodes.find((n) => n.id === 'pic');
    assert.deepEqual([node.image.w, node.image.h, node.image.key.length], [16, 9, 16]);
    assert.equal(JSON.stringify(put.body).includes(png), false);
    const got = await f.req(`/api/workshops/${ws.id}/node-image?team=${teamA}&node=pic`, undefined, guest);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal((await f.req(`/api/workshops/${ws.id}/node-image?team=${teamA}&node=pic`)).status, 401);
    assert.equal(
      (await f.req(`/api/workshops/${ws.id}/node-image`, { teamId: teamA, nodeId: 'pic', image: Buffer.from('not a picture, just some text that is long enough to pass the size check, repeated. '.repeat(3)).toString('base64') }, guest)).status,
      400,
    );
    // Pasted with a parent: the picture is a new topic under it, and Ctrl+Z takes it away.
    const child = await f.req(`/api/workshops/${ws.id}/node-image`, { teamId: teamA, parentId: 'pic', image: png, width: 16, height: 9 }, guest);
    assert.equal(child.status, 200);
    const made = child.body.teams[teamA].nodes.find((n) => n.parent === 'pic');
    assert.deepEqual([made.text, made.image.w, made.group], ['（画像）', 16, 0]);
    assert.equal(
      (await f.req(`/api/workshops/${ws.id}/node-image?team=${teamA}&node=${made.id}`, undefined, guest)).status,
      200,
    );
    assert.equal(
      (await f.req(`/api/workshops/${ws.id}/node-image`, { teamId: teamA, parentId: 'nowhere', image: png }, guest)).status,
      404,
    );
    const undone = await f.req(
      `/api/workshops/${ws.id}/action`,
      { action: 'undoMap', payload: { teamId: teamA }, revision: child.body.revision, requestId: id() },
      guest,
    );
    assert.equal(undone.status, 200);
    assert.equal(undone.body.teams[teamA].nodes.some((n) => n.id === made.id), false);
    const gone = await f.req(`/api/workshops/${ws.id}/node-image`, { teamId: teamA, nodeId: 'pic', remove: true }, guest);
    assert.equal(gone.body.teams[teamA].nodes.find((n) => n.id === 'pic').image, undefined);
    assert.equal((await f.req(`/api/workshops/${ws.id}/node-image?team=${teamA}&node=pic`, undefined, guest)).status, 404);
    const w2 = f.app.store.get('workshops', ws.id);
    w2.teams[teamA].nodes = w2.teams[teamA].nodes.filter((n) => n.id !== 'pic');
    f.app.store.put('workshops', ws.id, w2);
  }
  // Joining again keeps the role the admin gave meanwhile.
  const latest = f.app.store.get('workshops', ws.id);
  latest.members[email].role = '閲覧者';
  f.app.store.put('workshops', ws.id, latest);
  const again = await f.req('/api/join/start', { email, workshopId: ws.id });
  await f.req('/api/join/verify', { challenge: again.body.challenge, code: f.codes.get(email) });
  assert.equal(f.app.store.get('workshops', ws.id).members[email].role, '閲覧者');
  // A finished workshop takes no new participants.
  const closed = f.app.store.get('workshops', ws.id);
  closed.members[email].role = '編集者';
  f.app.store.put('workshops', ws.id, closed);
  // ① voice log from the browser's speech recognition: appended without any AI call.
  const asked = [];
  f.app.ai.run = async (task, input) => {
    asked.push({ task, mode: input.mode, length: input.transcript.length });
    return { text: '・駅前は夜に人手が足りない\n・見守りを自動にしたい' };
  };
  const session = await f.login('admin@example.test');
  const add = (text) => f.req(`/api/workshops/${ws.id}/transcript`, { teamId: teamA, text }, session);
  const first = await add('最初の発言。');
  assert.equal(first.status, 200);
  assert.equal(first.body.teams[teamA].discussion.transcript, '最初の発言。');
  assert.equal((await add('次の発言。')).body.teams[teamA].discussion.transcript, '最初の発言。\n次の発言。');
  assert.equal(asked.length, 0);
  assert.equal((await add('')).status, 400);
  assert.equal((await f.req(`/api/workshops/${ws.id}/transcript`, { teamId: teamA, text: 'x' }, {})).status, 401);
  // Full (100,000 characters): the older part becomes a summary, the latest 60,000 stay.
  const full = f.app.store.get('workshops', ws.id);
  full.teams[teamA].discussion.transcript = 'あ'.repeat(99998);
  f.app.store.put('workshops', ws.id, full);
  const packed = (await add('最後の発言です。')).body.teams[teamA].discussion.transcript;
  assert.deepEqual(asked.map((a) => [a.task, a.mode]), [['summarize', 'compact']]);
  assert.ok(asked[0].length > 39000);
  assert.match(packed, /^【ここまでの議論の要約】\n・駅前は夜に人手が足りない/);
  assert.match(packed, /【続きの記録】\nあ+\n最後の発言です。$/);
  assert.ok([...packed].length < 61000);
  // If the summary fails, recording still goes on: the oldest part is dropped.
  f.app.ai.run = async () => {
    throw Error('AI down');
  };
  const again2 = f.app.store.get('workshops', ws.id);
  again2.teams[teamA].discussion.transcript = 'い'.repeat(99998);
  f.app.store.put('workshops', ws.id, again2);
  const dropped = (await add('止まらない。')).body.teams[teamA].discussion.transcript;
  assert.equal([...dropped].length, 60000);
  assert.match(dropped, /止まらない。$/);
  // A workshop that is over takes no new participants.
  const over = f.app.store.get('workshops', ws.id);
  over.status = '完了';
  f.app.store.put('workshops', ws.id, over);
  assert.equal((await f.req('/api/join/start', { email: 'late@example.test', workshopId: ws.id })).status, 403);
});

test('HTTP: Notionへはエクスポートを押したときだけ書き出しを予約し、グラレコは音声ログとマップから作って別に保存する', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  let ws = (await f.req('/api/workshops', { name: '会議の記録' }, admin)).body;
  const teamId = Object.keys(ws.teams)[0];
  const act = async (action, payload) => {
    const r = await f.req(
      `/api/workshops/${ws.id}/action`,
      { action, payload, revision: ws.revision, requestId: id() },
      admin,
    );
    assert.equal(r.status, 200);
    ws = r.body;
    return r;
  };
  // Not connected to Notion: nothing to export.
  assert.equal((await f.req(`/api/workshops/${ws.id}/export`, {}, admin)).status, 409);
  {
    const w = f.app.store.get('workshops', ws.id);
    w.notion = { pageId: 'fixture-page', checkedAt: 0, error: 'Notionに接続できません' };
    f.app.store.put('workshops', ws.id, w);
  }
  // Ordinary work — saving the record, the outline, a new topic — queues nothing for Notion,
  // and works although the last Notion sync failed.
  await act('discussion', { teamId, transcript: '#01 10:00:00\n受付の待ち時間が長い。', snapshot: true });
  await act('createTopic', { teamId, anchorId: 'theme', placement: 'child', text: '待ち時間' });
  assert.equal((await f.req(`/api/workshops/${ws.id}/transcript`, { teamId, text: '予約を入れたい。' }, admin)).status, 200);
  assert.ok(!f.app.store.get('workshops', ws.id).documentSync?.queued);
  assert.equal(f.app.notion.content.outbox(ws.id).length, 0);
  // グラレコ: its own prompt, the voice log and the map as material.
  f.app.ai.config.providers = [
    {
      id: 'genspark-enterprise',
      label: 'test-only',
      endpoint: 'https://fixture.example.test',
      keyEnv: 'TEST_GATEWAY_KEY',
      approvalReference: 'test-only',
      capabilities: ['image'],
    },
  ];
  process.env.TEST_GATEWAY_KEY = 'test-only';
  t.after(() => delete process.env.TEST_GATEWAY_KEY);
  let sent;
  f.app.ai.transport = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, text: async () => JSON.stringify({ pngBase64: testPNG() }) };
  };
  const made = await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', kind: 'graphic', teamId }, admin);
  assert.equal(made.status, 200);
  assert.match(sent.prompt, /グラフィックレコーダー/);
  assert.match(sent.input.音声ログ, /受付の待ち時間が長い。\n予約を入れたい。/);
  assert.match(sent.input.マインドマップ, /・待ち時間/);
  // The title to put on the picture: month/day and the workshop's name.
  assert.ok(sent.input.タイトル.endsWith(' 会議の記録'));
  assert.equal(sent.input.タイトル.split(' ')[0].split('/').length, 2);
  assert.equal(sent.model, 'gpt-image-2.5');
  const applied = await f.req(`/api/workshops/${ws.id}/apply`, { proposal: made.body.proposal }, admin);
  assert.equal(applied.status, 200);
  const team = applied.body.teams[teamId];
  assert.ok(team.graphic.key);
  // Not the paper prototype: no team image, no deck saved, nothing to vote on.
  assert.equal(team.image, null);
  assert.equal((team.ideas || []).length, 0);
  const picture = await f.req(`/api/workshops/${ws.id}/graphic?team=${teamId}`, undefined, admin);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/png');
  assert.equal((await f.req(`/api/workshops/${ws.id}/graphic?team=${teamId}`)).status, 401);
  // The two pictures have separate prompts in the settings; each can be changed alone.
  const before = (await f.req('/api/me', undefined, admin)).body.ai;
  assert.match(before.graphicPrompt, /グラフィックレコーダー/);
  assert.match(before.imagePrompt, /チラシ風/);
  const saved = await f.req(
    '/api/ai/settings',
    { provider: before.provider, model: '', graphicPrompt: '会議を1枚の絵にまとめる独自の指示' },
    admin,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.graphicPrompt, '会議を1枚の絵にまとめる独自の指示');
  assert.equal(saved.body.imagePrompt, before.imagePrompt);
  await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', kind: 'graphic', teamId }, admin);
  assert.equal(sent.prompt, '会議を1枚の絵にまとめる独自の指示');
  // The paper prototype prompt gets the voice log as named material too (its latest part).
  await f.req(`/api/workshops/${ws.id}/ai`, { task: 'image', teamId }, admin);
  assert.doesNotMatch(sent.prompt, /グラフィックレコーダー|独自の指示/);
  assert.match(sent.prompt, /チラシ風/);
  assert.match(sent.prompt, /音声ログ/);
  assert.match(sent.input.音声ログ, /予約を入れたい。/);
  assert.equal(sent.input.企画内容.transcript, undefined);
  // Export: now, and only now, the record and the settings are queued for Notion. The page
  // this workshop pointed to is gone in Notion, so a new one is made for it first.
  assert.equal(f.app.notion.content.outbox(ws.id).length, 0);
  Object.assign(f.app.notion.config, { notionToken: 'fixture', notionSource: 'fixture-source' });
  const notionCalls = [];
  f.app.notion.transport = async (url, options) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    notionCalls.push(`${options.method} ${path}`);
    if (path === 'pages/fixture-page')
      return { ok: true, status: 200, json: async () => ({ id: 'fixture-page', in_trash: true }) };
    if (path === 'pages' && options.method === 'POST')
      return { ok: true, status: 200, json: async () => ({ id: 'new-page', last_edited_time: 'v1' }) };
    return { ok: false, status: 503, text: async () => '' };
  };
  const exported = await f.req(`/api/workshops/${ws.id}/export`, {}, admin);
  assert.equal(exported.status, 200);
  assert.deepEqual(notionCalls.slice(0, 2), ['GET pages/fixture-page', 'POST pages']);
  assert.equal(f.app.store.get('workshops', ws.id).notion.pageId, 'new-page');
  assert.equal(exported.body.documentSync.queued, true);
  assert.deepEqual(
    f.app.notion.content.outbox(ws.id).map((j) => j.reason),
    ['save', 'settings'],
  );
});
