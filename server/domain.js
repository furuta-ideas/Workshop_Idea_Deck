import { id, newWorkshop, newTeam, normalizeEmail, passwordHash } from './store.js';

export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const requireThat = (test, message, status = 400) => {
  if (!test) throw new Fault(status, message);
};
export const text = (v, max = 200) => {
  requireThat(typeof v === 'string' && [...v].length <= max, `文字数は${max}文字以内です`);
  return v.trim();
};
export function expiry(date) {
  if (!date) return Infinity;
  return new Date(date.length === 10 ? `${date}T23:59:59.999+09:00` : date).getTime();
}
export function validateDate(value) {
  requireThat(
    value === null || (typeof value === 'string' && Number.isFinite(expiry(value))),
    '終了日を確認してください',
  );
  return value;
}
export function expire(store, ws, now = Date.now()) {
  if (expiry(ws.endDate) < now && ws.status !== '破棄（閲覧不可）') {
    ws.status = '破棄（閲覧不可）';
    ws.revision++;
    ws.dirty = !!ws.notion;
    store.put('workshops', ws.id, ws);
  }
  return ws;
}
export function access(store, ws, user, write = false, now = Date.now()) {
  requireThat(ws, 'ワークショップがありません', 404);
  expire(store, ws, now);
  const member = ws.members[user.email];
  requireThat(user.admin || member, '参加権限がありません', 403);
  if (!user.admin) {
    requireThat(
      !ws.notion ||
        (now - (ws.notion.checkedAt || 0) < 60000 && !ws.notion.error && !ws.notion.conflict),
      'Notionの権限を再確認できません。同期をお待ちください',
      503,
    );
    requireThat(
      !ws.deleted && ws.status !== '破棄（閲覧不可）',
      'このワークショップは閲覧できません',
      403,
    );
  }
  if (write) {
    requireThat(
      ws.status === '進行中' && !ws.deleted,
      '進行中のワークショップのみ変更できます',
      403,
    );
    requireThat(user.admin || member?.role === '編集者', '閲覧専用です', 403);
  }
  return member;
}
export function teamFor(ws, user, teamId) {
  const team = ws.teams[teamId];
  requireThat(team, 'チームがありません', 404);
  requireThat(
    user.admin || ws.members[user.email]?.teamId === teamId,
    '他チームは変更できません',
    403,
  );
  return team;
}
export const totals = (ws, phase) =>
  Object.values(ws.votes[phase]).reduce((a, ballot) => {
    for (const [k, n] of Object.entries(ballot)) a[k] = (a[k] || 0) + n;
    return a;
  }, {});
export function view(ws, user) {
  const result = structuredClone(ws);
  delete result.members;
  result.votes = Object.fromEntries(
    ['cards', 'ideas'].map((p) => [
      p,
      { totals: totals(ws, p), mine: ws.votes[p][user.email] || {} },
    ]),
  );
  result.role = user.admin ? '管理者' : ws.members[user.email]?.role;
  result.myTeam = ws.members[user.email]?.teamId;
  if (!user.admin) {
    for (const [teamId, team] of Object.entries(result.teams)) {
      if (teamId !== result.myTeam) {
        team.nodes = [];
        team.deck = [];
        team.discussion = {
          running: false,
          transcript: '',
          what: team.discussion.what,
          who: team.discussion.who,
          how: team.discussion.how,
          points: team.discussion.points,
          keywords: team.discussion.keywords,
          rounds: [],
        };
      }
    }
  }
  if (user.admin) result.members = ws.members;
  return result;
}
export function createWorkshop(store, user, body) {
  requireThat(user.admin, '管理者のみ操作できます', 403);
  const ws = newWorkshop(text(body.name), user.email);
  requireThat(ws.name, '名前を入力してください');
  ws.theme = text(body.theme || body.name, 500);
  ws.endDate = validateDate(body.endDate || null);
  store.put('workshops', ws.id, ws);
  return ws;
}
export function mutate(store, user, wsId, body) {
  return store.tx(() => {
    const ws = store.get('workshops', wsId);
    access(store, ws, user, true);
    const requestKey = `${user.email}:${wsId}:${body.requestId}`;
    requireThat(
      typeof body.requestId === 'string' && body.requestId.length < 100,
      '操作IDが必要です',
    );
    if (store.get('requests', requestKey)) return ws;
    if (body.action !== 'vote')
      requireThat(
        body.revision === ws.revision,
        '別の参加者が更新しました。最新の内容を読み直してください。入力は保存されていません',
        409,
      );
    const p = body.payload || {};
    if (body.action === 'vote') {
      const phase = p.phase;
      requireThat(['cards', 'ideas'].includes(phase), '投票先が不正です');
      const timer = ws.timers[phase];
      requireThat(timer && !timer.closed && timer.endsAt > Date.now(), '投票の受付時間外です', 409);
      requireThat(p.delta === 1 || p.delta === -1, '1票ずつ操作してください');
      const valid =
        phase === 'cards'
          ? Object.values(ws.teams).some((t) => t.nodes.some((n) => n.id === p.target))
          : !!ws.teams[p.target]?.image;
      requireThat(valid, '投票先がありません');
      if (phase === 'cards') {
        const team = Object.values(ws.teams).find((t) => t.nodes.some((n) => n.id === p.target));
        teamFor(ws, user, team.id);
      }
      const ballot = (ws.votes[phase][user.email] ||= {});
      const used = Object.values(ballot).reduce((a, b) => a + b, 0);
      requireThat(
        (ballot[p.target] || 0) + p.delta >= 0 && used + p.delta <= ws.budgets[phase],
        '投票数の上限または取消可能数を超えています',
        409,
      );
      ballot[p.target] = (ballot[p.target] || 0) + p.delta;
    } else if (body.action === 'node') {
      const team = teamFor(ws, user, p.teamId);
      let node = team.nodes.find((n) => n.id === p.id);
      if (!node) {
        requireThat(team.nodes.length < 500, '項目は500件以内です');
        node = { id: id(), parent: null, group: 0 };
        team.nodes.push(node);
      }
      node.text = text(p.text, 500);
      requireThat(node.text, '言葉を入力してください');
      if (p.parent !== undefined) {
        requireThat(!p.parent || team.nodes.some((n) => n.id === p.parent), '親項目がありません');
        let cursor = p.parent;
        const seen = new Set([node.id]);
        while (cursor) {
          requireThat(!seen.has(cursor), '循環する親子関係は作れません');
          seen.add(cursor);
          cursor = team.nodes.find((n) => n.id === cursor)?.parent;
        }
        node.parent = p.parent || null;
      }
      if (p.group !== undefined) {
        requireThat(Number.isInteger(p.group) && p.group >= 0 && p.group < 8, '色が不正です');
        node.group = p.group;
      }
    } else if (body.action === 'deleteNode') {
      const team = teamFor(ws, user, p.teamId);
      requireThat(
        team.nodes.some((n) => n.id === p.id),
        '項目がありません',
      );
      team.nodes = team.nodes.filter((n) => n.id !== p.id);
      team.nodes.forEach((n) => {
        if (n.parent === p.id) n.parent = null;
      });
      team.deck = team.deck.filter((x) => x !== p.id);
      for (const ballot of Object.values(ws.votes.cards)) delete ballot[p.id];
    } else if (body.action === 'deck') {
      const team = teamFor(ws, user, p.teamId);
      const counts = totals(ws, 'cards');
      requireThat(
        Array.isArray(p.ids) && p.ids.length <= 5 && new Set(p.ids).size === p.ids.length,
        'デッキは重複なしで最大5枚です',
      );
      requireThat(
        p.ids.every((x) => team.nodes.some((n) => n.id === x) && counts[x] > 0),
        '1票以上のカードを選択してください',
      );
      team.deck = p.ids;
    } else if (body.action === 'discussion') {
      const team = teamFor(ws, user, p.teamId),
        d = team.discussion;
      for (const [key, max] of Object.entries({
        transcript: 30000,
        what: 40,
        who: 40,
        how: 120,
        points: 5000,
        keywords: 500,
      }))
        if (p[key] !== undefined) d[key] = text(p[key], max);
      if (p.running !== undefined) {
        requireThat(typeof p.running === 'boolean', '状態が不正です');
        if (d.running && !p.running)
          d.rounds.push({
            endedAt: new Date().toISOString(),
            transcript: d.transcript,
            what: d.what,
            who: d.who,
            how: d.how,
            points: d.points,
          });
        d.running = p.running;
      }
    } else if (body.action === 'settings') {
      requireThat(user.admin, '管理者のみ操作できます', 403);
      for (const phase of ['cards', 'ideas']) {
        if (p.budgets?.[phase] !== undefined) {
          const n = p.budgets[phase];
          requireThat(Number.isInteger(n) && n >= 1 && n <= 100, '票数は1〜100です');
          requireThat(
            Object.values(ws.votes[phase]).every(
              (b) => Object.values(b).reduce((a, v) => a + v, 0) <= n,
            ),
            '使用済みの票数未満には変更できません',
          );
          ws.budgets[phase] = n;
        }
        if (p.durations?.[phase] !== undefined) {
          const n = p.durations[phase];
          requireThat(Number.isInteger(n) && n >= 10 && n <= 3600, '時間は10〜3600秒です');
          ws.durations[phase] = n;
        }
      }
    } else if (body.action === 'timer') {
      requireThat(user.admin, '管理者のみ操作できます', 403);
      requireThat(['cards', 'ideas'].includes(p.phase), '投票種別が不正です');
      ws.timers[p.phase] = p.stop
        ? { ...ws.timers[p.phase], closed: true }
        : { endsAt: Date.now() + ws.durations[p.phase] * 1000, closed: false };
    } else if (body.action === 'addTeam') {
      requireThat(user.admin, '管理者のみ操作できます', 403);
      const t = newTeam(text(p.name, 80));
      requireThat(
        t.name && Object.keys(ws.teams).length < 50,
        'チーム名または上限を確認してください',
      );
      ws.teams[t.id] = t;
    } else throw new Fault(400, '未対応の操作です');
    // A cancelled card vote can invalidate a previously selected deck.
    const counts = totals(ws, 'cards');
    for (const team of Object.values(ws.teams)) team.deck = team.deck.filter((x) => counts[x] > 0);
    ws.revision++;
    store.put('workshops', ws.id, ws);
    store.put('requests', requestKey, { at: Date.now() });
    return ws;
  });
}
export function updateMeta(store, user, wsId, body) {
  requireThat(user.admin, '管理者のみ操作できます', 403);
  return store.tx(() => {
    const ws = store.get('workshops', wsId);
    access(store, ws, user);
    requireThat(body.revision === ws.revision, '更新が競合しました', 409);
    requireThat(!ws.notion?.conflict, 'Notionとの競合を解決してください', 409);
    if (body.name !== undefined) {
      ws.name = text(body.name);
      requireThat(ws.name, '名前を入力してください');
    }
    if (body.theme !== undefined) ws.theme = text(body.theme, 500);
    if (body.endDate !== undefined) ws.endDate = validateDate(body.endDate);
    if (body.status !== undefined) {
      requireThat(
        ['未着手', '進行中', '完了（変更不可）', '破棄（閲覧不可）'].includes(body.status),
        'ステータスが不正です',
      );
      ws.status = body.status;
    }
    if (body.deleted !== undefined) {
      requireThat(body.deleted === true, '削除操作が不正です');
      ws.deleted = true;
      ws.status = '破棄（閲覧不可）';
    }
    ws.dirty = !!ws.notion;
    ws.revision++;
    expire(store, ws);
    store.put('workshops', ws.id, ws);
    return ws;
  });
}
export function markdown(ws, team) {
  const d = team.discussion;
  const keywords = d.keywords
    .split(/[、,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const clean = (s) => String(s).replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
  const bold = (s) => {
    let v = clean(s);
    for (const k of keywords) v = v.split(clean(k)).join(`**${clean(k)}**`);
    return v;
  };
  return `# ${clean(ws.name)} / ${clean(team.name)}\n\nWHAT: ${bold(d.what)}\n\nWHO: ${bold(d.who)}\n\nHOW: ${bold(d.how)}\n\n${d.points
    .split('\n')
    .filter(Boolean)
    .map((x) => '- ' + bold(x))
    .join(
      '\n',
    )}\n\n## 議論記録\n\n${clean(d.transcript)}\n\n## 選択したカード\n\n${team.deck.map((x) => '- ' + clean(team.nodes.find((n) => n.id === x)?.text || '')).join('\n')}\n`;
}
