'use strict';
const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const app = $('#app'),
  modal = $('#modal'),
  modalContent = $('#modal-content');
const build = globalThis.WORKSHOP_BUILD || { version: 'development', builtAt: '未ビルド' };
// Remaining Genspark credits under the e-mail address (administrators only).
const creditLabel = () =>
  me?.credit
    ? `<span class="credit-info" id="credit-info" title="${esc(me.credit.error || (me.credit.at ? '取得 ' + new Date(me.credit.at).toLocaleTimeString('ja-JP') : ''))}">${
        Number.isFinite(me.credit.balance)
          ? creditBar(me.credit)
          : me.credit.error
            ? 'Genspark残高：取得できません'
            : 'Genspark残高：確認中…'
      }</span>`
    : '';
// Remaining credits as a horizontal bar (meter colours: green → amber → red).
function creditBar({ balance, total }) {
  const max = Math.max(balance, Number.isFinite(total) ? total : balance, 1),
    percent = Math.round((balance / max) * 100);
  return `<span class="credit-text">Genspark残り ${Math.round(balance).toLocaleString('ja-JP')}${
    Number.isFinite(total) && total >= balance ? ` / ${Math.round(total).toLocaleString('ja-JP')}` : ''
  } クレジット（${percent}%）</span><meter class="credit-meter" min="0" max="${max}" low="${max * 0.2}" high="${max * 0.5}" optimum="${max}" value="${balance}" aria-label="Gensparkの残りクレジット ${percent}%"></meter>`;
}
const taskNames = {
  transcribe: '音声認識（1回・最大3分）',
  pressRelease: '模擬プレスリリース',
  image: '画像生成（企画提案シート）',
  summarize: '議論を整理',
  classify: 'グループ分け',
  questions: '問いかけ',
  keywords: 'キーワード',
};
function creditUsageTable() {
  const usage = Object.entries(me.credit?.usage || {});
  if (!usage.length)
    return '<p class="muted">まだ記録がありません。AI処理を実行すると、処理の前後の残高の差から消費量を記録します（同時に別のAI処理が動いた回は記録しません）。</p>';
  return `<table><thead><tr><th>処理</th><th>回数</th><th>平均</th><th>直近</th></tr></thead><tbody>${usage
    .map(
      ([task, u]) =>
        `<tr><td>${esc(taskNames[task] || task)}</td><td>${u.count}</td><td>${(u.total / u.count).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}</td><td>${Number(u.last).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}</td></tr>`,
    )
    .join('')}</tbody></table><p class="muted">処理の前後の残高の差から求めた実測値です（単位：クレジット）。</p>`;
}
const buildLabel = () =>
  `<small class="build-info">ビルド ${esc(build.builtAt)}（日本時間）</small>`;
const gearIcon = () =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg>';
let sidebarCollapsed = false;
try {
  sidebarCollapsed = localStorage.getItem('workshop-sidebar-collapsed') === 'true';
} catch {}
let me,
  ws,
  workshops = [],
  tab = 0,
  teamId,
  selected = null,
  color = 0,
  zoom = 1,
  challenge,
  pending,
  editing = false,
  recording = null,
  toastTimer,
  polling = false;
const drafts = new Map();
// ?join=<id>: the QR code shown on the projector. Anyone whose email passes the one-time
// code becomes an editor of that workshop.
const joinId = new URL(location.href).searchParams.get('join');
const invitation = new URL(location.href).searchParams.get('workshop') || joinId;
// Steps: 0 ① talk (voice log) / 1 ② mind map / 2 ③ cards and deck / 3 ④ press release /
// 4 ⑤ paper prototypes and voting.
const titles = [
  'ワイガヤ（音声記録）',
  'もやもやの言語化',
  'カードで議論深耕',
  '模擬プレスの作成',
  'ペーパープロトの作成',
];
const TALK_SEGMENT_MS = 60000;
// ① voice log: the microphone session that keeps running across the tabs.
let talk = null;
const adviceStates = new Map();
let mapDragId = null,
  mapConnectId = null,
  recordingStarting = false,
  inlineEdit = null,
  mapObserver = null,
  sessionEntered = false;
const mapCollapsed = new Map();
const cardSorts = new Map();
let voteUiKey = '';
let pendingAudio = null,
  transcribing = false,
  activeAdviceChat = null;
let mapFit = false,
  mapUndoBusy = false,
  pointerDragging = false,
  generationBusy = false;
const advicePhases = ['ideation', 'ideation', 'selection', 'visualization', 'voting'];
const brand = () =>
  '<div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><div><div class="brand-name">アイディアワークショップ支援ツール</div><div class="brand-sub">SMALL INSIGHTS. NEW POSSIBILITIES.</div></div></div>';
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf || '' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && me) {
      me = null;
      login();
    }
    const error = Error(data.error || '処理に失敗しました');
    error.status = response.status;
    throw error;
  }
  return data;
}
const guarded = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    toast(err.message, true);
  }
};
function openDialog(content) {
  modal.classList.remove('qr-modal');
  modalContent.innerHTML = content;
  modal.showModal();
}
$('#modal-close').onclick = () => modal.close();
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});
function team() {
  return ws?.teams[teamId];
}
function writable() {
  return (
    ws?.status === '進行中' &&
    !ws.deleted &&
    (!ws.createAttempt || ws.notion) &&
    !ws.notion?.provisioning &&
    ['管理者', '編集者'].includes(ws.role) &&
    ((!ws.notion?.error && !ws.notion?.conflict) || me.admin)
  );
}
function editableTeam() {
  return writable();
}
const disabled = (ok) => (ok ? '' : ' disabled');
function remember() {
  // Only text being typed is kept as a draft; untouched fields must follow the shared data
  // (the ① voice log keeps growing while other tabs are open).
  if (!ws || !team() || !editing) return;
  const values = {};
  $$('[data-draft]').forEach((el) => (values[el.dataset.draft] = el.value));
  drafts.set(`${ws.id}/${teamId}/${tab}`, values);
}
function restore() {
  const values = drafts.get(`${ws?.id}/${teamId}/${tab}`);
  if (values)
    $$('[data-draft]').forEach((el) => {
      if (values[el.dataset.draft] !== undefined) el.value = values[el.dataset.draft];
    });
}
function clearDraft() {
  drafts.delete(`${ws.id}/${teamId}/${tab}`);
  editing = false;
}
async function action(action, payload) {
  const activeWs = ws.id,
    activeTeam = teamId;
  const result = await api(`/api/workshops/${ws.id}/action`, {
    action,
    payload,
    revision: ws.revision,
    requestId: crypto.randomUUID(),
  });
  if (ws?.id !== activeWs || teamId !== activeTeam) return result;
  ws = result;
  pending = null;
  clearDraft();
  if (action === 'vote' && tab === 1 && !inlineEdit) {
    refreshVotingUI();
    updateClocks();
  } else render();
  scheduleAdvice(
    {
      node: payload.id ? 'card_updated' : 'card_created',
      reparent: 'card_moved',
      reorderTopic: 'card_moved',
      standalone: 'card_moved',
      deleteNode: 'card_deleted',
      deck: 'card_shortlisted',
      discussion: 'visualization_updated',
    }[action] || 'timer_tick',
  );
  return result;
}
async function loadWorkshop(id) {
  remember();
  ws = await api(`/api/workshops/${id}`);
  // Everyone may work in any team; the team last opened in this browser tab comes back.
  let lastTeam = null;
  try {
    lastTeam = sessionStorage.getItem('workshop-team:' + ws.id);
  } catch {}
  teamId = ws.teams[lastTeam]
    ? lastTeam
    : ws.myTeam && ws.teams[ws.myTeam]
      ? ws.myTeam
      : Object.keys(ws.teams)[0];
  selected = null;
  pending = null;
  editing = false;
  try {
    sessionStorage.setItem('workshop-current', ws.id);
  } catch {}
  render();
}
// The screen to project: participants read the QR code, enter their email and the code.
async function showJoinQR() {
  const q = await api(`/api/workshops/${ws.id}/qr-data`);
  openDialog(
    `<section class="qr-screen"><h2>QRコード を読み込んで下さい。</h2><div class="qr-row"><div class="qr-text"><p class="qr-name">${esc(ws.name)}</p><ol class="qr-steps"><li>スマホやPCでQRコードを読み込む</li><li>メールアドレスを入力する</li><li>メールに届いた6桁の認証コードを入力する</li></ol><p class="qr-url">${esc(q.url)}</p></div><img src="${q.dataUrl}" alt="参加用QRコード"></div></section>`,
  );
  modal.classList.add('qr-modal');
}
// Back to #3, the workshop list.
function closeWorkshop() {
  remember();
  closeAdviceChat();
  stopTalk();
  stopRecording();
  ws = null;
  try {
    sessionStorage.removeItem('workshop-current');
  } catch {}
  render();
}
async function enter() {
  sessionEntered = true;
  me = await api('/api/me');
  workshops = await api('/api/workshops');
  let last = null;
  try {
    last = sessionStorage.getItem('workshop-current');
  } catch {}
  // A login shows the workshop list (#3). An invitation link, or a reload of this browser
  // tab, opens its workshop directly.
  const target =
    workshops.find((w) => w.id === invitation) || workshops.find((w) => w.id === last);
  if (target) await loadWorkshop(target.id);
  else {
    ws = null;
    render();
  }
}
// #2: the login card (email and one-time code only) on top of the opening picture.
function login() {
  app.dataset.view = 'login';
  sessionEntered = false;
  stopTalk();
  closeAdviceChat();
  ws = null;
  app.innerHTML = `<main class="opening"><section class="login-form opening-card"><span class="eyebrow">LET’S GET STARTED</span><h2>ワークショップへようこそ</h2><p class="muted">${joinId ? 'メールアドレスを入力すると、6桁の認証コードが届きます。コードを入力すると参加できます。' : invitation ? '招待されたワークショップの登録メールで参加してください。' : '登録済みのメールアドレスでログインしてください。'}</p><form id="login-form"><label for="email">メールアドレス</label><input id="email" type="email" autocomplete="username" placeholder="name@example.com" required maxlength="254"><div id="otp-field" hidden><label for="otp">メールに届いた6桁の認証コード</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></div><div id="login-error" class="error" role="alert"></div><button class="primary" id="login-submit">認証コードを送信</button></form><div id="demo-area"></div>${buildLabel()}<p class="login-foot">${joinId ? '認証後24時間は、同じブラウザーなら認証コードなしで入れます。' : '認証後24時間は、同じメールアドレスなら認証コードなしで入れます。<br>登録のないメールアドレスは利用できません。参加登録についてはファシリテーターへご連絡ください。'}</p></section></main>`;
  challenge = null;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      if (!challenge) {
        const result = await api(joinId ? '/api/join/start' : '/api/auth/start', {
          email: $('#email').value,
          workshopId: invitation,
        });
        // Within 24 hours of an OTP login on this browser, no new code is needed.
        if (result.trusted) {
          me = { csrf: result.csrf };
          await enter();
          return;
        }
        challenge = result.challenge;
        $('#otp-field').hidden = false;
        $('#email').readOnly = true;
        btn.textContent = '認証して参加';
        $('#otp').required = true;
        $('#otp').focus();
        toast(result.message);
      } else {
        await api(joinId ? '/api/join/verify' : '/api/auth/verify', {
          challenge,
          code: $('#otp').value,
        });
        await enter();
      }
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  api('/api/health')
    .then((h) => {
      if (!$('#login-form')) return;
      if (h.demo) {
        $('#login-form').hidden = true;
        $('.login-form > p.muted').textContent =
          '現在は体験モードです。下の参加ボタンを選んでください。メールアドレスや認証コードは不要です。';
        $('.login-foot').textContent =
          'OTPメールは送信されません。実際のメール認証には、送信元の接続設定が必要です。';
        $('#demo-area').innerHTML =
          '<div class="demo-panel"><strong>体験モードで参加</strong><p class="muted">メールは送信しません。本番認証・Notion・AI送信は無効です。</p><div class="row"><button data-demo="admin">管理者</button><button data-demo="editor">編集者</button><button data-demo="viewer">閲覧者</button></div></div>';
        $$('[data-demo]').forEach(
          (b) =>
            (b.onclick = guarded(async () => {
              await api('/api/demo', { email: `${b.dataset.demo}@example.test` });
              await enter();
            })),
        );
      } else if (!h.auth?.emailOtpReady) {
        $('#login-submit').disabled = true;
        $('#login-error').textContent =
          'OTPメールの送信設定がありません。管理者がメール送信元を設定してからご利用ください。';
      }
    })
    .catch(() => {});
}
// #3: the workshops this account can open, and the create button, on the opening picture.
function workshopList() {
  app.dataset.view = 'list';
  const state = emptyWorkshopCopy();
  app.innerHTML = `<main class="opening"><section class="workshop-list"><header class="list-head"><div><h1>${me.admin ? '新しいワークショップを始める' : 'ワークショップに参加する'}</h1><p class="muted">${esc(me.email)}${me.demo ? '（ローカル体験モード）' : ''}</p></div>${me.admin ? '<button id="new-workshop" class="primary">＋ 作成</button>' : ''}</header><h2>ワークショップを再開する</h2>${
    workshops.length
      ? `<div class="workshop-grid">${workshops
          .map(
            (w) =>
              `<button class="workshop-card${w.deleted ? ' deleted' : ''}" data-open-workshop="${esc(w.id)}" title="${esc(w.name)}"><span class="workshop-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i>${w.deleted ? '' : `<img data-thumb alt="" loading="lazy" src="/api/workshops/${encodeURIComponent(w.id)}/thumb?t=${Math.floor(Date.now() / 60000)}">`}</span><strong>${esc(w.name)}</strong><small>${esc([w.deleted ? '削除済み' : w.status, w.role, w.endDate ? '期限 ' + w.endDate : ''].filter(Boolean).join(' · '))}</small></button>`,
          )
          .join('')}</div>`
      : `<div class="empty"><strong>${state[0]}</strong>${state[1]}<br>一覧と権限は自動で再確認します。</div>`
  }${buildLabel()}</section></main>`;
  if ($('#new-workshop')) $('#new-workshop').onclick = newWorkshopDialog;
  // No picture yet (empty workshop, or one that may not be opened): the placeholder shows.
  $$('[data-thumb]').forEach((img) => img.addEventListener('error', () => img.remove()));
  $$('[data-open-workshop]').forEach(
    (b) => (b.onclick = guarded(() => loadWorkshop(b.dataset.openWorkshop))),
  );
}
function render() {
  if (!me) {
    login();
    return;
  }
  if (!ws) {
    workshopList();
    return;
  }
  const t = team();
  app.dataset.view = 'workspace';
  app.innerHTML = `<header class="topbar">${brand()}${ws ? `<nav class="tabbar tab-tone-${tab ? tab - 1 : 'w'}" aria-label="ワークショップのステップ" role="tablist">${titles.map((s, i) => `<button class="tab ${i === tab ? 'active' : ''}" data-tab="${i}" role="tab" aria-selected="${i === tab}" aria-controls="step-content"><span class="step">${['①', '②', '③', '④', '⑤'][i]}</span><span class="tab-name">${esc(s).replace('（', '<span class="tab-detail">（').replace('）', '）</span>')}</span>${i === 0 ? `<i class="rec-dot" title="録音中"${talk ? '' : ' hidden'}></i>` : ''}</button>`).join('')}</nav>` : ''}<div class="workspace-identity"><span class="identity">${esc(me.email)}</span>${creditLabel()}${buildLabel()}${me.admin ? `<button id="settings" class="icon" aria-label="管理者設定">${gearIcon()}</button>` : ''}</div></header>${me.demo ? '<div class="warning">ローカル体験モード — 体験用データを別フォルダーに保存しています。本番認証・Notion・AI送信は無効です。</div>' : ''}<div class="shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}"><aside class="sidebar"><div class="sidebar-tools"><button id="to-list" class="toolbar-icon" title="ワークショップ一覧へ戻る" aria-label="ワークショップ一覧へ戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg></button><button id="toggle-sidebar" class="sidebar-toggle" aria-label="${sidebarCollapsed ? 'メニューを展開' : 'メニューを折りたたむ'}" aria-expanded="${!sidebarCollapsed}" title="${sidebarCollapsed ? 'メニューを展開' : 'メニューを折りたたむ'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h16v16H4zM9 4v16m6-12-3 4 3 4"/></svg></button></div><div class="workspace-tag" title="${esc(ws.theme || ws.name)}">${esc(ws.name)}</div>${me.admin && !me.demo ? '<button id="show-qr" class="text-button to-list">▦ 参加用QRコードを表示</button>' : ''}<div class="sidebar-teams"><label>TEAMS</label><div class="team-switch">${
    Object.values(ws?.teams || {})
      .map(
        (t, i) =>
          `<button data-team="${esc(t.id)}" title="${esc(t.name)}" class="${t.id === teamId ? 'active' : ''}"><span><i class="team-dot"></i>${esc(t.name)}</span></button>`,
      )
      .join('') || '<p class="muted">チーム設定をお待ちください</p>'
  }</div></div><div class="sidebar-foot"><button id="save-log" class="save-log" title="入力中の内容を保存し、記録に書き込みます"${disabled(writable() && !!t)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7"/></svg><span>ログ保存</span></button><span class="connection">● ${connectionLabel()}</span></div></aside><main class="main" data-step="${tab ? tab - 1 : 'w'}">${ws ? `${!writable() ? '<div class="notice meta-badges">閲覧モードです。進行中のワークショップで編集権限があるときに操作できます。</div>' : ''}${ws.notion?.error ? `<div class="warning meta-badges">${esc(ws.notion.error)}</div>` : ''}${ws.notion?.conflict ? '<div class="warning meta-badges">Notionとの更新競合があります。管理者設定から解決してください。</div>' : ''}${teamNotice()}${ws.notion?.provisioning ? '<div class="notice">Notionのワークショップテンプレートを準備しています。完了すると自動でマップを表示します。</div>' : ''}${ws.creationError ? `<div class="warning">${esc(ws.creationError)}</div>` : ''}<div id="sync-banner"></div><section id="step-content" role="tabpanel">${t || tab === 4 ? stepContent() : '<div class="empty"><strong>チームの設定をお待ちください</strong>管理者設定からグループを作成・割当できます。</div>'}</section>${t ? adviceView() : ''}` : ''}</main></div>`;
  $('#toggle-sidebar').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    sidebarCollapsed = !sidebarCollapsed;
    try {
      localStorage.setItem('workshop-sidebar-collapsed', String(sidebarCollapsed));
    } catch {}
    render();
    requestAnimationFrame(() => {
      if (mapFit) fitMap();
      else updateMapStage();
    });
  });
  if (me.admin) $('#settings').onclick = guarded(settings);
  if ($('#show-qr')) $('#show-qr').onclick = guarded(showJoinQR);
  // ログ保存: what is being typed on this step is saved and written to the record.
  $('#save-log').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    const typed =
      tab === 0 && $('#transcript')
        ? { transcript: $('#transcript').value }
        : tab === 3 && $('#discussion-form')
          ? discussionValues()
          : {};
    await action('discussion', { teamId, ...typed, snapshot: true });
    toast(ws.notion ? 'ログを保存しました。Notionの記録にも書き込みます' : 'ログを保存しました');
  });
  $('#to-list').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    if (talk && !confirm('録音を停止して、ワークショップ一覧に戻りますか？')) return;
    closeWorkshop();
  });
  $$('[data-team]').forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        if (inlineEdit && !(await commitInline())) return;
        if (talk && b.dataset.team !== teamId && !confirm('録音を停止して、チームを切り替えますか？'))
          return;
        remember();
        if (b.dataset.team !== teamId) stopTalk();
        stopRecording();
        mapConnectId = null;
        teamId = b.dataset.team;
        try {
          sessionStorage.setItem('workshop-team:' + ws.id, teamId);
        } catch {}
        selected = null;
        editing = false;
        render();
      })),
  );
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        if (inlineEdit && !(await commitInline())) return;
        remember();
        stopRecording();
        mapConnectId = null;
        tab = Number(b.dataset.tab);
        editing = false;
        render();
      })),
  );
  if (t || tab === 4) {
    bindStep();
    restore();
    $$('[data-draft]').forEach((el) =>
      el.addEventListener('input', () => {
        editing = true;
        remember();
      }),
    );
  }
  bindAdvice();
  scheduleAdvice('phase_entered');
  bindContentStatus();
  showPending();
  updateClocks();
}
function contentStatus() {
  if (!ws?.notion) return '';
  const s = ws.documentSync || {},
    problem = s.error || s.readError,
    time = (ms) => new Date(ms).toLocaleTimeString('ja-JP'),
    label = s.error
      ? s.retryable && s.retryAt
        ? `Notionに一時的に接続できません。${time(s.retryAt)}ごろ自動で再送します（編集は続けられます）`
        : 'Notionへの記録に失敗しました：' + esc(s.error)
      : s.readError
        ? 'Notionの履歴を読み込めません：' + esc(s.readError)
        : s.syncing
          ? '● Notionの「ワークショップの記録」へ書き込み中・編集は続けられます'
          : s.queued
            ? '● Notionへの記録待ち'
            : s.at
              ? `● 最終記録 ${time(s.at)}（変わった部分だけをNotionの「ワークショップの記録」に上書きします）`
              : '● 内容が変わると、Notionの「ワークショップの記録」に上書きします';
  return `<div class="content-status ${problem ? 'content-warning' : ''}" role="status"><span>${label} </span><a href="https://www.notion.so/${ws.notion.pageId.replaceAll('-', '')}" target="_blank" rel="noopener">記録を開く ↗</a>${problem ? '<button id="retry-content-sync">同期を再試行</button>' : ''}</div>`;
}
let mapActivityTimer,
  lastMapActivitySent = 0;
function noteMapActivity() {
  if (!ws?.notion || !ws.documentSync?.queued || !editableTeam()) return;
  clearTimeout(mapActivityTimer);
  const activeWs = ws.id,
    activeTeam = teamId;
  mapActivityTimer = setTimeout(
    async () => {
      if (
        ws?.id !== activeWs ||
        teamId !== activeTeam ||
        !ws.documentSync?.queued ||
        !editableTeam()
      )
        return;
      lastMapActivitySent = Date.now();
      try {
        await api(`/api/workshops/${activeWs}/content-activity`, { teamId: activeTeam });
      } catch (e) {
        if (e.status === 409) noteMapActivity();
      }
    },
    Math.max(0, 1000 - (Date.now() - lastMapActivitySent)),
  );
}
for (const event of ['input', 'keydown', 'pointerdown', 'dragstart', 'dragover', 'drop', 'dragend'])
  app.addEventListener(
    event,
    (e) => {
      if (e.target.closest('.map-panel')) noteMapActivity();
    },
    true,
  );
function bindContentStatus() {
  if ($('#retry-content-sync'))
    $('#retry-content-sync').onclick = guarded(async () => {
      ws = await api(`/api/workshops/${ws.id}/content-sync`, {});
      render();
    });
  if ($('#reload-content-sync'))
    $('#reload-content-sync').onclick = guarded(async () => {
      if (
        ws.documentSync?.pending &&
        !confirm('未同期内容をバックアップし、Notionの内容を採用しますか？')
      )
        return;
      ws = await api(`/api/workshops/${ws.id}/content-sync`, { reload: true });
      render();
    });
}
function emptyWorkshopCopy() {
  const state = me.notion.state || (me.notion.enabled ? 'pending' : 'unconfigured');
  return me.demo
    ? ['ワークショップを作成しましょう', '現在はローカル体験モードです。']
    : state === 'unconfigured'
      ? [
          'Notion連携が未設定です',
          'ワークショップ一覧と参加者の権限を、まだ読み込めていません。管理者によるNotion接続設定が必要です。',
        ]
      : state === 'pending'
        ? [
            'Notionと同期しています',
            'ワークショップ一覧と参加者の権限を確認しています。接続後は自動で表示を更新します。',
          ]
        : ['error', 'stale'].includes(state)
          ? [
              'Notionの接続を確認してください',
              '一覧と権限を再確認できません。接続設定・ページの共有権限・同期結果を管理者に確認してください。',
            ]
          : [
              '表示可能なワークショップがありません',
              '参加登録・ワークショップの状態・期限を管理者に確認してください。',
            ];
}
function connectionLabel() {
  if (me.demo) return 'ローカル体験モード';
  return (
    {
      unconfigured: 'Notion未接続',
      pending: 'Notion同期待ち',
      error: 'Notion同期エラー',
      stale: 'Notion再確認待ち',
      ready: 'Notion連携中',
    }[me.notion.state] || (me.notion.enabled ? 'Notion連携あり' : 'Notion未接続')
  );
}
function stepContent() {
  if (tab === 0) return talkView();
  if (tab === 1) return mapView();
  if (tab === 2) return cardDeckView();
  if (tab === 3) return pressView();
  return ideaView();
}
function mapNodes() {
  const nodes = [...team().nodes];
  if (inlineEdit?.isNew && inlineEdit.wsId === ws.id && inlineEdit.teamId === teamId) {
    const draft = {
      id: inlineEdit.id,
      text: inlineEdit.text,
      parent: inlineEdit.parent,
      group: inlineEdit.group,
    };
    const anchor = nodes.findIndex((n) => n.id === inlineEdit.anchorId);
    if (anchor < 0) nodes.push(draft);
    else {
      const descendants = new Set([inlineEdit.anchorId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes)
          if (descendants.has(n.parent) && !descendants.has(n.id)) {
            descendants.add(n.id);
            changed = true;
          }
      }
      let at = anchor;
      nodes.forEach((n, i) => {
        if (descendants.has(n.id)) at = i;
      });
      nodes.splice(at + 1, 0, draft);
    }
  }
  return nodes;
}
function collapsedTopics() {
  const key = adviceKey();
  if (!mapCollapsed.has(key)) mapCollapsed.set(key, new Set());
  return mapCollapsed.get(key);
}
function descendantCount(id, nodes = team().nodes) {
  if (id === 'theme') return nodes.length;
  const visited = new Set();
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const n of nodes)
      if (frontier.includes(n.parent) && !visited.has(n.id)) {
        visited.add(n.id);
        next.push(n.id);
      }
    frontier = next;
  }
  return visited.size;
}
function mapView() {
  const t = team(),
    nodes = mapNodes(),
    closed = collapsedTopics(),
    canEdit = editableTeam();
  const topic = (n, depth) => {
    const edit = inlineEdit?.id === n.id;
    return `<div class="topic-box depth-${Math.min(4, depth)}"><${edit ? 'input' : 'button'} class="node ${selected === n.id ? 'selected' : ''} ${edit ? 'topic-editor' : ''}" ${edit ? `id="topic-editor" value="${esc(inlineEdit.text)}" maxlength="500" aria-label="トピックを編集"` : `data-node="${n.id}" data-map-target="${n.id}" draggable="${canEdit}" title="ダブルクリックで編集。Enterで同じ階層、Insertで子トピック"`} data-depth="${depth}" data-topic-id="${n.id}">${edit ? '' : `<span><i class="node-group g${n.group || 0}" aria-hidden="true"></i>${esc(n.text)}</span></button>`}${edit ? '' : nodes.some((c) => c.parent === n.id) ? `<button class="topic-toggle" data-collapse="${n.id}" aria-label="${esc(n.text)}を${closed.has(n.id) ? '展開' : '折り畳む'}" aria-expanded="${!closed.has(n.id)}">${closed.has(n.id) ? descendantCount(n.id, nodes) : '−'}</button>` : ''}${edit ? '' : `<span class="topic-votes" data-topic-votes="${n.id}">${topicVoteContents(n)}</span>`}</div>`;
  };
  const branch = (parent, depth = 1) => {
    if (depth > 500) return '';
    const children = nodes.filter((n) =>
      parent === 'theme' ? n.parent === parent || n.parent === null : n.parent === parent,
    );
    if (!children.length) return '';
    return `<ul class="branches">${children.map((n) => `<li class="tree-item">${topic(n, depth)}${closed.has(n.id) ? '' : branch(n.id, depth + 1)}</li>`).join('')}</ul>`;
  };
  const rootEdit = inlineEdit?.id === 'theme';
  return `<div class="map-layout"><div class="panel map-panel"><div class="panel-title"><h3>気づきのマインドマップ <span class="muted">${esc(t.name)} · ${t.nodes.length} 項目</span></h3><div class="board-actions"><span class="map-tools-off" hidden>${compactVoting()}<button id="move-topic-up" class="toolbar-icon" title="上へ移動" aria-label="トピックを上へ移動"${disabled(canEdit && !!selected && selected !== 'theme')}>↑</button><button id="move-topic-down" class="toolbar-icon" title="下へ移動" aria-label="トピックを下へ移動"${disabled(canEdit && !!selected && selected !== 'theme')}>↓</button><button id="new-topic" class="text-button"${disabled(canEdit)}>＋ トピック</button><button id="undo-map" class="text-button" title="マップ操作を取り消す（Ctrl＋Z・最大20操作）"${disabled(canEdit && !mapUndoBusy)}>↶ 元に戻す</button><button id="copy-outline" class="text-button" title="選択した枝をコピー（Ctrl＋C）">コピー</button><button id="paste-outline" class="text-button" title="階層を保って貼り付け（Ctrl＋V）"${disabled(canEdit)}>貼り付け</button><button id="map-record" class="toolbar-icon ${recording?.destination === 'map' ? 'is-recording' : ''}" aria-label="${recording?.destination === 'map' ? '音声入力を停止' : 'マイクで音声入力'}" title="音声入力"${disabled(canEdit)}>${micIcon()}</button><button id="topic-actions" class="toolbar-icon" aria-label="トピックの操作" title="選択中のトピックを操作"${disabled(canEdit && !!selected)}>⋯</button></span><button id="tb-add-sibling" class="toolbar-icon" aria-label="同階層を追加（Enter）" title="同階層を追加（Enter）"${disabled(canEdit && !!selected && selected !== 'theme')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="8" height="6" rx="1.5"/><path d="M11 12h4M15 7v10M15 7h5M15 17h5"/></svg></button><button id="tb-add-child" class="toolbar-icon" aria-label="子を追加（Insert）" title="子を追加（Insert）"${disabled(canEdit && !!selected)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="9" width="7" height="6" rx="1.5"/><path d="M9 12h4M13 6v12M13 6h3M13 18h3M19 4v4M17 6h4"/></svg></button><button id="collapse-all" class="toolbar-icon" aria-label="全て折り畳む" title="全て折り畳む"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg></button><button id="expand-all" class="toolbar-icon" aria-label="全て展開" title="全て展開"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9l5-5 5 5M7 15l5 5 5-5"/></svg></button><button id="zoom-out" class="toolbar-icon" aria-label="縮小" title="縮小"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M21 21l-5-5M8 11h6"/></svg></button><span id="zoom-label">${Math.round(zoom * 100)}%</span><button id="fit-map" class="toolbar-icon" aria-label="画面サイズに合わせて全トピックを表示" title="画面サイズに合わせる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 7h10v10H7z"/></svg></button><button id="zoom-in" class="toolbar-icon" aria-label="拡大" title="拡大"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M21 21l-5-5M8 11h6M11 8v6"/></svg></button></div></div>
  <div class="vote-bar" data-vote-bar>${timerView('cards', true)}</div>
  <div class="map-scroll" data-map-zone="detach"><div class="map-stage" id="map-stage"><div class="mindmap" id="mindmap"><svg id="map-links" class="map-links" aria-hidden="true"></svg><div class="connected-map"><div class="topic-box central-topic">${rootEdit ? `<input id="topic-editor" class="map-root topic-editor" value="${esc(inlineEdit.text)}" maxlength="500" aria-label="中心トピックを編集">` : `<button class="map-root ${selected === 'theme' ? 'selected' : ''}" data-map-target="theme" title="ダブルクリックで中心トピックを編集">${esc(t.rootText || ws.theme)}</button>`}${nodes.some((n) => n.parent === 'theme' || n.parent === null) ? `<button class="topic-toggle" data-collapse="theme" aria-label="中心トピックを${closed.has('theme') ? '展開' : '折り畳む'}" aria-expanded="${!closed.has('theme')}">${closed.has('theme') ? descendantCount('theme', nodes) : '−'}</button>` : ''}</div>${closed.has('theme') ? '' : branch('theme')}</div></div></div></div><div class="map-help" role="status">${mapConnectId ? '接続先をクリックしてください' : 'ダブルクリック：編集 · Enter：同階層 · Insert：子 · Delete：枝ごと削除 · Ctrl＋Z：取り消し · ドラッグ：移動 · 右クリック／長押し：メニュー'}</div></div></div>`;
}
function topicActionsDialog() {
  if (!editableTeam() || !selected) return;
  const node = team().nodes.find((n) => n.id === selected),
    root = selected === 'theme';
  if (!node && !root) return;
  openDialog(
    `<h2>トピックの操作</h2><p>${esc(root ? team().rootText || ws.theme : node.text)}</p><div class="topic-menu"><button id="edit-topic">文字を編集（F2）</button><button id="add-sibling">同階層を追加（Enter）</button><button id="add-child-topic">子を追加（Insert）</button>${root ? '' : `<button id="connect-node">接続先を選ぶ</button><button id="detach-node">枝ごと切り離す</button><button id="delete-node" class="danger">削除（Delete）</button><div class="colors">${Array.from({ length: 8 }, (_, i) => `<button class="color g${i}" data-topic-color="${i}" aria-label="色グループ${i + 1}" aria-pressed="${node.group === i}"></button>`).join('')}</div>`}</div>`,
  );
  $('#edit-topic').onclick = () => {
    modal.close();
    beginInline(selected);
  };
  $('#add-sibling').onclick = () => {
    modal.close();
    beginInline(selected, 'sibling');
  };
  $('#add-child-topic').onclick = () => {
    modal.close();
    beginInline(selected, 'child');
  };
  if (!root) {
    $('#connect-node').onclick = () => {
      modal.close();
      mapConnectId = selected;
      render();
    };
    $('#detach-node').onclick = guarded(async () => {
      await moveMapNode(selected, null);
      modal.close();
    });
    $('#delete-node').onclick = () => deleteMapTopic(selected);
    $$('[data-topic-color]').forEach(
      (b) =>
        (b.onclick = guarded(async () => {
          await action('node', {
            teamId,
            id: node.id,
            text: node.text,
            group: Number(b.dataset.topicColor),
          });
          modal.close();
        })),
    );
  }
}
function updateMapStage() {
  const canvas = $('#mindmap'),
    scroll = $('.map-scroll'),
    stage = $('#map-stage');
  if (!canvas || !scroll || !stage) return;
  const width = canvas.offsetWidth,
    height = canvas.offsetHeight,
    availableWidth = Math.max(1, scroll.clientWidth - 24),
    availableHeight = Math.max(1, scroll.clientHeight - 24);
  stage.style.width = `${Math.max(availableWidth, width * zoom)}px`;
  stage.style.height = `${Math.max(availableHeight, height * zoom)}px`;
  canvas.style.left = `${Math.max(0, (availableWidth - width * zoom) / 2)}px`;
  canvas.style.top = `${Math.max(0, (availableHeight - height * zoom) / 2)}px`;
  canvas.style.transform = `scale(${zoom})`;
  $('#zoom-label').textContent =
    `${zoom < 0.1 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%`;
  drawMapLinks();
}
// A resize can feed back into itself (zoom label width → toolbar wrap → map height →
// zoom). Remember recent sizes and ignore a size we just left, which breaks the
// oscillation without missing real resizes.
let mapSizeLog = [];
function onMapResize() {
  const canvas = $('#mindmap'),
    scroll = $('.map-scroll');
  if (!canvas || !scroll) return;
  const key = `${scroll.clientWidth}x${scroll.clientHeight}/${canvas.offsetWidth}x${canvas.offsetHeight}`,
    now = performance.now();
  mapSizeLog = mapSizeLog.filter((e) => now - e.at < 400);
  if (mapSizeLog.at(-1)?.key === key) return;
  if (mapSizeLog.some((e) => e.key === key)) {
    mapSizeLog.push({ key, at: now });
    return;
  }
  mapSizeLog.push({ key, at: now });
  if (mapFit) fitMap();
  else updateMapStage();
}
function fitMap() {
  const canvas = $('#mindmap'),
    scroll = $('.map-scroll');
  if (!canvas || !scroll) return;
  if (canvas.offsetWidth && canvas.offsetHeight)
    zoom = Math.min(
      1,
      Math.max(1, scroll.clientWidth - 24) / canvas.offsetWidth,
      Math.max(1, scroll.clientHeight - 24) / canvas.offsetHeight,
    );
  updateMapStage();
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
}

function drawMapLinks() {
  const canvas = $('#mindmap'),
    svg = $('#map-links');
  if (!canvas || !svg) return;
  const base = canvas.getBoundingClientRect(),
    paths = [];
  const all = mapNodes();
  for (const button of $$('[data-topic-id]')) {
    const n = all.find((x) => x.id === button.dataset.topicId);
    if (!n?.parent) continue;
    const parent = n.parent === 'theme' ? $('.map-root') : $(`[data-topic-id="${n.parent}"]`);
    if (!parent) continue;
    const a = parent.getBoundingClientRect(),
      b = button.getBoundingClientRect();
    const x1 = (a.right - base.left) / zoom,
      y1 = (a.top + a.height / 2 - base.top) / zoom,
      x2 = (b.left - base.left) / zoom,
      y2 = (b.top + b.height / 2 - base.top) / zoom;
    const depth = Number(button.dataset.depth),
      color =
        depth === 1 ? '#181192' : depth === 2 ? '#8f2114' : depth === 3 ? '#f15e51' : '#82786c';
    paths.push(
      `<path d="M${x1},${y1} C${x1 + (x2 - x1) * 0.55},${y1} ${x1 + (x2 - x1) * 0.45},${y2} ${x2},${y2}" stroke="${color}" stroke-width="${depth === 1 ? 3.2 : 1.2}" fill="none"/>`,
    );
  }
  svg.setAttribute('width', String(canvas.offsetWidth));
  svg.setAttribute('height', String(canvas.offsetHeight));
  svg.innerHTML = paths.join('');
}

function micIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
}
function robotIcon() {
  return '<svg viewBox="0 0 88 88" width="76" height="76" fill="none" aria-hidden="true"><path d="M44 18V9" stroke="#187c72" stroke-width="4"/><circle cx="44" cy="7" r="5" fill="#e8b852"/><rect x="14" y="20" width="60" height="48" rx="18" fill="#d9f0eb" stroke="#247d75" stroke-width="3"/><rect x="23" y="30" width="42" height="25" rx="10" fill="#fff"/><circle cx="34" cy="41" r="4" fill="#226259"/><circle cx="54" cy="41" r="4" fill="#226259"/><path d="M36 51q8 7 16 0" stroke="#226259" stroke-width="3" stroke-linecap="round"/><path d="M7 35v16M81 35v16M31 73l-3 8M57 73l3 8" stroke="#247d75" stroke-width="5" stroke-linecap="round"/><circle cx="21" cy="53" r="4" fill="#f2b2a0"/><circle cx="67" cy="53" r="4" fill="#f2b2a0"/></svg>';
}
function adviceKey() {
  return `${ws.id}/${teamId}`;
}
const characterNames = { kashi: 'かっしー', leafy: 'リーフィー' };
const characterLabels = { kashi: 'かっしー（男の子）', leafy: 'リーフィー（女の子）' };
// The one character shown for this workshop (set in 表示の設定).
const currentCharacter = () => (ws?.character === 'leafy' ? 'leafy' : 'kashi');
function characterAvatar(character, state = 'idle', small = false) {
  const pose =
    state === 'thinking'
      ? 'thinking'
      : state === 'speaking'
        ? 'speaking'
        : state === 'insight'
          ? 'insight'
          : 'idle';
  return `<span class="mascot-avatar mascot-${pose} ${small ? 'mascot-small' : ''}"><img src="/characters/${character}-${pose}.png" alt="${characterNames[character]}" width="100" height="100"></span>`;
}
function adviceScreen() {
  const selector = tab === 1 ? '[data-node]' : '[data-card]';
  return {
    visibleTopicIds:
      tab === 4 || tab === 0
        ? undefined
        : [
            ...new Set(
              $$(selector, $('#step-content')).map((e) => e.dataset.node || e.dataset.card),
            ),
          ],
    selectedTopicId: selected,
    ...(tab === 3 ? { discussion: discussionValues() } : {}),
    ...(inlineEdit
      ? { topicDraft: { id: inlineEdit.id, text: inlineEdit.text, isNew: inlineEdit.isNew } }
      : {}),
  };
}
// One-click requests in the assistant chat, per tab. The intent id tells the
// server what shape of answer to ask Genspark for.
const quickPrompts = {
  ideation: [
    [
      'group',
      'グループ分けして',
      '表示中のトピックを意味の近さでグループ分けして、グループ名と理由を教えて。',
    ],
    ['gaps', '足りない視点は？', 'いまのトピックに足りない視点を3つ、問いの形で教えて。'],
    ['deepen', '選んだ枝を深掘り', '選択中のトピックを深掘りする子トピックの案を出して。'],
  ],
  selection: [
    [
      'deck',
      'デッキ候補を選んで',
      '票と内容から、組み合わせると新しさが出るカードを最大5枚選んで、その狙いを教えて。',
    ],
    [
      'pattern',
      '票の傾向は？',
      '票が集まったカードの共通点と、そこから見える企画の方向性を教えて。',
    ],
  ],
  visualization: [
    [
      'headline',
      '一言で言うと×3案',
      '議論の内容を踏まえて、一言で言うと何なのか、切り口の違う案を3つ考えて。',
    ],
    ['www', 'Who/What/How整理', '議論の内容から Who・What・How を整理して。'],
    ['features', '３つの特長の案', 'この企画の３つの特長を、重ならない切り口で提案して。'],
    ['critique', '弱点と改善案', 'この企画の弱点やリスクと、その改善案を教えて。'],
  ],
  voting: [
    ['compare', '案を比較して', '各チームの案の強み・弱みを比較して、投票の観点を3つ提案して。'],
  ],
};
const optionLabels = {
  headline: '一言で言うと',
  who: 'Who',
  what: 'What',
  how: 'How',
  feature1: '特長１',
  feature2: '特長２',
  feature3: '特長３',
  keywords: 'キーワード',
  topic: 'トピック追加',
};
async function adoptOption(option) {
  if (option.field === 'topic')
    return action('createTopic', {
      teamId,
      anchorId:
        selected && (selected === 'theme' || team().nodes.some((n) => n.id === selected))
          ? selected
          : 'theme',
      placement: 'child',
      text: option.value,
    });
  const d = team().discussion;
  if (option.field.startsWith('feature')) {
    const features = [...(d.features || ['', '', ''])];
    while (features.length < 3) features.push('');
    features[Number(option.field.slice(-1)) - 1] = option.value;
    return action('discussion', { teamId, features });
  }
  return action('discussion', { teamId, [option.field]: option.value });
}
function chatActions(m, index) {
  if (m.role !== 'assistant') return '';
  const canEdit = !!(ws && editableTeam() && ws.id === activeAdviceChat?.context.wsId);
  const options = (m.options || [])
    .map(
      (o, i) =>
        `<li>${o.field === 'topic' ? '' : `<span class="option-field">${esc(optionLabels[o.field] || o.field)}</span>`}<span class="option-value">${esc(o.value)}</span><button type="button" class="option-add" data-adopt="${index}:${i}" title="${o.adopted ? '反映済み' : o.field === 'topic' ? 'マップに追加' : '④に反映'}" aria-label="${esc(o.value)}を${o.field === 'topic' ? 'マップに追加' : '④に反映'}"${disabled(canEdit && !o.adopted)}>${o.adopted ? '✓' : '＋'}</button>${o.reason ? `<small>${esc(o.reason)}</small>` : ''}</li>`,
    )
    .join('');
  const groups = m.groups?.length
    ? `<div class="chat-groups"><strong>グループ案</strong> ${m.groups.map((g) => esc(g.name) + '（' + g.nodeIds.length + '）').join(' / ')} ${m.proposal ? `<button type="button" class="chip" data-apply-groups="${index}"${disabled(canEdit)}>マップの色に適用</button>` : m.groupsApplied ? '<span class="pill">適用済み</span>' : ''}</div>`
    : '';
  return (options ? `<ul class="chat-options">${options}</ul>` : '') + groups;
}
// ---- AI chat: a pane on the right that stays open while the team works ----------------
// The pane lives outside #app, so the regular redraws of the workspace do not touch what is
// being typed in it.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const chats = new Map();
let chatOpen = false,
  chatVoiceSession = null;
const chatPane = document.createElement('aside');
chatPane.id = 'chat-pane';
chatPane.hidden = true;
chatPane.setAttribute('aria-label', 'AIチャット');
document.body.append(chatPane);
const chatContext = () => ({
  wsId: ws.id,
  teamId,
  phase: advicePhases[tab],
  stage: titles[tab],
  team: team().name,
});
const refitMap = () =>
  requestAnimationFrame(() => {
    if (tab === 1 && ws && $('#mindmap')) mapFit ? fitMap() : updateMapStage();
  });
function openAdviceChat() {
  if (!ws || !team()) return;
  const key = adviceKey();
  if (!chats.has(key)) chats.set(key, { messages: [], draft: '', character: currentCharacter() });
  const chat = chats.get(key);
  chat.character = currentCharacter();
  chat.context = chatContext();
  chat.screen = adviceScreen();
  chatOpen = true;
  document.body.classList.add('chat-open');
  chatPane.hidden = false;
  $('.chat-toggle')?.setAttribute('hidden', '');
  renderAdviceChat(chat);
  refitMap();
}
function closeAdviceChat() {
  stopChatVoice();
  chatOpen = false;
  activeAdviceChat = null;
  document.body.classList.remove('chat-open');
  chatPane.hidden = true;
  chatPane.innerHTML = '';
  $('.chat-toggle')?.removeAttribute('hidden');
  refitMap();
}
// After a redraw of the workspace: follow the step (and team) the user moved to.
function syncAdviceChat() {
  if (!chatOpen) return;
  if (!ws || !team()) return closeAdviceChat();
  const chat = activeAdviceChat;
  if (!chat || chat !== chats.get(adviceKey())) return openAdviceChat();
  if (chat.context.phase !== advicePhases[tab] || chat.context.stage !== titles[tab]) {
    chat.context = chatContext();
    renderAdviceChat(chat, false);
  }
}
function renderAdviceChat(chat, focus = true) {
  activeAdviceChat = chat;
  const busy = !!chat.busy,
    name = characterNames[chat.character],
    listening = !!chatVoiceSession;
  chatPane.innerHTML = `<section class="character-chat"><div class="chat-heading"><div class="character-picker">${characterAvatar(chat.character, busy ? 'thinking' : 'speaking', true)}<div><span class="eyebrow">${name}</span><h2>AIチャット</h2></div></div><button id="chat-close" class="icon" aria-label="AIチャットを閉じる">×</button></div>
    <p class="chat-context">${esc(chat.context.stage)} · ${esc(chat.context.team)}${aiAvailable('questions') ? '' : ' · Genspark 未接続'}</p>
    <div id="chat-log" class="chat-log" role="log" aria-live="polite">${chat.messages.length ? chat.messages.map((m, i) => `<article class="chat-message chat-${m.role}">${m.role === 'assistant' ? characterAvatar(m.character || 'kashi', 'insight', true) : ''}<div><small>${m.role === 'user' ? 'あなた' : characterNames[m.character || 'kashi']}</small><p>${esc(m.text)}</p>${chatActions(m, i)}</div></article>`).join('') : `<p class="chat-welcome">気になっていることや、いっしょに考えたいことを教えてね。いま開いている画面と①の音声ログを見ながら答えるよ。</p>`}${busy ? `<p class="chat-thinking" role="status">${name}が考えています<span aria-hidden="true">…</span></p>` : ''}</div>
    <p id="chat-error" class="error" role="alert">${esc(chat.error || '')}</p>
    <div class="quick-prompts" role="group" aria-label="よく使う相談">${(quickPrompts[chat.context.phase] || []).map(([id, label]) => `<button type="button" class="chip" data-quick="${id}"${disabled(!busy)}>${esc(label)}</button>`).join('')}</div>
    <form id="advice-chat-form"><label class="sr-only" for="advice-question">相談したいこと</label><textarea id="advice-question" maxlength="2000" rows="3" placeholder="相談したいことを入力（Ctrl＋Enterで送信）。マイクで話しても入力できます"${disabled(!busy)}>${esc(chat.draft)}</textarea><div class="row between"><button type="button" id="chat-voice" class="${listening ? 'is-recording' : ''}" aria-pressed="${listening}"${disabled(!busy)}>${micIcon()} ${listening ? '入力を終える' : '声で入力'}</button><button class="primary"${disabled(!busy)}>${busy ? '考え中…' : '送信 ↗'}</button></div></form></section>`;
  $('#chat-close').onclick = closeAdviceChat;
  $('#advice-question').oninput = (e) => (chat.draft = e.target.value);
  $('#advice-question').onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('#advice-chat-form').requestSubmit();
    }
  };
  $('#chat-voice').onclick = guarded(() => chatVoice(chat));
  $$('[data-quick]', chatPane).forEach(
    (b) =>
      (b.onclick = () => {
        const found = (quickPrompts[chat.context.phase] || []).find(
          ([id]) => id === b.dataset.quick,
        );
        if (!found || chat.busy) return;
        chat.intent = found[0];
        chat.draft = found[2];
        $('#advice-chat-form').requestSubmit();
      }),
  );
  $$('[data-adopt]', chatPane).forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        const [index, option] = b.dataset.adopt.split(':').map(Number);
        const picked = chat.messages[index]?.options?.[option];
        if (!picked) return;
        await adoptOption(picked);
        picked.adopted = true;
        toast(`「${optionLabels[picked.field]}」に反映しました`);
        renderAdviceChat(chat, false);
      })),
  );
  $$('[data-apply-groups]', chatPane).forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        const m = chat.messages[Number(b.dataset.applyGroups)];
        if (!m?.proposal) return;
        ws = await api(`/api/workshops/${ws.id}/apply`, { proposal: m.proposal });
        m.proposal = null;
        m.groupsApplied = true;
        render();
        toast('グループ分けをマップの色に適用しました（Ctrl+Zで戻せます）');
        renderAdviceChat(chat, false);
      })),
  );
  $('#advice-chat-form').onsubmit = guarded(async (e) => {
    e.preventDefault();
    if (chat.busy) return;
    stopChatVoice();
    const question = chat.draft.trim();
    if (!question) return $('#advice-question').focus();
    const intent = chat.intent || undefined;
    chat.intent = null;
    // Re-read the board so the answer uses the step and the screen shown right now.
    if (ws?.id === chat.context.wsId && teamId === chat.context.teamId) {
      chat.context = chatContext();
      chat.screen = adviceScreen();
    }
    const conversation = chat.messages.slice(-10).map(({ role, text }) => ({ role, text }));
    chat.messages.push({ role: 'user', text: question });
    chat.draft = '';
    chat.busy = true;
    chat.error = '';
    renderAdviceChat(chat, false);
    try {
      const result = await api(`/api/workshops/${chat.context.wsId}/advice`, {
        teamId: chat.context.teamId,
        phase: chat.context.phase,
        event: 'help_requested',
        question,
        ...(intent ? { intent } : {}),
        character: chat.character,
        conversation,
        screen: chat.screen,
        ui: {},
      });
      if (!result.should_speak || result.source !== 'ai')
        throw Error('Gensparkから回答が届きませんでした。接続状態を確認して再送してください。');
      chat.messages.push({
        role: 'assistant',
        text: result.bubble_text,
        character: result.character || chat.character,
        options: result.options || [],
        proposal: result.proposal || null,
        groups: result.suggested_clusters || [],
      });
      chat.messages = chat.messages.slice(-30);
    } catch (err) {
      chat.error = err.message;
      chat.draft = question;
      chat.messages.pop();
    } finally {
      chat.busy = false;
      if (activeAdviceChat === chat && chatOpen) renderAdviceChat(chat);
    }
  });
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
  if (focus && !busy && !listening) $('#advice-question').focus();
}
// Voice input for the chat: the browser's own speech recognition (free, as you speak); where
// the browser has none, a short recording is turned into text by Genspark.
function stopChatVoice() {
  const session = chatVoiceSession;
  if (session) session.stop();
}
async function chatVoice(chat) {
  if (chatVoiceSession) return stopChatVoice();
  const base = chat.draft.trim() ? chat.draft.trim() + ' ' : '';
  const show = () => {
    const el = $('#advice-question');
    if (el && activeAdviceChat === chat) el.value = chat.draft;
  };
  const finish = () => {
    chatVoiceSession = null;
    resumeTalk();
    if (activeAdviceChat === chat && chatOpen) renderAdviceChat(chat);
  };
  if (SpeechRec) {
    const rec = new SpeechRec();
    let finals = '';
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const words = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += words;
        else interim += words;
      }
      chat.draft = base + finals + interim;
      show();
    };
    rec.onerror = (e) => {
      if (!['no-speech', 'aborted'].includes(e.error))
        chat.error = `音声入力を使えませんでした（${e.error}）。マイクの許可を確認してください。`;
    };
    rec.onend = () => {
      chat.draft = (base + finals).trim() || chat.draft;
      finish();
    };
    pauseTalk();
    chatVoiceSession = { stop: () => rec.stop() };
    rec.start();
  } else {
    if (!aiAvailable('transcribe') || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw Error('このブラウザーでは声で入力できません（Chrome／Edgeで使えます）');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }),
      recorder = new MediaRecorder(stream),
      chunks = [],
      origin = chat.context;
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      clearTimeout(limit);
      stream.getTracks().forEach((t) => t.stop());
      try {
        const payload = await recordingPayload(
          new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
        );
        const p = await api(`/api/workshops/${origin.wsId}/ai`, {
          task: 'transcribe',
          teamId: origin.teamId,
          ...payload,
          destination: 'map',
        });
        chat.draft = (base + String(p.result.text || '')).trim();
      } catch (e) {
        chat.error = e.message;
      } finally {
        finish();
      }
    };
    const limit = setTimeout(() => recorder.state === 'recording' && recorder.stop(), 60000);
    chatVoiceSession = { stop: () => recorder.state === 'recording' && recorder.stop() };
    recorder.start();
  }
  renderAdviceChat(chat, false);
}
// The button that opens the chat; the green advice area of earlier versions is gone, which
// leaves the whole height to each step.
function adviceView() {
  if (!team()) return '';
  return `<button id="next-advice" class="chat-toggle" aria-label="AIチャットを開く"${chatOpen ? ' hidden' : ''}${disabled(writable())}>${characterAvatar(currentCharacter(), 'idle', true)}<span>AIチャット</span></button>`;
}
function bindAdvice() {
  if ($('#next-advice')) $('#next-advice').onclick = openAdviceChat;
  syncAdviceChat();
}
// Automatic advice ended with the advice area: the chat answers when asked.
function scheduleAdvice() {}

function sidebarStatus() {
  if (!ws) return '';
  return `<div class="sidebar-meta"><span class="pill">${esc(ws.status)}</span><span>${esc(ws.role)}</span>${ws.endDate ? `<small>期限 ${esc(ws.endDate)}</small>` : ''}</div>`;
}
function teamNotice() {
  return '';
}

function aiAvailable(task) {
  return me.ai.approved.some(
    (p) =>
      p.id === me.ai.provider && p.ready && p.approvalReference && p.capabilities?.includes(task),
  );
}
function aiStatus(task) {
  return aiAvailable(task)
    ? `接続先: ${me.ai.approved.find((p) => p.id === me.ai.provider).label} / ${me.ai.model || '無料・低コストを自動選択'}`
    : 'AI接続・社内認可は未設定です。キーボードで入力できます。';
}
function timerView(phase, anyone = false) {
  const mine = ws.votes[phase].mine,
    used = Object.values(mine).reduce((a, b) => a + b, 0);
  return `<div class="toolbar"><div class="budget">残り <strong>${ws.budgets[phase] - used}</strong> / ${ws.budgets[phase]} 票 <span class="muted">同じ案に複数投票・取消ができます</span></div><div class="timer"><div><small>VOTING TIME</small><div class="clock" data-clock="${phase}">03:00</div></div>${me.admin || anyone ? `<button data-timer="${phase}" class="primary"${disabled(writable())}>開始 / 再開</button><button data-stop="${phase}" class="text-button"${disabled(writable())}>締切</button>` : '<span class="muted">管理者が開始します</span>'}</div></div>`;
}
function votingOpen(phase) {
  return (
    writable() &&
    ws.timers[phase] &&
    !ws.timers[phase].closed &&
    ws.timers[phase].endsAt > Date.now()
  );
}
function votingIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m8 3 9 5-4 7-9-5 4-7ZM4 13H2v8h20v-8h-5M8 13h8"/><path d="m9 7 2 3 4-1"/></svg>';
}
function compactVotingContents() {
  const open = votingOpen('cards'),
    used = Object.values(ws.votes.cards.mine).reduce((a, b) => a + b, 0);
  return `<button class="toolbar-icon ${open ? 'voting-active' : ''}" ${open ? 'data-stop' : 'data-timer'}="cards" aria-label="${open ? 'カード投票を締め切る' : 'カード投票を開始'}" aria-pressed="${!!open}" title="${open ? 'カード投票を締め切る' : 'カード投票を開始'}"${disabled((me.admin && writable()) || editableTeam())}>${votingIcon()}</button><span class="vote-budget" title="残りの票 / 持ち票">${ws.budgets.cards - used}/${ws.budgets.cards}</span><span class="vote-clock" data-clock="cards"></span>`;
}
function compactVoting() {
  return `<div class="compact-voting">${compactVotingContents()}</div>`;
}
function cardVoteButtons(n) {
  if (!votingOpen('cards') || !editableTeam()) return '';
  const mine = ws.votes.cards.mine[n.id] || 0,
    used = Object.values(ws.votes.cards.mine).reduce((a, b) => a + b, 0);
  return `${mine > 0 ? `<button class="vote-minus" data-vote="cards" data-target="${n.id}" data-delta="-1" aria-label="${esc(n.text)}の自分の投票を取り消す" title="自分の${mine}票から1票を取り消す">−</button>` : ''}<button class="vote-plus" data-vote="cards" data-target="${n.id}" data-delta="1" aria-label="${esc(n.text)}に投票する" title="1票を投じる"${disabled(used < ws.budgets.cards)}>＋</button>`;
}
function topicVoteContents(n) {
  const total = ws.votes.cards.totals[n.id] || 0;
  return `${total > 0 ? `<span class="topic-total" aria-label="${total}票">${total}</span>` : ''}${cardVoteButtons(n)}`;
}
function refreshVotingUI(force = false) {
  if (!ws || !team() || pointerDragging) return;
  $('#mindmap')?.classList.toggle('map-voting-active', !!votingOpen('cards'));
  const key = `${ws.id}/${teamId}/${tab}/${ws.revision}/${!!votingOpen('cards')}/${editableTeam()}`;
  if (!force && key === voteUiKey) return;
  voteUiKey = key;
  $$('.compact-voting').forEach((el) => {
    el.innerHTML = compactVotingContents();
  });
  $$('[data-vote-bar]').forEach((el) => {
    el.innerHTML = timerView('cards', true);
  });
  $$('[data-topic-votes]').forEach((el) => {
    const n = team().nodes.find((n) => n.id === el.dataset.topicVotes);
    if (n) el.innerHTML = topicVoteContents(n);
  });
  $$('[data-card-votes]').forEach((el) => {
    const n = team().nodes.find((n) => n.id === el.dataset.cardVotes);
    if (n) el.innerHTML = cardVoteButtons(n);
  });
  bindVoting();
  if (tab === 1) requestAnimationFrame(() => (mapFit ? fitMap() : updateMapStage()));
}
function mapShape(w) {
  const t = w.teams[teamId];
  return JSON.stringify([
    w.name,
    w.theme,
    w.status,
    w.deleted,
    w.role,
    w.myTeam,
    w.notion?.error,
    w.notion?.conflict,
    w.notion?.provisioning,
    w.creationError,
    Object.values(w.teams).map((t) => [t.id, t.name]),
    t?.rootText,
    t?.nodes.map(({ id, text, parent, group }) => ({ id, text, parent, group })),
  ]);
}
function bindVoting() {
  $$('[data-vote]').forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        b.disabled = true;
        try {
          await action('vote', {
            phase: b.dataset.vote,
            target: b.dataset.target,
            delta: Number(b.dataset.delta),
          });
        } finally {
          if (b.isConnected) b.disabled = false;
        }
      })),
  );
  $$('[data-timer]').forEach(
    (b) => (b.onclick = guarded(() => action('timer', { phase: b.dataset.timer, teamId }))),
  );
  $$('[data-stop]').forEach(
    (b) =>
      (b.onclick = guarded(() => action('timer', { phase: b.dataset.stop, stop: true, teamId }))),
  );
}
function sticky(n, deck = false) {
  const total = ws.votes.cards.totals[n.id] || 0;
  return `<article class="sticky g${n.group}"${deck && editableTeam() ? ' draggable="true"' : ''} data-card="${n.id}"><span class="badge" aria-label="${total}票">${total}</span><p>${esc(n.text)}</p>${deck ? `<div class="sticky-votes"><button class="plus" data-add-deck="${n.id}" aria-label="デッキへ追加"${disabled(editableTeam() && !team().deck.includes(n.id) && team().deck.length < 5)}>＋</button></div>` : `<div class="sticky-votes card-vote-controls" data-card-votes="${n.id}">${cardVoteButtons(n)}</div>`}</article>`;
}
function cardView(deck) {
  const nodes = team().nodes.filter(
    (n) => (ws.votes.cards.totals[n.id] || 0) > 0 && !(deck && team().deck.includes(n.id)),
  );
  const sorted = deck || cardSorts.get(adviceKey());
  if (sorted)
    nodes.sort(
      (a, b) =>
        (ws.votes.cards.totals[b.id] || 0) - (ws.votes.cards.totals[a.id] || 0) ||
        team().nodes.indexOf(a) - team().nodes.indexOf(b),
    );
  return `<div class="panel narrowed-cards"><div class="panel-title"><h3>絞込み済みカード <span class="muted">${nodes.length}</span></h3><div class="row">${deck ? '' : compactVoting() + `<button id="sort-cards" class="toolbar-icon" aria-label="${sorted ? 'マップの順番に戻す' : '得票数の多い順に並べる'}" aria-pressed="${!!sorted}" title="${sorted ? 'マップの順番に戻す' : '得票数の多い順に並べる'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16M4 10h11M4 15h6M18 11v10m-3-3 3 3 3-3"/></svg></button>`}</div></div>${nodes.length ? `<div class="sticky-grid">${nodes.map((n) => sticky(n, deck)).join('')}</div>` : '<div class="empty">絞込み済みカードはありません</div>'}</div>`;
}

function deckPositions() {
  const t = team(),
    slots = Array(5).fill(null),
    seen = new Set();
  (t.deckSlots || []).slice(0, 5).forEach((id, i) => {
    if (t.deck.includes(id) && !seen.has(id)) {
      slots[i] = id;
      seen.add(id);
    }
  });
  for (const id of t.deck)
    if (!seen.has(id)) {
      const at = slots.indexOf(null);
      if (at >= 0) {
        slots[at] = id;
        seen.add(id);
      }
    }
  return slots;
}
// ③ deck history: each saved deck is "デッキ＃n"; a deck not saved yet takes the next number.
const deckIcon = () =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/></svg>';
function deckHistory(canEdit) {
  const t = team(),
    ideas = t.ideas || [],
    chips = ideas.map((idea, i) => {
      const active = idea.id === t.activeIdeaId;
      return `<button type="button" class="deck-chip${active ? ' active' : ''}" data-deck-idea="${idea.id}" aria-pressed="${active}" title="${esc(idea.title || 'デッキ＃' + (i + 1))}"${disabled(canEdit || active)}>${deckIcon()}デッキ＃${i + 1}</button>`;
    });
  if (!ideas.some((i) => i.id === t.activeIdeaId))
    chips.push(`<span class="deck-chip active" aria-current="true" title="編集中のデッキ">${deckIcon()}デッキ＃${ideas.length + 1}</span>`);
  return `<div class="deck-history" role="group" aria-label="デッキの切り替え">${chips.join('')}<button type="button" id="new-deck" class="toolbar-icon" aria-label="新しいデッキにする" title="新しいデッキにする（今のデッキは保存して戻れます）"${disabled(canEdit)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg></button></div>`;
}
const scaleClass = () =>
  `text-scale-${[100, 115, 130, 150].includes(ws.textScale) ? ws.textScale : 115}`;
// ① ワイガヤ: the voice log. While recording is on, speech keeps being added to this record,
// which ②–⑤ use as the context of the discussion.
function talkView() {
  const d = team().discussion,
    canEdit = editableTeam(),
    on = !!talk;
  return `<div class="deck-discussion talk-view ${scaleClass()}"><div class="panel talk-panel"><form id="talk-form"><div class="row between discussion-heading"><h3>ディスカッションの記録</h3><div class="row talk-controls">${SpeechRec && aiAvailable('transcribe') ? `<label class="talk-engine" for="talk-engine">文字起こし</label><select id="talk-engine"${on ? ' disabled' : ''}><option value="browser"${talkEngine() === 'browser' ? ' selected' : ''}>ブラウザー（無料）</option><option value="genspark"${talkEngine() === 'genspark' ? ' selected' : ''}>Genspark（句読点あり・クレジット使用）</option></select>` : ''}<button type="button" id="record-discussion" class="${on ? 'is-recording' : ''}" aria-pressed="${on}"${disabled(canEdit)}>${micIcon()} ${on ? '録音を停止' : '録音開始'}</button></div></div><div id="audio-status">${talkStatus()}</div>
  <textarea id="transcript" data-draft="transcript" class="transcript" maxlength="100000" placeholder="「録音開始」を押すと、停止するまで話した内容が文字になって、ここにたまっていきます。②〜⑤でAIが議論を整理するときの材料になります。キーボードで入力・修正もできます。"${disabled(canEdit)}>${esc(d.transcript)}</textarea>
  <div class="row between"><span class="save-hint">${talkEngine() === 'browser' ? '録音がONの間は、話したそばから文字にして自動で保存します（無料。ほかのタブに移っても続きます）' : '録音がONの間は、約１分ごとに文字にして自動で保存します（Gensparkのクレジットを使います。ほかのタブに移っても続きます）'}</span></div>${talkEngine() === 'genspark' ? `<p class="muted">${aiStatus('transcribe')}</p>` : ''}</form></div></div>`;
}
function deckPanel(canEdit) {
  const t = team();
  return `<div class="panel casino-deck"><div class="panel-title"><h3>アイデアのデッキ <span class="muted">${t.deck.length} / 5 枚</span></h3>${deckHistory(canEdit)}</div><div class="deck" id="deck">${Array.from(
    { length: 5 },
    (_, i) => {
      const n = t.nodes.find((n) => n.id === deckPositions()[i]);
      return `<div class="slot ${n ? 'filled' : ''}" data-slot="${i}">${n ? `<article class="deck-card sticky g${n.group}" data-deck-card="${n.id}"><span class="badge">${ws.votes.cards.totals[n.id] || 0}</span><button class="remove" data-remove-deck="${n.id}" aria-label="デッキから外す"${disabled(canEdit)}>×</button><p>${esc(n.text)}</p></article>` : '<span aria-hidden="true">＋</span>'}<span class="slot-number">0${i + 1}</span></div>`;
    },
  ).join('')}</div></div>`;
}
// ③ カードで議論深耕: the five-card deck, and below it the cards that got votes in ②.
function cardDeckView() {
  return `<div class="deck-workspace">${deckPanel(editableTeam())}${cardView(true)}</div>`;
}
// The press release text as a newspaper article: its title, then the body paragraphs.
function pressParts(value) {
  const body = [];
  let title = '',
    awaiting = false;
  for (const raw of String(value || '').split('\n')) {
    const line = raw.trim().replace(/^[#＃]+\s*/, '');
    const head = /^【?\s*(タイトル|見出し)\s*】?[:：]?\s*(.*)$/.exec(line);
    if (head && !title) {
      if (head[2]) title = head[2];
      else awaiting = true;
    } else if (/^【?\s*本文\s*】?$/.test(line)) continue;
    else if (awaiting && line) {
      title = line;
      awaiting = false;
    } else body.push(line);
  }
  if (!title) {
    const first = body.findIndex(Boolean);
    if (first >= 0 && body.filter(Boolean).length > 1) title = body.splice(first, 1)[0];
  }
  return {
    title,
    body: body
      .filter(Boolean)
      .map((line) => {
        const m = /^(【[^】]+】)\s*(.*)$/.exec(line);
        if (m && !m[2]) return `<h4>${esc(m[1])}</h4>`;
        return m ? `<p><strong>${esc(m[1])}</strong>${esc(m[2])}</p>` : `<p>${esc(line)}</p>`;
      })
      .join(''),
  };
}
function pressPaper(d) {
  if (!String(d.pressRelease || '').trim())
    return '<div class="empty press-empty">「模擬プレスの作成」を押すと、ここに新聞記事風の模擬プレスリリースが表示されます。</div>';
  const { title, body } = pressParts(d.pressRelease);
  return `<article class="press-paper"><header><span class="press-kicker">PRESS RELEASE（模擬）</span><h2>${esc(title || d.headline || '模擬プレスリリース')}</h2></header><div class="press-body">${body}</div></article>`;
}
let pressEditOpen = false;
// ④ saves what was typed as soon as a field is left; there is no save button.
async function saveOutline() {
  if (!editing || !$('#discussion-form') || !editableTeam()) return;
  const activeWs = ws.id,
    activeTeam = teamId;
  const result = await api(`/api/workshops/${ws.id}/action`, {
    action: 'discussion',
    payload: { teamId, ...discussionValues() },
    revision: ws.revision,
    requestId: crypto.randomUUID(),
  });
  if (ws?.id !== activeWs || teamId !== activeTeam) return;
  ws = result;
  pending = null;
  clearDraft();
}
// ④ 模擬プレスの作成: the deck chosen in ③, the outline of the idea on one screen, and below
// them the generated press release.
function pressView() {
  const t = team(),
    d = t.discussion,
    canEdit = editableTeam();
  const field = (key, label, max, placeholder = '') =>
    `<div class="outline-field"><label for="${key}">${label}</label><input id="${key}" data-draft="${key}" maxlength="${max}" value="${esc(d[key] || '')}" placeholder="${placeholder}"${disabled(canEdit)}></div>`;
  return `<div class="deck-workspace press-deck">${deckPanel(canEdit)}</div>
  <div class="deck-discussion idea-sheet press-sheet ${scaleClass()}"><form id="discussion-form"><div class="panel outline-panel">
  <div class="row between discussion-heading"><h3>アイデアの輪郭</h3><button type="button" data-ai="summarize" class="primary" title="①の記録と選んだカードから、一言で言うと・Who・What・How・３つの特長を書き出します"${disabled(canEdit)}>✧ たたき台を生成</button></div>
  ${field('headline', '一言で言うと', 100, '企画の価値を一言で')}
  <div class="outline-row">${field('who', 'Who', 40, '誰に')}${field('what', 'What', 40, 'どんな価値を提供するか')}${field('how', 'How', 120, 'どうやって実現するか')}</div>
  <fieldset class="features"><legend>３つの特長</legend><div class="outline-row">${[0, 1, 2].map((i) => `<div><label class="sr-only" for="feature-${i}">特長${i + 1}</label><textarea id="feature-${i}" data-draft="feature-${i}" class="feature-line" rows="2" maxlength="200" placeholder="${i + 1}．特長を１行の文章で"${disabled(canEdit)}>${esc(d.features?.[i] || '')}</textarea></div>`).join('')}</div></fieldset>
  <div class="row between section-actions"><span class="save-hint">入力した内容は自動で保存します</span><button type="button" data-ai="pressRelease" class="primary generate-button press-button"${disabled(canEdit)}>④ 模擬プレスの作成</button></div></div>
  <section class="panel press-panel" id="press-panel">${pressPaper(d)}<details class="press-edit"${pressEditOpen ? ' open' : ''}><summary>原稿を修正する</summary><textarea id="pressRelease" data-draft="pressRelease" class="press-release" maxlength="2000" placeholder="生成した原稿がここに入ります。確認・修正できます"${disabled(canEdit)}>${esc(d.pressRelease || '')}</textarea><p class="muted">この欄を閉じると、修正が上の記事に反映されます。</p></details><div class="row between proto-row"><span class="muted">輪郭と模擬プレスの内容を１枚の画像にします（Genspark / ${esc(me.ai?.imageModel || 'gpt-image-2')} · 16:9）。できた画像は⑤に並びます。</span><button type="button" data-ai="image" class="visualize-button generate-button"${disabled(canEdit)}>⑤ ペーパープロトの作成 ↗</button></div></section></form></div>`;
}
// ④ shows every deck that has a generated image as its own entry.
function ideaEntries() {
  const out = [];
  for (const t of Object.values(ws.teams)) {
    (t.ideas || []).forEach((idea, i) => {
      if (idea.image)
        out.push({ team: t, target: idea.id, label: `デッキ＃${i + 1}`, discussion: idea.discussion, src: `/api/workshops/${encodeURIComponent(ws.id)}/idea-image?idea=${encodeURIComponent(idea.id)}&v=${encodeURIComponent(idea.image.key)}` });
    });
    // Images made before decks were saved belong to the team itself.
    if (t.image && !(t.ideas || []).some((i) => i.id === t.activeIdeaId && i.image))
      out.push({ team: t, target: t.id, label: '', discussion: t.discussion, src: `data:image/png;base64,${t.image.base64}` });
  }
  return out;
}
function ideaView() {
  const teams = ideaEntries();
  return `${timerView('ideas')}<div class="panel"><div class="panel-title"><h3>チームのアイディア <span class="muted">${teams.length} 件</span></h3><span class="muted">どの班の案にも投票できます</span></div>${teams.length ? `<div class="ideas-grid">${teams.map((e) => { const t = e.team, k = e.target; return `<article class="idea"><span class="badge">${ws.votes.ideas.totals[k] || 0}</span><button class="image-open" data-idea-entry="${k}" aria-label="${esc(t.name + (e.label ? ' ' + e.label : ''))}の画像を拡大"><img src="${e.src}" alt="${esc(e.discussion.what || t.name + 'のアイディア')}"></button><div class="idea-body"><h3>${esc(t.name)}${e.label ? ` <span class="pill deck-pill">${e.label}</span>` : ''}</h3>${e.discussion.headline ? `<p><strong>${esc(e.discussion.headline)}</strong></p>` : ''}<p>${esc(e.discussion.what || 'チームのアイディア')}</p><div class="sticky-votes"><button data-vote="ideas" data-target="${k}" data-delta="-1" aria-label="${esc(t.name + (e.label ? ' ' + e.label : ''))}の投票を取り消す"${disabled(votingOpen('ideas') && (ws.votes.ideas.mine[k] || 0) > 0)}>−</button><span>あなたの投票 ${ws.votes.ideas.mine[k] || 0}</span><button data-vote="ideas" data-target="${k}" data-delta="1" aria-label="${esc(t.name + (e.label ? ' ' + e.label : ''))}へ投票する"${disabled(votingOpen('ideas'))}>＋</button></div></div></article>`; }).join('')}</div>` : '<div class="empty"><span class="symbol">▧</span><strong>チームのアイディアが、ここに集まります。</strong>生成した画像を、全チームで見比べて投票できます。<br>画像は④の「ペーパープロトの作成」で作ります。</div>'}</div>`;
}
function selectTopic(id) {
  selected = id;
  color = team().nodes.find((n) => n.id === id)?.group ?? color;
  $$('[data-node],.map-root').forEach((b) =>
    b.classList.toggle('selected', (b.dataset.node || 'theme') === id),
  );
  const actions = $('#topic-actions');
  if (actions) actions.disabled = !editableTeam() || !selected;
  for (const [selector, direction] of [
    ['#move-topic-up', -1],
    ['#move-topic-down', 1],
  ]) {
    const button = $(selector);
    if (button) button.disabled = !editableTeam() || !siblingTarget(id, direction);
  }
}
function siblingTarget(id, direction) {
  const node = team()?.nodes.find((n) => n.id === id);
  if (!node) return null;
  const siblings = team().nodes.filter((n) => (n.parent || 'theme') === (node.parent || 'theme'));
  return siblings[siblings.findIndex((n) => n.id === id) + direction];
}
async function moveTopicVertical(id, direction) {
  if (!editableTeam() || inlineEdit || editing) return;
  const target = siblingTarget(id, direction);
  if (!target) return;
  selected = id;
  await action('reorderTopic', {
    teamId,
    id,
    targetId: target.id,
    position: direction < 0 ? 'before' : 'after',
  });
  requestAnimationFrame(() => $(`[data-node="${id}"]`)?.focus({ preventScroll: true }));
}
function outlineText(anchorId = selected || 'theme') {
  const t = team(),
    lines = [];
  const visit = (id, depth) => {
    const node = t.nodes.find((n) => n.id === id);
    if (!node) return;
    lines.push('\t'.repeat(depth) + node.text.replace(/[\r\n\t]+/g, ' '));
    for (const child of t.nodes.filter((n) => n.parent === id)) visit(child.id, depth + 1);
  };
  if (anchorId === 'theme') {
    lines.push((t.rootText || ws.theme).replace(/[\r\n\t]+/g, ' '));
    for (const n of t.nodes.filter((n) => n.parent === 'theme' || n.parent === null))
      visit(n.id, 1);
  } else visit(anchorId, 0);
  return lines.join('\r\n');
}
async function pasteMapOutline(text, anchorId = selected || 'theme', placement = 'child') {
  if (!editableTeam()) throw Error('自分のチームの編集可能なマップで貼り付けてください');
  if (inlineEdit || editing) throw Error('文字の編集を確定してから貼り付けてください');
  const before = new Set(team().nodes.map((n) => n.id));
  collapsedTopics().delete(anchorId);
  await action('pasteOutline', { text, anchorId, placement, teamId });
  const first = team().nodes.find((n) => !before.has(n.id));
  if (first) selectTopic(first.id);
  toast(`${team().nodes.length - before.size}件のトピックを階層ごと貼り付けました`);
}
function pasteOutlineDialog() {
  const anchorId = selected || 'theme';
  if (!editableTeam() || inlineEdit) return;
  openDialog(
    `<h2>トピックを貼り付け</h2><p class="muted">MindManagerでコピーした内容を下に貼り付けてください。TAB・スペースの字下げを階層として取り込みます。</p><form id="paste-outline-form"><label for="paste-outline-text">コピーしたトピック</label><textarea id="paste-outline-text" rows="12" maxlength="512000" spellcheck="false" required></textarea><label for="paste-outline-position">追加する場所</label><select id="paste-outline-position"><option value="child">選択トピックの子として追加</option><option value="sibling">選択トピックと同じ階層に追加</option></select><button class="primary section-actions">階層を保って貼り付ける</button></form>`,
  );
  $('#paste-outline-text').focus();
  $('#paste-outline-form').onsubmit = guarded(async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      await pasteMapOutline(
        $('#paste-outline-text').value,
        anchorId,
        $('#paste-outline-position').value,
      );
      modal.close();
    } finally {
      button.disabled = false;
    }
  });
}
async function copyOutline() {
  const text = outlineText();
  try {
    await navigator.clipboard.writeText(text);
    toast('選択トピックと子孫をMindManager互換テキストでコピーしました');
  } catch {
    openDialog(
      `<h2>トピックをコピー</h2><p>下の文字をCtrl＋Cでコピーできます。</p><textarea id="copy-outline-text" rows="12" readonly>${esc(text)}</textarea>`,
    );
    $('#copy-outline-text').select();
  }
}
const mapClipboardTarget = (event) =>
  sessionEntered &&
  me &&
  ws &&
  team() &&
  tab === 1 &&
  !modal.open &&
  !inlineEdit &&
  !editing &&
  !event.target.closest?.('input,textarea,[contenteditable="true"]');
document.addEventListener('paste', (event) => {
  if (!mapClipboardTarget(event) || !editableTeam()) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text?.trim()) return;
  event.preventDefault();
  void guarded(() => pasteMapOutline(text))();
});
document.addEventListener('copy', (event) => {
  if (!mapClipboardTarget(event) || document.getSelection()?.toString()) return;
  if (!event.clipboardData) return;
  event.clipboardData.setData('text/plain', outlineText());
  event.preventDefault();
});
function beginInline(id, placement) {
  if (!editableTeam() || recording || recordingStarting) return;
  if (inlineEdit) return;
  if (editing) return toast('入力欄の内容を保存してからトピックを編集してください', true);
  const anchor = team().nodes.find((n) => n.id === id);
  if (id !== 'theme' && !anchor) return;
  const isNew = !!placement;
  inlineEdit = {
    id: isNew ? crypto.randomUUID() : id,
    isNew,
    anchorId: id,
    placement,
    wsId: ws.id,
    teamId,
    text: isNew ? '' : id === 'theme' ? team().rootText || ws.theme : anchor?.text || '',
    parent: isNew
      ? id === 'theme'
        ? 'theme'
        : placement === 'child'
          ? id
          : anchor?.parent
      : anchor?.parent,
    group: anchor?.group || 0,
  };
  if (isNew) collapsedTopics().delete(inlineEdit.parent);
  selected = inlineEdit.id;
  render();
}
function commitInline() {
  const edit = inlineEdit;
  if (!edit) return Promise.resolve(true);
  if (edit.commitPromise) return edit.commitPromise;
  edit.commitPromise = commitInlineNow();
  edit.commitPromise.finally(() => {
    delete edit.commitPromise;
  });
  return edit.commitPromise;
}
async function commitInlineNow() {
  const edit = inlineEdit;
  if (!edit) return true;
  if (edit.saving) return false;
  if (!edit.text.trim()) {
    inlineEdit = null;
    editing = false;
    selected = edit.isNew ? edit.anchorId : edit.id;
    if (selected !== 'theme' && !team().nodes.some((n) => n.id === selected)) selected = 'theme';
    render();
    return true;
  }
  edit.saving = true;
  try {
    const before = new Set(team().nodes.map((n) => n.id));
    const result = await api(`/api/workshops/${edit.wsId}/action`, {
      action: edit.isNew ? 'createTopic' : edit.id === 'theme' ? 'topicTheme' : 'node',
      payload: {
        teamId: edit.teamId,
        id: edit.id,
        text: edit.text,
        placement: edit.placement,
        anchorId: edit.anchorId,
      },
      revision: ws.revision,
      requestId: crypto.randomUUID(),
    });
    inlineEdit = null;
    ws = result;
    selected = edit.isNew ? team().nodes.find((n) => !before.has(n.id))?.id : edit.id;
    clearDraft();
    render();
    scheduleAdvice(edit.isNew ? 'card_created' : 'card_updated');
    return true;
  } catch (e) {
    edit.saving = false;
    if (e.status === 409) {
      try {
        pending = await api(`/api/workshops/${edit.wsId}`);
        showPending();
      } catch {}
    }
    toast(e.message, true);
    $('#topic-editor')?.focus();
    return false;
  }
}
// Use pointer events so dragging also works in embedded browsers and between topic rows.
// Native HTML drag events alone never fire on some embedded browser surfaces.
function pointerDrag(source, label, resolve, drop) {
  source.draggable = false;
  source.style.touchAction = 'none';
  source.onpointerdown = (start) => {
    if (
      start.button !== 0 ||
      !editableTeam() ||
      inlineEdit ||
      (editing && tab === 1) ||
      pointerDragging
    )
      return;
    if (
      start.target.closest('button,input,textarea') &&
      start.target.closest('button,input,textarea') !== source
    )
      return;
    const controller = new AbortController();
    let active = false,
      ghost,
      destination;
    const cleanMarkers = () =>
      $$('.map-drop-active,.map-drop-before,.map-drop-after,.dragover').forEach((el) =>
        el.classList.remove('map-drop-active', 'map-drop-before', 'map-drop-after', 'dragover'),
      );
    const finish = (event, cancel = false) => {
      if (event.pointerId !== start.pointerId) return;
      controller.abort();
      if (!active) return;
      source.releasePointerCapture?.(start.pointerId);
      ghost?.remove();
      source.classList.remove('dragging');
      cleanMarkers();
      pointerDragging = false;
      mapDragId = null;
      // The click following pointerup must not select a stale element or vote.
      const suppressClick = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      document.addEventListener('click', suppressClick, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', suppressClick, true), 0);
      if (!cancel && destination) void guarded(() => drop(destination))();
    };
    document.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== start.pointerId) return;
        if (!active && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6)
          return;
        event.preventDefault();
        if (!active) {
          active = pointerDragging = true;
          source.setPointerCapture?.(start.pointerId);
          source.classList.add('dragging');
          ghost = document.createElement('div');
          ghost.className = 'pointer-drag-ghost';
          ghost.textContent = label;
          document.body.appendChild(ghost);
        }
        ghost.style.left = `${event.clientX + 14}px`;
        ghost.style.top = `${event.clientY + 12}px`;
        cleanMarkers();
        destination = resolve(event, start);
        if (destination) destination.element.classList.add(destination.className);
        const scroll = $('.map-scroll');
        if (scroll && tab === 1) {
          const r = scroll.getBoundingClientRect();
          if (event.clientY < r.top + 30) scroll.scrollTop -= 18;
          if (event.clientY > r.bottom - 30) scroll.scrollTop += 18;
        }
      },
      { signal: controller.signal, passive: false },
    );
    document.addEventListener('pointerup', (e) => finish(e), { signal: controller.signal });
    document.addEventListener('pointercancel', (e) => finish(e, true), {
      signal: controller.signal,
    });
    window.addEventListener('blur', () => finish({ pointerId: start.pointerId }, true), {
      signal: controller.signal,
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') finish({ pointerId: start.pointerId }, true);
      },
      { signal: controller.signal },
    );
  };
}
function bindMapPointerDrag() {
  $$('[data-node]').forEach((source) => {
    const id = source.dataset.node,
      node = team().nodes.find((n) => n.id === id);
    pointerDrag(
      source,
      node.text,
      (event, start) => {
        mapDragId = id;
        const scroll = $('.map-scroll').getBoundingClientRect();
        if (
          event.clientX < scroll.left ||
          event.clientX > scroll.right ||
          event.clientY < scroll.top ||
          event.clientY > scroll.bottom
        )
          return null;
        let target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-map-target]');
        let position = 'child';
        const hit = target && team().nodes.find((n) => n.id === target.dataset.mapTarget),
          bounds = target?.getBoundingClientRect(),
          childTarget =
            target &&
            target.dataset.mapTarget !== id &&
            (target.dataset.mapTarget === 'theme' ||
              (hit && (hit.parent || 'theme') !== (node.parent || 'theme')) ||
              (event.clientX > bounds.left + bounds.width * 0.7 &&
                event.clientY > bounds.top + bounds.height * 0.25 &&
                event.clientY < bounds.bottom - bounds.height * 0.25));
        // A predominantly vertical gesture reorders siblings even in the gaps between them.
        if (Math.abs(event.clientX - start.clientX) < 70 && !childTarget) {
          const siblings = $$('[data-node]').filter((b) => {
            const n = team().nodes.find((n) => n.id === b.dataset.node);
            return n.id !== id && (n.parent || 'theme') === (node.parent || 'theme');
          });
          target = siblings.sort((a, b) => {
            const ar = a.getBoundingClientRect(),
              br = b.getBoundingClientRect();
            return (
              Math.abs(event.clientY - (ar.top + ar.bottom) / 2) -
              Math.abs(event.clientY - (br.top + br.bottom) / 2)
            );
          })[0];
          if (target) {
            const r = target.getBoundingClientRect();
            position = event.clientY < (r.top + r.bottom) / 2 ? 'before' : 'after';
          }
        } else if (target && target.dataset.mapTarget !== 'theme') {
          const r = target.getBoundingClientRect(),
            ratio = (event.clientY - r.top) / r.height;
          position = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';
        }
        if (!target || target.dataset.mapTarget === id) return null;
        const targetId = target.dataset.mapTarget;
        let ancestor = targetId;
        while (ancestor && ancestor !== 'theme') {
          if (ancestor === id) return null;
          ancestor = team().nodes.find((n) => n.id === ancestor)?.parent;
        }
        return {
          element: target,
          className: position === 'child' ? 'map-drop-active' : `map-drop-${position}`,
          targetId,
          position,
        };
      },
      async ({ targetId, position }) => {
        selected = id;
        if (position === 'child') await moveMapNode(id, targetId);
        else await action('reorderTopic', { teamId, id, targetId, position });
      },
    );
  });
}
function bindMap() {
  $('#mindmap').style.transform = `scale(${zoom})`;
  $('#undo-map').onclick = guarded(undoMapAction);
  $('#copy-outline').onclick = guarded(copyOutline);
  $('#paste-outline').onclick = pasteOutlineDialog;
  $('#move-topic-up').onclick = guarded(() => moveTopicVertical(selected, -1));
  $('#move-topic-down').onclick = guarded(() => moveTopicVertical(selected, 1));
  const zoomTo = (n) => {
    mapFit = false;
    zoom = Math.min(2, Math.max(0.02, n));
    $('#mindmap').style.transform = `scale(${zoom})`;
    updateMapStage();
  };
  $('#tb-add-sibling').onclick = () => selected && selected !== 'theme' && beginInline(selected, 'sibling');
  $('#tb-add-child').onclick = () => selected && beginInline(selected, 'child');
  $('#zoom-in').onclick = () => zoomTo(zoom + 0.1);
  $('#zoom-out').onclick = () => zoomTo(zoom - 0.1);
  $('#collapse-all').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    for (const n of team().nodes) collapsedTopics().add(n.id);
    collapsedTopics().add('theme');
    render();
  });
  $('#expand-all').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    collapsedTopics().clear();
    render();
  });
  $$('[data-collapse]').forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        if (inlineEdit && !(await commitInline())) return;
        const closed = collapsedTopics(),
          id = b.dataset.collapse;
        closed.has(id) ? closed.delete(id) : closed.add(id);
        render();
      })),
  );
  $('#new-topic').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    beginInline('theme', 'child');
  });
  $('#map-record').onclick = guarded(() => recordAudio('map'));
  $('#topic-actions').onclick = topicActionsDialog;
  $('#fit-map').onclick = guarded(async () => {
    if (inlineEdit && !(await commitInline())) return;
    collapsedTopics().clear();
    mapFit = true;
    render();
    requestAnimationFrame(fitMap);
  });
  const input = $('#topic-editor');
  if (input) {
    const resize = () => {
      input.style.width = `${Math.max(
        120,
        Math.min(
          2400,
          [...input.value].reduce((n, c) => n + (/[^\x00-\xff]/.test(c) ? 24 : 14), 36),
        ),
      )}px`;
      drawMapLinks();
    };
    input.oninput = () => {
      inlineEdit.text = input.value;
      editing = true;
      resize();
    };
    input.onkeydown = guarded(async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        selected = inlineEdit.isNew ? inlineEdit.anchorId : inlineEdit.id;
        inlineEdit = null;
        clearDraft();
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hasText = !!inlineEdit?.text.trim();
        if ((await commitInline()) && hasText) beginInline(selected, 'sibling');
      } else if (e.key === 'Insert') {
        e.preventDefault();
        const hasText = !!inlineEdit?.text.trim();
        if ((await commitInline()) && hasText) beginInline(selected, 'child');
      }
    });
    input.onblur = () => {
      if (inlineEdit && !inlineEdit.saving) void commitInline();
    };
    resize();
    input.focus();
    input.select();
  }
  $$('[data-map-target]').forEach((button) => {
    const id = button.dataset.mapTarget;
    button.onclick = guarded(async () => {
      if (mapConnectId) {
        const source = mapConnectId;
        mapConnectId = null;
        if (source !== id) await moveMapNode(source, id);
        return;
      }
      if (inlineEdit) return;
      if (editing && selected !== id) return toast('入力欄の内容を保存してください', true);
      selectTopic(id);
    });
    button.ondblclick = () => beginInline(id);
    button.oncontextmenu = (e) => {
      if (editableTeam()) {
        e.preventDefault();
        selectTopic(id);
        topicActionsDialog();
      }
    };
    button.onkeydown = (e) => {
      if (e.isComposing) return;
      if (['Enter', 'Insert', 'F2', 'Delete'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Delete' && id !== 'theme') deleteMapTopic(id);
        else
          beginInline(id, e.key === 'Enter' ? 'sibling' : e.key === 'Insert' ? 'child' : undefined);
      }
    };
    if (id === 'theme') return;
    button.ondragstart = (e) => {
      if (!editableTeam() || editing || inlineEdit) {
        e.preventDefault();
        return;
      }
      mapDragId = id;
      e.dataTransfer.setData('application/x-workshop-node', id);
      e.dataTransfer.effectAllowed = 'move';
      button.classList.add('dragging');
    };
    button.ondragend = () => {
      mapDragId = null;
      $$('.map-drop-active,.map-drop-before,.map-drop-after,.dragging').forEach((el) =>
        el.classList.remove('map-drop-active', 'map-drop-before', 'map-drop-after', 'dragging'),
      );
    };
  });
  $$('[data-map-target],[data-map-zone]').forEach((target) => {
    const dropPosition = (e) => {
      if (!target.dataset.mapTarget || target.dataset.mapTarget === 'theme') return 'child';
      const rect = target.getBoundingClientRect(),
        ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
      return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'child';
    };
    target.ondragover = (e) => {
      if (editableTeam() && mapDragId) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        target.classList.remove('map-drop-active', 'map-drop-before', 'map-drop-after');
        target.classList.add(
          dropPosition(e) === 'child' ? 'map-drop-active' : `map-drop-${dropPosition(e)}`,
        );
      }
    };
    target.ondragleave = (e) => {
      if (!target.contains(e.relatedTarget))
        target.classList.remove('map-drop-active', 'map-drop-before', 'map-drop-after');
    };
    target.ondrop = guarded(async (e) => {
      e.preventDefault();
      e.stopPropagation();
      target.classList.remove('map-drop-active', 'map-drop-before', 'map-drop-after');
      const id = e.dataTransfer?.getData('application/x-workshop-node') || mapDragId;
      mapDragId = null;
      if (!editableTeam() || !team().nodes.some((n) => n.id === id)) return;
      if (target.dataset.mapZone === 'delete') return deleteMapTopic(id);
      if (target.dataset.mapTarget === id) return;
      const position = dropPosition(e);
      if (!e.shiftKey && target.dataset.mapTarget && position !== 'child') {
        await action('reorderTopic', { teamId, id, targetId: target.dataset.mapTarget, position });
        return;
      }
      await moveMapNode(
        id,
        e.shiftKey ? null : target.dataset.mapTarget || null,
        target.dataset.mapZone === 'standalone',
      );
    });
    if (target.dataset.mapZone && target.tagName === 'BUTTON')
      target.onclick = guarded(async () => {
        if (!selected || selected === 'theme') return toast('操作するトピックを選択してください');
        if (target.dataset.mapZone === 'delete') deleteMapTopic(selected);
        else await moveMapNode(selected, null, true);
      });
  });
  bindMapPointerDrag();
  requestAnimationFrame(() => (mapFit ? fitMap() : updateMapStage()));
  mapObserver?.disconnect();
  if (window.ResizeObserver) {
    mapObserver = new ResizeObserver(onMapResize);
    mapObserver.observe($('#mindmap'));
    mapObserver.observe($('.map-scroll'));
  }
  document.fonts?.ready.then(() => (mapFit ? fitMap() : updateMapStage()));
  selectTopic(selected);
}
async function moveMapNode(id, parent, standalone = false) {
  if (!editableTeam()) throw Error('他チームは閲覧のみです');
  if (editing || inlineEdit) throw Error('編集中の内容を保存してください');
  if (parent) collapsedTopics().delete(parent);
  await action(standalone ? 'standalone' : 'reparent', { teamId, id, parent });
}
function deleteMapTopic(id) {
  return guarded(async () => {
    if (!editableTeam() || inlineEdit || editing) return;
    const node = team().nodes.find((n) => n.id === id);
    if (!node) return;
    const count = descendantCount(id) + 1;
    selected = node.parent || 'theme';
    if (modal.open) modal.close();
    await action('deleteNode', { teamId, id });
    toast(count + '件のトピックを削除しました。Ctrl＋Zで取り消せます');
  })();
}
async function undoMapAction() {
  if (!editableTeam() || inlineEdit || editing || mapUndoBusy) return;
  mapUndoBusy = true;
  const button = $('#undo-map');
  if (button) button.disabled = true;
  const previous = new Set(team().nodes.map((n) => n.id));
  try {
    await action('undoMap', { teamId });
    const restored = team().nodes.find((n) => !previous.has(n.id));
    selected =
      restored?.id ||
      (selected === 'theme' || team().nodes.some((n) => n.id === selected) ? selected : 'theme');
    if (restored) {
      let parent = restored.parent;
      while (parent) {
        collapsedTopics().delete(parent);
        parent = team().nodes.find((n) => n.id === parent)?.parent;
      }
    }
    render();
    toast('前のマップ操作を取り消しました');
  } finally {
    mapUndoBusy = false;
    if ($('#undo-map')) $('#undo-map').disabled = !editableTeam();
  }
}
document.addEventListener('keydown', (event) => {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.shiftKey ||
    event.altKey ||
    event.key.toLowerCase() !== 'z' ||
    !sessionEntered ||
    !me ||
    !ws ||
    !team() ||
    tab !== 1 ||
    modal.open ||
    inlineEdit ||
    editing ||
    event.target.closest?.('input,textarea,select,[contenteditable="true"]')
  )
    return;
  event.preventDefault();
  if (!event.repeat) void guarded(undoMapAction)();
});

// While the AI works: a spinner with what is being made, so nobody wonders if it started.
const busyLabels = {
  summarize: 'たたき台を作成しています…',
  pressRelease: '模擬プレスリリースを作成しています…',
  image: 'ペーパープロトタイプを生成しています…（1〜3分かかります）',
};
const busyBox = document.createElement('div');
busyBox.id = 'busy';
busyBox.hidden = true;
busyBox.setAttribute('role', 'status');
busyBox.innerHTML = '<i class="spinner" aria-hidden="true"></i><span></span>';
document.body.append(busyBox);
function showBusy(label) {
  busyBox.lastChild.textContent = label;
  busyBox.hidden = false;
}
function hideBusy() {
  busyBox.hidden = true;
}
function bindStep() {
  if (tab === 1) bindMap();
  bindVoting();
  if ($('#sort-cards'))
    $('#sort-cards').onclick = () => {
      cardSorts.set(adviceKey(), !cardSorts.get(adviceKey()));
      render();
    };
  $$('[data-ai]')
    .filter((b) => b.id !== 'map-record')
    .forEach(
      (b) =>
        (b.onclick = guarded(async () => {
          if (generationBusy) return;
          if (!aiAvailable(b.dataset.ai))
            throw Error(
              'AI接続が未設定です。管理者設定の「AI接続とモデル」でGenspark APIキー、または社内Genspark接続を設定してください。',
            );
          generationBusy = true;
          b.disabled = true;
          showBusy(busyLabels[b.dataset.ai] || 'AIが処理しています…');
          try {
            if (tab === 3) await action('discussion', { teamId, ...discussionValues() });
            $$('[data-ai]').forEach((button) => (button.disabled = true));
            await runAI(b.dataset.ai);
          } finally {
            hideBusy();
            generationBusy = false;
            $$('[data-ai]').forEach((button) => (button.disabled = !editableTeam()));
          }
        })),
    );
  if (tab === 2 || tab === 3) {
    $$('[data-card],[data-deck-card]').forEach((c) =>
      c.addEventListener('dragstart', (e) => {
        if (!editableTeam()) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('text/plain', c.dataset.card || c.dataset.deckCard);
        e.dataTransfer.effectAllowed = 'copy';
      }),
    );
    const add = async (nodeId, index) => {
      if (!editableTeam()) throw Error('他チームは閲覧のみです');
      if (editing) await action('discussion', { teamId, ...discussionValues() });
      if (!team().nodes.some((n) => n.id === nodeId))
        throw Error('配置するカードを確認してください');
      const slots = deckPositions(),
        previous = slots.indexOf(nodeId);
      index = Math.min(4, index);
      if (previous === index) return;
      const displaced = slots[index];
      if (previous >= 0) slots[previous] = displaced;
      else if (displaced) {
        const empty = slots.indexOf(null);
        if (empty < 0) throw Error('デッキは最大５枚です');
        slots[empty] = displaced;
      }
      slots[index] = nodeId;
      await action('deck', { teamId, ids: slots.filter(Boolean), slots });
    };
    $$('[data-card],[data-deck-card]').forEach((source) => {
      const id = source.dataset.card || source.dataset.deckCard;
      pointerDrag(
        source,
        team().nodes.find((n) => n.id === id)?.text || '',
        (event) => {
          const slot = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest('[data-slot]');
          return slot
            ? { element: slot, className: 'dragover', index: Number(slot.dataset.slot) }
            : null;
        },
        ({ index }) => add(id, index),
      );
    });
    $$('[data-slot]').forEach((slot) => {
      slot.ondragover = (e) => {
        if (editableTeam()) {
          e.preventDefault();
          slot.classList.add('dragover');
        }
      };
      slot.ondragleave = () => slot.classList.remove('dragover');
      slot.ondrop = guarded(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('dragover');
        await add(e.dataTransfer.getData('text/plain'), Number(slot.dataset.slot));
      });
    });
    $$('[data-add-deck]').forEach(
      (b) => (b.onclick = guarded(() => add(b.dataset.addDeck, deckPositions().indexOf(null)))),
    );
    $$('[data-remove-deck]').forEach(
      (b) =>
        (b.onclick = guarded(async () => {
          if (editing) await action('discussion', { teamId, ...discussionValues() });
          await action('deck', {
            teamId,
            ids: team().deck.filter((x) => x !== b.dataset.removeDeck),
            slots: deckPositions().map((id) => (id === b.dataset.removeDeck ? null : id)),
          });
        })),
    );
    // ③ deck history: the deck being left is saved with its unsent edits.
    const switchDeck = async (name, payload, message) => {
      await action(name, { teamId, ...discussionValues(), ...payload });
      clearDraft();
      render();
      toast(message);
    };
    $('#new-deck')?.addEventListener(
      'click',
      guarded(async () => {
        if (recording) return toast('録音を停止してから新しいデッキにしてください');
        if (!confirm('今のデッキを保存して、新しい空のデッキにしますか？（デッキ＃のアイコンで戻れます。①の音声記録はそのまま残ります）')) return;
        await switchDeck('clearIdea', {}, '新しいデッキにしました');
      }),
    );
    $$('[data-deck-idea]').forEach((b) =>
      b.addEventListener(
        'click',
        guarded(async () => {
          if (recording) return toast('録音を停止してからデッキを切り替えてください');
          await switchDeck('restoreIdea', { ideaId: b.dataset.deckIdea }, b.textContent.trim() + 'に戻しました');
        }),
      ),
    );
    if ($('#discussion-form')) {
      $('#discussion-form').onsubmit = guarded(async (e) => {
        e.preventDefault();
        await action('discussion', { teamId, ...discussionValues(), snapshot: true });
        toast(
          ws.notion ? '記録を保存しました。Notionの履歴に追加します' : '議論の記録を保存しました',
        );
      });
      $$('#discussion-form [data-draft]').forEach((el) =>
        el.addEventListener('change', guarded(saveOutline)),
      );
      // Closing 「原稿を修正する」 puts the corrected text into the article above.
      $('.press-edit').addEventListener(
        'toggle',
        guarded(async (e) => {
          pressEditOpen = e.target.open;
          if (e.target.open) return;
          await saveOutline();
          render();
        }),
      );
    }
  }
  if (tab === 0 && $('#talk-form')) {
    $('#talk-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('discussion', { teamId, transcript: $('#transcript').value, snapshot: true });
      toast(ws.notion ? '記録を保存しました。Notionの履歴に追加します' : '議論の記録を保存しました');
    });
    $('#record-discussion').onclick = guarded(async () => {
      if (talk) {
        stopTalk();
        render();
      } else await startTalk();
    });
    if ($('#talk-engine'))
      $('#talk-engine').onchange = (e) => {
        try {
          localStorage.setItem('workshop-talk-engine', e.target.value);
        } catch {}
        render();
      };
    if (talk) $('#transcript').scrollTop = $('#transcript').scrollHeight;
  }
  $$('[data-idea-entry]').forEach(
    (b) =>
      (b.onclick = () => {
        const e = ideaEntries().find((x) => x.target === b.dataset.ideaEntry);
        if (e)
          openDialog(
            `<h2>${esc(e.team.name)}${e.label ? ' · ' + e.label : ''}</h2><img class="image-large" src="${e.src}" alt="アイディア拡大画像"><div class="summary-preview">${summaryHTML(e.discussion)}</div>`,
          );
      }),
  );
  $$('[data-image]').forEach(
    (b) =>
      (b.onclick = () =>
        openDialog(
          `<h2>${esc(ws.teams[b.dataset.image].name)}</h2><img class="image-large" src="data:image/png;base64,${ws.teams[b.dataset.image].image.base64}" alt="アイディア拡大画像"><div class="summary-preview">${summaryHTML(ws.teams[b.dataset.image].discussion)}</div>`,
        )),
  );
}
function discussionValues() {
  return {
    ...Object.fromEntries(
      ['transcript', 'headline', 'pressRelease', 'what', 'who', 'how', 'points', 'keywords'].map(
        (k) => [k, $('#' + k)?.value ?? team().discussion[k] ?? ''],
      ),
    ),
    features: [0, 1, 2].map(
      (i) => String($('#feature-' + i)?.value ?? team().discussion.features?.[i] ?? '').replace(/\s*\n\s*/g, ' '),
    ),
  };
}
function summaryHTML(d) {
  const words = String(d.keywords || '')
    .split(/[、,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const bold = (v) => {
    const value = String(v || '');
    if (!words.length) return esc(value);
    const pattern = new RegExp(
      words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g',
    );
    let end = 0,
      out = '';
    for (const m of value.matchAll(pattern)) {
      out += esc(value.slice(end, m.index)) + `<strong>${esc(m[0])}</strong>`;
      end = m.index + m[0].length;
    }
    return out + esc(value.slice(end));
  };
  return `一言で言うと　${bold(d.headline)}\nWho　${bold(d.who)}\nWhat　${bold(d.what)}\nHow　${bold(d.how)}\n\n３つの特長\n${(
    d.features || []
  )
    .filter(Boolean)
    .map((x) => '・' + bold(x))
    .join('\n')}\n\n${bold(d.pressRelease)}\n\n${String(d.points || '')
    .split('\n')
    .filter(Boolean)
    .map((x) => '・' + bold(x))
    .join('\n')}`;
}
async function runAI(task, extra = {}) {
  const origin = { workshop: ws.id, teamId, tab };
  if (editing && !(task === 'transcribe' && extra.destination === 'map'))
    throw Error('AI処理の前に、入力した内容を保存してください。');
  toast('承認済みの接続先で処理しています…');
  const p = await api(`/api/workshops/${ws.id}/ai`, { task, teamId, ...extra });
  if (origin.workshop !== ws?.id || origin.teamId !== teamId || origin.tab !== tab)
    throw Error(
      '処理中に画面が切り替わりました。元のチームの画面で結果を確認してください。録音は保持しています。',
    );
  if (task === 'transcribe' && extra.destination === 'map') {
    const text = p.result.text || p.result.transcript || '';
    openDialog(
      `<h2>音声入力を確認</h2><p class="muted">内容を修正し、新しいトピックとしてマップ内で確認してください。</p><textarea id="voice-preview" maxlength="500">${esc(text)}</textarea><button id="use-voice" class="primary">トピックに入力</button>`,
    );
    $('#use-voice').onclick = guarded(() => {
      const text = $('#voice-preview').value;
      if (text.length > 500) throw Error('500文字以内にしてください');
      modal.close();
      beginInline('theme', 'child');
      if (inlineEdit) {
        inlineEdit.text = text;
        render();
      }
    });
    return;
  }
  if (task === 'questions') {
    const questions = Array.isArray(p.result.questions) ? p.result.questions : [];
    openDialog(
      `<h2>視点をひろげる質問</h2><div class="proposal">${esc(questions.join('\n\n') || p.result.text || '質問が返りませんでした')}</div><p class="muted">質問をヒントに、回答をマップの新しい項目として入力してください。</p>`,
    );
    return;
  }
  if (task === 'transcribe' && extra.destination === 'discussion') {
    const text = String(p.result.text || '').trim(),
      input = $('#transcript');
    if (!text || !input)
      throw Error('認識した文字を追加できませんでした。録音を保存・再送できます。');
    const combined = [input.value.trim(), text].filter(Boolean).join('\n');
    if ([...combined].length > 30000)
      throw Error('議論記録が30000文字を超えます。録音を保存してから記録を整理してください');
    input.value = combined;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    remember();
    toast('認識した文字を記録に追加しました。「記録を保存」で共有できます。');
    return;
  }
  if (task === 'summarize' || task === 'pressRelease') {
    ws = await api(`/api/workshops/${ws.id}/apply`, { proposal: p.proposal });
    clearDraft();
    if (task === 'pressRelease') pressEditOpen = false;
    render();
    if (task === 'pressRelease') $('#press-panel')?.scrollIntoView?.({ block: 'start' });
    toast(
      task === 'summarize'
        ? 'たたき台を書き出しました。自由に書き直してください'
        : '模擬プレスを作成しました',
    );
    return;
  }
  const imageData =
    task === 'image'
      ? typeof p.result.pngBase64 === 'string'
        ? `data:image/png;base64,${p.result.pngBase64}`
        : typeof p.result.imageBase64 === 'string' && ['image/jpeg', 'image/webp'].includes(p.result.mime)
          ? `data:${p.result.mime};base64,${p.result.imageBase64}`
          : null
      : null;
  const preview = imageData
      ? `<img class="image-large" id="ai-image-preview" src="${esc(imageData)}" alt="生成画像の適用前プレビュー">`
      : `<div class="proposal">${esc(task === 'pressRelease' ? p.result.text : JSON.stringify(p.result, null, 2))}</div>`;
  openDialog(
    `<h2>AI提案をレビュー</h2><p class="muted">内容を確認してから、チームの共有データに適用してください。${task === 'image' ? '画像の差替時は、このチーム画像への投票がリセットされます。' : ''}</p>${preview}<div class="row section-actions"><button id="apply-ai" class="primary">確認して適用</button><button id="discard-ai">今回は適用しない</button></div>`,
  );
  $('#discard-ai').onclick = () => modal.close();
  $('#apply-ai').onclick = guarded(async () => {
    const extra =
      task === 'image' && typeof p.result.pngBase64 !== 'string'
        ? { pngBase64: await pngFromImage($('#ai-image-preview')) }
        : {};
    ws = await api(`/api/workshops/${ws.id}/apply`, { proposal: p.proposal, ...extra });
    clearDraft();
    modal.close();
    // A new paper prototype is shown where they are compared: ⑤.
    if (task === 'image') tab = 4;
    render();
    if (task === 'pressRelease') $('#press-panel')?.scrollIntoView?.({ block: 'start' });
    toast('確認したAI提案を適用しました');
  });
}
// Convert a previewed JPEG/WebP to PNG (at most 2048 px wide) for the team image.
async function pngFromImage(img) {
  if (!img) throw Error('プレビュー画像がありません');
  if (!img.complete) await new Promise((ok, ng) => ((img.onload = ok), (img.onerror = ng)));
  // Keep the upload under the server's 8 MB request limit.
  for (let width = Math.min(2048, img.naturalWidth); ; width = Math.round(width * 0.8)) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((img.naturalHeight * width) / img.naturalWidth);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    if (base64.length < 7 * 1024 * 1024 || width < 800) return base64;
  }
}
function recordingStatus() {
  if (recording)
    return '<div class="recording-status" role="status"><span>● 録音中 <span id="recording-time">00:00</span></span><label>入力レベル <meter id="recording-level" min="0" max="100" value="0"></meter></label></div>';
  if (transcribing) return '<p class="recording-status" role="status">Gensparkで文字起こし中…</p>';
  if (pendingAudio?.workshop === ws.id && pendingAudio.teamId === teamId)
    return `<div class="recording-status"><span>${pendingAudio.error ? esc(pendingAudio.error) : '録音データを保持しています'}</span>${pendingAudio.error ? '<button type="button" id="retry-recording">文字起こしを再送</button>' : ''}<button type="button" id="download-recording">録音を保存 ↓</button></div>`;
  return '';
}
async function recordingPayload(blob) {
  let data = blob;
  const Context = window.AudioContext || window.webkitAudioContext,
    Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Context && Offline) {
    const context = new Context();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (decoded.duration < 0.25)
        throw Error('録音が短すぎます。１秒以上話してから停止してください。');
      if (decoded.duration > 181)
        throw Error('録音は３分以内に区切ってください。元の録音は保存できます。');
      const offline = new Offline(1, Math.ceil(decoded.duration * 16000), 16000),
        source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const mono = (await offline.startRendering()).getChannelData(0),
        buffer = new ArrayBuffer(44 + mono.length * 2),
        view = new DataView(buffer);
      const write = (at, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
      };
      write(0, 'RIFF');
      view.setUint32(4, buffer.byteLength - 8, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, mono.length * 2, true);
      for (let i = 0; i < mono.length; i++) {
        const n = Math.max(-1, Math.min(1, mono[i]));
        view.setInt16(44 + i * 2, n < 0 ? n * 32768 : n * 32767, true);
      }
      data = new Blob([buffer], { type: 'audio/wav' });
    } finally {
      await context.close();
    }
  }
  if (data.size > 6 * 1024 * 1024)
    throw Error('録音が大きすぎます。短く区切ってください。元の録音は保存できます。');
  const bytes = new Uint8Array(await data.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { audio: btoa(binary), mimeType: data.type || blob.type };
}
async function processRecording(session) {
  if (transcribing) return;
  if (session.workshop !== ws.id || session.teamId !== teamId)
    throw Error('録音したチームに戻って再送してください');
  transcribing = true;
  session.error = '';
  remember();
  render();
  try {
    session.payload ||= await recordingPayload(session.blob);
    if (session.destination === 'discussion' && editing)
      await action('discussion', { teamId, ...discussionValues() });
    await runAI('transcribe', { ...session.payload, destination: session.destination });
  } catch (error) {
    session.error = error.message;
    toast(error.message, true);
  } finally {
    transcribing = false;
    const status = $('#audio-status');
    if (status) {
      status.innerHTML = recordingStatus();
      bindRecordingRecovery();
    }
  }
}
function bindRecordingRecovery() {
  if ($('#retry-recording'))
    $('#retry-recording').onclick = guarded(() => processRecording(pendingAudio));
  if ($('#download-recording'))
    $('#download-recording').onclick = () => {
      const url = URL.createObjectURL(pendingAudio.blob),
        link = document.createElement('a');
      link.href = url;
      link.download =
        'workshop-recording.' +
        (pendingAudio.blob.type.includes('mp4')
          ? 'm4a'
          : pendingAudio.blob.type.includes('ogg')
            ? 'ogg'
            : 'webm');
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
}
async function recordAudio(destination) {
  if (transcribing) throw Error('文字起こしが終わるまでお待ちください');
  if (recording) {
    if (recording.recorder.state === 'recording') recording.recorder.stop();
    return;
  }
  if (recordingStarting) return;
  if (talk) throw Error('①の録音中は、マップの音声入力を使えません');
  if (!aiAvailable('transcribe'))
    throw Error('認可済み音声認識が未設定です。キーボードで入力してください。');
  if (!editableTeam()) throw Error('このチームは閲覧のみです');
  if (editing && destination !== 'map') throw Error('録音の前に入力内容を保存してください');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    throw Error('このブラウザーでは録音できません。HTTPS環境を確認してください。');
  const original = { workshop: ws.id, teamId, tab };
  recordingStarting = true;
  remember();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } finally {
    recordingStarting = false;
  }
  if (original.workshop !== ws?.id || original.teamId !== teamId || original.tab !== tab) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const chunks = [],
    mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
    session = { recorder, stream, destination };
  let size = 0;
  recording = session;
  recorder.ondataavailable = (e) => {
    chunks.push(e.data);
    size += e.data.size;
    if (size > 6 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
  };
  recorder.onstop = async () => {
    clearTimeout(session.limit);
    clearInterval(session.meterTimer);
    void session.meterContext?.close();
    stream.getTracks().forEach((t) => t.stop());
    if (recording === session) recording = null;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    pendingAudio = { blob, destination, ...original };
    remember();
    render();
    if (original.workshop !== ws?.id || original.teamId !== teamId || original.tab !== tab) return;
    if (blob.size < 128) {
      pendingAudio.error = '録音データが空です。マイクを選び、音量を確認してください。';
      render();
      return;
    }
    await processRecording(pendingAudio);
  };
  recorder.onerror = () => {
    toast('録音中にエラーが発生しました。マイクの接続を確認してください。', true);
    if (recorder.state === 'recording') recorder.stop();
  };
  session.limit = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, 180000);
  session.startedAt = Date.now();
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) {
      session.meterContext = new Context();
      const analyser = session.meterContext.createAnalyser();
      analyser.fftSize = 256;
      session.meterContext.createMediaStreamSource(stream).connect(analyser);
      const levels = new Uint8Array(analyser.fftSize);
      session.meterTimer = setInterval(() => {
        analyser.getByteTimeDomainData(levels);
        const rms = Math.sqrt(
            levels.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / levels.length,
          ),
          meter = $('#recording-level'),
          time = $('#recording-time');
        if (meter) meter.value = Math.min(100, rms * 400);
        if (time) {
          const n = Math.floor((Date.now() - session.startedAt) / 1000);
          time.textContent =
            String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
        }
      }, 150);
    }
  } catch {}
  recorder.start(1000);
  render();
  toast('録音中です。もう一度マイクボタンを押すと停止します。');
}
function stopRecording() {
  const session = recording;
  if (!session) return;
  recording = null;
  clearTimeout(session.limit);
  clearInterval(session.meterTimer);
  void session.meterContext?.close();
  session.recorder.onstop = () => session.stream.getTracks().forEach((t) => t.stop());
  if (session.recorder.state === 'recording') session.recorder.stop();
  session.stream.getTracks().forEach((t) => t.stop());
}

// ---- ① voice log -------------------------------------------------------------
// While it is on, speech keeps being added to the team's record on the server, on any tab.
// Two engines: the browser's own speech recognition (free, text as you speak), or one-minute
// recordings turned into text by Genspark (uses credits; better punctuation).
let talkNote = '';
const TALK_FLUSH_MS = 8000;
function talkEngine() {
  let saved = '';
  try {
    saved = localStorage.getItem('workshop-talk-engine') || '';
  } catch {}
  if (saved === 'genspark' && aiAvailable('transcribe')) return 'genspark';
  return SpeechRec ? 'browser' : 'genspark';
}
function talkStatus() {
  if (talk)
    return `<div class="recording-status" role="status"><span>● 録音中 <span id="talk-time">00:00</span></span><span id="talk-queue"></span>${talk.engine === 'browser' ? '<span id="talk-interim" class="talk-interim"></span>' : '<label>入力レベル <meter id="recording-level" min="0" max="100" value="0"></meter></label>'}</div>${talk.error ? `<p class="recording-status talk-error">${esc(talk.error)}</p>` : ''}`;
  return talkNote ? `<p class="recording-status" role="status">${esc(talkNote)}</p>` : '';
}
function refreshTalk() {
  $$('.rec-dot').forEach((el) => (el.hidden = !talk));
  if (!talk) return;
  const time = $('#talk-time'),
    queue = $('#talk-queue'),
    interim = $('#talk-interim'),
    n = Math.floor((Date.now() - talk.startedAt) / 1000),
    two = (v) => String(v).padStart(2, '0');
  if (time)
    time.textContent =
      (n >= 3600 ? Math.floor(n / 3600) + ':' : '') +
      two(Math.floor((n % 3600) / 60)) +
      ':' +
      two(n % 60);
  if (queue)
    queue.textContent = talk.waiting
      ? talk.engine === 'browser'
        ? '保存中…'
        : `文字起こし中 ${talk.waiting}件`
      : '';
  if (interim) interim.textContent = [...talk.buffer, talk.interim].filter(Boolean).join('。');
}
async function startTalk() {
  if (talk || recordingStarting) return;
  if (recording) throw Error('マップの音声入力を停止してから開始してください');
  const engine = talkEngine();
  if (engine === 'genspark' && !aiAvailable('transcribe'))
    throw Error(
      'このブラウザーには音声認識がなく、Gensparkの音声認識も未設定です。Chrome／Edgeで開くか、キーボードで入力してください。',
    );
  if (!editableTeam()) throw Error('このワークショップは閲覧のみです');
  if (editing) throw Error('録音の前に入力内容を保存してください');
  const origin = { workshop: ws.id, teamId };
  const session = {
    ...origin,
    engine,
    startedAt: Date.now(),
    waiting: 0,
    error: '',
    buffer: [],
    interim: '',
    queue: Promise.resolve(),
  };
  if (engine === 'browser') {
    talk = session;
    talkNote = '';
    talkStartMark(session);
    talkListen(session);
    session.flushTimer = setInterval(() => talkFlush(session), TALK_FLUSH_MS);
  } else {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw Error('このブラウザーでは録音できません。HTTPS環境を確認してください。');
    recordingStarting = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } finally {
      recordingStarting = false;
    }
    if (origin.workshop !== ws?.id || origin.teamId !== teamId) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    session.stream = stream;
    talk = session;
    talkNote = '';
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) {
        session.meterContext = new Context();
        const analyser = session.meterContext.createAnalyser();
        analyser.fftSize = 256;
        session.meterContext.createMediaStreamSource(stream).connect(analyser);
        const levels = new Uint8Array(analyser.fftSize);
        session.meterTimer = setInterval(() => {
          analyser.getByteTimeDomainData(levels);
          const rms = Math.sqrt(
              levels.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / levels.length,
            ),
            meter = $('#recording-level');
          if (meter) meter.value = Math.min(100, rms * 400);
        }, 150);
      }
    } catch {}
    talkStartMark(session);
    talkSegment(session);
  }
  render();
  toast('録音を開始しました。停止するまで、話した内容が記録にたまっていきます。');
}
// Browser engine: recognition ends by itself after a pause in speech, so it is started again
// for as long as the recording is on.
function talkListen(session) {
  const rec = new SpeechRec();
  session.rec = rec;
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const words = e.results[i][0].transcript.trim();
      if (!words) continue;
      if (e.results[i].isFinal) session.buffer.push(words);
      else interim += words;
    }
    session.interim = interim;
    refreshTalk();
  };
  rec.onerror = (e) => {
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
      session.fatal = true;
      session.error =
        'マイクまたは音声認識を使えません。ブラウザーのマイクの許可を確認してください。';
    } else if (e.error === 'network')
      session.error = '音声認識サーバーに接続できません。接続が戻ると再開します。';
  };
  rec.onend = () => {
    session.interim = '';
    if (talk === session && session.fatal) {
      stopTalk();
      render();
    } else if (talk === session && !session.paused)
      setTimeout(() => {
        if (talk === session && !session.paused && session.rec === rec) talkListen(session);
      }, 300);
    else if (talk !== session) talkFlush(session);
  };
  try {
    rec.start();
  } catch {}
}
// The AI chat's voice input needs the recogniser for a moment.
function pauseTalk() {
  if (talk?.engine !== 'browser' || talk.paused) return;
  talk.paused = true;
  talk.rec?.stop();
}
function resumeTalk() {
  if (talk?.engine !== 'browser' || !talk.paused) return;
  talk.paused = false;
  talkListen(talk);
}
// Each recording starts with a numbered line (＃01 10:15:30) and ends with a divider, so
// the record shows where one recording stops and the next begins.
const clockTime = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });
function talkMark(session, line) {
  session.waiting++;
  session.queue = session.queue.then(async () => {
    try {
      const latest = await api(`/api/workshops/${session.workshop}/transcript`, {
        teamId: session.teamId,
        text: typeof line === 'function' ? line() : line,
      });
      talkApplied(session, latest, typeof line === 'function' ? line() : line);
    } catch (e) {
      session.error = `記録に書き込めませんでした：${e.message}`;
    } finally {
      session.waiting--;
      talkFinished(session);
      refreshTalk();
    }
  });
}
function talkStartMark(session) {
  const n = (String(ws.teams[session.teamId]?.discussion.transcript || '').match(/^#\d+ /gm) || [])
    .length;
  talkMark(session, `#${String(n + 1).padStart(2, '0')} ${clockTime()}`);
}
const talkEndMark = (session) =>
  talkMark(session, () => `―――――――― 録音終了 ${clockTime()} ――――――――`);
// Recognised sentences are sent every few seconds, in order.
function talkFlush(session) {
  if (!session.buffer.length) return talkFinished(session);
  const words = session.buffer.splice(0).join('。') + '。';
  session.waiting++;
  session.queue = session.queue.then(async () => {
    try {
      const latest = await api(`/api/workshops/${session.workshop}/transcript`, {
        teamId: session.teamId,
        text: words,
      });
      talkApplied(session, latest, words);
      session.error = '';
    } catch (e) {
      session.error = `保存できなかった発言があります：${e.message}`;
    } finally {
      session.waiting--;
      talkFinished(session);
      refreshTalk();
    }
  });
}
// Genspark engine: the microphone is recorded in one-minute pieces.
function talkSegment(session) {
  const chunks = [],
    mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    ),
    recorder = new MediaRecorder(session.stream, mimeType ? { mimeType } : undefined);
  session.recorder = recorder;
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    clearTimeout(session.timer);
    // The next piece starts at once, so almost nothing is lost between pieces.
    if (talk === session) talkSegment(session);
    else session.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    if (blob.size >= 128) {
      session.waiting++;
      session.queue = session.queue.then(() => talkTranscribe(session, blob));
    } else talkFinished(session);
    refreshTalk();
  };
  recorder.onerror = () => {
    session.error = '録音中にエラーが発生しました。マイクの接続を確認してください。';
    if (recorder.state === 'recording') recorder.stop();
  };
  session.timer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, TALK_SEGMENT_MS);
  recorder.start(1000);
}
function stopTalk() {
  const session = talk;
  if (!session) return;
  talk = null;
  clearTimeout(session.timer);
  clearInterval(session.meterTimer);
  clearInterval(session.flushTimer);
  void session.meterContext?.close();
  talkNote = '録音を停止しました。残りの音声を文字にしています…';
  if (session.engine === 'browser') {
    // The recogniser hands over its last words when it ends; then they are sent.
    if (session.paused || !session.rec) talkFlush(session);
    else
      try {
        session.rec.stop();
      } catch {
        talkFlush(session);
      }
    setTimeout(() => {
      talkFlush(session);
      talkEndMark(session);
    }, 1500);
    return;
  }
  // The last piece joins the queue when the recorder stops; the divider follows it.
  setTimeout(() => talkEndMark(session), 400);
  // Stopping the recorder hands its last piece to the transcription queue.
  if (session.recorder?.state === 'recording') session.recorder.stop();
  else {
    session.stream.getTracks().forEach((t) => t.stop());
    talkFinished(session);
  }
}
function talkFinished(session) {
  if (talk === session || session.waiting || session.buffer.length) return;
  talkNote = session.error || (talk ? talkNote : '録音を停止しました。記録は保存済みです。');
  const status = $('#audio-status');
  if (status && tab === 0 && !talk) status.innerHTML = talkStatus();
}
async function talkTranscribe(session, blob) {
  try {
    const payload = await recordingPayload(blob);
    const p = await api(`/api/workshops/${session.workshop}/ai`, {
      task: 'transcribe',
      teamId: session.teamId,
      ...payload,
      destination: 'discussion',
    });
    const words = String(p.result.text || '').trim();
    if (words) {
      const latest = await api(`/api/workshops/${session.workshop}/apply`, {
        proposal: p.proposal,
      });
      talkApplied(session, latest, words);
    }
    session.error = '';
  } catch (e) {
    // A piece with no speech at its very end is too short to transcribe; that is not an error.
    if (!/短すぎ/.test(e.message))
      session.error = `文字にできなかった区間があります：${e.message}`;
  } finally {
    session.waiting--;
    talkFinished(session);
    refreshTalk();
  }
}
function talkApplied(session, latest, words) {
  if (ws?.id !== session.workshop || teamId !== session.teamId || tab !== 0) {
    // A draft typed in ① earlier gets the new words too, so saving it later loses nothing.
    const draft = drafts.get(`${session.workshop}/${session.teamId}/0`);
    if (draft?.transcript !== undefined)
      draft.transcript = [draft.transcript.trim(), words].filter(Boolean).join('\n');
    return;
  }
  // On the other tabs the regular refresh picks the new record up.
  const input = $('#transcript');
  if (editing && input) {
    // Text being typed stays; the new words join it, as they already did on the server.
    ws = latest;
    input.value = [input.value.trim(), words].filter(Boolean).join('\n');
    remember();
    input.scrollTop = input.scrollHeight;
  } else if (!modal.open) {
    ws = latest;
    render();
  }
}
function updateClocks() {
  if (!ws) return;
  refreshTalk();
  refreshVotingUI();
  $$('[data-clock]').forEach((el) => {
    const timer = ws.timers[el.dataset.clock],
      seconds =
        timer && !timer.closed
          ? Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000))
          : ws.durations[el.dataset.clock];
    el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    el.title = timer?.closed ? '受付終了' : timer ? '受付中' : '開始待ち';
  });
  $$('[data-vote]').forEach((b) => {
    if (!votingOpen(b.dataset.vote)) b.disabled = true;
  });
}
function accountDialog() {
  openDialog(
    `<h2>アカウント設定</h2><p class="muted">${esc(me.email)}</p><form id="password-form"><label for="current-password">現在のパスワード（初回設定は空欄）</label><input id="current-password" type="password" autocomplete="current-password" maxlength="200"><label for="new-password">新しいパスワード（12〜200文字）</label><input id="new-password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><label for="confirm-password">新しいパスワードを再入力</label><input id="confirm-password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><p class="muted">初回設定はログインから15分以内に行ってください。変更すると、他のログイン済み端末はログアウトします。</p><button class="primary">パスワードを保存</button></form>`,
  );
  $('#password-form').onsubmit = guarded(async (e) => {
    e.preventDefault();
    if ($('#new-password').value !== $('#confirm-password').value)
      throw Error('確認用パスワードが一致しません');
    await api('/api/password', {
      password: $('#new-password').value,
      currentPassword: $('#current-password').value,
    });
    modal.close();
    toast('パスワードを保存しました');
  });
}
function newWorkshopDialog() {
  openDialog(
    '<h2>ワークショップを作成</h2><form id="create-workshop"><label for="ws-name">ワークショップ名</label><input id="ws-name" required maxlength="200"><label for="ws-theme">テーマ</label><textarea id="ws-theme" maxlength="500"></textarea><label for="ws-end">終了日（日本時間の23:59まで有効）</label><input id="ws-end" type="date"><p class="muted">Notion接続済みの場合は、ワークショップ一覧へ「ワークショップテンプレート」で自動登録します。</p><button class="primary">作成する</button></form>',
  );
  const creationRequestId = crypto.randomUUID();
  $('#create-workshop').onsubmit = guarded(async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector('button');
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await api('/api/workshops', {
        requestId: creationRequestId,
        name: $('#ws-name').value,
        theme: $('#ws-theme').value || $('#ws-name').value,
        endDate: $('#ws-end').value || null,
      });
      modal.close();
      workshops = await api('/api/workshops');
      await loadWorkshop(result.id);
    } finally {
      submit.disabled = false;
    }
  });
}
async function settings() {
  me = await api('/api/me');
  const facilitator = await api('/api/facilitator');
  const teams = Object.values(ws?.teams || {}),
    connection = me.notion;
  openDialog(
    `<div class="settings"><div class="eyebrow">FACILITATOR SETTINGS</div><h2>ワークショップの設定</h2>${
      ws
        ? `<section><h3>基本情報・進行状態</h3><form id="meta-form"><div class="grid"><div><label for="meta-name">名前</label><input id="meta-name" value="${esc(ws.name)}" required maxlength="200"><label for="meta-theme">テーマ</label><textarea id="meta-theme" maxlength="500">${esc(ws.theme)}</textarea></div><div><label for="meta-status">ステータス</label><select id="meta-status">${['未着手', '進行中', '完了（変更不可）', '破棄（閲覧不可）'].map((s) => `<option${s === ws.status ? ' selected' : ''}>${s}</option>`).join('')}</select><label for="meta-end">終了日（日本時間・当日まで有効）</label><input type="date" id="meta-end" value="${esc(ws.endDate?.slice(0, 10) || '')}"></div></div><div class="row section-actions"><button class="primary"${disabled(!ws.notion?.conflict)}>基本情報を保存</button><button type="button" id="delete-workshop" class="text-button danger">削除する</button></div></form><p class="muted">完了は閲覧のみ、破棄は参加者の閲覧を停止します。期限超過時は自動的に破棄されます。</p></section><section><h3>投票の設定</h3><form id="vote-settings"><div class="grid">${['cards', 'ideas'].map((p, i) => `<div><label for="budget-${p}">${i === 0 ? '② カード投票' : '⑤ アイディア投票'}：1人あたりの票数</label><input id="budget-${p}" type="number" min="1" max="100" value="${ws.budgets[p]}" required><label for="duration-${p}">投票時間（秒）</label><input id="duration-${p}" type="number" min="10" max="3600" value="${ws.durations[p]}" required></div>`).join('')}</div><p class="muted">時間の変更は次の「開始 / 再開」から反映されます。投票の取消も受付時間中に操作できます。</p><button class="primary"${disabled(writable())}>投票設定を保存</button></form></section><section><h3>表示の設定</h3><form id="display-settings" class="row"><label for="text-scale">①・④ ディスカッションの記録・アイデアの輪郭・３つの特長の文字サイズ</label><select id="text-scale">${[
          [100, '標準'],
          [115, '大きい（既定）'],
          [130, 'さらに大きい'],
          [150, '特大'],
        ]
          .map(([v, l]) => `<option value="${v}"${v === (ws.textScale || 115) ? ' selected' : ''}>${l}（${v}%）</option>`)
          .join('')}</select><label for="ai-character">AIアドバイスのキャラクター</label><select id="ai-character">${Object.entries(characterLabels).map(([v, l]) => `<option value="${v}"${v === currentCharacter() ? ' selected' : ''}>${l}</option>`).join('')}</select><button class="primary">表示設定を保存</button></form><p class="muted">参加者全員の画面に反映されます。</p></section><section><h3>チームと参加者</h3><form id="team-form" class="row"><input id="team-name" placeholder="新しいチーム名" required maxlength="80"><button${disabled(writable())}>チーム追加</button></form><form id="member-form"><div class="grid"><div><label for="member-email">登録メールアドレス</label><input id="member-email" type="email" required maxlength="254"></div><div><label for="member-role">権限</label><select id="member-role"><option>編集者</option><option>閲覧者</option><option>管理者</option></select></div><div><label for="member-password">初期パスワード（ローカル管理時のみ・任意）</label><input id="member-password" type="password" autocomplete="new-password" minlength="12" maxlength="200"${disabled(!ws.notion)}></div></div><button class="primary section-actions"${disabled(!ws.deleted)}>参加者を登録 / 更新</button></form><table><thead><tr><th>メールアドレス</th><th>権限</th><th></th></tr></thead><tbody>${Object.entries(
            ws.members || {},
          )
            .map(
              ([email, m]) =>
                `<tr><td>${esc(email)}</td><td>${esc(m.role)}</td><td><button data-edit-member="${esc(email)}" class="text-button">編集</button></td></tr>`,
            )
            .join(
              '',
            )}</tbody></table><div class="qr-area"><img class="qr" src="/api/workshops/${ws.id}/qr" alt="参加用QRコード"><div><h3>参加用QR</h3><p class="muted">QRを読み、メールの認証コードが通った人を、編集者として自動で登録します。<br>投影用の大きな表示は、左のメニューの「参加用QRコードを表示」から開けます。</p><a href="${esc(location.origin + '/?join=' + ws.id)}" target="_blank" rel="noopener">参加ページを開く ↗</a></div></div></section>`
        : ''
    }<section><h3>Notion連携</h3>${contentStatus()}<p class="muted">${connection.enabled ? '長期API接続を設定済み。' : '長期APIトークンとWS一覧のデータソースIDは、サーバー環境変数で設定してください。'} ${connection.at ? '最終同期 ' + new Date(connection.at).toLocaleString('ja-JP') : ''}</p>${connection.error ? `<div class="warning">${esc(connection.error)}</div>` : ''}<div class="row section-actions"><button id="notion-sync"${disabled(connection.enabled)}>今すぐ同期</button>${ws && !ws.notion ? `<button id="notion-publish"${disabled(connection.enabled && !ws.createAttempt)}>このWSをNotionへ接続</button>` : ''}</div>${ws?.createAttempt && !ws.notion ? '<p class="error">ページ作成結果が不明です。docs/NOTION.mdの照合手順を確認してください。</p>' : ''}${ws?.notion?.conflict ? `<div class="conflict"><strong>更新の競合</strong><pre class="proposal">${esc(JSON.stringify(ws.notion.conflict.remote, null, 2))}</pre><div class="row"><button data-resolve="notion">Notion側を採用</button><button data-resolve="app">アプリ側を採用</button></div></div>` : ''}</section><section><h3>AIファシリテータの動作（Markdown）</h3><p class="muted">このmdをAIの指示として読み込みます。AI未接続時は先頭設定の基本ガイドを使います。JSON設定ブロックを保持してください。</p><form id="facilitator-form"><label for="facilitator-md">ファシリテータ用md</label><textarea id="facilitator-md" class="markdown-editor" spellcheck="false" maxlength="120000">${esc(facilitator.markdown)}</textarea><div class="row"><button class="primary">mdを保存</button><a href="/api/facilitator/export">mdをダウンロード ↓</a></div><p id="facilitator-save-status" role="status"></p></form></section><section><h3>Gensparkのクレジット消費（実測）</h3><p>${creditLabel() || 'Genspark未接続'}</p>${creditUsageTable()}</section><section><h3>AI接続とモデル</h3><p class="muted">AIはすべてGenspark経由で実行します。画像モデルは下の「画像モデル」で選べます（現在：${esc(me.ai.imageModel || 'gpt-image-2')}）。</p><div class="genspark-test"><button type="button" id="genspark-diagnose"${disabled(me.ai.approved.some((p) => p.id === 'genspark-gsk' && p.ready))}>Genspark接続テスト</button><div id="genspark-diagnose-status" role="status">${me.ai.lastError ? `<p class="warning">最後のAIエラー（${esc(new Date(me.ai.lastError.at).toLocaleString('ja-JP'))}）：${esc(me.ai.lastError.message)}</p>` : ''}</div></div><div class="genspark-browser-login"><button id="genspark-browser-login" class="primary">Gensparkにブラウザーで接続</button><p>① 接続ボタンを押す → ② Gensparkで会社のアカウントにログインして許可 → ③ この画面に戻り「接続済み」を確認。</p><div id="genspark-login-status" role="status"></div></div><details><summary>APIキーを手動で登録する場合</summary><form id="genspark-connect"><label for="genspark-api-key">Genspark GSK APIキー（秘密設定）</label><input id="genspark-api-key" type="password" autocomplete="new-password" placeholder="gsk_… または gsk-…" maxlength="1000" required><button class="primary">Gensparkに接続</button><p class="muted">サーバーにのみ保存します。登録後はキーを表示しません。</p></form></details><form id="ai-settings"><label for="ai-provider">使用サービス</label><select id="ai-provider"><option value="genspark-enterprise">Genspark Enterprise（既定）</option>${me.ai.approved
      .filter((p) => p.id !== 'genspark-enterprise')
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
      .join(
        '',
      )}</select><label for="ai-model">文章モデル（空欄＝無料・低コストのモデルを自動で選択）</label><input id="ai-model" value="${esc(me.ai.model)}" maxlength="100" placeholder="未指定"><label for="ai-image-model">画像モデル（企画提案シート）</label><div class="row"><input id="ai-image-model" value="${esc(me.ai.imageModel || 'gpt-image-2')}" maxlength="100" placeholder="gpt-image-2" list="ai-image-model-list"><datalist id="ai-image-model-list"></datalist><button type="button" id="check-image-models">Gensparkで使えるか確認</button></div><p id="image-model-status" class="muted" role="status"></p><label for="ai-press-prompt">模擬プレスリリース作成用プロンプト</label><textarea id="ai-press-prompt" class="generation-prompt" maxlength="6000">${esc(me.ai.pressReleasePrompt || '')}</textarea><label for="ai-prompt">企画提案シート作成用プロンプト（Genspark / ${esc(me.ai.imageModel || 'gpt-image-2')}）</label><textarea id="ai-prompt" class="generation-prompt" maxlength="6000">${esc(me.ai.imagePrompt)}</textarea><p class="muted">質問・分類・文字起こし・文章生成・画像生成はGensparkのみを使用します。文章モデルを空欄にするとGensparkの契約既定モデルを使います。</p><button class="primary">AI設定を保存</button></form></section>${ws ? `<section><h3>成果物の保存</h3><p class="muted">WSの状態を「完了（変更不可）」にすると、管理者がPNG・Markdownを保存できます。</p>${ws.status === '完了（変更不可）' ? teams.map((t) => `<div class="export-links"><strong class="muted">${esc(t.name)}</strong><a href="/api/workshops/${ws.id}/export?team=${t.id}&format=md">文章 Markdown ↓</a>${t.image ? `<a href="/api/workshops/${ws.id}/export?team=${t.id}&format=png">画像 PNG ↓</a>` : ''}</div>`).join('') : ''}<button id="notion-results"${disabled(ws.status === '完了（変更不可）' && !!ws.notion && connection.enabled)}>NotionのWS配下へ成果を保存</button></section>` : ''}</div>`,
  );
  bindContentStatus();
  if (ws) {
    $('#meta-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      ws = await api(`/api/workshops/${ws.id}/meta`, {
        revision: ws.revision,
        name: $('#meta-name').value,
        theme: $('#meta-theme').value,
        status: $('#meta-status').value,
        endDate: $('#meta-end').value || null,
      });
      await refreshSettings('基本情報を保存しました');
    });
    $('#delete-workshop').onclick = guarded(async () => {
      if (!confirm('このWSを削除し、参加者の閲覧を停止しますか？管理者の記録は残ります。')) return;
      ws = await api(`/api/workshops/${ws.id}/meta`, { revision: ws.revision, deleted: true });
      modal.close();
      workshops = await api('/api/workshops');
      render();
    });
    $('#vote-settings').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('settings', {
        budgets: Object.fromEntries(
          ['cards', 'ideas'].map((p) => [p, Number($('#budget-' + p).value)]),
        ),
        durations: Object.fromEntries(
          ['cards', 'ideas'].map((p) => [p, Number($('#duration-' + p).value)]),
        ),
      });
      await settings();
      toast('投票設定を保存しました');
    });
    $('#display-settings').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('settings', { textScale: Number($('#text-scale').value), character: $('#ai-character').value });
      await settings();
      toast('表示設定を保存しました');
    });
    $('#team-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('addTeam', { name: $('#team-name').value });
      await settings();
    });
    $('#member-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      ws = await api(`/api/workshops/${ws.id}/members`, {
        email: $('#member-email').value,
        role: $('#member-role').value,
        password: $('#member-password').value,
      });
      await refreshSettings('参加者を更新しました');
    });
    $$('[data-edit-member]').forEach(
      (b) =>
        (b.onclick = () => {
          const email = b.dataset.editMember,
            m = ws.members[email];
          $('#member-email').value = email;
          $('#member-role').value = m.role;
          $('#member-email').focus();
        }),
    );
    if ($('#notion-publish'))
      $('#notion-publish').onclick = guarded(async () => {
        ws = await api(`/api/workshops/${ws.id}/publish`, {});
        await refreshSettings('Notionページと参加者DBを作成しました');
      });
    $$('[data-resolve]').forEach(
      (b) =>
        (b.onclick = guarded(async () => {
          await api(`/api/workshops/${ws.id}/resolve`, { choice: b.dataset.resolve });
          ws = await api(`/api/workshops/${ws.id}`);
          await refreshSettings('競合を解決しました');
        })),
    );
    $('#notion-results').onclick = guarded(async () => {
      await api(`/api/workshops/${ws.id}/results`, {});
      toast('NotionのWS配下へ成果を保存しました');
    });
  }
  $('#notion-sync').onclick = guarded(async () => {
    await api('/api/notion/sync', {});
    if (ws) ws = await api(`/api/workshops/${ws.id}`);
    await refreshSettings('Notionと同期しました');
  });
  $('#facilitator-form').onsubmit = guarded(async (e) => {
    e.preventDefault();
    const saved = await api('/api/facilitator', {
      markdown: $('#facilitator-md').value,
      version: facilitator.version,
    });
    Object.assign(facilitator, saved);
    me.facilitator = saved;
    $('#facilitator-save-status').textContent = 'mdを保存しました。次の助言から反映します。';
  });
  $('#ai-provider').value = me.ai.provider;
  $('#genspark-browser-login').onclick = guarded(async () => {
    const button = $('#genspark-browser-login'),
      status = $('#genspark-login-status');
    button.disabled = true;
    try {
      const login = await api('/api/ai/login/start', {});
      status.innerHTML = `<p><a href="${esc(login.authUrl)}" target="_blank" rel="noopener noreferrer">Gensparkを開いて接続を許可する ↗</a></p><p>認証が終わったら、この画面へ戻ってください。</p>`;
      window.open(login.authUrl, '_blank', 'noopener,noreferrer');
      const pollLogin = async () => {
        if (!status.isConnected) return;
        if (Date.now() > login.expiresAt) {
          status.textContent = '認証期限が切れました。接続ボタンからやり直してください。';
          button.disabled = false;
          return;
        }
        try {
          const result = await api('/api/ai/login/poll', { requestId: login.requestId });
          if (result.status === 'connected') {
            me.ai = result.ai;
            status.textContent = 'Genspark 接続済み。AIアドバイス・録音・画像生成を使用できます。';
            button.disabled = false;
            return;
          }
          if (result.status === 'expired') {
            status.textContent = '認証期限が切れました。やり直してください。';
            button.disabled = false;
            return;
          }
          setTimeout(pollLogin, login.pollMs);
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      };
      setTimeout(pollLogin, login.pollMs);
    } catch (error) {
      button.disabled = false;
      throw error;
    }
  });
  $('#genspark-connect').onsubmit = guarded(async (e) => {
    e.preventDefault();
    const input = $('#genspark-api-key'),
      button = $('#genspark-connect button');
    button.disabled = true;
    try {
      me.ai = await api('/api/ai/connect', { apiKey: input.value.trim() });
      input.value = '';
      modal.close();
      await settings();
      toast('Gensparkに接続しました');
    } finally {
      input.value = '';
      if (button.isConnected) button.disabled = false;
    }
  });
  $('#genspark-diagnose').onclick = guarded(async () => {
    const out = $('#genspark-diagnose-status');
    out.textContent = 'Gensparkに順番に接続しています…';
    try {
      const r = await api('/api/ai/diagnose', {});
      out.innerHTML = `<p class="${r.ok ? 'muted' : 'warning'}">${r.ok ? '接続できています。' : '接続に問題があります。'}（キー形式 ${esc(r.keyType)} / 使用サービス ${esc(r.provider)}${r.toolCount !== null ? ' / ツール ' + r.toolCount + '件' : ''}）</p><ul class="diagnose-steps">${r.steps.map((s) => `<li>${s.ok ? '✓' : '✗'} ${esc(s.name)}：${s.status || '通信失敗'}${s.detail ? ' — ' + esc(s.detail) : ''}（${s.ms}ms）</li>`).join('')}</ul>`;
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $('#check-image-models').onclick = guarded(async () => {
    const status = $('#image-model-status'),
      wanted = $('#ai-image-model').value.trim();
    status.textContent = 'Gensparkに問い合わせています…';
    try {
      const r = await api('/api/ai/image-models');
      $('#ai-image-model-list').innerHTML = r.available
        .map((m) => `<option value="${esc(m)}"></option>`)
        .join('');
      const gpt = r.available.filter((m) => m.includes('gpt-image'));
      status.textContent = !r.available.length
        ? 'Gensparkからモデル一覧を取得できませんでした。保存したモデルでそのまま生成を試します。'
        : r.available.includes(wanted)
          ? `「${wanted}」はGensparkで使えます。`
          : `「${wanted}」は現在Gensparkで使えません。使えるGPT画像モデル：${gpt.join('、') || 'なし'}（ほか${r.available.length - gpt.length}件）`;
    } catch (e) {
      status.textContent = e.message;
    }
  });
  $('#ai-settings').onsubmit = guarded(async (e) => {
    e.preventDefault();
    me.ai = await api('/api/ai/settings', {
      provider: $('#ai-provider').value,
      model: $('#ai-model').value,
      imageModel: $('#ai-image-model').value.trim(),
      imagePrompt: $('#ai-prompt').value,
      pressReleasePrompt: $('#ai-press-prompt').value,
    });
    toast('AI設定を保存しました');
    render();
  });
}
async function refreshSettings(message) {
  workshops = await api('/api/workshops');
  modal.close();
  render();
  await settings();
  toast(message);
}
function showPending() {
  const el = $('#sync-banner');
  if (!el) return;
  el.innerHTML = pending
    ? '<div class="warning sync-banner">チームの共有内容が更新されました。入力中の内容は画面に保持しています。<button id="load-pending" class="text-button">最新の共有内容を表示</button></div>'
    : '';
  if (pending)
    $('#load-pending').onclick = () => {
      remember();
      if (
        inlineEdit &&
        !inlineEdit.isNew &&
        !pending.teams[teamId]?.nodes.some((n) => n.id === inlineEdit.id) &&
        inlineEdit.id !== 'theme'
      ) {
        inlineEdit.id = crypto.randomUUID();
        inlineEdit.isNew = true;
        inlineEdit.parent = 'theme';
        inlineEdit.anchorId = 'theme';
        inlineEdit.placement = 'child';
      }
      ws = pending;
      pending = null;
      editing = false;
      render();
      toast(
        '共有内容を更新しました。入力中の内容は入力欄に保持しています。保存前に内容を確認してください。',
      );
    };
}
async function poll() {
  if (
    !sessionEntered ||
    !me ||
    inlineEdit ||
    polling ||
    modal.open ||
    recording ||
    recordingStarting ||
    pointerDragging ||
    mapDragId ||
    mapConnectId
  )
    return;
  polling = true;
  try {
    const [latestMe, latestList] = await Promise.all([api('/api/me'), api('/api/workshops')]);
    if (pointerDragging) return;
    const roleChanged = latestMe.admin !== me.admin;
    const stateChanged = latestMe.notion.state !== me.notion.state;
    const listChanged = JSON.stringify(latestList) !== JSON.stringify(workshops);
    me = latestMe;
    workshops = latestList;
    const credit = $('#credit-info');
    if (credit) credit.outerHTML = creditLabel();
    if (!ws) {
      // #3, the workshop list: keep it current.
      if (roleChanged || stateChanged || listChanged) render();
      return;
    }
    if (roleChanged || !workshops.some((w) => w.id === ws.id)) {
      if (workshops.some((w) => w.id === ws.id)) await loadWorkshop(ws.id);
      else closeWorkshop();
      return;
    }
    const latest = await api(`/api/workshops/${ws.id}`);
    if (pointerDragging) return;
    if (tab === 1 && !stateChanged && !listChanged && mapShape(latest) === mapShape(ws)) {
      ws = latest;
      refreshVotingUI();
      updateClocks();
    } else if (latest.revision !== ws.revision || stateChanged || listChanged) {
      if (editing) {
        pending = latest;
        showPending();
      } else {
        ws = latest;
        render();
      }
    } else if (JSON.stringify(latest.documentSync) !== JSON.stringify(ws.documentSync)) {
      ws.documentSync = latest.documentSync;
      const status = $('.content-status');
      if (status) status.outerHTML = contentStatus();
      bindContentStatus();
    }
  } catch (e) {
    if (me) {
      toast(e.message, true);
      try {
        workshops = await api('/api/workshops');
        if (ws && workshops.some((w) => w.id === ws.id)) await loadWorkshop(ws.id);
        else closeWorkshop();
      } catch {}
    }
  } finally {
    polling = false;
  }
}
window.addEventListener('beforeunload', () => {
  if (recording) recording.stream.getTracks().forEach((t) => t.stop());
  talk?.stream?.getTracks().forEach((t) => t.stop());
  talk?.rec?.stop();
});
setInterval(updateClocks, 1000);
setInterval(poll, 3000);
const started = performance.now();
// #1 → #2/#3: the opening picture first; a saved login (24 hours) goes straight to the list.
enter().catch(() => {
  me = null;
  login();
});
setTimeout(
  () => {
    $('#splash')?.remove();
    app.hidden = false;
  },
  Math.max(0, 2000 - (performance.now() - started)),
);
