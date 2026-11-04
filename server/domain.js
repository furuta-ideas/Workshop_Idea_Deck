import { id, newWorkshop, newTeam, normalizeEmail, passwordHash } from './store.js';
import { parseOutline } from './outline.js';
import { mapActions, captureMap, recordMapUndo, removeCards, undoMap } from './map-history.js';

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
    requireThat(!ws.createAttempt || ws.notion, 'Notionへの登録結果の確認をお待ちください', 409);
    requireThat(
      !ws.notion?.provisioning,
      'Notionテンプレートを準備しています。少しお待ちください',
      409,
    );
    requireThat(
      ws.status === '進行中' && !ws.deleted,
      '進行中のワークショップのみ変更できます',
      403,
    );
    requireThat(user.admin || member?.role === '編集者', '閲覧専用です', 403);
  }
  return member;
}
export function teamFor(ws, user, teamId, write = true) {
  const team = ws.teams[teamId];
  requireThat(team, 'チームがありません', 404);
  requireThat(!write || ws.members[user.email]?.teamId === teamId, '他チームは変更できません', 403);
  return team;
}
export const totals = (ws, phase) =>
  Object.values(ws.votes[phase]).reduce(
    (a, ballot) => {
      for (const [k, n] of Object.entries(ballot)) a[k] = (a[k] || 0) + n;
      return a;
    },
    { ...(ws.notionVoteBaseline?.[phase] || {}) },
  );
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
  if (user.admin) result.members = ws.members;
  return result;
}
function parentFor(team, node, requested) {
  requireThat(
    requested === null || requested === 'theme' || team.nodes.some((n) => n.id === requested),
    '接続先の項目がありません',
  );
  let cursor = requested;
  const seen = new Set([node.id]);
  while (cursor && cursor !== 'theme') {
    requireThat(!seen.has(cursor), '循環する親子関係は作れません');
    seen.add(cursor);
    cursor = team.nodes.find((n) => n.id === cursor)?.parent;
  }
  return requested;
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
    const mapTeam = mapActions.has(body.action) ? teamFor(ws, user, p.teamId) : null;
    const mapBefore = mapTeam && captureMap(ws, mapTeam, body.action === 'deleteNode');
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
        requireThat(
          p.parent === undefined || p.parent === null,
          '新しい気づきは単独で追加してください',
        );
        node = { id: id(), parent: null, group: 0 };
        team.nodes.push(node);
      }
      node.text = text(p.text, 500);
      requireThat(node.text, '言葉を入力してください');
      if (p.parent !== undefined) {
        node.parent = parentFor(team, node, p.parent);
      }
      if (p.group !== undefined) {
        requireThat(Number.isInteger(p.group) && p.group >= 0 && p.group < 8, '色が不正です');
        node.group = p.group;
      }
    } else if (body.action === 'createTopic') {
      const team = teamFor(ws, user, p.teamId);
      requireThat(team.nodes.length < 500, '項目は500件以内です');
      const words = text(p.text, 500);
      requireThat(words, 'トピックを入力してください');
      requireThat(
        ['floating', 'sibling', 'child', 'main'].includes(p.placement),
        '追加位置が不正です',
      );
      const anchor = team.nodes.find((n) => n.id === p.anchorId);
      if (['sibling', 'child'].includes(p.placement))
        requireThat(anchor || p.anchorId === 'theme', '追加元のトピックがありません');
      const parent =
        p.placement === 'floating'
          ? null
          : p.placement === 'main' || p.anchorId === 'theme'
            ? 'theme'
            : p.placement === 'child'
              ? anchor.id
              : anchor.parent;
      const node = { id: id(), text: words, parent, group: anchor?.group || 0 };
      let at = team.nodes.length;
      if (anchor) {
        const descendants = new Set([anchor.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of team.nodes)
            if (descendants.has(n.parent) && !descendants.has(n.id)) {
              descendants.add(n.id);
              changed = true;
            }
        }
        at = Math.max(...team.nodes.map((n, i) => (descendants.has(n.id) ? i : -1))) + 1;
      }
      team.nodes.splice(at, 0, node);
    } else if (body.action === 'pasteOutline') {
      const team = teamFor(ws, user, p.teamId);
      const outline = parseOutline(p.text);
      requireThat(team.nodes.length + outline.length <= 500, '貼り付け後の項目は500件以内です');
      requireThat(['child', 'sibling'].includes(p.placement), '貼り付け位置が不正です');
      const anchor = team.nodes.find((n) => n.id === p.anchorId);
      requireThat(anchor || p.anchorId === 'theme', '貼り付け先のトピックがありません');
      const rootParent =
        p.anchorId === 'theme' ? 'theme' : p.placement === 'child' ? anchor.id : anchor.parent;
      const inserted = outline.map((n) => ({ id: id(), text: n.text, group: anchor?.group || 0 }));
      outline.forEach((n, i) => {
        inserted[i].parent = n.parentIndex === null ? rootParent : inserted[n.parentIndex].id;
      });
      const descendants = new Set([p.anchorId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of team.nodes)
          if (descendants.has(n.parent) && !descendants.has(n.id)) {
            descendants.add(n.id);
            changed = true;
          }
      }
      const at = anchor
        ? Math.max(...team.nodes.map((n, i) => (descendants.has(n.id) ? i : -1))) + 1
        : team.nodes.length;
      team.nodes.splice(at, 0, ...inserted);
    } else if (body.action === 'topicTheme') {
      const team = teamFor(ws, user, p.teamId);
      team.rootText = text(p.text, 500);
      requireThat(team.rootText, '中心トピックを入力してください');
    } else if (body.action === 'undoClassification') {
      const team = teamFor(ws, user, p.teamId),
        backup = team.lastGrouping;
      requireThat(backup, '元に戻せる分類がありません');
      requireThat(
        backup.applied.every((item) => {
          const n = team.nodes.find((n) => n.id === item.id);
          return !n || n.group === item.group;
        }),
        '分類後に変更があります。上書きを避けるため元に戻せません',
        409,
      );
      for (const item of backup.before) {
        const node = team.nodes.find((n) => n.id === item.id);
        if (node) node.group = item.group;
      }
      delete team.lastGrouping;
    } else if (body.action === 'reorderTopic') {
      const team = teamFor(ws, user, p.teamId),
        node = team.nodes.find((n) => n.id === p.id),
        target = team.nodes.find((n) => n.id === p.targetId);
      requireThat(
        node && target && node.id !== target.id,
        '移動するトピックと挿入先を確認してください',
      );
      requireThat(['before', 'after'].includes(p.position), '挿入位置が不正です');
      node.parent = parentFor(team, node, target.parent);
      const descendants = (root, nodes) => {
        const ids = new Set([root]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of nodes)
            if (ids.has(n.parent) && !ids.has(n.id)) {
              ids.add(n.id);
              changed = true;
            }
        }
        return ids;
      };
      const moving = descendants(node.id, team.nodes);
      requireThat(!moving.has(target.id), '自分の枝の中へは移動できません');
      const branch = team.nodes.filter((n) => moving.has(n.id)),
        rest = team.nodes.filter((n) => !moving.has(n.id)),
        targetBranch = descendants(target.id, rest);
      const at =
        p.position === 'before'
          ? rest.findIndex((n) => n.id === target.id)
          : Math.max(...rest.map((n, i) => (targetBranch.has(n.id) ? i : -1))) + 1;
      rest.splice(at, 0, ...branch);
      team.nodes = rest;
    } else if (body.action === 'reparent' || body.action === 'standalone') {
      const team = teamFor(ws, user, p.teamId);
      const node = team.nodes.find((n) => n.id === p.id);
      requireThat(node, '項目がありません', 404);
      node.parent = parentFor(team, node, body.action === 'standalone' ? null : p.parent);
      if (body.action === 'standalone')
        for (const child of team.nodes) if (child.parent === node.id) child.parent = null;
      if (node.parent === null) {
        team.nodes = team.nodes.filter((n) => n.id !== node.id);
        team.nodes.push(node);
      }
    } else if (body.action === 'deleteNode') {
      const team = teamFor(ws, user, p.teamId);
      requireThat(
        team.nodes.some((n) => n.id === p.id),
        '項目がありません',
      );
      const removed = new Set([p.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of team.nodes)
          if (removed.has(n.parent) && !removed.has(n.id)) {
            removed.add(n.id);
            changed = true;
          }
      }
      removeCards(ws, team, removed);
    } else if (body.action === 'undoMap') {
      undoMap(store, ws, teamFor(ws, user, p.teamId), user);
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
      if (p.slots !== undefined) {
        requireThat(
          Array.isArray(p.slots) &&
            p.slots.length === 5 &&
            p.slots.every((id) => id === null || p.ids.includes(id)) &&
            JSON.stringify(p.slots.filter(Boolean)) === JSON.stringify(p.ids),
          'デッキの配置が不正です',
        );
        team.deckSlots = p.slots;
      } else team.deckSlots = [...p.ids, ...Array(5 - p.ids.length).fill(null)];
    } else if (body.action === 'discussion') {
      const team = teamFor(ws, user, p.teamId),
        d = team.discussion;
      for (const [key, max] of Object.entries({
        transcript: 30000,
        headline: 100,
        pressRelease: 2000,
        what: 40,
        who: 40,
        how: 120,
        points: 5000,
        keywords: 500,
      }))
        if (p[key] !== undefined) d[key] = text(p[key], max);
      if (p.features !== undefined) {
        requireThat(Array.isArray(p.features) && p.features.length <= 3, '特長は３つまでです');
        d.features = p.features.map((value) => {
          const line = text(value, 200);
          requireThat(!/[\r\n]/.test(line), '特長は１行ずつ入力してください');
          return line;
        });
      }
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
            headline: d.headline || '',
            features: d.features || [],
            pressRelease: d.pressRelease || '',
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
      requireThat(['cards', 'ideas'].includes(p.phase), '投票種別が不正です');
      if (!user.admin) {
        requireThat(p.phase === 'cards', '管理者のみ操作できます', 403);
        teamFor(ws, user, p.teamId);
      }
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
    if (mapBefore) recordMapUndo(store, ws, mapTeam, user, mapBefore);
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
  return `# ${clean(ws.name)} / ${clean(team.name)}\n\n一言で言うと: ${bold(d.headline || '')}\n\nWHO: ${bold(d.who)}\n\nWHAT: ${bold(d.what)}\n\nHOW: ${bold(d.how)}\n\n## ３つの特長\n\n${(
    d.features || []
  )
    .filter(Boolean)
    .map((x) => '- ' + bold(x))
    .join('\n')}\n\n## 模擬プレスリリース\n\n${clean(d.pressRelease || '')}\n\n${d.points
    .split('\n')
    .filter(Boolean)
    .map((x) => '- ' + bold(x))
    .join(
      '\n',
    )}\n\n## 議論記録\n\n${clean(d.transcript)}\n\n## 選択したカード\n\n${team.deck.map((x) => '- ' + clean(team.nodes.find((n) => n.id === x)?.text || '')).join('\n')}\n`;
}
