import { text, requireThat, totals } from './domain.js';
const stages = {
  ideation: '② もやもやの言語化',
  selection: '③ カードで議論深耕',
  visualization: '④ 模擬プレスの作成',
  voting: '⑤ ペーパープロトの作成',
};
const tail = (v, max) => [...String(v || '')].slice(-max).join('');
export function screenContext(ws, team, body) {
  const screen = body.screen || {};
  requireThat(
    screen && typeof screen === 'object' && !Array.isArray(screen),
    '画面の情報を確認してください',
  );
  const ids = screen.visibleTopicIds;
  requireThat(
    ids === undefined ||
      (Array.isArray(ids) &&
        ids.length <= 500 &&
        ids.every((id) => typeof id === 'string' && id.length <= 100)),
    '表示中のトピックを確認してください',
  );
  const visible = team.nodes.filter((n) => !ids || ids.includes(n.id));
  const selected = team.nodes.find((n) => n.id === screen.selectedTopicId),
    discussion = { ...team.discussion };
  if (body.phase === 'visualization' && screen.discussion) {
    const d = screen.discussion;
    for (const [key, max] of Object.entries({
      transcript: 100000,
      headline: 100,
      who: 40,
      what: 40,
      how: 120,
      points: 5000,
      keywords: 500,
      pressRelease: 2000,
    }))
      if (d[key] !== undefined) discussion[key] = text(d[key], max);
    if (d.features !== undefined) {
      requireThat(Array.isArray(d.features) && d.features.length <= 3, '特長は３つまでです');
      discussion.features = d.features.map((v) => text(v, 200));
    }
  }
  const draft = screen.topicDraft;
  let topicDraft;
  if (draft) {
    requireThat(
      draft.id === 'theme' || team.nodes.some((n) => n.id === draft.id) || draft.isNew === true,
      '編集中のトピックを確認してください',
    );
    topicDraft = { text: text(draft.text, 500), isNew: !!draft.isNew };
    if (!draft.isNew) topicDraft.id = draft.id;
  }
  const votes = totals(ws, 'cards');
  return {
    stage: stages[body.phase],
    workshop: ws.name,
    team: team.name,
    theme: team.rootText || ws.theme,
    visible_topics: visible.map((n) => ({
      id: n.id,
      text: n.text,
      parent: n.parent,
      group: n.group,
      votes: votes[n.id] || 0,
    })),
    selected_topic: selected
      ? { id: selected.id, text: selected.text }
      : screen.selectedTopicId === 'theme'
        ? { id: 'theme', text: team.rootText || ws.theme }
        : null,
    topic_draft: topicDraft,
    selected_cards: team.deck
      .map((id) => {
        const n = team.nodes.find((n) => n.id === id);
        return n ? { id, text: n.text } : null;
      })
      .filter(Boolean),
    discussion:
      body.phase === 'visualization'
        ? Object.fromEntries(
            [
              'transcript',
              'headline',
              'who',
              'what',
              'how',
              'features',
              'points',
              'keywords',
              'pressRelease',
            ].map((key) => [key, key === 'transcript' ? tail(discussion[key], 12000) : (discussion[key] ?? '')]),
          )
        : undefined,
    // The voice log recorded in ① is context on every step (its latest part).
    discussion_log:
      body.phase !== 'visualization' && discussion.transcript
        ? tail(discussion.transcript, 4000)
        : undefined,
    ideas:
      body.phase === 'voting'
        ? Object.values(ws.teams).map((t) => ({
            team: t.name,
            headline: t.discussion.headline || '',
            who: t.discussion.who,
            what: t.discussion.what,
            how: t.discussion.how,
            features: t.discussion.features || [],
            votes: [t.id, ...(t.ideas || []).map((i) => i.id)].reduce((a, k) => a + (totals(ws, 'ideas')[k] || 0), 0),
            image_available: !!t.image,
          }))
        : undefined,
  };
}
