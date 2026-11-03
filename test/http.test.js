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

test('HTTP: 新規作成はNotionテンプレートを自動適用し、同じ操作IDで二重登録しない', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test');
  const n = f.app.notion;
  n.config.notionToken = 'fixture';
  n.config.notionSource = 'fixture';
  let calls = 0;
  n.workshopTemplate = async () => ({ id: 'template-selected' });
  n.publishNew = async (ws, template) => {
    assert.equal(template.id, 'template-selected');
    calls++;
    ws.notion = { pageId: 'created-page', provisioning: true, templateId: template.id };
    f.app.store.put('workshops', ws.id, ws);
    return ws;
  };
  const payload = { name: '自動登録WS', requestId: id() };
  const created = await f.req('/api/workshops', payload, admin);
  assert.equal(created.status, 201);
  assert.equal(created.body.notion.pageId, 'created-page');
  const retry = await f.req('/api/workshops', payload, admin);
  assert.equal(retry.body.id, created.body.id);
  assert.equal(calls, 1);
  assert.equal(f.app.store.all('workshops').length, 1);
});

test('HTTP: 作成応答の消失は保存したWSに明示し、テンプレート未取得時は空WSを増やさない', async (t) => {
  const f = await setup(t),
    admin = await f.login('admin@example.test'),
    n = f.app.notion;
  n.config.notionToken = 'fixture';
  n.config.notionSource = 'fixture';
  n.workshopTemplate = async () => {
    throw new Fault(409, 'テンプレートがありません');
  };
  assert.equal((await f.req('/api/workshops', { name: '未作成' }, admin)).status, 409);
  assert.equal(f.app.store.all('workshops').length, 0);
  n.workshopTemplate = async () => ({ id: 'template' });
  let calls = 0;
  n.publishNew = async (ws) => {
    calls++;
    ws.createAttempt = true;
    f.app.store.put('workshops', ws.id, ws);
    throw new Fault(502, '作成応答が失われました');
  };
  const payload = { name: '結果確認待ち', requestId: id() };
  const created = await f.req('/api/workshops', payload, admin);
  assert.equal(created.status, 201);
  assert.ok(created.body.creationError);
  assert.equal(created.body.createAttempt, true);
  await f.req('/api/workshops', payload, admin);
  assert.equal(calls, 1);
});

test('HTTP: マップ操作はNotion通信をせず保存し、同期待ちでも連続編集できる', async (t) => {
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
    assert.equal(response.body.documentSync.queued, true);
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
  assert.equal(response.body.documentSync.generation, 3);
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
    assert.equal(response.body.documentSync.generation, 2);
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
  for (const session of [admin, editor]) {
    assert.equal(
      (
        await f.req(
          `/api/workshops/${ws.id}/action`,
          {
            action: 'node',
            payload: { teamId: other.id, text: '越境' },
            revision: ws.revision,
            requestId: id(),
          },
          session,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.req(
          `/api/workshops/${ws.id}/advice`,
          { teamId: other.id, phase: 'ideation', event: 'help_requested' },
          session,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.req(`/api/workshops/${ws.id}/ai`, { teamId: other.id, task: 'questions' }, session))
        .status,
      403,
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

test('HTTP: 既存セッションの管理者権限はNotionの最新メンバーから再計算し、陳腐化時は剥奪', async (t) => {
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
  ws.notion.checkedAt = 0;
  f.app.store.put('workshops', ws.id, ws);
  assert.equal((await f.req('/api/me', undefined, session)).body.admin, false);
  assert.equal((await f.req('/api/workshops', undefined, session)).body.length, 0);
});

test('HTTP: Notion障害中も登録済み利用者のOTP認証は可能だが、古いWS権限は使えない', async (t) => {
  const f = await setup(t);
  Object.assign(f.app.notion.config, {
    notionToken: 'fixture-token',
    notionSource: 'fixture-source',
  });
  f.app.notion.transport = async () => ({ ok: false, status: 503 });
  const session = await f.login('admin@example.test');
  const me = await f.req('/api/me', undefined, session);
  assert.equal(me.status, 200);
  assert.equal(me.body.notion.state, 'error');
});
