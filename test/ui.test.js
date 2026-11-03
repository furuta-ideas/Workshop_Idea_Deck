import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { newWorkshop, newTeam } from '../server/store.js';
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
  const other = newTeam('B班');
  other.nodes.push({ id: 'other-1', text: '他チームの気づき', group: 0, parent: null });
  ws.teams[other.id] = other;
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
    else if (path === '/api/facilitator')
      data = {
        markdown: readFileSync(new URL('../config/ai-facilitator.md', import.meta.url), 'utf8'),
        version: 'test',
        policy: {},
      };
    else if (path.endsWith('/advice')) data = { should_speak: false };
    else if (path === '/api/workshops')
      data = state.available ? [{ id: ws.id, name: ws.name, status: ws.status }] : [];
    else if (path === `/api/workshops/${ws.id}`) data = view(ws, { ...admin, admin: state.admin });
    else if (path.endsWith('/action')) {
      if (state.actionGate) await state.actionGate;
      const body = JSON.parse(options.body);
      if (body.action === 'node' && team.nodes.some((n) => n.id === body.payload.id))
        Object.assign(
          team.nodes.find((n) => n.id === body.payload.id),
          body.payload,
        );
      else if (body.action === 'node')
        team.nodes.push({
          id: 'node-2',
          text: body.payload.text,
          parent: null,
          group: body.payload.group,
        });
      if (body.action === 'createTopic') {
        const p = body.payload,
          anchor = team.nodes.find((n) => n.id === p.anchorId);
        team.nodes.push({
          id: 'topic-' + team.nodes.length,
          text: p.text,
          group: 0,
          parent:
            p.anchorId === 'theme' ? 'theme' : p.placement === 'child' ? anchor.id : anchor.parent,
        });
      }
      if (body.action === 'reparent')
        team.nodes.find((n) => n.id === body.payload.id).parent = body.payload.parent;
      if (body.action === 'deck') team.deck = [...body.payload.ids];
      if (body.action === 'discussion') Object.assign(team.discussion, body.payload);
      if (body.action === 'timer') ws.timers[body.payload.phase] = { endsAt: Date.now() + 180000 };
      ws.revision++;
      data = view(ws, admin);
    } else data = { ok: true };
    return { ok: true, status: 200, json: async () => data };
  };
  window.eval(script);
  await settle();
  if (!viewState.landing) {
    window.document.querySelector('#login-entry').click();
    await settle();
  }
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
  click(f, '#new-topic');
  const topic = f.doc.querySelector('#topic-editor');
  topic.value = '新しい気づき';
  topic.dispatchEvent(new f.window.Event('input'));
  topic.dispatchEvent(new f.window.FocusEvent('blur'));
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
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});
test('DOM: 閲覧者に設定歯車を表示せず、編集や音声認識も無効', async (t) => {
  const f = await setup(t, '閲覧者');
  assert.equal(f.doc.querySelector('#settings'), null);
  assert.equal(f.doc.querySelector('#node-text'), null);
  assert.ok(f.doc.querySelector('#new-topic').disabled);
  assert.ok(f.doc.querySelector('#map-record').disabled);
  assert.match(f.doc.querySelector('.notice').textContent, /閲覧モード/);
  assert.equal(f.calls.filter((c) => c.path.includes('/ai')).length, 0);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
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
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
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
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 保存済みセッションもログイン入口を表示し、操作後にワークショップへ進む', async (t) => {
  const f = await setup(t, '管理者', undefined, { landing: true });
  assert.ok(f.doc.querySelector('#login-entry'));
  assert.equal(
    f.calls.some((c) => c.path === '/api/me'),
    false,
  );
  click(f, '#login-entry');
  await settle();
  assert.equal(f.doc.querySelectorAll('[data-tab]').length, 4);
});

test('DOM: 他チームを表示できるが管理者でも編集・AI送信できない', async (t) => {
  const f = await setup(t),
    buttons = f.doc.querySelectorAll('[data-team]');
  buttons[1].click();
  await settle();
  assert.match(f.doc.querySelector('#step-content').textContent, /他チームの気づき/);
  assert.equal(f.doc.querySelector('#node-text'), null);
  assert.ok(f.doc.querySelector('#new-topic').disabled);
  assert.ok(f.doc.querySelector('#map-record').disabled);
  assert.ok(f.doc.querySelector('#next-advice').disabled);
  assert.equal(f.doc.querySelector('.page-top'), null);
  assert.equal(f.doc.querySelector('#node-parent'), null);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: ダブルクリックで直接編集、Enterで同階層、Insertで子、折り畳みで件数表示', async (t) => {
  const f = await setup(t);
  let button = f.doc.querySelector('[data-node]');
  button.click();
  button.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
  let editor = f.doc.querySelector('#topic-editor');
  assert.ok(editor);
  editor.value = '変更した気づき';
  editor.dispatchEvent(new f.window.Event('input'));
  editor.dispatchEvent(
    new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await settle();
  assert.ok(f.doc.querySelector('#topic-editor'));
  editor = f.doc.querySelector('#topic-editor');
  editor.value = '同じ階層';
  editor.dispatchEvent(new f.window.Event('input'));
  editor.dispatchEvent(
    new f.window.KeyboardEvent('keydown', { key: 'Insert', bubbles: true, cancelable: true }),
  );
  await settle();
  editor = f.doc.querySelector('#topic-editor');
  editor.value = '子の項目';
  editor.dispatchEvent(new f.window.Event('input'));
  editor.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  const operations = f.calls.filter((c) => c.path.endsWith('/action'));
  assert.equal(operations[0].body.action, 'node');
  assert.equal(operations[1].body.payload.placement, 'sibling');
  assert.equal(operations[2].body.payload.placement, 'child');
  const toggle = f.doc.querySelector('[data-collapse]:not([data-collapse="theme"])');
  assert.ok(toggle);
  toggle.click();
  assert.match(toggle.textContent, /−/);
  assert.ok(
    f.doc.querySelector('[data-collapse]:not([data-collapse="theme"])').textContent.includes('1'),
  );
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 未接続マイクは録音許可やAI送信を行わず、入力中の文字を保持する', async (t) => {
  const f = await setup(t);
  click(f, '#new-topic');
  const input = f.doc.querySelector('#topic-editor');
  input.value = '途中のメモ';
  input.dispatchEvent(new f.window.Event('input'));
  click(f, '#map-record');
  await settle();
  assert.equal(f.doc.querySelector('#topic-editor').value, '途中のメモ');
  assert.match(f.doc.querySelector('#toast').textContent, /未設定/);
  assert.equal(
    f.calls.some((c) => c.path.endsWith('/ai')),
    false,
  );
});

test('DOM: ドラッグで接続し、折り畳みはデータを書き換えず展開できる', async (t) => {
  const f = await setup(t),
    node = f.doc.querySelector('[data-node]'),
    root = f.doc.querySelector('.map-root');
  const values = new Map(),
    transfer = { setData: (k, v) => values.set(k, v), getData: (k) => values.get(k) };
  const dispatch = (target, type) => {
    const e = new f.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: transfer });
    target.dispatchEvent(e);
  };
  dispatch(node, 'dragstart');
  dispatch(root, 'dragover');
  dispatch(root, 'drop');
  await settle();
  assert.equal(f.team.nodes[0].parent, 'theme');
  assert.ok(f.doc.querySelector('#map-links path'));
  const before = f.calls.filter((c) => c.path.endsWith('/action')).length;
  click(f, '[data-collapse="theme"]');
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 0);
  assert.equal(f.doc.querySelector('[data-collapse="theme"]').textContent, '1');
  click(f, '[data-collapse="theme"]');
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 1);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/action')).length, before);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 全体表示は折り畳みを展開し、縦横を収める縮尺を計算。編集パネル・単独枠は存在しない', async (t) => {
  const f = await setup(t);
  assert.equal(f.doc.querySelector('#node-form'), null);
  assert.equal(f.doc.querySelector('.loose-area'), null);
  assert.equal(f.doc.querySelector('.map-actions'), null);
  const proto = f.window.HTMLElement.prototype;
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get() {
      return this.id === 'mindmap' ? 1800 : 0;
    },
  });
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get() {
      return this.id === 'mindmap' ? 900 : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('map-scroll') ? 924 : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('map-scroll') ? 474 : 0;
    },
  });
  click(f, '#collapse-all');
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 0);
  const before = f.calls.filter((c) => c.path.endsWith('/action')).length;
  click(f, '#fit-map');
  await settle();
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 1);
  assert.equal(f.doc.querySelector('#zoom-label').textContent, '50%');
  assert.equal(f.doc.querySelector('#mindmap').style.transform, 'scale(0.5)');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/action')).length, before);
  assert.ok(f.doc.querySelector('.advice-robot #next-advice'));
  for (let tab = 0; tab < 4; tab++) {
    click(f, `[data-tab="${tab}"]`);
    assert.ok(f.doc.querySelector(`.tabbar.tab-tone-${tab}`));
  }
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 得票カードをデッキへドロップし、カードを別スロットへ移動・除去。閲覧時は変更不可', async (t) => {
  const f = await setup(t);
  f.team.nodes.push({ id: 'node-b', text: '別の気づき', group: 1, parent: null });
  f.ws.votes.cards['admin@example.test'] = { 'node-1': 1, 'node-b': 1 };
  click(f, '[data-tab="2"]');
  const drop = async (id, index) => {
    const target = f.doc.querySelector(`[data-slot="${index}"]`),
      e = new f.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { getData: () => id } });
    target.dispatchEvent(e);
    await settle();
  };
  await drop('node-1', 0);
  assert.ok(f.doc.querySelector('[data-slot="0"] > .deck-card.g0'));
  assert.equal(f.doc.querySelector('[data-deck-card]').draggable, true);
  await drop('node-b', 1);
  await drop('node-b', 0);
  assert.deepEqual(f.team.deck, ['node-b', 'node-1']);
  assert.equal(f.doc.querySelector('[data-slot="0"] [data-deck-card]').dataset.deckCard, 'node-b');
  click(f, '[data-remove-deck="node-b"]');
  await settle();
  assert.deepEqual(f.team.deck, ['node-1']);
  f.doc.querySelectorAll('[data-team]')[1].click();
  await settle();
  const before = f.calls.filter((c) => c.path.endsWith('/action')).length;
  await drop('node-1', 0);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/action')).length, before);
  assert.match(f.doc.querySelector('#toast').textContent, /閲覧のみ/);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 入力の保存中に全体表示を押しても二重追加せず、保存完了後に全体へ切り替える', async (t) => {
  const f = await setup(t);
  let release;
  f.state.actionGate = new Promise((resolve) => (release = resolve));
  click(f, '#new-topic');
  const input = f.doc.querySelector('#topic-editor');
  input.value = '保存中でも一度だけ追加';
  input.dispatchEvent(new f.window.Event('input'));
  input.dispatchEvent(new f.window.FocusEvent('blur'));
  click(f, '#fit-map');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/action')).length, 1);
  release();
  await settle();
  assert.equal(f.team.nodes.filter((n) => n.text === '保存中でも一度だけ追加').length, 1);
  assert.equal(f.doc.querySelector('#topic-editor'), null);
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 2);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});
