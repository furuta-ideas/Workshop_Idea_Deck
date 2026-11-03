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
const titles = ['もやもやの言語化（N1）', 'カードの選択', 'カードの可視化', 'アイディアの投票'];
const subtitles = [
  '頭の中の小さな気づきを、言葉にしてつなげよう。',
  '気になる言葉に、あなたの一票を。可能性の種を選ぼう。',
  '選んだカードを組み合わせて、チームのアイディアを育てよう。',
  'みんなのアイディアを見渡して、共感や期待を一票に。',
];
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
    throw Error(data.error || '処理に失敗しました');
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
    ['管理者', '編集者'].includes(ws.role) &&
    ((!ws.notion?.error && !ws.notion?.conflict) || me.admin)
  );
}
function editableTeam() {
  return writable() && (me.admin || ws.myTeam === teamId);
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
  const result = await api(`/api/workshops/${ws.id}/action`, {
    action,
    payload,
    revision: ws.revision,
    requestId: crypto.randomUUID(),
  });
  ws = result;
  pending = null;
  clearDraft();
  render();
  return result;
}
async function loadWorkshop(id) {
  remember();
  ws = await api(`/api/workshops/${id}`);
  teamId =
    ws.myTeam && ws.teams[ws.myTeam] ? ws.myTeam : me.admin ? Object.keys(ws.teams)[0] : null;
  selected = null;
  pending = null;
  editing = false;
  render();
}
async function enter() {
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
function login() {
  app.innerHTML = `<main class="login"><section class="login-story">${brand()}<div class="eyebrow">IDEA WORKSHOP</div><h1>ひとつの気づきが、<br>次のアイディアに。</h1><p class="lead">言葉にする。選び取る。組み合わせる。<br>一人ひとりの「もやもや」から、<br>チームで新しい可能性を見つけましょう。</p><div class="mini-notes" aria-hidden="true"><span class="g0">小さな<br>気づき</span><span class="g1">まだない<br>つながり</span><span class="g2">新しい<br>アイディア</span></div></section><section class="login-form"><span class="eyebrow">LET’S GET STARTED</span><h2>ワークショップへようこそ</h2><p class="muted">${invitation ? '招待されたワークショップの登録メールで参加してください。' : '登録済みのメールアドレスでログインしてください。'}</p><form id="login-form"><label for="email">メールアドレス</label><input id="email" type="email" autocomplete="username webauthn" placeholder="name@example.com" required maxlength="254"><div id="password-field"${invitation ? ' hidden' : ''}><label for="password">パスワード <span class="muted">設定済みの方</span></label><input id="password" type="password" autocomplete="current-password" maxlength="200"></div><div id="otp-field" hidden><label for="otp">メールに届いた6桁の認証コード</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></div><div id="login-error" class="error" role="alert"></div><button class="primary" id="login-submit">認証コードを送信</button></form><button id="passkey-login" class="passkey">⌑ パスキーでログイン</button><div id="demo-area"></div><p class="login-foot">登録のないメールアドレスは利用できません。<br>参加登録や接続についてはファシリテーターへご連絡ください。</p></section></main>`;
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
function render() {
  if (!me) {
    login();
    return;
  }
  const t = team();
  app.innerHTML = `<header class="topbar">${brand()}<div class="row"><span class="identity">${esc(me.email)}</span><button id="account" class="avatar" aria-label="アカウントとパスワード設定">${me.admin ? 'F' : 'P'}</button><button id="register-key" class="text-button" title="パスキーを登録">⌑ パスキー登録</button>${me.admin ? '<button id="settings" class="icon" aria-label="管理者設定">⚙</button>' : ''}<button id="logout" class="text-button">ログアウト</button></div></header>${me.demo ? '<div class="warning">ローカル体験モード — 体験用データを別フォルダーに保存しています。本番認証・Notion・AI送信は無効です。</div>' : ''}<div class="shell"><aside class="sidebar"><div><label for="workshop-select">WORKSHOP</label><select id="workshop-select" aria-label="ワークショップを選択">${workshops.map((w) => `<option value="${esc(w.id)}"${w.id === ws?.id ? ' selected' : ''}>${esc(w.name)}${w.deleted ? '（削除済み）' : ''}</option>`).join('')}</select>${me.admin ? '<button id="new-workshop" class="text-button new-workshop">＋ ワークショップを作成</button>' : ''}</div><div class="workspace-tag"><span class="eyebrow">TODAY’S THEME</span><br>${esc(ws?.theme || '新しいワークショップを始めましょう')}</div><div><label>TEAMS</label><div class="team-switch">${
    Object.values(ws?.teams || {})
      .filter((t) => me.admin || t.id === ws.myTeam)
      .map(
        (t, i) =>
          `<button data-team="${esc(t.id)}" class="${t.id === teamId ? 'active' : ''}"><span><i class="team-dot"></i>${esc(t.name)}</span><span>${t.id === ws.myTeam ? '参加中' : '↗'}</span></button>`,
      )
      .join('') || '<p class="muted">チーム設定をお待ちください</p>'
  }</div></div><div class="sidebar-foot"><span class="connection">● ${me.demo ? 'ローカル保存' : me.notion.enabled ? 'Notion連携あり' : 'サーバー保存'}</span><br>ひとりの視点を、みんなの可能性に。<br>Workshop Idea Deck · v0.3</div></aside><main class="main">${ws ? `<div class="page-top"><div><div class="eyebrow">WORKSHOP / ${esc(t?.name || 'チーム未設定')}</div><h1>${titles[tab]}</h1><p>${subtitles[tab]}</p><div class="ws-meta"><span class="pill">${esc(ws.status)}</span><span>${esc(ws.role)}</span>${ws.endDate ? `<span>期限 ${esc(ws.endDate)}</span>` : ''}</div></div><div class="row"><span class="eyebrow">STEP 0${tab + 1} / 04</span></div></div><nav class="tabbar" aria-label="ワークショップのステップ" role="tablist">${titles.map((s, i) => `<button class="tab ${i === tab ? 'active' : ''}" data-tab="${i}" role="tab" aria-selected="${i === tab}" aria-controls="step-content"><span class="step">${i + 1}</span>${s}</button>`).join('')}</nav>${!writable() ? '<div class="notice meta-badges">閲覧モードです。進行中のワークショップで編集権限があるときに操作できます。</div>' : ''}${ws.notion?.error ? `<div class="warning meta-badges">${esc(ws.notion.error)}</div>` : ''}${ws.notion?.conflict ? '<div class="warning meta-badges">Notionとの更新競合があります。管理者設定から解決してください。</div>' : ''}<div id="sync-banner"></div><section id="step-content" role="tabpanel">${t || tab === 3 ? stepContent() : '<div class="empty"><strong>チームの設定をお待ちください</strong>管理者設定からグループを作成・割当できます。</div>'}</section><div class="footer-note"><span>● 入力内容はサーバーへ保存され、チームで共有されます</span><span>AI提案はプレビュー後に適用 · 自動フォールバックなし</span></div>` : `<div class="center-empty"><div class="eyebrow">YOUR NEXT WORKSHOP</div><h1>新しい可能性を、ここから。</h1><p class="muted">表示可能なワークショップがありません。<br>参加登録・Notionの状態・同期結果を管理者に確認してください。</p>${me.admin ? '<button id="create-first" class="primary">＋ ワークショップを作成</button>' : ''}</div>`}</main></div>`;
  $('#account').onclick = accountDialog;
  $('#logout').onclick = guarded(async () => {
    stopRecording();
    await api('/api/logout', {});
    me = null;
    ws = null;
    login();
  });
  $('#register-key').onclick = guarded(async () => {
    const data = await api('/api/auth/register/options', {});
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: data.options });
    await api('/api/auth/register/verify', { challengeId: data.challengeId, response });
    toast('この端末のパスキーを登録しました');
  });
  if (me.admin) {
    $('#settings').onclick = guarded(settings);
    if ($('#new-workshop')) $('#new-workshop').onclick = newWorkshopDialog;
    if ($('#create-first')) $('#create-first').onclick = newWorkshopDialog;
  }
  $('#workshop-select').onchange = guarded(async (e) => {
    stopRecording();
    await loadWorkshop(e.target.value);
  });
  $$('[data-team]').forEach(
    (b) =>
      (b.onclick = () => {
        remember();
        stopRecording();
        teamId = b.dataset.team;
        selected = null;
        editing = false;
        render();
      }),
  );
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        remember();
        tab = Number(b.dataset.tab);
        editing = false;
        render();
      }),
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
  showPending();
  updateClocks();
}
function stepContent() {
  if (tab === 0) return mapView();
  if (tab === 1) return cardView(false);
  if (tab === 2) return deckView();
  return ideaView();
}
function mapView() {
  const t = team(),
    node = t.nodes.find((n) => n.id === selected);
  const branch = (parent, depth = 0) => {
    if (depth > 50) return '';
    const children = t.nodes.filter((n) => n.parent === parent);
    if (!children.length) return '';
    return `<ul class="branches">${children.map((n) => `<li><button class="node g${n.group} ${selected === n.id ? 'selected' : ''}" data-node="${n.id}">${esc(n.text)}</button>${branch(n.id, depth + 1)}</li>`).join('')}</ul>`;
  };
  return `<div class="map-layout"><div class="panel map-panel"><div class="panel-title"><h3>気づきのマインドマップ <span class="muted">${t.nodes.length} 項目</span></h3><div class="board-actions"><button id="zoom-out" class="text-button" aria-label="縮小">−</button><span id="zoom-label">${Math.round(zoom * 100)}%</span><button id="zoom-in" class="text-button" aria-label="拡大">＋</button></div></div><div class="map-scroll"><div class="mindmap" id="mindmap"><div class="map-root">${esc(ws.theme)}</div>${branch(null)}${!t.nodes.length ? '<div class="empty">右の入力欄から、最初の気づきを追加しましょう。</div>' : ''}</div></div></div><form class="panel inspector" id="node-form"><div class="row between"><h3>${node ? '気づきを編集' : '気づきを追加'}</h3><button type="button" id="new-node" class="text-button">＋ 新規</button></div><p>気になったこと、感じたことを自由に。<br>親項目を選ぶと、言葉をつなげられます。</p><div class="fields"><div><label for="node-text">言葉・気づき</label><textarea id="node-text" data-draft="node-text" maxlength="500" placeholder="どんなことが気になる？" required${disabled(editableTeam())}>${esc(node?.text || '')}</textarea></div><div><label for="node-parent">親となる項目</label><select id="node-parent" data-draft="node-parent"${disabled(editableTeam())}><option value="">テーマに直接つなぐ</option>${t.nodes
    .filter((n) => n.id !== selected)
    .map(
      (n) =>
        `<option value="${n.id}"${node?.parent === n.id ? ' selected' : ''}>${esc(n.text.slice(0, 28))}</option>`,
    )
    .join(
      '',
    )}</select><label>グループの色</label><div class="colors">${Array.from({ length: 8 }, (_, i) => `<button type="button" class="color g${i} ${(node?.group ?? color) === i ? 'active' : ''}" data-color="${i}" aria-label="色グループ${i + 1}" aria-pressed="${(node?.group ?? color) === i}"${disabled(editableTeam())}></button>`).join('')}</div></div></div><button class="primary"${disabled(editableTeam())}>${node ? '変更を保存' : '＋ マップに追加'}</button>${node ? `<button type="button" id="delete-node" class="text-button danger"${disabled(editableTeam())}>この項目を削除</button><button type="button" id="add-child" class="text-button"${disabled(editableTeam())}>＋ 子項目を追加</button>` : ''}</form></div><div class="ai-strip"><div class="ai-icon" aria-hidden="true">✧</div><div class="ai-content"><h3>AIと、視点をひろげる</h3><p>${t.nodes.length >= 21 ? '21件以上の気づきが集まりました。4つの視点などに整理すると、つながりが見つかります。' : '「誰の、どんな場面？」を考えながら、気づきを増やしましょう。'}</p><small class="muted">${aiStatus('questions')}</small></div><div class="ai-buttons"><button data-ai="questions"${disabled(editableTeam() && aiAvailable('questions'))}>✧ 別の視点を探す</button><button data-ai="classify"${disabled(editableTeam() && aiAvailable('classify'))}>グループを整理</button><button data-ai="transcribe" id="map-record"${disabled(editableTeam() && aiAvailable('transcribe'))}>◉ 音声入力</button></div></div>`;
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
function sticky(n, deck = false) {
  const total = ws.votes.cards.totals[n.id] || 0,
    mine = ws.votes.cards.mine[n.id] || 0;
  return `<article class="sticky g${n.group}"${deck && editableTeam() ? ' draggable="true"' : ''} data-card="${n.id}"><span class="badge" aria-label="${total}票">${total}</span><p>${esc(n.text)}</p>${deck ? `<div class="sticky-votes"><span>グループ ${n.group + 1}</span><button class="plus" data-add-deck="${n.id}" aria-label="デッキへ追加"${disabled(editableTeam() && !team().deck.includes(n.id) && team().deck.length < 5)}>＋</button></div>` : `<div class="sticky-votes"><button data-vote="cards" data-target="${n.id}" data-delta="-1" aria-label="${esc(n.text)} の投票を取り消す"${disabled(votingOpen('cards') && editableTeam() && mine > 0)}>−</button><span>あなたの投票 ${mine}</span><button class="plus" data-vote="cards" data-target="${n.id}" data-delta="1" aria-label="${esc(n.text)} に投票する"${disabled(votingOpen('cards') && editableTeam())}>＋</button></div>`}</article>`;
}
function cardView(deck) {
  const nodes = [...team().nodes].filter((n) => !deck || ws.votes.cards.totals[n.id] > 0);
  if (deck)
    nodes.sort(
      (a, b) =>
        (ws.votes.cards.totals[b.id] || 0) - (ws.votes.cards.totals[a.id] || 0) ||
        team().nodes.indexOf(a) - team().nodes.indexOf(b),
    );
  return `${deck ? '' : timerView('cards')}<div class="panel"><div class="panel-title"><h3>${deck ? '得票したカード' : 'チームの気づき'} <span class="muted">${nodes.length} 枚</span></h3><span class="muted">${deck ? '票数順 · ドラッグまたは＋でデッキへ' : '付箋の＋を押して投票'}</span></div>${nodes.length ? `<div class="sticky-grid">${nodes.map((n) => sticky(n, deck)).join('')}</div>` : '<div class="empty"><span class="symbol">▧</span><strong>まだカードがありません</strong>' + (deck ? '②で1票以上を獲得したカードが、ここに並びます。' : '①で言葉を入力すると、付箋としてここに並びます。') + '</div>'}</div>`;
}
function deckView() {
  const t = team(),
    d = t.discussion,
    slots = Math.max(3, Math.min(5, t.deck.length + 1));
  return `<div class="deck-discussion"><div class="panel"><div class="panel-title"><h3>アイディアのデッキ <span class="muted">${t.deck.length} / 5 枚</span></h3><span class="muted">まずは3枚、最大5枚まで</span></div><div class="deck" id="deck">${Array.from(
    { length: slots },
    (_, i) => {
      const n = t.nodes.find((n) => n.id === t.deck[i]);
      return `<div class="slot ${n ? 'filled g' + n.group : ''}" data-slot="${i}">${n ? `<span class="badge">${ws.votes.cards.totals[n.id] || 0}</span><button class="remove" data-remove-deck="${n.id}" aria-label="デッキから外す"${disabled(editableTeam())}>×</button><p>${esc(n.text)}</p>` : '<span>＋</span><span>カードをここへ</span>'}<span class="slot-number">0${i + 1}</span></div>`;
    },
  ).join(
    '',
  )}</div><form id="discussion-form"><div class="discussion-editor"><div><div class="row between"><h3>ディスカッション記録</h3><span class="${d.running ? 'recording' : 'muted'}">${d.running ? '● 議論中' : 'レビュー / 待機中'}</span></div><textarea id="transcript" data-draft="transcript" class="transcript" maxlength="30000" placeholder="議論の内容を入力できます。認可済み音声認識を設定すると録音から文字起こしできます。"${disabled(editableTeam())}>${esc(d.transcript)}</textarea><div class="row between"><button type="button" id="record-discussion"${disabled(editableTeam() && d.running && aiAvailable('transcribe'))}>${recording ? '■ 録音を停止' : '◉ 録音・文字起こし'}</button><span class="save-hint">最大約6MB / 1回</span></div><p class="muted">${aiStatus('transcribe')}</p><small class="muted">議論ラウンド: ${d.rounds.length} 回完了</small></div><div class="summary"><h3>アイディアの輪郭</h3><div class="row"><label for="what">WHAT</label><input id="what" data-draft="what" maxlength="40" placeholder="創出する価値（40文字以内）" value="${esc(d.what)}"${disabled(editableTeam())}></div><div class="row"><label for="who">WHO</label><input id="who" data-draft="who" maxlength="40" placeholder="誰に（40文字以内）" value="${esc(d.who)}"${disabled(editableTeam())}></div><div class="row"><label for="how">HOW</label><textarea id="how" data-draft="how" maxlength="120" placeholder="どうやって（120文字以内）"${disabled(editableTeam())}>${esc(d.how)}</textarea></div><label for="points">重要な論点（1行に1つ）</label><textarea id="points" data-draft="points" maxlength="5000"${disabled(editableTeam())}>${esc(d.points)}</textarea><label for="keywords">強調するキーワード（読点・カンマで区切る）</label><input id="keywords" data-draft="keywords" maxlength="500" value="${esc(d.keywords)}"${disabled(editableTeam())}><div class="row between"><button class="primary"${disabled(editableTeam())}>記録を保存</button><button type="button" id="preview-summary" class="text-button">文章プレビュー</button></div></div></div></form></div><aside class="panel discussion-control"><div><div class="eyebrow">LET’S COMBINE</div><h3>カードをつないで、<br>まだない価値を。</h3><p>選んだ言葉の間にある関係を話し合い、アイディアの輪郭をまとめましょう。</p></div><div><button id="discussion-toggle" class="primary"${disabled(editableTeam())}>${d.running ? '■ ディスカッションの終了' : '▶ ディスカッションの開始'}</button><p>終了後は内容をレビュー。何度でも再開して議論を追加できます。</p><div class="stack"><button data-ai="summarize"${disabled(editableTeam() && aiAvailable('summarize'))}>✧ 議論をAIで整理</button><button data-ai="keywords"${disabled(editableTeam() && aiAvailable('keywords'))}>重要キーワードを抽出</button><button data-ai="image" class="accent"${disabled(editableTeam() && aiAvailable('image') && !!me.ai.imagePrompt)}>アイディアの可視化・画像化 ↗</button></div><p>${me.ai.imagePrompt ? '画像生成は設定済みプロンプトで実行します。' : '画像生成プロンプトは未設定です。管理者が後日設定できます。'}<br>${aiStatus('summarize')}</p></div></aside></div>${cardView(true)}`;
}
function ideaView() {
  const teams = Object.values(ws.teams).filter((t) => t.image);
  return `${timerView('ideas')}<div class="panel"><div class="panel-title"><h3>チームのアイディア <span class="muted">${teams.length} 件</span></h3><span class="muted">自チームにも投票できます</span></div>${teams.length ? `<div class="ideas-grid">${teams.map((t) => `<article class="idea"><span class="badge">${ws.votes.ideas.totals[t.id] || 0}</span><button class="image-open" data-image="${t.id}" aria-label="${esc(t.name)}の画像を拡大"><img src="data:image/png;base64,${t.image.base64}" alt="${esc(t.discussion.what || t.name + 'のアイディア')}"></button><div class="idea-body"><h3>${esc(t.name)}${t.id === ws.myTeam ? ' <span class="pill">あなたのチーム</span>' : ''}</h3><p>${esc(t.discussion.what || 'チームのアイディア')}</p><div class="sticky-votes"><button data-vote="ideas" data-target="${t.id}" data-delta="-1" aria-label="${esc(t.name)}の投票を取り消す"${disabled(votingOpen('ideas') && (ws.votes.ideas.mine[t.id] || 0) > 0)}>−</button><span>あなたの投票 ${ws.votes.ideas.mine[t.id] || 0}</span><button data-vote="ideas" data-target="${t.id}" data-delta="1" aria-label="${esc(t.name)}へ投票する"${disabled(votingOpen('ideas'))}>＋</button></div></div></article>`).join('')}</div>` : '<div class="empty"><span class="symbol">▧</span><strong>チームのアイディアが、ここに集まります。</strong>③で生成した画像を、全チームで見比べられます。<br>画像生成の接続と認可が未設定の間も、議論の文章は保存できます。</div>'}</div>`;
}
function bindStep() {
  $$('[data-node]').forEach(
    (b) =>
      (b.onclick = () => {
        clearDraft();
        selected = b.dataset.node;
        color = team().nodes.find((n) => n.id === selected).group;
        render();
      }),
  );
  if (tab === 0) {
    $('#mindmap').style.transform = `scale(${zoom})`;
    $('#zoom-in').onclick = () => {
      zoom = Math.min(1.5, zoom + 0.1);
      $('#mindmap').style.transform = `scale(${zoom})`;
      $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
    };
    $('#zoom-out').onclick = () => {
      zoom = Math.max(0.5, zoom - 0.1);
      $('#mindmap').style.transform = `scale(${zoom})`;
      $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
    };
    $('#new-node').onclick = () => {
      clearDraft();
      selected = null;
      render();
      $('#node-text').focus();
    };
    $$('[data-color]').forEach(
      (b) =>
        (b.onclick = () => {
          color = Number(b.dataset.color);
          $$('[data-color]').forEach((el) => {
            el.classList.toggle('active', el === b);
            el.setAttribute('aria-pressed', String(el === b));
          });
        }),
    );
    $('#node-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('node', {
        teamId,
        id: selected,
        text: $('#node-text').value,
        parent: $('#node-parent').value || null,
        group: color,
      });
      selected = null;
      render();
      $('#node-text').focus();
    });
    if ($('#delete-node'))
      $('#delete-node').onclick = guarded(async () => {
        await action('deleteNode', { teamId, id: selected });
        selected = null;
        render();
      });
    if ($('#add-child'))
      $('#add-child').onclick = () => {
        const parent = selected;
        clearDraft();
        selected = null;
        render();
        $('#node-parent').value = parent;
        $('#node-text').focus();
      };
    $('#map-record').onclick = guarded(() => recordAudio('map'));
  }
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
    (b) => (b.onclick = guarded(() => action('timer', { phase: b.dataset.timer }))),
  );
  $$('[data-stop]').forEach(
    (b) => (b.onclick = guarded(() => action('timer', { phase: b.dataset.stop, stop: true }))),
  );
  $$('[data-ai]')
    .filter((b) => b.id !== 'map-record')
    .forEach((b) => (b.onclick = guarded(() => runAI(b.dataset.ai))));
  if (tab === 2) {
    $$('[data-card]').forEach((c) =>
      c.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', c.dataset.card);
        e.dataTransfer.effectAllowed = 'copy';
      }),
    );
    const add = async (nodeId, index) => {
      const ids = team().deck.filter((x) => x !== nodeId);
      ids.splice(Math.min(index, ids.length), 0, nodeId);
      await action('deck', { teamId, ids });
    };
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
        slot.classList.remove('dragover');
        await add(e.dataTransfer.getData('text/plain'), Number(slot.dataset.slot));
      });
    });
    $$('[data-add-deck]').forEach(
      (b) => (b.onclick = guarded(() => add(b.dataset.addDeck, team().deck.length))),
    );
    $$('[data-remove-deck]').forEach(
      (b) =>
        (b.onclick = guarded(() =>
          action('deck', { teamId, ids: team().deck.filter((x) => x !== b.dataset.removeDeck) }),
        )),
    );
    $('#discussion-form').onsubmit = guarded(async (e) => {
      e.preventDefault();
      await action('discussion', { teamId, ...discussionValues() });
      toast('議論の記録を保存しました');
    });
    $('#discussion-toggle').onclick = guarded(async () => {
      stopRecording();
      await action('discussion', {
        teamId,
        ...discussionValues(),
        running: !team().discussion.running,
      });
    });
    $('#record-discussion').onclick = guarded(() => recordAudio('discussion'));
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
  return Object.fromEntries(
    ['transcript', 'what', 'who', 'how', 'points', 'keywords'].map((k) => [
      k,
      $('#' + k)?.value ?? team().discussion[k],
    ]),
  );
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
  return `WHAT　${bold(d.what)}\nWHO　${bold(d.who)}\nHOW　${bold(d.how)}\n\n${String(
    d.points || '',
  )
    .split('\n')
    .filter(Boolean)
    .map((x) => '・' + bold(x))
    .join('\n')}`;
}
async function runAI(task, extra = {}) {
  if (editing) throw Error('AI処理の前に、入力した内容を保存してください。');
  toast('承認済みの接続先で処理しています…');
  const p = await api(`/api/workshops/${ws.id}/ai`, { task, teamId, ...extra });
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
      : `<div class="proposal">${esc(JSON.stringify(p.result, null, 2))}</div>`;
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
    recording.recorder.stop();
    return;
  }
  if (!aiAvailable('transcribe'))
    throw Error('認可済み音声認識が未設定です。キーボードで入力してください。');
  if (editing) throw Error('録音の前に、入力した内容を保存してください。');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    throw Error('このブラウザーでは録音できません。HTTPS環境を確認してください。');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }),
    chunks = [];
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  let size = 0;
  const original = { workshop: ws.id, teamId };
  recording = { recorder, stream };
  recorder.ondataavailable = (e) => {
    chunks.push(e.data);
    size += e.data.size;
    if (size > 6 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
  };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recording = null;
    render();
    if (original.workshop !== ws?.id || original.teamId !== teamId) {
      toast('画面を移動したため録音は送信せず破棄しました');
      return;
    }
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size > 6 * 1024 * 1024)
        throw Error('録音が大きすぎます。短く区切って録音してください。');
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
  toast('録音中です。もう一度ボタンを押すと停止して文字起こしします。');
  if (destination === 'map') $('#map-record').textContent = '■ 録音を停止';
}
function stopRecording() {
  if (recording) {
    recording.recorder.onstop = () => {
      recording?.stream.getTracks().forEach((t) => t.stop());
      recording = null;
    };
    recording.recorder.stop();
  }
}
function updateClocks() {
  if (!ws) return;
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
    '<h2>ワークショップを作成</h2><form id="create-workshop"><label for="ws-name">ワークショップ名</label><input id="ws-name" required maxlength="200"><label for="ws-theme">テーマ</label><textarea id="ws-theme" maxlength="500"></textarea><label for="ws-end">終了日（日本時間の23:59まで有効）</label><input id="ws-end" type="date"><p class="muted">まずサーバーへ保存します。作成後、管理者設定からNotionへ接続できます。</p><button class="primary">作成する</button></form>',
  );
  $('#create-workshop').onsubmit = guarded(async (e) => {
    e.preventDefault();
    const result = await api('/api/workshops', {
      name: $('#ws-name').value,
      theme: $('#ws-theme').value || $('#ws-name').value,
      endDate: $('#ws-end').value || null,
    });
    modal.close();
    workshops = await api('/api/workshops');
    await loadWorkshop(result.id);
  });
}
async function settings() {
  me = await api('/api/me');
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
    }<section><h3>Notion連携</h3><p class="muted">${connection.enabled ? '長期API接続を設定済み。' : '長期APIトークンとWS一覧のデータソースIDは、サーバー環境変数で設定してください。'} ${connection.at ? '最終同期 ' + new Date(connection.at).toLocaleString('ja-JP') : ''}</p>${connection.error ? `<div class="warning">${esc(connection.error)}</div>` : ''}<div class="row section-actions"><button id="notion-sync"${disabled(connection.enabled)}>今すぐ同期</button>${ws && !ws.notion ? `<button id="notion-publish"${disabled(connection.enabled && !ws.createAttempt)}>このWSをNotionへ接続</button>` : ''}</div>${ws?.createAttempt && !ws.notion ? '<p class="error">ページ作成結果が不明です。docs/NOTION.mdの照合手順を確認してください。</p>' : ''}${ws?.notion?.conflict ? `<div class="conflict"><strong>更新の競合</strong><pre class="proposal">${esc(JSON.stringify(ws.notion.conflict.remote, null, 2))}</pre><div class="row"><button data-resolve="notion">Notion側を採用</button><button data-resolve="app">アプリ側を採用</button></div></div>` : ''}</section><section><h3>AI接続とモデル</h3><p class="muted">会社承認済みの接続先はサーバーの許可リストから選択します。認可情報・接続キーは画面から追加できません。</p><form id="ai-settings"><label for="ai-provider">使用サービス</label><select id="ai-provider"><option value="genspark-enterprise">Genspark Enterprise（既定）</option>${me.ai.approved
      .filter((p) => p.id !== 'genspark-enterprise')
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
      .join(
        '',
      )}</select><label for="ai-model">モデル（空欄＝サービス既定モデル）</label><input id="ai-model" value="${esc(me.ai.model)}" maxlength="150" placeholder="未指定"><label for="ai-prompt">画像生成プロンプト</label><textarea id="ai-prompt" maxlength="6000" placeholder="後日、画像生成用プロンプトを設定してください">${esc(me.ai.imagePrompt)}</textarea><p class="muted">質問・分類・文字起こし・要約・キーワード・画像生成のすべてに、この制限を適用します。</p><button class="primary">AI設定を保存</button></form></section>${ws ? `<section><h3>成果物の保存</h3><p class="muted">WSの状態を「完了（変更不可）」にすると、管理者がPNG・Markdownを保存できます。</p>${ws.status === '完了（変更不可）' ? teams.map((t) => `<div class="export-links"><strong class="muted">${esc(t.name)}</strong><a href="/api/workshops/${ws.id}/export?team=${t.id}&format=md">文章 Markdown ↓</a>${t.image ? `<a href="/api/workshops/${ws.id}/export?team=${t.id}&format=png">画像 PNG ↓</a>` : ''}</div>`).join('') : ''}<button id="notion-results"${disabled(ws.status === '完了（変更不可）' && !!ws.notion && connection.enabled)}>NotionのWS配下へ成果を保存</button></section>` : ''}</div>`,
  );
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
  $('#ai-provider').value = me.ai.provider;
  $('#ai-settings').onsubmit = guarded(async (e) => {
    e.preventDefault();
    me.ai = await api('/api/ai/settings', {
      provider: $('#ai-provider').value,
      model: $('#ai-model').value,
      imagePrompt: $('#ai-prompt').value,
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
  if (!me || !ws || polling || modal.open || recording) return;
  polling = true;
  try {
    const latest = await api(`/api/workshops/${ws.id}`);
    if (latest.revision !== ws.revision) {
      if (editing) {
        pending = latest;
        showPending();
      } else {
        ws = latest;
        render();
      }
    }
  } catch (e) {
    if (me) {
      toast(e.message, true);
      try {
        workshops = await api('/api/workshops');
        const next = workshops.find((w) => !w.deleted);
        if (next) await loadWorkshop(next.id);
        else {
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
const started = performance.now();
(async () => {
  try {
    await enter();
  } catch {
    login();
  }
  const remaining = Math.max(0, 5000 - (performance.now() - started));
  setTimeout(() => {
    $('#splash').remove();
    app.hidden = false;
  }, remaining);
})();
