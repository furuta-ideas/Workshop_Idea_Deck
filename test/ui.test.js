import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { newWorkshop } from '../server/store.js';
import { view } from '../server/domain.js';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
async function setup(t, role = '管理者', loginState, viewState = {}) {
  const errors = [],
    calls = [],
    admin = { email: 'admin@example.test', admin: role === '管理者' };
  let ws = newWorkshop('画面テスト', admin.email),
    team = Object.values(ws.teams)[0];
  ws.members[admin.email].role = role;
  team.nodes.push({ id: 'node-1', text: '地域のつながり', group: 0, parent: null });
  const dom = new JSDOM(html, {
    url: 'http://localhost:4317',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole().on('jsdomError', (e) => errors.push(e)),
  });
  const { window } = dom;
  const state = {
    admin: admin.admin,
    available: true,
    notion: { enabled: false, state: 'unconfigured' },
    ...viewState,
  };
  window.setInterval = (fn, milliseconds) => {
    if (milliseconds === 3000) state.poll = fn;
    return 1;
  };
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Object.defineProperty(window, 'crypto', { value: webcrypto });
  window.fetch = async (path, options = {}) => {
    calls.push({ path, body: options.body && JSON.parse(options.body) });
    if (loginState && path === '/api/me')
      return { ok: false, status: 401, json: async () => ({ error: 'ログインしてください' }) };
    let data;
    if (path === '/api/health') data = loginState || { demo: false, auth: { emailOtpReady: true } };
    else if (path === '/api/me')
      data = {
        email: admin.email,
        admin: state.admin,
        csrf: 'test',
        demo: false,
        ai: { provider: 'genspark-enterprise', model: '', imagePrompt: '', approved: [] },
        notion: state.notion,
      };
    else if (path === '/api/workshops')
      data = state.available ? [{ id: ws.id, name: ws.name, status: ws.status }] : [];
    else if (path === `/api/workshops/${ws.id}`) data = view(ws, { ...admin, admin: state.admin });
    else if (path.endsWith('/action')) {
      const body = JSON.parse(options.body);
      if (body.action === 'node')
        team.nodes.push({
          id: 'node-2',
          text: body.payload.text,
          parent: body.payload.parent,
          group: body.payload.group,
        });
      if (body.action === 'discussion') Object.assign(team.discussion, body.payload);
      if (body.action === 'timer') ws.timers[body.payload.phase] = { endsAt: Date.now() + 180000 };
      ws.revision++;
      data = view(ws, admin);
    } else data = { ok: true };
    return { ok: true, status: 200, json: async () => data };
  };
  window.eval(script);
  await settle();
  return { dom, window, doc: window.document, calls, errors, ws, team, state };
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const click = (f, selector) => {
  const el = f.doc.querySelector(selector);
  assert.ok(el, selector);
  el.click();
};
test('DOM: 4タブ・管理者設定・マップから付箋・デッキ・議論フォームが描画される', async (t) => {
  const f = await setup(t);
  assert.equal(f.doc.querySelectorAll('[data-tab]').length, 4);
  assert.match(f.doc.querySelector('.map-root').textContent, /画面テスト/);
  assert.ok(f.doc.querySelector('#settings'));
  f.doc.querySelector('#node-text').value = '新しい気づき';
  f.doc
    .querySelector('#node-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 2);
  click(f, '[data-tab="1"]');
  assert.equal(f.doc.querySelectorAll('[data-card]').length, 2);
  click(f, '[data-timer="cards"]');
  await settle();
  assert.ok(
    !f.doc.querySelector('[data-vote]').disabled ||
      f.doc.querySelector('[data-delta="1"]').disabled === false,
  );
  click(f, '[data-tab="2"]');
  assert.equal(f.doc.querySelectorAll('[data-slot]').length, 3);
  assert.ok(f.doc.querySelector('#discussion-form'));
  assert.ok(f.doc.querySelector('#record-discussion').disabled);
  f.doc.querySelector('#what').value = '地域の交流';
  f.doc.querySelector('#keywords').value = '地域';
  click(f, '#preview-summary');
  assert.match(f.doc.querySelector('.summary-preview').innerHTML, /<strong>地域<\/strong>/);
  f.window.document.querySelector('#modal-close').click();
  click(f, '[data-tab="3"]');
  assert.match(f.doc.querySelector('#step-content').textContent, /チームのアイディア/);
  assert.equal(f.errors.length, 0);
});
test('DOM: 閲覧者に設定歯車を表示せず、編集や音声認識も無効', async (t) => {
  const f = await setup(t, '閲覧者');
  assert.equal(f.doc.querySelector('#settings'), null);
  assert.ok(f.doc.querySelector('#node-text').disabled);
  assert.ok(f.doc.querySelector('#map-record').disabled);
  assert.match(f.doc.querySelector('.notice').textContent, /閲覧モード/);
  assert.equal(f.calls.filter((c) => c.path.includes('/ai')).length, 0);
  assert.equal(f.errors.length, 0);
});
test('DOM: 管理者設定の各フォームとQR・AI未設定状態', async (t) => {
  const f = await setup(t);
  click(f, '#settings');
  await settle();
  for (const selector of [
    '#meta-form',
    '#vote-settings',
    '#team-form',
    '#member-form',
    '#ai-settings',
    '.qr',
  ])
    assert.ok(f.doc.querySelector(selector), selector);
  assert.ok(f.doc.querySelector('#notion-sync').disabled);
  assert.equal(f.doc.querySelector('#ai-model').value, '');
  assert.equal(f.doc.querySelector('#ai-prompt').value, '');
  assert.equal(f.errors.length, 0);
});

test('DOM: 体験モードはメール認証フォームを隠し、参加ボタンを案内する', async (t) => {
  const f = await setup(t, '管理者', { demo: true, auth: { emailOtpReady: false } });
  assert.equal(f.doc.querySelector('#login-form').hidden, true);
  assert.equal(f.doc.querySelector('#passkey-login').hidden, true);
  assert.equal(f.doc.querySelectorAll('[data-demo]').length, 3);
  assert.match(f.doc.querySelector('.login-foot').textContent, /OTPメールは送信されません/);
});

test('DOM: 通常モードでもメール送信が未設定なら理由を表示して無効化する', async (t) => {
  const f = await setup(t, '管理者', { demo: false, auth: { emailOtpReady: false } });
  assert.equal(f.doc.querySelector('#login-submit').disabled, true);
  assert.match(f.doc.querySelector('#login-error').textContent, /送信設定がありません/);
});

test('DOM: Notion未接続と同期失敗を明示し、同期後は空一覧と管理者権限を自動更新', async (t) => {
  const f = await setup(t, '閲覧者', undefined, { available: false });
  assert.match(f.doc.querySelector('.center-empty').textContent, /Notion連携が未設定/);
  assert.equal(f.doc.querySelector('#settings'), null);
  f.state.notion = { enabled: true, state: 'error' };
  await f.state.poll();
  assert.match(f.doc.querySelector('.center-empty').textContent, /Notionの接続を確認/);
  f.state.notion = { enabled: true, state: 'ready' };
  f.state.admin = true;
  f.state.available = true;
  await f.state.poll();
  assert.ok(f.doc.querySelector('#settings'));
  assert.ok(f.doc.querySelector('.map-root'));
  assert.equal(f.doc.querySelectorAll('#workshop-select option').length, 1);
  assert.equal(f.errors.length, 0);
});
