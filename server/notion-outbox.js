export const outboxKey = (id) => `notion-outbox:${id}`;

// The sender checkpoints its frozen document here, never over the live board.
// Both the checkpoint and the Notion operation journal survive a restart.
export function snapshotStore(store, job) {
  const key = outboxKey(job.workshop.id);
  return new Proxy(store, {
    get(target, property) {
      if (property === 'put')
        return (table, id, body) => {
          if (table === 'workshops' && id === job.workshop.id) {
            job.workshop = structuredClone(body);
            target.put('kv', key, job);
            return body;
          }
          return target.put(table, id, body);
        };
      if (property === 'get')
        return (table, id) =>
          table === 'workshops' && id === job.workshop.id
            ? structuredClone(job.workshop)
            : target.get(table, id);
      if (property === 'all')
        return (table) =>
          target
            .all(table)
            .map((row) =>
              table === 'workshops' && row.id === job.workshop.id
                ? structuredClone(job.workshop)
                : row,
            );
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function mergeBlockIds(current, sent) {
  for (const [id, team] of Object.entries(current.teams)) {
    const ids = new Map((sent.teams[id]?.nodes || []).map((n) => [n.id, n.notionBlockId]));
    for (const node of team.nodes) if (ids.get(node.id)) node.notionBlockId = ids.get(node.id);
  }
}

export function preserveLocalContent(incoming, latest) {
  incoming.teams = { ...incoming.teams, ...structuredClone(latest.teams) };
  for (const field of [
    'theme',
    'votes',
    'budgets',
    'durations',
    'timers',
    'notionVoteBaseline',
    'documentSync',
  ]) {
    if (latest[field] === undefined) delete incoming[field];
    else incoming[field] = structuredClone(latest[field]);
  }
}
