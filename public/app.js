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
const buildLabel = () =>
  `<small class="build-info">v${esc(build.version)} · ビルド ${esc(build.builtAt)}（日本時間）</small>`;
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
const invitation = new URL(location.href).searchParams.get('workshop');
const titles = [
  'もやもやの言語化（N1）',
  '言語化の絞込み（カードの選択）',
  'アイデアの可視化（カードの可視化）',
  'アイデアの絞込み（投票）',
];
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
let mapFit = false,
  mapUndoBusy = false,
  pointerDragging = false,
  generationBusy = false;
const advicePhases = ['ideation', 'selection', 'visualization', 'voting'];
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
  return writable() && ws.myTeam === teamId;
}
const disabled = (ok) => (ok ? '' : ' disabled');
function remember() {
  if (!ws || !team()) return;
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
  if (action === 'vote' && tab === 0 && !inlineEdit) {
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
  teamId = ws.myTeam && ws.teams[ws.myTeam] ? ws.myTeam : Object.keys(ws.teams)[0];
  selected = null;
  pending = null;
  editing = false;
  render();
}
async function enter() {
  sessionEntered = true;
  me = await api('/api/me');
  workshops = await api('/api/workshops');
  const target =
    workshops.find((w) => w.id === invitation) ||
    workshops.find((w) => w.id === ws?.id) ||
    workshops.find((w) => !w.deleted) ||
    workshops[0];
  if (target) await loadWorkshop(target.id);
  else {
    ws = null;
    render();
  }
}
function loginForm() {
  app.dataset.view = 'login';
  app.innerHTML = `<main class="login"><section class="login-story">${brand()}<div class="eyebrow">IDEA WORKSHOP</div><h1>ひとつの気づきが、<br>次のアイディアに。</h1><p class="lead">言葉にする。選び取る。組み合わせる。<br>一人ひとりの「もやもや」から、<br>チームで新しい可能性を見つけましょう。</p><div class="mini-notes" aria-hidden="true"><span class="g0">小さな<br>気づき</span><span class="g1">まだない<br>つながり</span><span class="g2">新しい<br>アイディア</span></div></section><section class="login-form"><span class="eyebrow">LET’S GET STARTED</span><h2>ワークショップへようこそ</h2><p class="muted">${invitation ? '招待されたワークショップの登録メールで参加してください。' : '登録済みのメールアドレスでログインしてください。'}</p><form id="login-form"><label for="email">メールアドレス</label><input id="email" type="email" autocomplete="username webauthn" placeholder="name@example.com" required maxlength="254"><div id="password-field"${invitation ? ' hidden' : ''}><label for="password">パスワード <span class="muted">設定済みの方</span></label><input id="password" type="password" autocomplete="current-password" maxlength="200"></div><div id="otp-field" hidden><label for="otp">メールに届いた6桁の認証コード</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></div><div id="login-error" class="error" role="alert"></div><button class="primary" id="login-submit">認証コードを送信</button></form><button id="passkey-login" class="passkey">⌑ パスキーでログイン</button><div id="demo-area"></div>${buildLabel()}<p class="login-foot">登録のないメールアドレスは利用できません。<br>参加登録や接続についてはファシリテーターへご連絡ください。</p></section></main>`;
  challenge = null;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      if (!challenge) {
        const result = await api('/api/auth/start', {
          email: $('#email').value,
          password: $('#password').value,
          workshopId: invitation,
        });
        challenge = result.challenge;
        $('#otp-field').hidden = false;
        $('#email').readOnly = true;
        $('#password-field').hidden = true;
        btn.textContent = '認証して参加';
        $('#otp').required = true;
        $('#otp').focus();
        toast(result.message);
      } else {
        await api('/api/auth/verify', { challenge, code: $('#otp').value });
        await enter();
      }
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  $('#passkey-login').onclick = guarded(async () => {
    const data = await api('/api/auth/passkey/options', { email: $('#email').value });
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options });
    await api('/api/auth/passkey/verify', { challengeId: data.challengeId, response });
    await enter();
  });
  api('/api/health')
    .then((h) => {
      if (!$('#login-form')) return;
      if (h.demo) {
        $('#login-form').hidden = true;
        $('#passkey-login').hidden = true;
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
function login() {
  app.dataset.view = 'login';
  sessionEntered = false;
  ws = null;
  app.innerHTML = `<main class="login-landing"><section class="login-card">${brand()}<div class="login-symbol" aria-hidden="true">✦</div><h1>アイディアワークショップ</h1><span class="security-pill">メールOTP・パスキー対応</span><h2>参加者ログイン</h2><p>登録されたアカウントで本人確認します。</p><button id="login-entry" class="primary">本人確認してログイン</button><p class="muted">小さな気づきから、新しい可能性へ。</p>${buildLabel()}</section></main>`;
  $('#login-entry').onclick = guarded(async () => {
    try {
      await enter();
    } catch {
      me = null;
      loginForm();
    }
  });
}
function render() {
  if (!me) {
    login();
    return;
  }
  const t = team();
  app.dataset.view = 'workspace';
  app.innerHTML = `<header class="topbar">${brand()}${ws ? `<nav class="tabbar tab-tone-${tab}" aria-label="ワークショップのステップ" role="tablist">${titles.map((s, i) => `<button class="tab ${i === tab ? 'active' : ''}" data-tab="${i}" role="tab" aria-selected="${i === tab}" aria-controls="step-content"><span class="step">${['①', '②', '③', '④'][i]}</span><span class="tab-name">${esc(s).replace('（', '<span class="tab-detail">（').replace('）', '）</span>')}</span></button>`).join('')}</nav>` : ''}<div class="workspace-identity"><span class="identity">${esc(me.email)}</span>${buildLabel()}${me.admin ? `<button id="settings" class="icon" aria-label="管理者設定">${gearIcon()}</button>` : ''}</div></header>${me.demo ? '<div class="warning">ローカル体験モード — 体験用データを別フォルダーに保存しています。本番認証・Notion・AI送信は無効です。</div>' : ''}<div class="shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}"><aside class="sidebar"><button id="toggle-sidebar" class="sidebar-toggle" aria-label="${sidebarCollapsed ? 'メニューを展開' : 'メニューを折りたたむ'}" aria-expanded="${!sidebarCollapsed}" title="${sidebarCollapsed ? 'メニューを展開' : 'メニューを折りたたむ'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h16v16H4zM9 4v16m6-12-3 4 3 4"/></svg><span>メニュー</span></button><div><label for="workshop-select">WORKSHOP</label><select id="workshop-select" aria-label="ワークショップを選択">${workshops.map((w) => `<option value="${esc(w.id)}"${w.id === ws?.id ? ' selected' : ''}>${esc(w.name)}${w.deleted ? '（削除済み）' : ''}</option>`).join('')}</select>${me.admin ? '<button id="new-workshop" class="text-button new-workshop">＋ ワークショップを作成</button>' : ''}</div><div class="workspace-tag"><span class="eyebrow">TODAY’S THEME</span><br>${esc(ws?.theme || '新しいワークショップを始めましょう')}</div>${sidebarStatus()}<div class="sidebar-teams"><label>TEAMS</label><div class="team-switch">${
    Object.values(ws?.teams || {})
      .map(
        (t, i) =>
          `<button data-team="${esc(t.id)}" title="${esc(t.name)}・${t.id === ws.myTeam ? '参加中' : '閲覧のみ'}" class="${t.id === teamId ? 'active' : ''}"><span><i class="team-dot"></i>${esc(t.name)}</span><span>${t.id === ws.myTeam ? '参加中' : '閲覧'}</span></button>`,
      )
      .join('') || '<p class="muted">チーム設定をお待ちください</p>'
  }</div></div><div class="sidebar-foot"><span class="connection">● ${connectionLabel()}</span><br>ひとりの視点を、みんなの可能性に。<br>Workshop Idea Deck · v${esc(build.version)}</div></aside><main class="main" data-step="${tab}">${ws ? `${!writable() ? '<div class="notice meta-badges">閲覧モードです。進行中のワークショップで編集権限があるときに操作できます。</div>' : ''}${ws.notion?.error ? `<div class="warning meta-badges">${esc(ws.notion.error)}</div>` : ''}${ws.notion?.conflict ? '<div class="warning meta-badges">Notionとの更新競合があります。管理者設定から解決してください。</div>' : ''}${teamNotice()}${ws.notion?.provisioning ? '<div class="notice">Notionのワークショップテンプレートを準備しています。完了すると自動でマップを表示します。</div>' : ''}${ws.creationError ? `<div class="warning">${esc(ws.creationError)}</div>` : ''}<div id="sync-banner"></div><section id="step-content" role="tabpanel">${t || tab === 3 ? stepContent() : '<div class="empty"><strong>チームの設定をお待ちください</strong>管理者設定からグループを作成・割当できます。</div>'}</section>${t ? adviceView() : ''}` : emptyWorkshopView()}</main></div>`;
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
  if (me.admin) {
    $('#settings').onclick = guarded(settings);
    if ($('#new-workshop')) $('#new-workshop').onclick = newWorkshopDialog;
    if ($('#create-first')) $('#create-first').onclick = newWorkshopDialog;
  }
  $('#workshop-select').onchange = guarded(async (e) => {
    if (inlineEdit && !(await commitInline())) return;
    stopRecording();
    await loadWorkshop(e.target.value);
  });
  $$('[data-team]').forEach(
    (b) =>
      (b.onclick = guarded(async () => {
        if (inlineEdit && !(await commitInline())) return;
        remember();
        stopRecording();
        mapConnectId = null;
        teamId = b.dataset.team;
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
  if (t || tab === 3) {
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
    problem = s.error || (s.pending && !s.queued && !s.syncing),
    label = s.error
      ? 'Notion同期未完了（編集は続けられます）：' + esc(s.error)
      : s.syncing
        ? '● Notionへバックグラウンド同期中・編集は続けられます' +
          (s.queued ? '（新しい変更は次に送信）' : '')
        : s.queued
          ? '● サーバーに保存済み・操作停止10秒後にNotionへ同期'
          : s.pending
            ? 'Notionへ同期中です。'
            : '● Notionと同期';
  return `<div class="content-status ${problem ? 'content-warning' : ''}" role="status"><span>${label} </span><a href="https://www.notion.so/${ws.notion.pageId.replaceAll('-', '')}" target="_blank" rel="noopener">記録を開く ↗</a>${problem ? '<button id="retry-content-sync">同期を再試行</button>' : ''}${me.admin ? '<button id="reload-content-sync" class="text-button">Notionから再読込み</button>' : ''}</div>`;
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
function emptyWorkshopView() {
  const state = me.notion.state || (me.notion.enabled ? 'pending' : 'unconfigured');
  const copy = me.demo
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
  return `<div class="center-empty"><div class="eyebrow">YOUR WORKSHOPS</div><h1>${copy[0]}</h1><p class="muted">${copy[1]}</p><p class="muted">一覧と権限は自動で再確認します。</p>${me.admin ? '<button id="create-first" class="primary">＋ ワークショップを作成</button>' : ''}</div>`;
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
  if (tab === 0) return mapView();
  if (tab === 1) return cardView(false);
  if (tab === 2) return deckView();
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
  return `<div class="map-layout"><div class="panel map-panel"><div class="panel-title"><h3>気づきのマインドマップ <span class="muted">${esc(t.name)} · ${t.nodes.length} 項目</span></h3><div class="board-actions">${compactVoting()}<button id="move-topic-up" class="toolbar-icon" title="上へ移動" aria-label="トピックを上へ移動"${disabled(canEdit && !!selected && selected !== 'theme')}>↑</button><button id="move-topic-down" class="toolbar-icon" title="下へ移動" aria-label="トピックを下へ移動"${disabled(canEdit && !!selected && selected !== 'theme')}>↓</button><button id="new-topic" class="text-button"${disabled(canEdit)}>＋ トピック</button><button id="undo-map" class="text-button" title="マップ操作を取り消す（Ctrl＋Z・最大20操作）"${disabled(canEdit && !mapUndoBusy)}>↶ 元に戻す</button><button id="copy-outline" class="text-button" title="選択した枝をコピー（Ctrl＋C）">コピー</button><button id="paste-outline" class="text-button" title="階層を保って貼り付け（Ctrl＋V）"${disabled(canEdit)}>貼り付け</button><button id="map-record" class="toolbar-icon ${recording?.destination === 'map' ? 'is-recording' : ''}" aria-label="${recording?.destination === 'map' ? '音声入力を停止' : 'マイクで音声入力'}" title="音声入力"${disabled(canEdit)}>${micIcon()}</button><button id="topic-actions" class="toolbar-icon" aria-label="トピックの操作" title="選択中のトピックを操作"${disabled(canEdit && !!selected)}>⋯</button><button id="collapse-all" class="text-button">全て折り畳む</button><button id="expand-all" class="text-button">全て展開</button><button id="zoom-out" class="text-button" aria-label="縮小">−</button><span id="zoom-label">${Math.round(zoom * 100)}%</span><button id="fit-map" class="toolbar-icon" aria-label="画面サイズに合わせて全トピックを表示" title="画面サイズに合わせる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 7h10v10H7z"/></svg></button><button id="zoom-in" class="text-button" aria-label="拡大">＋</button></div></div>
  <div class="map-scroll" data-map-zone="detach"><div class="map-stage" id="map-stage"><div class="mindmap" id="mindmap"><svg id="map-links" class="map-links" aria-hidden="true"></svg><div class="connected-map"><div class="topic-box central-topic">${rootEdit ? `<input id="topic-editor" class="map-root topic-editor" value="${esc(inlineEdit.text)}" maxlength="500" aria-label="中心トピックを編集">` : `<button class="map-root ${selected === 'theme' ? 'selected' : ''}" data-map-target="theme" title="ダブルクリックで中心トピックを編集">${esc(t.rootText || ws.theme)}</button>`}${nodes.some((n) => n.parent === 'theme' || n.parent === null) ? `<button class="topic-toggle" data-collapse="theme" aria-label="中心トピックを${closed.has('theme') ? '展開' : '折り畳む'}" aria-expanded="${!closed.has('theme')}">${closed.has('theme') ? descendantCount('theme', nodes) : '−'}</button>` : ''}</div>${closed.has('theme') ? '' : branch('theme')}</div></div></div></div><div class="map-help" role="status">${mapConnectId ? '接続先をクリックしてください' : 'ダブルクリック：編集 · Enter：同階層 · Insert：子 · Delete：枝ごと削除 · Ctrl＋Z：取り消し · ドラッグ：移動'}</div></div></div>`;
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
function adviceState() {
  const key = `${adviceKey()}/${tab}`;
  if (!adviceStates.has(key))
    adviceStates.set(key, {
      enteredAt: Date.now(),
      lastChangedAt: Date.now(),
      muted: sessionStorage.getItem('facilitator-muted') === 'true',
    });
  return adviceStates.get(key);
}
function adviceView() {
  if (!team()) return '';
  const s = adviceState(),
    message = s.response,
    show =
      !s.muted &&
      !((tab === 1 || tab === 3) && votingOpen(tab === 1 ? 'cards' : 'ideas')) &&
      message?.should_speak &&
      (s.manual || s.expires > Date.now());
  return `<section class="ai-advice ${s.muted ? 'muted-robot' : ''}" aria-label="AIアドバイス"><div class="advice-robot"><div class="robot-avatar robot-${s.muted ? 'muted' : s.busy ? 'thinking' : show ? message.robot_animation : 'observing'}">${robotIcon()}</div><button id="next-advice"${disabled(editableTeam() && !s.muted && !s.busy)}>助言をもらう</button></div><div class="advice-body"><div class="row between"><h3>AIアドバイス <span class="guide-label">${message?.source === 'ai' ? '認可済みAI' : 'md基本ガイド'}</span></h3><button id="mute-advice" class="text-button" aria-pressed="${s.muted}">${s.muted ? '助言を再開' : '助言をミュート'}</button></div>${show ? `<div class="robot-bubble" role="status" aria-live="polite"><p id="advice-message">${esc(message.bubble_text)}</p><div class="row"><button id="dismiss-advice" class="text-button">閉じる</button><button id="later-advice" class="text-button">あとで</button><button id="answer-advice" class="text-button">考えを入力する ↗</button>${message.proposal ? '<button id="preview-clusters">分類案を確認</button>' : ''}</div></div>` : `<p class="muted">${s.muted ? '助言を休止しています。' : s.busy ? 'チームの内容を確認しています…' : '必要なときに短い問いで、発想や整理をお手伝いします。'}</p>`}<div class="row advice-actions">${tab === 0 ? `<button id="classify-advice"${disabled(editableTeam() && aiAvailable('classify'))}>グループ整理案</button>${team().lastGrouping ? `<button id="undo-classify"${disabled(editableTeam())}>分類を元に戻す</button>` : ''}` : ''}<span class="muted">${aiAvailable('questions') ? esc(aiStatus('questions')) : '外部AI未接続：md基本ガイドを表示（生成AIモデルは未使用）'}</span></div></div></section>`;
}
function refreshAdvice() {
  const el = $('.ai-advice');
  if (el && team()) {
    el.outerHTML = adviceView();
    bindAdvice();
  }
}
function bindAdvice() {
  if (!$('#next-advice')) return;
  $('#next-advice').onclick = guarded(() => requestAdvice('help_requested'));
  $('#mute-advice').onclick = () => {
    const s = adviceState();
    s.muted = !s.muted;
    for (const state of adviceStates.values()) {
      state.muted = s.muted;
      state.response = null;
    }
    sessionStorage.setItem('facilitator-muted', String(s.muted));
    s.response = null;
    refreshAdvice();
  };
  const feedback = (action) =>
    guarded(async () => {
      const s = adviceState(),
        m = s.response;
      s.response = null;
      if (action === 'later') s.snooze = Date.now() + 90000;
      refreshAdvice();
      if (m)
        await api(`/api/workshops/${ws.id}/advice-feedback`, {
          phase: advicePhases[tab],
          messageId: m.message_id,
          action,
        });
    });
  if ($('#dismiss-advice')) $('#dismiss-advice').onclick = feedback('dismiss');
  if ($('#later-advice')) $('#later-advice').onclick = feedback('later');
  if ($('#answer-advice'))
    $('#answer-advice').onclick = () => {
      if (tab === 0) {
        beginInline('theme', 'child');
        return;
      }
      const input = $('#what');
      input?.focus();
      input?.scrollIntoView({ block: 'nearest' });
    };
  if ($('#classify-advice')) $('#classify-advice').onclick = guarded(() => runAI('classify'));
  if ($('#undo-classify'))
    $('#undo-classify').onclick = guarded(() => action('undoClassification', { teamId }));
  if ($('#preview-clusters'))
    $('#preview-clusters').onclick = () => {
      const m = adviceState().response;
      openDialog(
        `<h2>グループ整理案</h2>${m.suggested_clusters.map((g) => `<h3>${esc(g.name)}</h3><ul>${g.nodeIds.map((id) => `<li>${esc(team().nodes.find((n) => n.id === id)?.text)}</li>`).join('')}</ul>`).join('')}<p class="muted">未分類の項目はそのまま残します。色の変更のみ適用します。</p><button id="apply-clusters" class="primary">確認して分類を適用</button>`,
      );
      $('#apply-clusters').onclick = guarded(async () => {
        ws = await api(`/api/workshops/${ws.id}/apply`, { proposal: m.proposal });
        modal.close();
        render();
      });
    };
}
async function requestAdvice(event) {
  if (!ws || !team() || !editableTeam()) return;
  const s = adviceState(),
    manual = event === 'help_requested';
  if (
    s.busy ||
    s.muted ||
    s.snooze > Date.now() ||
    modal.open ||
    inlineEdit ||
    editing ||
    mapDragId ||
    recording ||
    recordingStarting ||
    ((tab === 1 || tab === 3) && votingOpen(tab === 1 ? 'cards' : 'ideas'))
  )
    return;
  if (s.response && (s.manual || s.expires > Date.now())) {
    if (!manual) return;
    s.response = null;
  }
  const key = `${adviceKey()}/${tab}`,
    phase = advicePhases[tab],
    workshop = ws.id,
    group = teamId;
  s.busy = true;
  refreshAdvice();
  try {
    const response = await api(`/api/workshops/${workshop}/advice`, {
      teamId: group,
      phase,
      event,
      enteredAt: s.enteredAt,
      lastChangedAt: s.lastChangedAt,
      ui: {
        robot_muted: s.muted,
        user_is_typing: editing,
        user_is_dragging: !!mapDragId,
        bubble_visible: false,
      },
    });
    if (key !== `${adviceKey()}/${tab}` || editing || inlineEdit || mapDragId || modal.open) return;
    if (response.should_speak) {
      s.response = response;
      s.manual = manual;
      s.expires = Date.now() + response.duration_ms;
      if (!manual)
        setTimeout(() => {
          if (s.response === response) {
            s.response = null;
            if (ws?.id === workshop && teamId === group && advicePhases[tab] === phase)
              refreshAdvice();
          }
        }, response.duration_ms);
    }
  } catch (e) {
    if (manual) toast(e.message, true);
  } finally {
    s.busy = false;
    if (ws?.id === workshop && teamId === group) refreshAdvice();
  }
}
function scheduleAdvice(event) {
  if (!ws || !team()) return;
  const s = adviceState();
  if (event !== 'phase_entered') s.lastChangedAt = Date.now();
  if (event === 'phase_entered') {
    if (s.entered) return;
    s.entered = true;
  }
  setTimeout(() => void requestAdvice(event), 700);
}

function sidebarStatus() {
  if (!ws) return '';
  return `<div class="sidebar-meta"><span class="pill">${esc(ws.status)}</span><span>${esc(ws.role)}</span>${ws.endDate ? `<small>期限 ${esc(ws.endDate)}</small>` : ''}</div>`;
}
function teamNotice() {
  if (!team() || ws.myTeam === teamId) return '';
  return `<div class="notice team-readonly"><strong>${esc(team().name)}を閲覧中</strong><span>このチームは閲覧のみです。編集・カード投票は自分のチームで行ってください。</span></div>`;
}

function aiAvailable(task) {
  return me.ai.approved.some(
    (p) =>
      p.id === me.ai.provider && p.ready && p.approvalReference && p.capabilities?.includes(task),
  );
}
function aiStatus(task) {
  return aiAvailable(task)
    ? `接続先: ${me.ai.approved.find((p) => p.id === me.ai.provider).label} / ${me.ai.model || 'サービス既定モデル'}`
    : 'AI接続・社内認可は未設定です。キーボードで入力できます。';
}
function timerView(phase) {
  const mine = ws.votes[phase].mine,
    used = Object.values(mine).reduce((a, b) => a + b, 0);
  return `<div class="toolbar"><div class="budget">残り <strong>${ws.budgets[phase] - used}</strong> / ${ws.budgets[phase]} 票 <span class="muted">同じ案に複数投票・取消ができます</span></div><div class="timer"><div><small>VOTING TIME</small><div class="clock" data-clock="${phase}">03:00</div></div>${me.admin ? `<button data-timer="${phase}" class="primary"${disabled(writable())}>開始 / 再開</button><button data-stop="${phase}" class="text-button"${disabled(writable())}>締切</button>` : '<span class="muted">管理者が開始します</span>'}</div></div>`;
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
  $$('[data-topic-votes]').forEach((el) => {
    const n = team().nodes.find((n) => n.id === el.dataset.topicVotes);
    if (n) el.innerHTML = topicVoteContents(n);
  });
  $$('[data-card-votes]').forEach((el) => {
    const n = team().nodes.find((n) => n.id === el.dataset.cardVotes);
    if (n) el.innerHTML = cardVoteButtons(n);
  });
  bindVoting();
  if (tab === 0) requestAnimationFrame(() => (mapFit ? fitMap() : updateMapStage()));
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
  const nodes = team().nodes.filter((n) => (ws.votes.cards.totals[n.id] || 0) > 0);
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
function deckView() {
  const t = team(),
    d = t.discussion,
    canEdit = editableTeam();
  const field = (key, label, max, placeholder = '') =>
    `<div class="outline-field"><label for="${key}">${label}</label><input id="${key}" data-draft="${key}" maxlength="${max}" value="${esc(d[key] || '')}" placeholder="${placeholder}"${disabled(canEdit)}></div>`;
  return `<div class="deck-workspace"><div class="panel casino-deck"><div class="panel-title"><h3>アイデアのデッキ <span class="muted">${t.deck.length} / 5 枚</span></h3></div><div class="deck" id="deck">${Array.from(
    { length: 5 },
    (_, i) => {
      const n = t.nodes.find((n) => n.id === deckPositions()[i]);
      return `<div class="slot ${n ? 'filled' : ''}" data-slot="${i}">${n ? `<article class="deck-card sticky g${n.group}" data-deck-card="${n.id}"><span class="badge">${ws.votes.cards.totals[n.id] || 0}</span><button class="remove" data-remove-deck="${n.id}" aria-label="デッキから外す"${disabled(canEdit)}>×</button><p>${esc(n.text)}</p></article>` : '<span aria-hidden="true">＋</span>'}<span class="slot-number">0${i + 1}</span></div>`;
    },
  ).join('')}</div></div>${cardView(true)}</div>
  <div class="deck-discussion"><div class="panel"><form id="discussion-form"><div class="discussion-editor">
  <div><div class="row between discussion-heading"><h3>ディスカッションの記録</h3><button type="button" id="record-discussion" class="${recording ? 'is-recording' : ''}"${disabled(canEdit)}>${micIcon()} ${recording ? '録音を停止' : '録音開始'}</button></div>
  <textarea id="transcript" data-draft="transcript" class="transcript" maxlength="30000" placeholder="議論の内容を入力・録音します。"${disabled(canEdit)}>${esc(d.transcript)}</textarea>
  <div class="row between"><span class="save-hint">${recording ? '● 録音中 · ' : ''}最大約6MB / 1回</span><button type="button" data-ai="summarize"${disabled(canEdit)}>✧ 議論を整理</button></div><p class="muted">${aiStatus('transcribe')}</p></div>
  <div class="summary"><h3>アイデアの輪郭</h3>${field('headline', '一言で言うと', 100, '企画の価値を一言で')}${field('who', 'Who', 40, '誰に')}${field('what', 'What', 40, 'どんな価値を提供するか')}<div class="outline-field"><label for="how">How</label><textarea id="how" data-draft="how" maxlength="120" placeholder="どうやって実現するか"${disabled(canEdit)}>${esc(d.how)}</textarea></div>
  <fieldset class="features"><legend>３つの特長</legend>${[0, 1, 2].map((i) => `<label class="sr-only" for="feature-${i}">特長${i + 1}</label><input id="feature-${i}" data-draft="feature-${i}" maxlength="200" placeholder="${i + 1}．特長を１行の文章で" value="${esc(d.features?.[i] || '')}"${disabled(canEdit)}>`).join('')}</fieldset>
  <button type="button" data-ai="pressRelease" class="primary"${disabled(canEdit)}>模擬プレスリリースの生成</button><label for="pressRelease">模擬プレスリリース</label><textarea id="pressRelease" data-draft="pressRelease" class="press-release" maxlength="2000" placeholder="生成した原稿を確認・修正できます"${disabled(canEdit)}>${esc(d.pressRelease || '')}</textarea>
  <button type="button" data-ai="image" class="visualize-button"${disabled(canEdit)}>アイデアの可視化 ↗</button><small class="muted">Genspark / GPT Image 2.5 · 16:9</small>
  <div class="row between section-actions"><button class="primary"${disabled(canEdit)}>記録を保存</button><button type="button" id="preview-summary" class="text-button">文章プレビュー</button></div></div></div></form></div></div>
  ${t.image ? `<div class="panel generated-proposal"><h3>企画提案シート</h3><button class="image-open" data-image="${t.id}" aria-label="企画提案シートを拡大"><img src="data:image/png;base64,${t.image.base64}" alt="${esc(d.headline || '企画提案シート')}"></button></div>` : ''}`;
}
function ideaView() {
  const teams = Object.values(ws.teams).filter((t) => t.image);
  return `${timerView('ideas')}<div class="panel"><div class="panel-title"><h3>チームのアイディア <span class="muted">${teams.length} 件</span></h3><span class="muted">自チームにも投票できます</span></div>${teams.length ? `<div class="ideas-grid">${teams.map((t) => `<article class="idea"><span class="badge">${ws.votes.ideas.totals[t.id] || 0}</span><button class="image-open" data-image="${t.id}" aria-label="${esc(t.name)}の画像を拡大"><img src="data:image/png;base64,${t.image.base64}" alt="${esc(t.discussion.what || t.name + 'のアイディア')}"></button><div class="idea-body"><h3>${esc(t.name)}${t.id === ws.myTeam ? ' <span class="pill">あなたのチーム</span>' : ''}</h3><p>${esc(t.discussion.what || 'チームのアイディア')}</p><div class="sticky-votes"><button data-vote="ideas" data-target="${t.id}" data-delta="-1" aria-label="${esc(t.name)}の投票を取り消す"${disabled(votingOpen('ideas') && (ws.votes.ideas.mine[t.id] || 0) > 0)}>−</button><span>あなたの投票 ${ws.votes.ideas.mine[t.id] || 0}</span><button data-vote="ideas" data-target="${t.id}" data-delta="1" aria-label="${esc(t.name)}へ投票する"${disabled(votingOpen('ideas'))}>＋</button></div></div></article>`).join('')}</div>` : '<div class="empty"><span class="symbol">▧</span><strong>チームのアイディアが、ここに集まります。</strong>③で生成した画像を、全チームで見比べられます。<br>画像生成の接続と認可が未設定の間も、議論の文章は保存できます。</div>'}</div>`;
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
  tab === 0 &&
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
      (editing && tab === 0) ||
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
        if (scroll && tab === 0) {
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
    mapObserver = new ResizeObserver(() => (mapFit ? fitMap() : updateMapStage()));
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
    tab !== 0 ||
    modal.open ||
    inlineEdit ||
    editing ||
    event.target.closest?.('input,textarea,select,[contenteditable="true"]')
  )
    return;
  event.preventDefault();
  if (!event.repeat) void guarded(undoMapAction)();
});

function bindStep() {
  if (tab === 0) bindMap();
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
          try {
            if (tab === 2) await action('discussion', { teamId, ...discussionValues() });
            $$('[data-ai]').forEach((button) => (button.disabled = true));
            await runAI(b.dataset.ai);
          } finally {
            generationBusy = false;
            $$('[data-ai]').forEach((button) => (button.disabled = !editableTeam()));
          }
        })),
    );
  if (tab === 2) {
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
    $('#discussion-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('discussion', { teamId, ...discussionValues() });
      toast('議論の記録を保存しました');
    });
    $('#record-discussion').onclick = guarded(async () => {
      if (!recording && aiAvailable('transcribe'))
        await action('discussion', { teamId, ...discussionValues(), running: true });
      await recordAudio('discussion');
    });
    $('#preview-summary').onclick = () =>
      openDialog(
        `<h2>アイディアの文章プレビュー</h2><div class="summary-preview">${summaryHTML(discussionValues())}</div>`,
      );
  }
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
      (i) => $('#feature-' + i)?.value ?? team().discussion.features?.[i] ?? '',
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
  if (editing && !(task === 'transcribe' && extra.destination === 'map'))
    throw Error('AI処理の前に、入力した内容を保存してください。');
  toast('承認済みの接続先で処理しています…');
  const p = await api(`/api/workshops/${ws.id}/ai`, { task, teamId, ...extra });
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
  const preview =
    task === 'image' && typeof p.result.pngBase64 === 'string'
      ? `<img class="image-large" src="data:image/png;base64,${esc(p.result.pngBase64)}" alt="生成画像の適用前プレビュー">`
      : `<div class="proposal">${esc(task === 'pressRelease' ? p.result.text : JSON.stringify(p.result, null, 2))}</div>`;
  openDialog(
    `<h2>AI提案をレビュー</h2><p class="muted">内容を確認してから、チームの共有データに適用してください。${task === 'image' ? '画像の差替時は、このチーム画像への投票がリセットされます。' : ''}</p>${preview}<div class="row section-actions"><button id="apply-ai" class="primary">確認して適用</button><button id="discard-ai">今回は適用しない</button></div>`,
  );
  $('#discard-ai').onclick = () => modal.close();
  $('#apply-ai').onclick = guarded(async () => {
    ws = await api(`/api/workshops/${ws.id}/apply`, { proposal: p.proposal });
    clearDraft();
    modal.close();
    render();
    toast('確認したAI提案を適用しました');
  });
}
async function recordAudio(destination) {
  if (recording) {
    if (recording.recorder.state === 'recording') recording.recorder.stop();
    return;
  }
  if (recordingStarting) return;
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
    stream.getTracks().forEach((t) => t.stop());
    if (recording === session) recording = null;
    remember();
    render();
    if (original.workshop !== ws?.id || original.teamId !== teamId || original.tab !== tab) return;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size > 6 * 1024 * 1024) throw Error('短く区切って録音してください');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      await runAI('transcribe', { audio: btoa(binary), mimeType: recorder.mimeType, destination });
    } catch (e) {
      toast(e.message, true);
    }
  };
  recorder.start(1000);
  render();
  toast('録音中です。もう一度マイクボタンを押すと停止します。');
}
function stopRecording() {
  const session = recording;
  if (!session) return;
  recording = null;
  session.recorder.onstop = () => session.stream.getTracks().forEach((t) => t.stop());
  if (session.recorder.state === 'recording') session.recorder.stop();
  session.stream.getTracks().forEach((t) => t.stop());
}

function updateClocks() {
  if (!ws) return;
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
        ? `<section><h3>基本情報・進行状態</h3><form id="meta-form"><div class="grid"><div><label for="meta-name">名前</label><input id="meta-name" value="${esc(ws.name)}" required maxlength="200"><label for="meta-theme">テーマ</label><textarea id="meta-theme" maxlength="500">${esc(ws.theme)}</textarea></div><div><label for="meta-status">ステータス</label><select id="meta-status">${['未着手', '進行中', '完了（変更不可）', '破棄（閲覧不可）'].map((s) => `<option${s === ws.status ? ' selected' : ''}>${s}</option>`).join('')}</select><label for="meta-end">終了日（日本時間・当日まで有効）</label><input type="date" id="meta-end" value="${esc(ws.endDate?.slice(0, 10) || '')}"></div></div><div class="row section-actions"><button class="primary"${disabled(!ws.notion?.conflict)}>基本情報を保存</button><button type="button" id="delete-workshop" class="text-button danger">削除する</button></div></form><p class="muted">完了は閲覧のみ、破棄は参加者の閲覧を停止します。期限超過時は自動的に破棄されます。</p></section><section><h3>投票の設定</h3><form id="vote-settings"><div class="grid">${['cards', 'ideas'].map((p, i) => `<div><label for="budget-${p}">${i === 0 ? '② カード選択' : '④ アイディア投票'}：1人あたりの票数</label><input id="budget-${p}" type="number" min="1" max="100" value="${ws.budgets[p]}" required><label for="duration-${p}">投票時間（秒）</label><input id="duration-${p}" type="number" min="10" max="3600" value="${ws.durations[p]}" required></div>`).join('')}</div><p class="muted">時間の変更は次の「開始 / 再開」から反映されます。投票の取消も受付時間中に操作できます。</p><button class="primary"${disabled(writable())}>投票設定を保存</button></form></section><section><h3>チームと参加者</h3><form id="team-form" class="row"><input id="team-name" placeholder="新しいチーム名" required maxlength="80"><button${disabled(writable())}>チーム追加</button></form><form id="member-form"><div class="grid"><div><label for="member-email">登録メールアドレス</label><input id="member-email" type="email" required maxlength="254"></div><div><label for="member-role">権限</label><select id="member-role"><option>編集者</option><option>閲覧者</option><option>管理者</option></select></div><div><label for="member-team">グループ</label><select id="member-team"><option value="">未割当</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div><div><label for="member-password">初期パスワード（ローカル管理時のみ・任意）</label><input id="member-password" type="password" autocomplete="new-password" minlength="12" maxlength="200"${disabled(!ws.notion)}></div></div><button class="primary section-actions"${disabled(!ws.deleted)}>参加者を登録 / 更新</button></form><table><thead><tr><th>メールアドレス</th><th>権限</th><th>チーム</th><th></th></tr></thead><tbody>${Object.entries(
            ws.members || {},
          )
            .map(
              ([email, m]) =>
                `<tr><td>${esc(email)}</td><td>${esc(m.role)}</td><td>${esc(ws.teams[m.teamId]?.name || '未割当')}</td><td><button data-edit-member="${esc(email)}" class="text-button">編集</button></td></tr>`,
            )
            .join(
              '',
            )}</tbody></table><div class="qr-area"><img class="qr" src="/api/workshops/${ws.id}/qr" alt="参加用QRコード"><div><h3>参加用QR</h3><p class="muted">登録済みメール＋メールOTPで参加します。<br>QRだけで権限は付与されません。</p><a href="${esc(location.origin + '/?workshop=' + ws.id)}" target="_blank" rel="noopener">参加ページを開く ↗</a></div></div></section>`
        : ''
    }<section><h3>Notion連携</h3>${contentStatus()}<p class="muted">${connection.enabled ? '長期API接続を設定済み。' : '長期APIトークンとWS一覧のデータソースIDは、サーバー環境変数で設定してください。'} ${connection.at ? '最終同期 ' + new Date(connection.at).toLocaleString('ja-JP') : ''}</p>${connection.error ? `<div class="warning">${esc(connection.error)}</div>` : ''}<div class="row section-actions"><button id="notion-sync"${disabled(connection.enabled)}>今すぐ同期</button>${ws && !ws.notion ? `<button id="notion-publish"${disabled(connection.enabled && !ws.createAttempt)}>このWSをNotionへ接続</button>` : ''}</div>${ws?.createAttempt && !ws.notion ? '<p class="error">ページ作成結果が不明です。docs/NOTION.mdの照合手順を確認してください。</p>' : ''}${ws?.notion?.conflict ? `<div class="conflict"><strong>更新の競合</strong><pre class="proposal">${esc(JSON.stringify(ws.notion.conflict.remote, null, 2))}</pre><div class="row"><button data-resolve="notion">Notion側を採用</button><button data-resolve="app">アプリ側を採用</button></div></div>` : ''}</section><section><h3>AIファシリテータの動作（Markdown）</h3><p class="muted">このmdをAIの指示として読み込みます。AI未接続時は先頭設定の基本ガイドを使います。JSON設定ブロックを保持してください。</p><form id="facilitator-form"><label for="facilitator-md">ファシリテータ用md</label><textarea id="facilitator-md" class="markdown-editor" spellcheck="false" maxlength="120000">${esc(facilitator.markdown)}</textarea><div class="row"><button class="primary">mdを保存</button><a href="/api/facilitator/export">mdをダウンロード ↓</a></div><p id="facilitator-save-status" role="status"></p></form></section><section><h3>AI接続とモデル</h3><p class="muted">AIはすべてGenspark経由で実行します。画像モデルはGPT Image 2.5です。</p><form id="genspark-connect"><label for="genspark-api-key">Genspark GSK APIキー（秘密設定）</label><input id="genspark-api-key" type="password" autocomplete="new-password" placeholder="gsk-…" maxlength="1000" required><button class="primary">Gensparkに接続</button><p class="muted">サーバーにのみ保存します。登録後はキーを表示しません。</p></form><form id="ai-settings"><label for="ai-provider">使用サービス</label><select id="ai-provider"><option value="genspark-enterprise">Genspark Enterprise（既定）</option>${me.ai.approved
      .filter((p) => p.id !== 'genspark-enterprise')
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
      .join(
        '',
      )}</select><label for="ai-model">モデル（空欄＝サービス既定モデル）</label><input id="ai-model" value="${esc(me.ai.model)}" maxlength="150" placeholder="未指定"><label for="ai-press-prompt">模擬プレスリリース作成用プロンプト</label><textarea id="ai-press-prompt" class="generation-prompt" maxlength="6000">${esc(me.ai.pressReleasePrompt || '')}</textarea><label for="ai-prompt">企画提案シート作成用プロンプト（Genspark / GPT Image 2.5）</label><textarea id="ai-prompt" class="generation-prompt" maxlength="6000">${esc(me.ai.imagePrompt)}</textarea><p class="muted">質問・分類・文字起こし・文章生成・画像生成はGensparkのみを使用します。文章モデルを空欄にするとGensparkの契約既定モデルを使います。</p><button class="primary">AI設定を保存</button></form></section>${ws ? `<section><h3>成果物の保存</h3><p class="muted">WSの状態を「完了（変更不可）」にすると、管理者がPNG・Markdownを保存できます。</p>${ws.status === '完了（変更不可）' ? teams.map((t) => `<div class="export-links"><strong class="muted">${esc(t.name)}</strong><a href="/api/workshops/${ws.id}/export?team=${t.id}&format=md">文章 Markdown ↓</a>${t.image ? `<a href="/api/workshops/${ws.id}/export?team=${t.id}&format=png">画像 PNG ↓</a>` : ''}</div>`).join('') : ''}<button id="notion-results"${disabled(ws.status === '完了（変更不可）' && !!ws.notion && connection.enabled)}>NotionのWS配下へ成果を保存</button></section>` : ''}</div>`,
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
        teamId: $('#member-team').value || null,
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
          $('#member-team').value = m.teamId || '';
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
    adviceStates.clear();
    $('#facilitator-save-status').textContent = 'mdを保存しました。次の助言から反映します。';
  });
  $('#ai-provider').value = me.ai.provider;
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
  $('#ai-settings').onsubmit = guarded(async (e) => {
    e.preventDefault();
    me.ai = await api('/api/ai/settings', {
      provider: $('#ai-provider').value,
      model: $('#ai-model').value,
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
    if (!ws || roleChanged || !workshops.some((w) => w.id === ws.id)) {
      const next =
        workshops.find((w) => w.id === ws?.id) || workshops.find((w) => !w.deleted) || workshops[0];
      if (next) await loadWorkshop(next.id);
      else {
        remember();
        ws = null;
        if (roleChanged || stateChanged || listChanged) render();
      }
      return;
    }
    const latest = await api(`/api/workshops/${ws.id}`);
    if (pointerDragging) return;
    if (tab === 0 && !stateChanged && !listChanged && mapShape(latest) === mapShape(ws)) {
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
        const next = workshops.find((w) => !w.deleted);
        if (next) await loadWorkshop(next.id);
        else {
          remember();
          ws = null;
          render();
        }
      } catch {}
    }
  } finally {
    polling = false;
  }
}
window.addEventListener('beforeunload', () => {
  if (recording) recording.stream.getTracks().forEach((t) => t.stop());
});
setInterval(updateClocks, 1000);
setInterval(poll, 3000);
setInterval(() => {
  if (sessionEntered && team()) {
    const s = adviceState();
    if (s.response && !s.manual && s.expires <= Date.now()) {
      s.response = null;
      refreshAdvice();
    }
    void requestAdvice('timer_tick');
  }
}, 15000);
const started = performance.now();
login();
setTimeout(
  () => {
    $('#splash')?.remove();
    app.hidden = false;
  },
  Math.max(0, 5000 - (performance.now() - started)),
);
