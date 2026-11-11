import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { newWorkshop, newTeam } from '../server/store.js';
import { view } from '../server/domain.js';
import { parseOutline } from '../server/outline.js';
import { clearIdea, restoreIdea } from '../server/ideas.js';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
async function setup(t, role = '管理者', loginState, viewState = {}) {
  const mapBackups = [];
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
  if (viewState.content) {
    ws.notion = { pageId: 'notion-page', checkedAt: Date.now() };
    ws.documentSync = viewState.documentSync || { pending: false, error: null };
  }
  const dom = new JSDOM(html, {
    url: viewState.url || 'http://localhost:4317',
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
    if (milliseconds === 1000) state.tick = fn;
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
    if (loginState && !state.joined && path === '/api/me')
      return { ok: false, status: 401, json: async () => ({ error: 'ログインしてください' }) };
    let data;
    if (path === '/api/health') data = loginState || { demo: false, auth: { emailOtpReady: true } };
    else if (path === '/api/me')
      data = {
        email: admin.email,
        admin: state.admin,
        csrf: 'test',
        demo: false,
        ai: state.ai || {
          provider: 'genspark-enterprise',
          model: '',
          imagePrompt: '',
          approved: [],
        },
        notion: state.notion,
      };
    else if (path === '/api/facilitator')
      data = {
        markdown: readFileSync(new URL('../config/ai-facilitator.md', import.meta.url), 'utf8'),
        version: 'test',
        policy: {},
      };
    else if (path.endsWith('/advice')) data = state.adviceResponse || { should_speak: false };
    else if (path.endsWith('/ai')) {
      if (state.failAudio)
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: '録音の認識結果が空でした' }),
        };
      data = state.aiResponse || {
        result: { text: 'テスト音声のテストです。' },
        proposal: 'audio-test',
      };
    } else if (path === '/api/join/start') data = { challenge: 'join-1', message: '認証コードを送りました' };
    else if (path === '/api/join/verify') {
      state.joined = true;
      data = { status: 'approved', workshopId: ws.id, csrf: 'test' };
    } else if (path.endsWith('/qr-data'))
      data = { url: 'http://localhost:4317/?join=' + ws.id, dataUrl: 'data:image/png;base64,AAAA' };
    else if (path.endsWith('/transcript')) {
      team.discussion.transcript = [team.discussion.transcript, JSON.parse(options.body).text]
        .filter(Boolean)
        .join('\n');
      ws.revision++;
      data = view(ws, admin);
    } else if (path.endsWith('/apply')) {
      if (state.onApply) state.onApply(team);
      else
        team.discussion.transcript = [team.discussion.transcript, 'テスト音声のテストです。']
          .filter(Boolean)
          .join('\n');
      ws.revision++;
      data = view(ws, admin);
    } else if (path.endsWith('/content-sync')) {
      ws.documentSync = { pending: false, error: null };
      data = view(ws, admin);
    } else if (path === '/api/workshops')
      data = state.available ? [{ id: ws.id, name: ws.name, status: ws.status }] : [];
    else if (path === `/api/workshops/${ws.id}`) data = view(ws, { ...admin, admin: state.admin });
    else if (path.endsWith('/action')) {
      if (state.actionConflict) {
        state.actionConflict = false;
        ws.revision++;
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'Notion側の変更を確認してください' }),
        };
      }
      if (state.actionGate) await state.actionGate;
      const body = JSON.parse(options.body);
      if (
        [
          'node',
          'createTopic',
          'pasteOutline',
          'topicTheme',
          'reparent',
          'reorderTopic',
          'standalone',
          'deleteNode',
        ].includes(body.action)
      )
        mapBackups.push(structuredClone({ nodes: team.nodes, rootText: team.rootText }));
      if (body.action === 'undoMap') Object.assign(team, mapBackups.pop());
      if (body.action === 'deleteNode') {
        const removed = new Set([body.payload.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of team.nodes)
            if (removed.has(n.parent) && !removed.has(n.id)) {
              removed.add(n.id);
              changed = true;
            }
        }
        team.nodes = team.nodes.filter((n) => !removed.has(n.id));
      }
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
      if (body.action === 'pasteOutline') {
        const p = body.payload,
          outline = parseOutline(p.text),
          before = team.nodes.length;
        outline.forEach((n, i) =>
          team.nodes.push({
            id: 'pasted-' + (before + i),
            text: n.text,
            group: 0,
            parent: n.parentIndex === null ? p.anchorId : 'pasted-' + (before + n.parentIndex),
          }),
        );
      }
      if (body.action === 'vote') {
        const p = body.payload,
          ballot = (ws.votes[p.phase][admin.email] ||= {});
        ballot[p.target] = (ballot[p.target] || 0) + p.delta;
      }
      if (body.action === 'reorderTopic') {
        const p = body.payload,
          n = team.nodes.find((n) => n.id === p.id),
          target = team.nodes.find((n) => n.id === p.targetId);
        n.parent = target.parent;
        const at = team.nodes.indexOf(n);
        team.nodes.splice(at, 1);
        team.nodes.splice(team.nodes.indexOf(target) + (p.position === 'after' ? 1 : 0), 0, n);
      }
      // ③ deck history runs the server's own functions; images are not stored here.
      const kv = { put() {}, get() { return null; } };
      if (body.action === 'clearIdea') clearIdea(kv, ws, team, body.payload);
      if (body.action === 'restoreIdea') {
        const { patchDiscussion } = await import('../server/ideas.js');
        const idea = team.ideas.find((i) => i.id === body.payload.ideaId);
        if (team.activeIdeaId !== idea.id) patchDiscussion(team, body.payload);
        restoreIdea(kv, ws, team, idea);
      }
      if (body.action === 'reparent')
        team.nodes.find((n) => n.id === body.payload.id).parent = body.payload.parent;
      if (body.action === 'deck') {
        team.deck = [...body.payload.ids];
        team.deckSlots = body.payload.slots || [
          ...team.deck,
          ...Array(5 - team.deck.length).fill(null),
        ];
      }
      if (body.action === 'discussion') Object.assign(team.discussion, body.payload);
      if (body.action === 'timer')
        ws.timers[body.payload.phase] = {
          endsAt: Date.now() + 180000,
          closed: !!body.payload.stop,
        };
      ws.revision++;
      data = view(ws, admin);
    } else data = { ok: true };
    return { ok: true, status: 200, json: async () => data };
  };
  if (viewState.speech) window.SpeechRecognition = viewState.speech;
  window.eval(readFileSync(new URL('../public/build-info.js', import.meta.url), 'utf8'));
  window.eval(script);
  await settle();
  // A saved login opens the workshop list (#3); the tests start on ②, the mind map.
  if (!viewState.landing) {
    window.document.querySelector('[data-open-workshop]')?.click();
    await settle();
    window.document.querySelector('[data-tab="1"]')?.click();
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

test('DOM: 助言ボタンで会話を開き、キャラクターを選び、質問と画面の未保存内容を送る', async (t) => {
  const f = await setup(t);
  f.ws.character = 'leafy';
  f.ws.revision++;
  await f.state.poll();
  f.state.adviceResponse = {
    should_speak: true,
    source: 'ai',
    character: 'leafy',
    bubble_text: 'この企画なら、小さな体験会から試すとよさそうです。',
  };
  click(f, '[data-tab="3"]');
  f.doc.querySelector('#headline').value = '未保存のアイデア';
  click(f, '#next-advice');
  assert.ok(f.doc.querySelector('#advice-question'),f.errors.map(e=>e.detail?.stack || e.message).join('\n'));
  // Only the workshop's character appears; the admin picked リーフィー.
  assert.equal(f.doc.querySelectorAll('.character-picker img').length, 1);
  assert.equal(f.doc.querySelector('.character-picker img').getAttribute('alt'), 'リーフィー');
  // The chat is a pane on the right; the green advice area and its button are gone.
  assert.equal(f.doc.querySelector('#chat-pane').hidden, false);
  assert.ok(f.doc.querySelector('#chat-pane #chat-voice'));
  assert.equal(f.doc.querySelector('.ai-advice'), null);
  assert.equal(f.doc.querySelector('.chat-toggle').hidden, true);
  assert.ok(f.doc.body.classList.contains('chat-open'));
  const input = f.doc.querySelector('#advice-question');
  input.value = 'この企画の最初の一歩は？';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.doc
    .querySelector('#advice-chat-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const call = f.calls.filter((c) => c.path.endsWith('/advice') && c.body.question).at(-1);
  assert.equal(call.body.question, 'この企画の最初の一歩は？');
  assert.equal(call.body.character, 'leafy');
  assert.equal(call.body.screen.discussion.headline, '未保存のアイデア');
  assert.match(f.doc.querySelector('#chat-log').textContent, /小さな体験会/);
  assert.equal(f.doc.querySelector('#headline').value, '未保存のアイデア');
  assert.equal(f.doc.querySelector('.chat-assistant img').getAttribute('alt'), 'リーフィー');
  // The pane stays open on other steps, with what is being typed, and follows the step.
  const typing = f.doc.querySelector('#advice-question');
  typing.value = '続きの質問';
  typing.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  click(f, '[data-tab="1"]');
  assert.equal(f.doc.querySelector('#chat-pane').hidden, false);
  assert.equal(f.doc.querySelector('#advice-question').value, '続きの質問');
  assert.match(f.doc.querySelector('.chat-context').textContent, /もやもやの言語化/);
  assert.match(f.doc.querySelector('#chat-log').textContent, /小さな体験会/);
  click(f, '#chat-close');
  assert.equal(f.doc.querySelector('#chat-pane').hidden, true);
  assert.equal(f.doc.querySelector('.chat-toggle').hidden, false);
  assert.equal(f.doc.body.classList.contains('chat-open'), false);
});

test('DOM: ①の録音はONの間、区切りごとに文字にして記録へ足し続け、ほかのタブでも止まらない', async (t) => {
  const ai = {
    provider: 'genspark-gsk',
    approved: [
      {
        id: 'genspark-gsk',
        ready: true,
        approvalReference: 'Genspark',
        capabilities: ['transcribe'],
      },
    ],
    model: '',
  };
  const f = await setup(t, '管理者', undefined, { ai });
  // A deterministic MediaRecorder with real Blob/arrayBuffer support; no actual microphone.
  f.window.Blob = Blob;
  let stopped = 0;
  const recorders = [];
  Object.defineProperty(f.window.navigator, 'mediaDevices', {
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) },
  });
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.mimeType = 'audio/webm;codecs=opus';
      this.state = 'inactive';
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob([new Uint8Array(256)], { type: this.mimeType }) });
      void this.onstop();
    }
  }
  f.window.MediaRecorder = Recorder;
  // Recording exists only in ①.
  assert.equal(f.doc.querySelector('#record-discussion'), null);
  click(f, '[data-tab="0"]');
  click(f, '#record-discussion');
  await settle();
  assert.ok(f.doc.querySelector('#recording-level'));
  assert.equal(f.doc.querySelector('.rec-dot').hidden, false);
  assert.match(f.doc.querySelector('#record-discussion').textContent, /録音を停止/);
  // The first one-minute piece ends: it is transcribed and saved, and the next piece starts.
  recorders[0].stop();
  await settle();
  await settle();
  assert.equal(recorders.length, 2);
  assert.equal(recorders[1].state, 'recording');
  assert.equal(stopped, 0);
  // The recording starts with its number and the time.
  assert.match(f.team.discussion.transcript, /^#01 \d{1,2}:\d\d:\d\d\nテスト音声のテストです。$/);
  assert.equal(f.doc.querySelector('#transcript').value, f.team.discussion.transcript);
  // Moving to another step keeps the recording on; a failed piece does not stop it.
  click(f, '[data-tab="1"]');
  assert.equal(f.doc.querySelector('.rec-dot').hidden, false);
  f.state.failAudio = true;
  recorders[1].stop();
  await settle();
  await settle();
  assert.equal(recorders.length, 3);
  f.state.failAudio = false;
  click(f, '[data-tab="0"]');
  assert.match(f.doc.querySelector('#audio-status').textContent, /文字にできなかった区間/);
  // Stopping hands over the last piece and releases the microphone.
  click(f, '#record-discussion');
  await settle();
  await settle();
  assert.ok(stopped > 0);
  assert.equal(recorders.length, 3);
  assert.equal(f.doc.querySelector('.rec-dot').hidden, true);
  assert.match(f.doc.querySelector('#record-discussion').textContent, /録音開始/);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/ai')).length, 3);
  // …and ends with a divider; the next recording gets the next number.
  await new Promise((r) => setTimeout(r, 500));
  assert.match(
    f.team.discussion.transcript,
    /^#01 [\d:]+\nテスト音声のテストです。\nテスト音声のテストです。\n―+ 録音終了 [\d:]+ ―+$/,
  );
  await f.state.poll();
  click(f, '#record-discussion');
  await settle();
  assert.match(f.team.discussion.transcript, /録音終了 [\d:]+ ―+\n#02 [\d:]+$/);
});

test('DOM: マップ投票アイコン→＋／自分だけ−、投票してもノードとスクロール位置を保持', async (t) => {
  const f = await setup(t);
  f.team.nodes.push({ id: 'node-b', text: '別の案', parent: 'theme', group: 1 });
  f.ws.votes.cards['other@example.test'] = { 'node-b': 1 };
  f.ws.revision++;
  await f.state.poll();
  assert.equal(f.doc.querySelector('[data-topic-votes="node-1"] [data-vote]'), null);
  click(f, '.map-panel [data-timer="cards"]');
  await settle();
  const node = f.doc.querySelector('[data-node="node-1"]'),
    panel = f.doc.querySelector('.map-panel'),
    scroll = f.doc.querySelector('.map-scroll');
  scroll.scrollLeft = 120;
  scroll.scrollTop = 80;
  assert.equal(f.doc.querySelector('[data-topic-votes="node-b"] [data-delta="-1"]'), null);
  click(f, '[data-topic-votes="node-1"] [data-delta="1"]');
  await settle();
  assert.equal(f.doc.querySelector('[data-node="node-1"]'), node);
  assert.equal(f.doc.querySelector('.map-panel'), panel);
  assert.equal(scroll.scrollLeft, 120);
  assert.equal(scroll.scrollTop, 80);
  assert.equal(f.doc.querySelector('[data-topic-votes="node-1"] .topic-total').textContent, '1');
  assert.ok(f.doc.querySelector('[data-topic-votes="node-1"] [data-delta="-1"]'));
  click(f, '[data-topic-votes="node-1"] [data-delta="-1"]');
  await settle();
  assert.equal(f.doc.querySelector('[data-topic-votes="node-1"] [data-delta="-1"]'), null);
  click(f, '[data-tab="2"]');
  assert.deepEqual(
    [...f.doc.querySelectorAll('[data-card]')].map((n) => n.dataset.card),
    ['node-b'],
  );
  assert.doesNotMatch(f.doc.querySelector('#step-content').textContent, /あなたの投票/);
  f.ws.timers.cards.endsAt = Date.now() - 100;
  f.ws.revision++;
  await f.state.poll();
  f.state.tick();
  assert.equal(f.doc.querySelector('#step-content [data-vote]'), null);
});

test('DOM: ③は5枠のデッキの下に、②で票が入ったカードだけを得票の多い順に並べる', async (t) => {
  const f = await setup(t);
  f.team.nodes.push(
    { id: 'node-b', text: 'B', parent: 'theme', group: 1 },
    { id: 'node-c', text: 'C', parent: 'theme', group: 2 },
  );
  f.ws.votes.cards = {
    'other@example.test': { 'node-1': 2, 'node-b': 5 },
    'admin@example.test': { 'node-1': 1 },
  };
  f.ws.revision++;
  await f.state.poll();
  click(f, '[data-tab="2"]');
  assert.deepEqual(
    [...f.doc.querySelectorAll('[data-card]')].map((n) => n.dataset.card),
    ['node-b', 'node-1'],
  );
  const panels = f.doc.querySelector('.deck-workspace').children;
  assert.ok(panels[0].classList.contains('casino-deck'));
  assert.ok(panels[1].classList.contains('narrowed-cards'));
  assert.match(panels[1].querySelector('h3').textContent, /絞込み済みカード/);
  assert.equal(f.doc.querySelectorAll('[data-slot]').length, 5);
  // The outline and the press release moved to ④.
  assert.equal(f.doc.querySelector('#discussion-form'), null);
  assert.equal(f.doc.querySelector('#step-content [data-vote]'), null);
});

test('DOM: 上下ボタン・ドラッグの挿入線で兄弟の順番を変え、Alt上下は何もしない', async (t) => {
  const f = await setup(t);
  f.team.nodes.push({ id: 'node-b', text: 'B', parent: 'theme', group: 1 });
  f.ws.revision++;
  await f.state.poll();
  click(f, '[data-node="node-1"]');
  click(f, '#move-topic-down');
  await settle();
  assert.equal(
    f.calls.filter((c) => c.body?.action === 'reorderTopic').at(-1).body.payload.position,
    'after',
  );
  assert.deepEqual(
    f.team.nodes.map((n) => n.id),
    ['node-b', 'node-1'],
  );
  f.doc
    .querySelector('[data-node="node-1"]')
    .dispatchEvent(
      new f.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
    );
  await settle();
  assert.deepEqual(
    f.team.nodes.map((n) => n.id),
    ['node-b', 'node-1'],
  );
  const source = f.doc.querySelector('[data-node="node-b"]'),
    target = f.doc.querySelector('[data-node="node-1"]');
  target.getBoundingClientRect = () => ({
    top: 100,
    height: 30,
    left: 100,
    right: 250,
    width: 150,
    bottom: 130,
  });
  const transfer = { setData() {}, getData: () => 'node-b' };
  const event = (type) => {
    const e = new f.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: 101 });
    Object.defineProperty(e, 'dataTransfer', { value: transfer });
    return e;
  };
  source.dispatchEvent(event('dragstart'));
  target.dispatchEvent(event('dragover'));
  assert.ok(target.classList.contains('map-drop-before'));
  target.dispatchEvent(event('drop'));
  await settle();
  assert.deepEqual(
    f.team.nodes.map((n) => n.id),
    ['node-b', 'node-1'],
  );
});

test('DOM: Deleteとメニュー削除は確認なしで子孫を消し、Ctrl+Zとボタンで枝を戻せる', async (t) => {
  const f = await setup(t);
  f.team.nodes.push(
    { id: 'child', text: '子の気づき', parent: 'node-1', group: 1 },
    { id: 'grandchild', text: '孫の気づき', parent: 'child', group: 2 },
  );
  f.ws.revision++;
  await f.state.poll();
  click(f, '[data-node="node-1"]');
  f.doc
    .querySelector('[data-node="node-1"]')
    .dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await settle();
  assert.equal(f.doc.querySelector('#confirm-delete-node'), null);
  assert.equal(f.doc.querySelector('#modal').open, false);
  assert.equal(f.team.nodes.length, 0);
  const undo = new f.window.KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  f.doc.querySelector('.map-root').dispatchEvent(undo);
  await settle();
  assert.equal(undo.defaultPrevented, true);
  assert.equal(f.team.nodes.length, 3);
  assert.equal(f.team.nodes[2].parent, 'child');
  click(f, '[data-node="node-1"]');
  click(f, '#topic-actions');
  click(f, '#delete-node');
  await settle();
  assert.equal(f.team.nodes.length, 0);
  assert.equal(f.doc.querySelector('#modal').open, false);
  click(f, '#undo-map');
  await settle();
  assert.equal(f.team.nodes.length, 3);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 文字入力中のCtrl+Zと閲覧者のCtrl+Zはマップ取消APIへ送らない', async (t) => {
  const f = await setup(t);
  click(f, '#new-topic');
  const input = f.doc.querySelector('#topic-editor');
  const undo = new f.window.KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(undo);
  await settle();
  assert.equal(undo.defaultPrevented, false);
  assert.equal(
    f.calls.some((c) => c.body?.action === 'undoMap'),
    false,
  );
  const viewer = await setup(t, '閲覧者');
  assert.equal(viewer.doc.querySelector('#undo-map').disabled, true);
  viewer.doc
    .querySelector('.map-root')
    .dispatchEvent(
      new viewer.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
  await settle();
  assert.equal(
    viewer.calls.some((c) => c.body?.action === 'undoMap'),
    false,
  );
});

test('DOM: MindManagerの8項目をCtrl+V相当で階層追加し、折り畳んだ枝もTAB形式でコピー', async (t) => {
  const f = await setup(t);
  click(f, '[data-node="node-1"]');
  const text = readFileSync(
    new URL('../test-support/mindmanager-copy.txt', import.meta.url),
    'utf8',
  );
  const paste = new f.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text } });
  f.doc.querySelector('[data-node="node-1"]').dispatchEvent(paste);
  await settle();
  assert.equal(paste.defaultPrevented, true);
  assert.equal(f.team.nodes.length, 9);
  assert.equal(
    f.calls.filter((c) => c.path.endsWith('/action') && c.body.action === 'pasteOutline').length,
    1,
  );
  assert.equal(f.team.nodes[1].parent, 'node-1');
  click(f, '#collapse-all');
  await settle();
  let copied;
  const copy = new f.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', {
    value: {
      setData: (type, value) => {
        assert.equal(type, 'text/plain');
        copied = value;
      },
    },
  });
  f.doc.querySelector('.map-root').dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  assert.deepEqual(parseOutline(copied), parseOutline(text));
  assert.ok(copied.includes('\r\n\t'));
});

test('DOM: 貼付けダイアログで階層を選べ、文字入力中・閲覧者にはマップ貼付けを割り込ませない', async (t) => {
  const f = await setup(t);
  click(f, '#paste-outline');
  f.doc.querySelector('#paste-outline-text').value = '親\n\t子';
  f.doc.querySelector('#paste-outline-position').value = 'sibling';
  f.doc
    .querySelector('#paste-outline-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(
    f.calls.find((c) => c.body?.action === 'pasteOutline').body.payload.placement,
    'sibling',
  );
  click(f, '#new-topic');
  const paste = new f.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '入力の中の文章' } });
  f.doc.querySelector('#topic-editor').dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  const viewer = await setup(t, '閲覧者');
  assert.equal(viewer.doc.querySelector('#paste-outline').disabled, true);
  const denied = new viewer.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(denied, 'clipboardData', { value: { getData: () => '追加しない' } });
  viewer.doc.querySelector('.map-root').dispatchEvent(denied);
  await settle();
  assert.equal(
    viewer.calls.some((c) => c.body?.action === 'pasteOutline'),
    false,
  );
});

for (const confirm of ['Enter', 'Insert', 'blur', 'Escape']) {
  test(`DOM: 空トピックを${confirm}で取り消した後も選択・直接編集・追加が続けられる`, async (t) => {
    const f = await setup(t);
    const count = f.team.nodes.length;
    click(f, '#new-topic');
    const input = f.doc.querySelector('#topic-editor');
    input.value = '   ';
    input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    if (confirm === 'blur') input.dispatchEvent(new f.window.FocusEvent('blur'));
    else
      input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: confirm, bubbles: true }));
    await settle();
    assert.equal(f.doc.querySelector('#topic-editor'), null);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/action')).length, 0);
    assert.equal(f.team.nodes.length, count);
    click(f, '[data-node="node-1"]');
    assert.equal(f.doc.querySelector('[data-node="node-1"]').classList.contains('selected'), true);
    f.doc
      .querySelector('[data-node="node-1"]')
      .dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(f.doc.querySelector('#topic-editor').value, '地域のつながり');
    f.doc
      .querySelector('#topic-editor')
      .dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    click(f, '#new-topic');
    assert.ok(f.doc.querySelector('#topic-editor'));
    assert.deepEqual(
      f.errors.map((e) => e.message),
      [],
    );
  });
}

test('DOM: ビルド日時をログイン・認証入力・メインに同じ固定値で表示し、上端タブと収納メニューを保つ', async (t) => {
  const f = await setup(t, '管理者', undefined, { landing: true });
  const label = f.doc.querySelector('.build-info').textContent;
  assert.match(label, /ビルド \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(label, /v\d/);
  click(f, '[data-open-workshop]');
  await settle();
  assert.equal(f.doc.querySelector('.workspace-identity .build-info').textContent, label);
  assert.equal(f.doc.querySelectorAll('.topbar [data-tab]').length, 5);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  assert.equal(f.doc.querySelector('#register-key'), null);
  assert.equal(f.doc.querySelector('#logout'), null);
  assert.equal(f.doc.querySelector('#account'), null);
  assert.ok(f.doc.querySelector('#settings svg'));
  click(f, '#toggle-sidebar');
  await settle();
  assert.equal(f.doc.querySelector('.shell').classList.contains('sidebar-collapsed'), true);
  assert.equal(f.doc.querySelector('#toggle-sidebar').getAttribute('aria-expanded'), 'false');
  click(f, '[data-tab="1"]');
  assert.equal(f.doc.querySelector('.shell').classList.contains('sidebar-collapsed'), true);
  click(f, '#toggle-sidebar');
  await settle();
  assert.equal(f.doc.querySelector('.shell').classList.contains('sidebar-collapsed'), false);
  const auth = await setup(t, '管理者', { demo: false, auth: { emailOtpReady: true } });
  assert.equal(auth.doc.querySelector('.login-form .build-info').textContent, label);
});
test('DOM: 4タブ・管理者設定・マップから付箋・デッキ・議論フォームが描画される', async (t) => {
  const f = await setup(t);
  assert.equal(f.doc.querySelectorAll('[data-tab]').length, 5);
  assert.match(f.doc.querySelector('.map-root').textContent, /画面テスト/);
  assert.ok(f.doc.querySelector('#settings'));
  click(f, '#new-topic');
  const topic = f.doc.querySelector('#topic-editor');
  topic.value = '新しい気づき';
  topic.dispatchEvent(new f.window.Event('input'));
  topic.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  assert.equal(f.doc.querySelectorAll('[data-node]').length, 2);
  f.ws.votes.cards['admin@example.test'] = Object.fromEntries(f.team.nodes.map((n) => [n.id, 1]));
  f.ws.revision++;
  await f.state.poll();
  // ③: the deck and the voted cards only.
  click(f, '[data-tab="2"]');
  assert.equal(f.doc.querySelectorAll('[data-card]').length, 2);
  assert.equal(f.doc.querySelectorAll('[data-slot]').length, 5);
  assert.equal(f.doc.querySelector('#discussion-form'), null);
  // ④: the deck, the outline (Who / What / How in one row) and the press release button.
  click(f, '[data-tab="3"]');
  assert.equal(f.doc.querySelectorAll('[data-slot]').length, 5);
  assert.ok(f.doc.querySelector('#discussion-form'));
  assert.equal(f.doc.querySelector('#record-discussion'), null);
  assert.equal(f.doc.querySelector('#transcript'), null);
  assert.deepEqual(
    [...f.doc.querySelectorAll('.outline-row')[0].querySelectorAll('input')].map((i) => i.id),
    ['who', 'what', 'how'],
  );
  assert.equal(f.doc.querySelectorAll('.outline-row .feature-line').length, 3);
  assert.match(f.doc.querySelector('[data-ai="pressRelease"]').textContent, /模擬プレスの作成/);
  // ④ has no save or preview button; it saves by itself. The paper prototype is made here,
  // under the press release.
  assert.match(f.doc.querySelector('#press-panel [data-ai="image"]').textContent, /ペーパープロトの作成/);
  assert.equal(f.doc.querySelector('#preview-summary'), null);
  assert.doesNotMatch(f.doc.querySelector('#discussion-form').textContent, /記録を保存/);
  assert.match(f.doc.querySelector('[data-ai="summarize"]').textContent, /たたき台を生成/);
  assert.ok(f.doc.querySelector('#press-panel #pressRelease'));
  // The generated text is shown as a newspaper article: title, then body.
  f.team.discussion.pressRelease = '##【タイトル】\n駅前から始まる新しい日常\n\n##【本文】\n\n【課題の背景】\n人手が足りません。';
  f.ws.revision++;
  await f.state.poll();
  assert.equal(f.doc.querySelector('.press-paper h2').textContent, '駅前から始まる新しい日常');
  assert.equal(f.doc.querySelector('.press-body h4').textContent, '【課題の背景】');
  assert.equal(f.doc.querySelector('.press-body p').textContent, '人手が足りません。');
  assert.doesNotMatch(f.doc.querySelector('.press-paper').textContent, /##|本文】/);
  // Leaving a field saves it, without redrawing the form.
  const what = f.doc.querySelector('#what');
  what.value = '地域の交流';
  what.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  what.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await settle();
  const saved = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(saved.body.action, 'discussion');
  assert.equal(saved.body.payload.what, '地域の交流');
  assert.equal(saved.body.payload.snapshot, undefined);
  assert.equal(f.doc.querySelector('#what'), what);
  // Correcting the text and closing 「原稿を修正する」 updates the article.
  const details = f.doc.querySelector('.press-edit'),
    draft = f.doc.querySelector('#pressRelease');
  details.open = true;
  details.dispatchEvent(new f.window.Event('toggle'));
  draft.value = '【タイトル】直した見出し\n本文を直しました。';
  draft.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  details.open = false;
  details.dispatchEvent(new f.window.Event('toggle'));
  await settle();
  assert.equal(f.doc.querySelector('.press-paper h2').textContent, '直した見出し');
  assert.equal(f.doc.querySelector('.press-body p').textContent, '本文を直しました。');
  assert.equal(f.doc.querySelector('.press-edit').open, false);
  // ⑤: make the paper prototype, compare and vote.
  click(f, '[data-tab="4"]');
  assert.match(f.doc.querySelector('#step-content').textContent, /チームのアイディア/);
  assert.equal(f.doc.querySelector('[data-ai="image"]'), null);
  // ①: the voice log.
  click(f, '[data-tab="0"]');
  assert.ok(f.doc.querySelector('#talk-form #record-discussion'));
  assert.ok(f.doc.querySelector('#talk-form #transcript'));
  // Sidebar: the theme on top; no workshop list box, status or version.
  // Sidebar: icon tools right under the brand, then the workshop's title (not its memo).
  assert.equal(f.doc.querySelector('.sidebar > :first-child').className, 'sidebar-tools');
  assert.deepEqual(
    [...f.doc.querySelectorAll('.sidebar-tools button')].map((b) => [b.id, b.textContent.trim()]),
    [
      ['to-list', ''],
      ['toggle-sidebar', ''],
    ],
  );
  assert.equal(f.doc.querySelector('.workspace-tag').textContent, '画面テスト');
  // ログ保存 sits with the Notion status; ① has no save button of its own.
  assert.match(f.doc.querySelector('.sidebar-foot #save-log').textContent, /ログ保存/);
  assert.ok(f.doc.querySelector('#save-log svg'));
  assert.equal(f.doc.querySelector('#talk-form button.primary'), null);
  const box = f.doc.querySelector('#transcript');
  box.value = '手で書いた記録';
  box.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  click(f, '#save-log');
  await settle();
  const logged = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(logged.body.payload.transcript, '手で書いた記録');
  assert.equal(logged.body.payload.snapshot, true);
  assert.match(f.doc.querySelector('#toast').textContent, /ログを保存しました/);
  // ②: only fold / unfold / zoom show in the bar; voting uses the same bar as ⑤.
  click(f, '[data-tab="1"]');
  assert.deepEqual(
    [...f.doc.querySelectorAll('.board-actions > button, .board-actions > span:not([hidden])')].map(
      (b) => b.id,
    ),
    ['collapse-all', 'expand-all', 'zoom-out', 'zoom-label', 'fit-map', 'zoom-in'],
  );
  assert.equal(f.doc.querySelector('#new-topic').closest('[hidden]').className, 'map-tools-off');
  assert.match(f.doc.querySelector('.map-panel .vote-bar').textContent, /残り.*票.*VOTING TIME/s);
  assert.ok(f.doc.querySelector('.vote-bar [data-timer="cards"]'));
  click(f, '[data-tab="0"]');
  assert.equal(f.doc.querySelector('#workshop-select'), null);
  assert.equal(f.doc.querySelector('.sidebar-meta'), null);
  assert.doesNotMatch(f.doc.querySelector('.sidebar').textContent, /v\d+\.\d+/);
  assert.doesNotMatch(f.doc.querySelector('.workspace-identity').textContent, /v\d+\.\d+/);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});
test('DOM: 閲覧者に設定歯車を表示せず、編集や音声認識も無効', async (t) => {
  const f = await setup(t, '閲覧者');
  assert.equal(f.doc.querySelector('#settings'), null);
  assert.equal(f.doc.querySelector('#node-text'), null);
  assert.equal(f.doc.querySelector('#new-topic').disabled, true);
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
  assert.equal(f.doc.querySelector('#passkey-login'), null);
  assert.equal(f.doc.querySelector('#password'), null);
  assert.ok(f.doc.querySelector('.opening .opening-card'));
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
  assert.match(f.doc.querySelector('.workshop-list .empty').textContent, /Notion連携が未設定/);
  assert.equal(f.doc.querySelector('#settings'), null);
  f.state.notion = { enabled: true, state: 'error' };
  await f.state.poll();
  assert.match(f.doc.querySelector('.workshop-list .empty').textContent, /Notionの接続を確認/);
  f.state.notion = { enabled: true, state: 'ready' };
  f.state.admin = true;
  f.state.available = true;
  await f.state.poll();
  // The list fills in by itself; the admin can now create and open workshops.
  assert.ok(f.doc.querySelector('#new-workshop'));
  click(f, '[data-open-workshop]');
  await settle();
  assert.ok(f.doc.querySelector('#settings'));
  click(f, '[data-tab="1"]');
  assert.ok(f.doc.querySelector('.map-root'));
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 保存済みセッションはログインを省いてワークショップ一覧を表示し、選ぶと開き、一覧へ戻れる', async (t) => {
  const f = await setup(t, '管理者', undefined, { landing: true });
  assert.equal(f.doc.querySelector('#login-form'), null);
  assert.ok(f.calls.some((c) => c.path === '/api/me'));
  assert.ok(f.doc.querySelector('.opening .workshop-list'));
  assert.match(f.doc.querySelector('.workshop-list').textContent, /新しいワークショップを始める/);
  assert.match(f.doc.querySelector('.workshop-list').textContent, /ワークショップを再開する/);
  assert.ok(f.doc.querySelector('#new-workshop'));
  assert.equal(f.doc.querySelectorAll('[data-open-workshop]').length, 1);
  // Each card shows the workshop's picture; if there is none, the placeholder stays.
  const thumb = f.doc.querySelector('[data-open-workshop] img[data-thumb]');
  assert.ok(thumb.getAttribute('src').startsWith('/api/workshops/') && thumb.getAttribute('src').includes('/thumb?t='));
  thumb.dispatchEvent(new f.window.Event('error'));
  assert.equal(f.doc.querySelector('[data-open-workshop] img'), null);
  assert.equal(f.doc.querySelectorAll('[data-open-workshop] .workshop-thumb i').length, 5);
  assert.match(f.doc.querySelector('[data-open-workshop]').textContent, /画面テスト/);
  assert.equal(f.doc.querySelectorAll('[data-tab]').length, 0);
  click(f, '[data-open-workshop]');
  await settle();
  assert.equal(f.doc.querySelectorAll('[data-tab]').length, 5);
  // A workshop opens on ①, the voice log.
  assert.ok(f.doc.querySelector('#talk-form'));
  click(f, '#to-list');
  await settle();
  assert.ok(f.doc.querySelector('.workshop-list'));
  // Staying on the list: the regular refresh must not open a workshop by itself.
  await f.state.poll();
  assert.ok(f.doc.querySelector('.workshop-list'));
  // Without a saved login: the card with email and one-time code only.
  const guest = await setup(t, '管理者', { demo: false, auth: { emailOtpReady: true } });
  assert.ok(guest.doc.querySelector('.opening #login-form #email'));
  assert.ok(guest.doc.querySelector('#otp-field'));
  assert.equal(guest.doc.querySelector('#password'), null);
  assert.equal(guest.doc.querySelector('#passkey-login'), null);
});

test('DOM: 班の割当はなく、どの班でも編集・AIチャットができる', async (t) => {
  const f = await setup(t),
    buttons = f.doc.querySelectorAll('[data-team]');
  buttons[1].click();
  await settle();
  assert.match(f.doc.querySelector('#step-content').textContent, /他チームの気づき/);
  assert.equal(f.doc.querySelector('#node-text'), null);
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  assert.equal(f.doc.querySelector('#next-advice').disabled, false);
  assert.equal(f.doc.querySelector('.team-readonly'), null);
  assert.doesNotMatch(f.doc.querySelector('.team-switch').textContent, /閲覧|参加中/);
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
  assert.ok(f.doc.querySelector('#next-advice.chat-toggle'));
  for (let tab = 0; tab < 5; tab++) {
    click(f, `[data-tab="${tab}"]`);
    assert.ok(f.doc.querySelector(`.tabbar.tab-tone-${tab ? tab - 1 : 'w'}`));
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
  assert.equal(f.doc.querySelector('[data-deck-card]').draggable, false);
  assert.equal(typeof f.doc.querySelector('[data-deck-card]').onpointerdown, 'function');
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
  // The other team's deck takes only that team's cards.
  assert.match(f.doc.querySelector('#toast').textContent, /配置するカードを確認/);
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

test('DOM: 新しいタブ名、Notion未同期の明示、再同期後の編集再開', async (t) => {
  const f = await setup(t, '管理者', undefined, {
    content: true,
    documentSync: { pending: true, error: '接続を確認してください' },
  });
  const labels = [...f.doc.querySelectorAll('[data-tab]')].map((b) => b.textContent);
  assert.match(labels[0], /①.*ワイガヤ（音声記録）/);
  assert.match(labels[1], /②.*もやもやの言語化/);
  assert.match(labels[2], /③.*カードで議論深耕/);
  assert.match(labels[3], /④.*模擬プレスの作成/);
  assert.match(labels[4], /⑤.*ペーパープロトの作成/);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  click(f, '#settings');
  await settle();
  assert.match(f.doc.querySelector('.content-status').textContent, /記録に失敗/);
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  click(f, '#retry-content-sync');
  await settle();
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  f.doc.querySelector('#modal-close').click();
  click(f, '#settings');
  await settle();
  assert.match(f.doc.querySelector('.content-status').textContent, /ワークショップの記録/);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 10秒同期待ち中も続けて編集でき、入力中の活動を通知する', async (t) => {
  const f = await setup(t, '管理者', undefined, {
    content: true,
    documentSync: { pending: true, queued: true, dueAt: Date.now() + 10000, error: null },
  });
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  assert.equal(f.doc.querySelector('#retry-content-sync'), null);
  click(f, '#new-topic');
  const input = f.doc.querySelector('#topic-editor');
  input.value = '連続して入力';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await settle();
  assert.ok(
    f.calls.some((c) => c.path.endsWith('/content-activity') && c.body.teamId === f.team.id),
  );
  input.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  assert.ok(f.team.nodes.some((n) => n.text === '連続して入力'));
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: 同期中・同期障害中も編集でき、同期状態だけの更新ではマップを再描画しない', async (t) => {
  const f = await setup(t, '管理者', undefined, {
    content: true,
    documentSync: { pending: true, syncing: true, error: null },
  });
  const panel = f.doc.querySelector('.map-panel');
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  f.ws.documentSync = { pending: false, syncing: false, error: null };
  await f.state.poll();
  assert.equal(f.doc.querySelector('.map-panel'), panel);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  f.ws.documentSync = { pending: true, syncing: false, error: 'Notion側の更新を確認してください' };
  await f.state.poll();
  assert.equal(f.doc.querySelector('.map-panel'), panel);
  assert.equal(f.doc.querySelector('#new-topic').disabled, false);
  assert.equal(f.doc.querySelector('.main .content-status'), null);
  click(f, '#new-topic');
  const editor = f.doc.querySelector('#topic-editor');
  editor.value = '同期障害中も書ける';
  editor.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await f.state.poll();
  assert.equal(f.doc.querySelector('#topic-editor'), editor);
  editor.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  assert.ok(f.team.nodes.some((n) => n.text === '同期障害中も書ける'));
});

test('DOM: Notion競合でも入力を保持し、最新内容を読み込んでから保存し直せる', async (t) => {
  const f = await setup(t);
  f.state.actionConflict = true;
  const node = f.doc.querySelector('[data-node]');
  node.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
  let input = f.doc.querySelector('#topic-editor');
  input.value = '保存したい入力';
  input.dispatchEvent(new f.window.Event('input'));
  input.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  assert.ok(f.doc.querySelector('#load-pending'));
  assert.equal(f.doc.querySelector('#topic-editor').value, '保存したい入力');
  click(f, '#load-pending');
  input = f.doc.querySelector('#topic-editor');
  assert.equal(input.value, '保存したい入力');
  input.dispatchEvent(new f.window.FocusEvent('blur'));
  await settle();
  assert.equal(f.team.nodes[0].text, '保存したい入力');
  assert.deepEqual(
    f.errors.map((e) => e.message),
    [],
  );
});

test('DOM: AIアシスタントのチップで種類付き相談を送り、候補を③へ反映できる', async (t) => {
  const f = await setup(t);
  f.state.adviceResponse = {
    should_speak: true,
    source: 'ai',
    character: 'kashi',
    bubble_text: '3つの案です。',
    options: [
      { field: 'headline', value: '駅から始まる新しい日常', reason: '生活者視点' },
      { field: 'feature2', value: '誰でもすぐ使える' },
    ],
  };
  click(f, '[data-tab="3"]');
  click(f, '#next-advice');
  const chips = [...f.doc.querySelectorAll('[data-quick]')].map((b) => b.textContent);
  assert.ok(chips.includes('一言で言うと×3案'));
  click(f, '[data-quick="headline"]');
  await settle();
  const call = f.calls.filter((c) => c.path.endsWith('/advice') && c.body.question).at(-1);
  assert.equal(call.body.intent, 'headline');
  assert.match(call.body.question, /一言で言うと/);
  assert.match(f.doc.querySelector('.chat-options').textContent, /駅から始まる新しい日常/);
  click(f, '[data-adopt$=":0"]');
  await settle();
  const adopt = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(adopt.body.action, 'discussion');
  assert.equal(adopt.body.payload.headline, '駅から始まる新しい日常');
  click(f, '[data-adopt$=":1"]');
  await settle();
  const feature = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(feature.body.payload.features[1], '誰でもすぐ使える');
});

test('DOM: ③の「記録を保存」はNotion履歴への記録を依頼する', async (t) => {
  const f = await setup(t);
  click(f, '[data-tab="3"]');
  f.doc.querySelector('#headline').value = '保存する一言';
  f.doc
    .querySelector('#discussion-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const call = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(call.body.action, 'discussion');
  assert.equal(call.body.payload.snapshot, true);
  assert.equal(call.body.payload.headline, '保存する一言');
});

test('DOM: ③は既定で文字を大きくし、絞込み済みカードの＋でデッキへ追加できる', async (t) => {
  const f = await setup(t);
  click(f, '[data-tab="3"]');
  const wrap = f.doc.querySelector('.deck-discussion');
  assert.ok(wrap.classList.contains('text-scale-115'));
  click(f, '[data-tab="2"]');
  const plus = [...f.doc.querySelectorAll('[data-add-deck]')].find((b) => !b.disabled);
  if (plus) {
    plus.click();
    await settle();
    const call = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
    assert.equal(call.body.action, 'deck');
    assert.ok(call.body.payload.ids.includes(plus.dataset.addDeck));
  }
  click(f, '[data-tab="3"]');
  assert.equal(f.doc.querySelector('[data-ai="image"]').textContent.includes('ペーパープロト'), true);
});

test('DOM: ③リフレッシュで今のデッキを＃1に残して空にし、アイコンで戻れる。④はデッキごとに表示', async (t) => {
  const f = await setup(t);
  f.window.confirm = () => true;
  click(f, '[data-tab="3"]');
  assert.match(f.doc.querySelector('.deck-history').textContent, /デッキ＃1/);
  const headline = f.doc.querySelector('#headline');
  headline.value = '最初の案';
  headline.dispatchEvent(new f.window.Event('input'));
  click(f, '#new-deck');
  await settle();
  const call = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(call.body.action, 'clearIdea');
  assert.equal(call.body.payload.headline, '最初の案');
  assert.equal(f.doc.querySelector('#headline').value, '');
  const chip = f.doc.querySelector('[data-deck-idea]');
  assert.equal(chip.textContent.trim(), 'デッキ＃1');
  assert.match(f.doc.querySelector('.deck-chip.active').textContent, /デッキ＃2/);
  chip.click();
  await settle();
  assert.equal(f.doc.querySelector('#headline').value, '最初の案');
  assert.equal(f.doc.querySelector('[data-deck-idea].active')?.textContent.trim(), 'デッキ＃1');
  // ④: each deck with an image is its own entry and vote target.
  f.team.ideas[0].image = { key: 'k1', width: 16, height: 9 };
  f.team.ideas.push({ ...structuredClone(f.team.ideas[0]), id: 'idea-2', image: { key: 'k2', width: 16, height: 9 } });
  f.ws.revision++;
  await f.state.poll();
  click(f, '[data-tab="4"]');
  await settle();
  const entries = [...f.doc.querySelectorAll('.idea')];
  assert.equal(entries.length, 2);
  assert.match(entries[1].textContent, /デッキ＃2/);
  assert.equal(entries[1].querySelector('[data-vote="ideas"][data-delta="1"]').dataset.target, 'idea-2');
  assert.match(entries[0].querySelector('img').getAttribute('src'), /idea-image\?idea=/);
});

test('DOM: ①のディスカッションの記録は手入力でも保存でき、④の整理の材料になる', async (t) => {
  const f = await setup(t);
  f.team.discussion.transcript = '録音で話したこと';
  f.ws.revision++;
  await f.state.poll();
  click(f, '[data-tab="0"]');
  assert.equal(f.doc.querySelector('#record-discussion').disabled, false);
  const box = f.doc.querySelector('#transcript');
  assert.equal(box.value, '録音で話したこと');
  assert.equal(box.maxLength, 100000);
  box.value = '録音で話したこと\nあとから書き足したこと';
  box.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.doc
    .querySelector('#talk-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const call = f.calls.filter((c) => c.path.endsWith('/action')).at(-1);
  assert.equal(call.body.action, 'discussion');
  assert.equal(call.body.payload.snapshot, true);
  assert.match(call.body.payload.transcript, /あとから書き足したこと/);
  assert.match(f.team.discussion.transcript, /あとから書き足したこと/);
  click(f, '[data-tab="3"]');
  assert.equal(f.doc.querySelector('#transcript'), null);
  assert.ok(f.doc.querySelector('[data-ai="summarize"]'));
});

test('DOM: ①はブラウザーの音声認識を優先し、聞き取った文をまとめて記録へ送り、認識が切れても続ける', async (t) => {
  const recs = [];
  class Speech {
    constructor() {
      recs.push(this);
    }
    start() {
      this.on = true;
    }
    stop() {
      this.on = false;
      this.onend?.();
    }
    say(text, isFinal = true) {
      this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
    }
  }
  const f = await setup(t, '管理者', undefined, { speech: Speech });
  let flush;
  const timers = f.window.setInterval;
  f.window.setInterval = (fn, ms) => (ms === 8000 ? ((flush = fn), 1) : timers(fn, ms));
  click(f, '[data-tab="0"]');
  assert.match(f.doc.querySelector('.save-hint').textContent, /無料/);
  // No AI connection is needed for the browser engine.
  click(f, '#record-discussion');
  await settle();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].lang, 'ja-JP');
  assert.equal(f.doc.querySelector('.rec-dot').hidden, false);
  recs[0].say('駅前は夜に人手が足りない');
  recs[0].say('見守りを自動にしたい');
  recs[0].say('まだ途中', false);
  // Only the start line (number and time) has been written so far.
  const marks = f.calls.filter((c) => c.path.endsWith('/transcript'));
  assert.equal(marks.length, 1);
  assert.match(marks[0].body.text, /^#01 \d{1,2}:\d\d:\d\d$/);
  flush();
  await settle();
  const sent = f.calls.filter((c) => c.path.endsWith('/transcript')).slice(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, '駅前は夜に人手が足りない。見守りを自動にしたい。');
  assert.match(f.doc.querySelector('#transcript').value, /見守りを自動にしたい。/);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/ai')).length, 0);
  // Recognition ends after a pause in speech: it starts again by itself.
  recs[0].onend();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(recs.length, 2);
  // Stopping sends what is left.
  recs[1].say('最後のひとこと');
  click(f, '#record-discussion');
  await settle();
  assert.equal(recs[1].on, false);
  assert.equal(f.doc.querySelector('.rec-dot').hidden, true);
  assert.match(f.team.discussion.transcript, /最後のひとこと。$/);
  // A divider closes the recording.
  await new Promise((r) => setTimeout(r, 1700));
  assert.match(f.team.discussion.transcript, /最後のひとこと。\n―+ 録音終了 [\d:]+ ―+$/);
});

test('DOM: QRコードの参加ページはメールと認証コードだけで入り、そのワークショップを開く', async (t) => {
  const f = await setup(
    t,
    '編集者',
    { demo: false, auth: { emailOtpReady: true } },
    { url: 'http://localhost:4317/?join=placeholder' },
  );
  assert.match(f.doc.querySelector('.login-form > p.muted').textContent, /認証コードが届きます/);
  const submit = () =>
    f.doc
      .querySelector('#login-form')
      .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  f.doc.querySelector('#email').value = 'guest@example.test';
  submit();
  await settle();
  const start = f.calls.find((c) => c.path === '/api/join/start');
  assert.equal(start.body.email, 'guest@example.test');
  assert.equal(start.body.workshopId, 'placeholder');
  assert.equal(f.calls.some((c) => c.path === '/api/auth/start'), false);
  assert.equal(f.doc.querySelector('#otp-field').hidden, false);
  f.doc.querySelector('#otp').value = '123456';
  submit();
  await settle();
  await settle();
  const verify = f.calls.find((c) => c.path === '/api/join/verify');
  assert.deepEqual(verify.body, { challenge: 'join-1', code: '123456' });
  // Logged in: the list (the placeholder id is not this fixture's workshop).
  assert.ok(f.doc.querySelector('.workshop-list [data-open-workshop]'));
});

test('DOM: 管理者は投影用の参加QRコードを大きく表示でき、設定に班の割当はない', async (t) => {
  const f = await setup(t);
  click(f, '#show-qr');
  await settle();
  assert.ok(f.doc.querySelector('#modal').classList.contains('qr-modal'));
  assert.match(f.doc.querySelector('.qr-screen h2').textContent, /QRコード を読み込んで下さい/);
  assert.match(f.doc.querySelector('.qr-screen img').getAttribute('src'), /^data:image\/png/);
  assert.match(f.doc.querySelector('.qr-url').textContent, /\?join=/);
  f.doc.querySelector('#modal-close').click();
  click(f, '#settings');
  await settle();
  assert.equal(f.doc.querySelector('#modal').classList.contains('qr-modal'), false);
  assert.equal(f.doc.querySelector('#member-team'), null);
  assert.ok(f.doc.querySelector('#member-role'));
  const viewer = await setup(t, '閲覧者');
  assert.equal(viewer.doc.querySelector('#show-qr'), null);
});

test('DOM: ④の「たたき台を生成」と「模擬プレスの作成」は確認ダイアログなしで画面に反映し、③はデッキに置いたカードを下段に出さない', async (t) => {
  const ai = {
    provider: 'genspark-gsk',
    approved: [
      {
        id: 'genspark-gsk',
        ready: true,
        approvalReference: 'Genspark',
        capabilities: ['summarize', 'pressRelease'],
      },
    ],
    model: '',
  };
  const f = await setup(t, '管理者', undefined, { ai });
  f.team.nodes.push({ id: 'node-b', text: '別の気づき', group: 1, parent: null });
  f.ws.votes.cards['admin@example.test'] = { 'node-1': 1, 'node-b': 2 };
  f.team.deck = ['node-b'];
  f.team.deckSlots = ['node-b', null, null, null, null];
  f.ws.revision++;
  await f.state.poll();
  // ③: node-b is on the deck, so only node-1 is listed below.
  click(f, '[data-tab="2"]');
  assert.deepEqual(
    [...f.doc.querySelectorAll('.narrowed-cards [data-card]')].map((n) => n.dataset.card),
    ['node-1'],
  );
  assert.equal(f.doc.querySelector('[data-deck-card]').dataset.deckCard, 'node-b');
  click(f, '[data-tab="3"]');
  f.state.aiResponse = { result: { headline: '案' }, proposal: 'draft-1' };
  f.state.onApply = (team) =>
    Object.assign(team.discussion, {
      headline: '止まらない街を守る',
      who: '自治体',
      what: '見守り',
      how: 'AIカメラ',
      features: ['夜も見守る', '判断を学ぶ', '住民が参加'],
    });
  click(f, '[data-ai="summarize"]');
  await settle();
  await settle();
  assert.ok(!f.doc.querySelector('#modal').open);
  assert.equal(f.doc.querySelector('#apply-ai'), null);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/apply')).at(-1).body.proposal, 'draft-1');
  assert.equal(f.doc.querySelector('#headline').value, '止まらない街を守る');
  assert.equal(f.doc.querySelector('#who').value, '自治体');
  assert.deepEqual(
    [...f.doc.querySelectorAll('.feature-line')].map((x) => x.value),
    ['夜も見守る', '判断を学ぶ', '住民が参加'],
  );
  assert.match(f.doc.querySelector('#toast').textContent, /たたき台/);
  f.state.aiResponse = { result: { text: '原稿' }, proposal: 'press-1' };
  f.state.onApply = (team) => (team.discussion.pressRelease = '【タイトル】新しい街\n本文です。');
  click(f, '[data-ai="pressRelease"]');
  await settle();
  await settle();
  assert.equal(f.doc.querySelector('#apply-ai'), null);
  assert.equal(f.doc.querySelector('.press-paper h2').textContent, '新しい街');
  // While the AI worked a spinner said what was being made; it is gone when done.
  assert.match(f.doc.querySelector('#busy').textContent, /模擬プレスリリースを作成しています/);
  assert.equal(f.doc.querySelector('#busy').hidden, true);
  // AI chat proposals: no 「トピック追加」 label, an icon button.
  f.state.adviceResponse = {
    should_speak: true,
    source: 'ai',
    character: 'kashi',
    bubble_text: '案です。',
    options: [{ field: 'topic', value: 'AIで事前予知' }, { field: 'headline', value: '一言' }],
  };
  click(f, '#next-advice');
  const q = f.doc.querySelector('#advice-question');
  q.value = '案を出して';
  q.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.doc
    .querySelector('#advice-chat-form')
    .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const items = [...f.doc.querySelectorAll('.chat-options li')];
  assert.equal(items[0].querySelector('.option-field'), null);
  assert.equal(items[0].querySelector('.option-add').textContent, '＋');
  assert.equal(items[0].querySelector('.option-add').title, 'マップに追加');
  assert.equal(items[1].querySelector('.option-field').textContent, '一言で言うと');
  assert.match(f.doc.querySelector('.chat-message.chat-assistant small').textContent, /かっしー/);
});
