import { hash } from './store.js';
import { requireThat } from './domain.js';

export const mapActions = new Set([
  'node',
  'createTopic',
  'pasteOutline',
  'topicTheme',
  'reparent',
  'standalone',
  'deleteNode',
  'undoClassification',
]);
export const mapUndoLimit = 20;
const keyFor = (ws, team, user) => `map-undo:${ws.id}:${team.id}:${hash(user.email)}`;
const logicalNode = ({ id, text, parent, group }) => ({ id, text, parent, group });
const fingerprint = (team) =>
  hash(JSON.stringify({ rootText: team.rootText ?? null, nodes: team.nodes.map(logicalNode) }));

export function captureMap(ws, team, withVotes = false) {
  return structuredClone({
    nodes: team.nodes,
    rootText: team.rootText ?? null,
    deck: team.deck,
    lastGrouping: team.lastGrouping ?? null,
    ...(withVotes ? { votes: ws.votes.cards, baseline: ws.notionVoteBaseline?.cards || {} } : {}),
  });
}

export function recordMapUndo(store, ws, team, user, before) {
  const afterHash = fingerprint(team);
  if (afterHash === fingerprint(before)) return;
  const key = keyFor(ws, team, user),
    history = store.get('kv', key)?.entries || [],
    previous = new Map(before.nodes.map((n) => [n.id, n])),
    current = new Map(team.nodes.map((n) => [n.id, n])),
    deleted = new Set(before.nodes.filter((n) => !current.has(n.id)).map((n) => n.id));
  // Never rewind across another participant's map change or an external import.
  if (history.length && history.at(-1).afterHash !== fingerprint(before)) history.length = 0;
  const entry = {
    afterHash,
    rootText: before.rootText,
    lastGrouping: before.lastGrouping,
    order: before.nodes.map((n) => n.id),
    nodes: before.nodes.filter(
      (n) =>
        !current.has(n.id) ||
        JSON.stringify(logicalNode(n)) !== JSON.stringify(logicalNode(current.get(n.id))),
    ),
    added: team.nodes.filter((n) => !previous.has(n.id)).map((n) => n.id),
    deck: before.deck.map((id, index) => ({ id, index })).filter((n) => deleted.has(n.id)),
    votes: Object.fromEntries(
      Object.entries(before.votes || {})
        .map(([email, ballot]) => [
          email,
          Object.fromEntries(Object.entries(ballot).filter(([id]) => deleted.has(id))),
        ])
        .filter(([, ballot]) => Object.keys(ballot).length),
    ),
    baseline: Object.fromEntries(
      Object.entries(before.baseline || {}).filter(([id]) => deleted.has(id)),
    ),
  };
  history.push(entry);
  while (
    history.length > mapUndoLimit ||
    Buffer.byteLength(JSON.stringify(history)) > 2 * 1024 * 1024
  )
    history.shift();
  store.put('kv', key, { entries: history });
}

export function removeCards(ws, team, removed) {
  team.nodes = team.nodes.filter((n) => !removed.has(n.id));
  team.deck = team.deck.filter((id) => !removed.has(id));
  for (const ballot of Object.values(ws.votes.cards)) for (const id of removed) delete ballot[id];
  if (ws.notionVoteBaseline?.cards)
    for (const id of removed) delete ws.notionVoteBaseline.cards[id];
}

export function undoMap(store, ws, team, user) {
  const key = keyFor(ws, team, user),
    history = store.get('kv', key)?.entries || [],
    entry = history.at(-1);
  requireThat(entry, '取り消せるマップ操作がありません（最大20操作）', 409);
  requireThat(
    entry.afterHash === fingerprint(team),
    '別の編集があるため、この操作は取り消せません。最新のマップを確認してください',
    409,
  );
  const current = new Map(team.nodes.map((n) => [n.id, n]));
  removeCards(ws, team, new Set(entry.added));
  const restored = new Map(team.nodes.map((n) => [n.id, n]));
  for (const node of entry.nodes) {
    const value = structuredClone(node);
    if (current.get(node.id)?.notionBlockId)
      value.notionBlockId = current.get(node.id).notionBlockId;
    restored.set(node.id, value);
  }
  team.nodes = entry.order.map((id) => restored.get(id));
  requireThat(team.nodes.every(Boolean), '復元するトピックを確認できません', 409);
  if (entry.rootText === null) delete team.rootText;
  else team.rootText = entry.rootText;
  if (entry.lastGrouping === null) delete team.lastGrouping;
  else team.lastGrouping = structuredClone(entry.lastGrouping);
  // Restore deletion side effects without overwriting subsequent ballots or decks.
  for (const [email, ballot] of Object.entries(entry.votes)) {
    const existing = ws.votes.cards[email] || {},
      merged = { ...existing, ...ballot };
    requireThat(
      Object.values(merged).reduce((a, n) => a + n, 0) <= ws.budgets.cards,
      '削除後の投票と競合しています。票数を調整してから取り消してください',
      409,
    );
    ws.votes.cards[email] = merged;
  }
  if (Object.keys(entry.baseline).length) {
    ws.notionVoteBaseline ||= { cards: {}, ideas: {} };
    Object.assign(ws.notionVoteBaseline.cards, entry.baseline);
  }
  for (const { id, index } of entry.deck)
    if (!team.deck.includes(id)) team.deck.splice(Math.min(index, team.deck.length), 0, id);
  requireThat(
    team.deck.length <= 5,
    '削除後のデッキ選択と競合しています。選択を調整してから取り消してください',
    409,
  );
  history.pop();
  store.put('kv', key, { entries: history });
}
