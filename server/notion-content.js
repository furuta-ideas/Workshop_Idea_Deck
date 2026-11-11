// The workshop record in Notion.
//
// v0.21: the app keeps one living record under 「ワークショップの記録」 (see writeRecord):
// a toggle per team with ① the voice log, ② the mind map and one toggle per deck, plus
// 「ペーパープロトの投票」. Only the parts that changed are written again. Notion is a place
// to read the record; edits made there are not brought back to the app.
// The reading code below (parse, readTree, latestEntries) understands the timestamped
// history entries of v0.14–v0.20 and is kept for scripts/check-notion-content.js.
import { hash } from './store.js';
import { requireThat, mutate, access, teamFor, totals } from './domain.js';
import { validatePNG } from './png.js';
import { preserveLocalContent } from './notion-outbox.js';
import { patchDiscussion, hasDeckContent, ideaImageKey } from './ideas.js';

export const historyHeading = 'ワークショップの履歴';
// v0.21: the living record (see writeRecord).
export const recordHeading = 'ワークショップの記録';
export const voteTitle = 'ペーパープロトの投票';
// Notion calls one run may spend on the record; the rest continues in the next run.
const RECORD_BUDGET = 30;
export const sections = {
  world: '求められる世界',
  map: 'マインドマップ',
  image: 'ペーパープロトタイプ',
  press: '模擬プレスリリース',
  outline: 'アイデアの輪郭',
  memo: '議論メモ',
  settings: '設定情報',
};
export const settingTitles = {
  facilitator: 'AIファシリテータ（プロンプト）',
  imagePrompt: 'ペーパープロトタイプ（プロンプト）',
  pressPrompt: '模擬プレスリリース（プロンプト）',
  votes: '投票結果',
};
const outlineFields = [
  ['headline', '一言で言うと', 100],
  ['who', 'Who', 40],
  ['what', 'What', 40],
  ['how', 'How', 120],
  ['feature1', '特長1', 200],
  ['feature2', '特長2', 200],
  ['feature3', '特長3', 200],
  ['keywords', 'キーワード', 500],
];
const colors = [
  'default',
  'green_background',
  'orange_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
  'gray_background',
];
const textTypes = new Set([
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'toggle',
  'bulleted_list_item',
  'numbered_list_item',
  'paragraph',
  'to_do',
  'quote',
  'callout',
]);
const stateKey = (id) => `notion-content:${id}`;
const outboxKey = (id) => `notion-history-outbox:${id}`;
const plain = (list) => (list || []).map((x) => x.plain_text ?? x.text?.content ?? '').join('');
const words = (b) => plain(b?.[b.type]?.rich_text);
const clip = (s, max) => [...String(s ?? '')].slice(0, max).join('');
const rt = (value) => {
  const s = String(value ?? '');
  const n = Math.max(1, Math.min(100, Math.ceil(s.length / 2000)));
  return Array.from({ length: n }, (_, i) => ({
    type: 'text',
    text: { content: s.slice(i * 2000, (i + 1) * 2000) },
  }));
};
const block = (type, text, extra = {}) => ({
  object: 'block',
  type,
  [type]: { rich_text: rt(text), ...extra },
});
const toggle = (text, children, color) =>
  block('toggle', text, {
    ...(color ? { color } : {}),
    ...(children?.length ? { children } : {}),
  });
// Long text → paragraphs of about 1,800 characters, cut at line ends. A recording's
// start line (#01 10:15:30) and end divider begin a paragraph of their own.
const textBlocks = (value, max = 1800) => {
  const out = [];
  let current = '';
  for (const line of String(value || '').split('\n')) {
    const mark = /^#\d+ /.test(line) || /^―+ 録音終了/.test(line);
    if (current && (mark || current.length + line.length + 1 > max)) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
    if (mark) {
      out.push(current);
      current = '';
    }
  }
  if (current.trim()) out.push(current);
  return out.length
    ? out.map((p) => block('paragraph', p))
    : [block('paragraph', '（まだありません）')];
};
// Long text → one paragraph per blank-line separated part.
const paragraphs = (text) => {
  const parts = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts.map((p) => block('paragraph', p)) : [block('paragraph', '')];
};
const stamp = (ms) => {
  const jst = new Date(ms + 9 * 3600000).toISOString();
  return `${jst.slice(0, 10).replaceAll('-', '')}_${jst.slice(11, 19).replaceAll(':', '')}`;
};
export const entryTitle = (ws, team, ms) => `${stamp(ms)}_${ws.name}＿${team.name}`;
// "yyyymmdd_hhmmss_…＿<team>" → "yyyymmdd_hhmmss", else null (template, examples).
const entryStamp = (title, teamName) => {
  const m = /^(\d{8}_\d{6})_/.exec(title || '');
  if (!m) return null;
  return title.endsWith(`＿${teamName}`) || title.endsWith(`_${teamName}`) ? m[1] : null;
};
// Network trouble, rate limits and Notion 5xx retry by themselves.
const retryable = (e) =>
  e.notionStatus === 429 || e.notionStatus >= 500 || (!e.status && !e.notionStatus);
// Changes made without 「記録を保存」 (AI results, transcripts, deck choices) are recorded
// once things settle, as one entry per team for that window.
export const AUTO_DELAY_MS = 60000;
// The page's app settings live in one toggle under 「アプリの設定」, replaced on each change.
export const settingsHeading = 'アプリの設定';
export const settingsToggle = '設定情報（アプリの最新設定）';
export const syncDue = (s) => s?.queued && (!s.error || s.retryable);
export const syncAt = (s) => Math.max(s?.dueAt || 0, s?.error ? s.retryAt || 0 : 0);

// ④ votes of a team: its own (older data) plus those of each saved deck.
export function teamIdeaVotes(ws, team) {
  const t = totals(ws, 'ideas');
  return (t[team.id] || 0) + (team.ideas || []).reduce((a, i) => a + (t[i.id] || 0), 0);
}
export class NotionContent {
  constructor(notion) {
    this.notion = notion;
    this.store = notion.store;
    this.active = new Map();
    this.reading = new Set();
  }
  state(ws) {
    return this.store.get('kv', stateKey(ws.id));
  }
  save(ws, state) {
    this.store.put('kv', stateKey(ws.id), state);
  }
  outbox(wsId) {
    return this.store.get('kv', outboxKey(wsId))?.jobs || [];
  }
  // ---- Writing -----------------------------------------------------------
  settings() {
    const rows = this.notion.settingsProvider?.() || [];
    const value = (key) => rows.find((r) => r.key === key)?.value || '';
    return {
      facilitator: value('ai:facilitator'),
      imagePrompt: value('ai:imagePrompt'),
      pressPrompt: value('ai:pressReleasePrompt'),
    };
  }
  capture(ws, team, now) {
    const cardTotals = totals(ws, 'cards');
    const d = team.discussion;
    return {
      teamId: team.id,
      teamName: team.name,
      title: entryTitle(ws, team, now),
      world: team.rootText || ws.theme || '',
      nodes: team.nodes.map(({ id, text, parent, group }) => ({ id, text, parent, group })),
      press: d.pressRelease || '',
      outline: {
        headline: d.headline || '',
        who: d.who || '',
        what: d.what || '',
        how: d.how || '',
        feature1: d.features?.[0] || '',
        feature2: d.features?.[1] || '',
        feature3: d.features?.[2] || '',
        keywords: d.keywords || '',
      },
      memo: d.transcript || '',
      settings: this.settings(),
      votes: Object.fromEntries(
        team.nodes.filter((n) => cardTotals[n.id] > 0).map((n) => [n.id, cardTotals[n.id]]),
      ),
      deck: [...team.deck],
      ideaVotes: teamIdeaVotes(ws, team),
      imageKey: team.image ? hash(team.image.base64) : null,
    };
  }
  // Record a snapshot of one team now; it is sent in the background.
  // 'auto' snapshots replace this team's earlier unsent 'auto' snapshot and wait
  // AUTO_DELAY_MS; 'save' and 'image' are sent at once and never replaced.
  schedule(ws, teamId, reason = 'save', now = Date.now(), snapshot, delay) {
    const team = ws.teams[teamId];
    if (!ws.notion || !team) return ws;
    const sending = this.active.has(ws.id);
    let jobs = this.outbox(ws.id);
    if (!sending || jobs.length > 1)
      jobs = jobs.filter((j, i) => (sending && i === 0) || !(j.reason === 'auto' && j.snapshot?.teamId === teamId));
    jobs.push({ reason, snapshot: snapshot || this.capture(ws, team, now) });
    return this.queue(ws, jobs, now + (delay ?? (reason === 'auto' ? AUTO_DELAY_MS : 0)));
  }
  queue(ws, jobs, dueAt) {
    this.store.put('kv', outboxKey(ws.id), { jobs });
    const s = ws.documentSync || {};
    ws.documentSync = {
      ...s,
      queued: true,
      pending: true,
      dueAt: s.queued && s.dueAt ? Math.min(s.dueAt, dueAt) : dueAt,
      error: s.retryable ? s.error : null,
    };
    this.store.put('workshops', ws.id, ws);
    return ws;
  }
  // App settings (AI prompts and models, facilitator md, this workshop's display and
  // voting settings) as label/value rows.
  settingsRows(ws) {
    const rows = (this.notion.settingsProvider?.() || []).map(({ label, value }) => ({ label, value: String(value ?? '') }));
    const character = { kashi: 'かっしー（男の子）', leafy: 'リーフィー（女の子）' }[ws.character || 'kashi'];
    rows.push(
      { label: '①・④の文字サイズ', value: `${ws.textScale || 115}%` },
      { label: 'AIアドバイスのキャラクター', value: character },
      { label: '② カード投票の票数・投票時間', value: `${ws.budgets?.cards}票・${ws.durations?.cards}秒` },
      { label: '⑤ アイディア投票の票数・投票時間', value: `${ws.budgets?.ideas}票・${ws.durations?.ideas}秒` },
    );
    return rows;
  }
  scheduleSettings(ws, now = Date.now()) {
    if (!ws?.notion || ws.deleted) return ws;
    const jobs = this.outbox(ws.id).filter((j, i) => (this.active.has(ws.id) && i === 0) || j.reason !== 'settings');
    jobs.push({ reason: 'settings', at: now });
    return this.queue(ws, jobs, now + 2000);
  }
  async writeSettings(ws) {
    const top = await this.topBlocks(ws);
    for (const b of top.filter((b) => b.type === 'toggle' && words(b) === settingsToggle))
      await this.notion.call(`blocks/${b.id}`, 'PATCH', { in_trash: true });
    let heading = top.find((b) => /^heading_/.test(b.type) && words(b).trim() === settingsHeading);
    if (!heading)
      [heading] = await this.append(ws.notion.pageId, [block('heading_2', settingsHeading, { color: 'green_background' })]);
    const [box] = await this.append(ws.notion.pageId, [toggle(settingsToggle)], { type: 'after_block', after_block: { id: heading.id } });
    requireThat(box?.id, 'Notionへの設定の保存結果を確認できません', 502);
    const rows = this.settingsRows(this.store.get('workshops', ws.id) || ws);
    const long = rows.filter((r) => r.value.length > 120 || r.value.includes('\n')),
      short = rows.filter((r) => !long.includes(r));
    await this.append(box.id, [
      block('paragraph', `更新：${stamp(Date.now()).replace('_', ' ')}（アプリで設定を保存すると、この欄を最新の内容に置き換えます）`),
      ...short.map((r) => block('paragraph', `${r.label}：${r.value || '（未設定）'}`)),
    ]);
    if (long.length) {
      const made = await this.append(box.id, long.map((r) => toggle(r.label)));
      for (const [i, r] of long.entries()) if (made[i]?.id) await this.append(made[i].id, paragraphs(r.value));
    }
  }
  activity(user, wsId, teamId) {
    const ws = this.store.get('workshops', wsId);
    access(this.store, ws, user, true);
    teamFor(ws, user, teamId);
    return { queued: !!ws.documentSync?.queued };
  }
  due(now = Date.now()) {
    return this.store
      .all('workshops')
      .filter(
        (ws) =>
          ws.notion &&
          syncDue(ws.documentSync) &&
          syncAt(ws.documentSync) <= now &&
          !this.active.has(ws.id) &&
          !this.reading.has(ws.id),
      )
      .sort((a, b) => syncAt(a.documentSync) - syncAt(b.documentSync))[0];
  }
  recoverScheduled() {
    for (const ws of this.store.all('workshops'))
      if (ws.notion && ws.documentSync?.syncing) {
        const queued = this.outbox(ws.id).length > 0;
        ws.documentSync = { ...ws.documentSync, syncing: false, queued, pending: queued };
        this.store.put('workshops', ws.id, ws);
      }
  }
  requestRetry(wsId, now = Date.now()) {
    const ws = this.store.get('workshops', wsId);
    if (this.active.has(wsId)) return ws;
    const queued = this.outbox(wsId).length > 0;
    ws.documentSync = {
      ...ws.documentSync,
      error: null,
      retries: 0,
      retryAt: 0,
      queued,
      pending: queued,
      dueAt: now,
    };
    this.store.put('workshops', wsId, ws);
    return ws;
  }
  async retry(ws) {
    return this.flushScheduled(ws.id, Date.now(), true);
  }
  async flushScheduled(wsId, now = Date.now(), force = false) {
    if (this.active.has(wsId)) return this.active.get(wsId);
    const ws = this.store.get('workshops', wsId);
    if (
      !ws?.notion ||
      this.reading.has(wsId) ||
      (!force && (!syncDue(ws.documentSync) || syncAt(ws.documentSync) > now))
    )
      return ws;
    const work = this.sendAll(wsId, now);
    this.active.set(wsId, work);
    try {
      return await work;
    } finally {
      this.active.delete(wsId);
    }
  }
  async sendAll(wsId, now) {
    let ws = this.store.get('workshops', wsId);
    ws.documentSync = { ...ws.documentSync, syncing: true };
    this.store.put('workshops', wsId, ws);
    let error = null,
      more = false;
    try {
      for (;;) {
        const jobs = this.outbox(wsId);
        if (!jobs.length) break;
        if (jobs[0].reason === 'settings') await this.writeSettings(ws);
        // A long record is written over several runs, a limited number of calls each.
        else if (await this.writeRecord(wsId)) {
          more = true;
          break;
        }
        const rest = this.outbox(wsId).slice(1);
        if (rest.length) this.store.put('kv', outboxKey(wsId), { jobs: rest });
        else this.store.del('kv', outboxKey(wsId));
      }
    } catch (e) {
      error = e;
    }
    ws = this.store.get('workshops', wsId);
    const left = this.outbox(wsId).length > 0;
    const s = { ...ws.documentSync, syncing: false, queued: left, pending: left };
    if (error) {
      s.error = error.message;
      s.retryable = retryable(error);
      if (s.retryable) {
        s.retries = (s.retries || 0) + 1;
        s.retryAt = now + Math.min(600000, 30000 * 2 ** (s.retries - 1));
      }
    } else
      Object.assign(s, {
        error: null,
        retryable: false,
        retries: 0,
        retryAt: 0,
        at: Date.now(),
        ...(more ? { dueAt: now + 3000 } : {}),
      });
    ws.documentSync = s;
    this.store.put('workshops', wsId, ws);
    return ws;
  }
  async topBlocks(ws) {
    return this.notion.list(`blocks/${ws.notion.pageId}/children`);
  }
  // Find (or create) the history heading; new entries go right after the
  // template toggle, or the heading itself, so the newest is on top.
  async anchor(ws, top) {
    const index = top.findIndex(
      (b) => /^heading_/.test(b.type) && words(b).trim() === historyHeading,
    );
    if (index < 0) {
      const created = await this.notion.call(`blocks/${ws.notion.pageId}/children`, 'PATCH', {
        children: [block('heading_2', historyHeading, { color: 'green_background' })],
        position: { type: 'start' },
      });
      return created.results?.[0]?.id;
    }
    const template = top
      .slice(index + 1)
      .find((b) => b.type === 'toggle' && words(b).includes('（テンプレート）'));
    return (template || top[index]).id;
  }
  async append(parentId, children, position) {
    const created = [];
    for (let i = 0; i < children.length; i += 100) {
      const result = await this.notion.call(`blocks/${parentId}/children`, 'PATCH', {
        children: children.slice(i, i + 100),
        ...(position && i === 0 ? { position } : {}),
      });
      created.push(...(result.results || []));
    }
    return created;
  }
  async uploadImage(base64, name) {
    const upload = await this.notion.call('file_uploads', 'POST', {
      mode: 'single_part',
      filename: name,
      content_type: 'image/png',
    });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }), name);
    await this.notion.call(`file_uploads/${upload.id}/send`, 'POST', form);
    return upload.id;
  }
  // ---- v0.21: the record (written only; Notion is where people read it) -----------------
  //
  //   ワークショップの記録
  //   ▸ A班
  //       ▸ ① ワイガヤ（音声記録）
  //       ▸ ② もやもやの言語化：<map centre>      → the topic tree as toggles, with votes
  //       ▸ デッキ＃1：<一言で言うと>
  //           ▸ 選択したカード ▸ アイデアの輪郭 ▸ 模擬プレスリリース ▸ ペーパープロトタイプ
  //       ▸ デッキ＃2：…
  //   ▸ B班 …
  //   ▸ ペーパープロトの投票
  //       ▸ 投票結果（得票の多い順） ▸ 画像の一覧
  //
  // Each ▸ under a team is written again only when its content changed, so the page always
  // shows the latest state without growing a new entry per save.
  async trash(blockId) {
    this.spent++;
    try {
      await this.notion.call(`blocks/${blockId}`, 'PATCH', { in_trash: true });
    } catch (e) {
      // Already removed in Notion by a person: nothing to do.
      if (retryable(e)) throw e;
    }
  }
  // Append at a position; if the neighbour it refers to is gone, append at the end.
  async place(parentId, children, position) {
    this.spent++;
    try {
      return await this.append(parentId, children, position);
    } catch (e) {
      if (!position || retryable(e)) throw e;
      return this.append(parentId, children);
    }
  }
  async imageBlock(base64, key) {
    if (!base64) return [block('paragraph', '（画像はまだありません）')];
    this.spent += 2;
    const upload = await this.uploadImage(base64, `${String(key).slice(0, 24)}.png`);
    return [
      {
        object: 'block',
        type: 'image',
        image: { type: 'file_upload', file_upload: { id: upload } },
      },
    ];
  }
  // The topic tree: children and grandchildren go in one call; deeper levels follow.
  async writeTree(sectionId, nodes) {
    const kidsOf = (p) =>
      nodes.filter((n) => (p === 'theme' ? n.parent === 'theme' || n.parent === null : n.parent === p));
    const label = (n) => n.text + (n.votes ? `（${n.votes}票）` : '');
    const make = (n, deep) =>
      toggle(
        label(n),
        deep ? kidsOf(n.id).map((k) => make(k, false)) : null,
        colors[n.group] || 'default',
      );
    const level = async (parentNode, blockId) => {
      const kids = kidsOf(parentNode);
      if (!kids.length) return;
      this.spent++;
      const created = await this.append(blockId, kids.map((k) => make(k, true)));
      for (const [i, k] of kids.entries()) {
        const grand = kidsOf(k.id);
        if (!created[i]?.id || !grand.some((g) => kidsOf(g.id).length)) continue;
        this.spent++;
        const listed = await this.notion.list(`blocks/${created[i].id}/children`);
        for (const [j, g] of grand.entries()) if (listed[j]?.id) await level(g.id, listed[j].id);
      }
    };
    if (!nodes.length) await this.append(sectionId, [block('paragraph', '（まだありません）')]);
    else await level('theme', sectionId);
  }
  recordSections(ws, team) {
    const cardVotes = totals(ws, 'cards'),
      d = team.discussion,
      nodes = team.nodes.map(({ id, text, parent, group }) => ({
        id,
        text,
        parent,
        group,
        votes: cardVotes[id] || 0,
      }));
    const out = [
      {
        key: 'talk',
        title: '① ワイガヤ（音声記録）',
        data: d.transcript || '',
        fill: (blockId) => this.append(blockId, textBlocks(d.transcript)),
      },
      {
        key: 'map',
        title: `② もやもやの言語化：${team.rootText || ws.theme || ''}`,
        data: nodes,
        fill: (blockId) => this.writeTree(blockId, nodes),
      },
    ];
    const deck = (key, n, cards, discussion, imageKey, base64) => {
      const lines = outlineFields
        .map(([field, label]) => [
          label,
          field.startsWith('feature')
            ? discussion.features?.[Number(field.slice(-1)) - 1]
            : discussion[field],
        ])
        .filter(([, value]) => value);
      out.push({
        key,
        title: `デッキ＃${n}：${discussion.headline || '（一言で言うと：未入力）'}`,
        data: { cards, lines, press: discussion.pressRelease || '', imageKey },
        fill: async (blockId) =>
          this.append(blockId, [
            toggle(
              '選択したカード',
              cards.length
                ? cards.map((c) =>
                    block('bulleted_list_item', c.text + (c.votes ? `（${c.votes}票）` : '')),
                  )
                : [block('paragraph', '（まだ選んでいません）')],
            ),
            toggle(
              'アイデアの輪郭',
              lines.length
                ? lines.map(([label, value]) => block('paragraph', `${label}：${value}`))
                : [block('paragraph', '（まだありません）')],
            ),
            toggle('模擬プレスリリース', textBlocks(discussion.pressRelease)),
            toggle('ペーパープロトタイプ', await this.imageBlock(base64(), imageKey)),
          ]),
      });
    };
    const card = (c) => ({ text: c.text, votes: cardVotes[c.id] || 0 });
    const live = (key, n) =>
      deck(
        key,
        n,
        team.deck.map((cardId) => team.nodes.find((x) => x.id === cardId)).filter(Boolean).map(card),
        d,
        team.image ? hash(team.image.base64) : null,
        () => team.image?.base64,
      );
    const ideas = team.ideas || [];
    ideas.forEach((idea, i) => {
      // The deck being edited is written from the live board, not from its last save.
      if (idea.id === team.activeIdeaId) live(`deck:${idea.id}`, i + 1);
      else
        deck(
          `deck:${idea.id}`,
          i + 1,
          (idea.cards || []).map(card),
          idea.discussion || {},
          idea.image?.key || null,
          () =>
            idea.image && this.store.get('kv', ideaImageKey(ws.id, idea.image.key))?.base64,
        );
    });
    if (!ideas.some((i) => i.id === team.activeIdeaId) && hasDeckContent({ ...team, discussion: { ...d, transcript: '' } }))
      live('deck:draft', ideas.length + 1);
    return out;
  }
  voteSections(ws) {
    const votes = totals(ws, 'ideas'),
      entries = [];
    for (const team of Object.values(ws.teams)) {
      (team.ideas || []).forEach((idea, i) => {
        if (!idea.image) return;
        const active = idea.id === team.activeIdeaId;
        entries.push({
          name: `${team.name} デッキ＃${i + 1}`,
          headline: (active ? team.discussion : idea.discussion)?.headline || '',
          votes: votes[idea.id] || 0,
          imageKey: idea.image.key,
          base64: () => this.store.get('kv', ideaImageKey(ws.id, idea.image.key))?.base64,
        });
      });
      // An image made before decks were saved belongs to the team itself.
      if (team.image && !(team.ideas || []).some((i) => i.id === team.activeIdeaId && i.image))
        entries.push({
          name: team.name,
          headline: team.discussion.headline || '',
          votes: votes[team.id] || 0,
          imageKey: hash(team.image.base64),
          base64: () => team.image.base64,
        });
    }
    const ranked = [...entries].sort((a, b) => b.votes - a.votes);
    const line = (e) => `${e.name}${e.headline ? '：' + e.headline : ''}`;
    return [
      {
        key: 'rank',
        title: '投票結果（得票の多い順）',
        data: ranked.map((e) => [e.name, e.headline, e.votes]),
        fill: (blockId) =>
          this.append(
            blockId,
            ranked.length
              ? ranked.map((e) => block('numbered_list_item', `${e.votes}票　${line(e)}`))
              : [block('paragraph', '（まだペーパープロトタイプがありません）')],
          ),
      },
      {
        key: 'images',
        title: '画像の一覧',
        data: entries.map((e) => [e.name, e.headline, e.imageKey]),
        fill: async (blockId) => {
          const blocks = [];
          for (const e of entries)
            blocks.push(block('paragraph', line(e)), ...(await this.imageBlock(e.base64(), e.imageKey)));
          await this.append(
            blockId,
            blocks.length ? blocks : [block('paragraph', '（まだペーパープロトタイプがありません）')],
          );
        },
      },
    ];
  }
  // Bring the ▸ sections of one group (a team, or the votes) up to date. Returns true when
  // the call budget of this run is used up and the rest must wait for the next run.
  async syncSections(ws, state, group, sections) {
    let previous = null;
    for (const s of sections) {
      const fp = hash(JSON.stringify([s.title, s.data]));
      const old = group.sections[s.key];
      if (old?.fp === fp) {
        previous = old.id;
        continue;
      }
      if (this.spent >= RECORD_BUDGET) return true;
      if (old?.id) await this.trash(old.id);
      const [made] = await this.place(
        group.id,
        [toggle(s.title)],
        previous ? { type: 'after_block', after_block: { id: previous } } : { type: 'start' },
      );
      requireThat(made?.id, 'Notionへの記録の追加結果を確認できません', 502);
      // Remembered before it is filled: an interrupted write is replaced, not doubled.
      group.sections[s.key] = { id: made.id, fp: null };
      this.save(ws, state);
      this.spent++;
      await s.fill(made.id);
      group.sections[s.key].fp = fp;
      this.save(ws, state);
      previous = made.id;
    }
    for (const key of Object.keys(group.sections))
      if (!sections.some((s) => s.key === key)) {
        await this.trash(group.sections[key].id);
        delete group.sections[key];
        this.save(ws, state);
      }
    return false;
  }
  async writeRecord(wsId) {
    const ws = this.store.get('workshops', wsId);
    const state = this.state(ws) || {};
    const rec = (state.record ||= { teams: {}, votes: null });
    this.spent = 1;
    const top = await this.topBlocks(ws);
    const alive = new Set(top.filter((b) => !b.in_trash).map((b) => b.id));
    let after = top.find((b) => /^heading_/.test(b.type) && words(b).trim() === recordHeading)?.id;
    if (!after) {
      const created = await this.notion.call(`blocks/${ws.notion.pageId}/children`, 'PATCH', {
        children: [block('heading_2', recordHeading, { color: 'green_background' })],
        position: { type: 'start' },
      });
      after = created.results?.[0]?.id;
      requireThat(after, 'Notionへの記録の見出しを作成できません', 502);
    }
    const group = async (known, title) => {
      if (known && alive.has(known.id) && known.name === title) return known;
      if (known?.id && alive.has(known.id)) await this.trash(known.id);
      const [made] = await this.place(ws.notion.pageId, [toggle(title)], {
        type: 'after_block',
        after_block: { id: after },
      });
      requireThat(made?.id, 'Notionへの記録の追加結果を確認できません', 502);
      return { id: made.id, name: title, sections: {} };
    };
    for (const team of Object.values(ws.teams)) {
      const g = (rec.teams[team.id] = await group(rec.teams[team.id], team.name));
      this.save(ws, state);
      if (await this.syncSections(ws, state, g, this.recordSections(ws, team))) return true;
      after = g.id;
    }
    for (const teamId of Object.keys(rec.teams))
      if (!ws.teams[teamId]) {
        if (alive.has(rec.teams[teamId].id)) await this.trash(rec.teams[teamId].id);
        delete rec.teams[teamId];
      }
    rec.votes = await group(rec.votes, voteTitle);
    this.save(ws, state);
    return this.syncSections(ws, state, rec.votes, this.voteSections(ws));
  }
  // ---- Reading -----------------------------------------------------------
  async readTree(blockId, depth = 0, budget = { n: 0 }) {
    requireThat(depth < 60 && budget.n < 6000, 'Notionの履歴が深すぎるか大きすぎます', 409);
    const children = await this.notion.list(`blocks/${blockId}/children`);
    const out = [];
    for (const b of children) {
      if (b.archived || b.in_trash) continue;
      budget.n++;
      out.push({
        id: b.id,
        type: b.type,
        text: words(b),
        color: b[b.type]?.color,
        caption: plain(b[b.type]?.caption),
        url: b.type === 'image' ? b.image?.file?.url || b.image?.external?.url : undefined,
        children:
          b.has_children && b.type !== 'child_database' && b.type !== 'child_page'
            ? await this.readTree(b.id, depth + 1, budget)
            : [],
      });
    }
    return out;
  }
  parse(tree, teamName) {
    const section = (title) => tree.find((b) => b.text.trim() === title);
    const texts = (b) =>
      (b?.children || []).filter((c) => textTypes.has(c.type)).map((c) => c.text);
    const settings = section(sections.settings);
    const setting = (title) => settings?.children.find((b) => b.text.trim() === title);
    const world = section(sections.world)?.children.find((c) => textTypes.has(c.type))?.text;
    const nodes = [];
    const visit = (b, parent) => {
      if (textTypes.has(b.type) && b.text.trim()) {
        nodes.push({
          blockId: b.id,
          text: clip(b.text, 500),
          parent,
          group: Math.max(0, colors.indexOf(b.color)),
        });
        for (const c of b.children) visit(c, b.id);
      } else for (const c of b.children) visit(c, parent);
    };
    for (const b of section(sections.map)?.children || []) visit(b, 'theme');
    const outline = {};
    for (const line of texts(section(sections.outline))) {
      const m = /^([^：:]+)[：:]\s*([\s\S]*)$/.exec(line);
      const field = m && outlineFields.find(([, label]) => label === m[1].trim());
      if (field) outline[field[0]] = clip(m[2].trim(), field[2]);
    }
    const image = section(sections.image)?.children.find((c) => c.type === 'image');
    let votes = { cards: [], deck: [], ideaVotes: 0 };
    const code = setting(settingTitles.votes)?.children.find((c) => c.type === 'code');
    if (code?.text.trim()) {
      try {
        votes = { ...votes, ...JSON.parse(code.text) };
      } catch {
        requireThat(
          false,
          `「${teamName}」の投票結果のJSONが読めません。Notionで修正してください`,
          409,
        );
      }
    }
    const prompt = (title) => {
      const b = setting(title);
      return b ? texts(b).join('\n\n').trim() : undefined;
    };
    const memo = section(sections.memo);
    const data = {
      world: world ? clip(world === '（未設定）' ? '' : world, 500) : '',
      nodes,
      press: clip(texts(section(sections.press)).join('\n\n').trim(), 2000),
      outline,
      memo: memo ? clip(texts(memo).join('\n\n').trim(), 100000) : undefined,
      image: image
        ? { blockId: image.id, url: image.url, key: /^image:(\w+)$/.exec(image.caption)?.[1] }
        : null,
      votes,
      settings: {
        facilitator: prompt(settingTitles.facilitator),
        imagePrompt: prompt(settingTitles.imagePrompt),
        pressPrompt: prompt(settingTitles.pressPrompt),
      },
    };
    // Signed image URLs change on every read; fingerprint the block instead.
    const stable = { ...data, image: data.image && { ...data.image, url: undefined } };
    return { ...data, fp: hash(JSON.stringify(stable)) };
  }
  // Newest entry per team name, from the page's top-level toggles.
  latestEntries(ws, top) {
    const latest = {};
    for (const team of Object.values(ws.teams))
      for (const b of top)
        if (b.type === 'toggle') {
          const s = entryStamp(words(b), team.name);
          if (s && (!latest[team.name] || s > latest[team.name].stamp))
            latest[team.name] = { id: b.id, stamp: s };
        }
    return latest;
  }
  // v0.21: Notion is a record to read. Edits made there are not brought back to the app.
  async pull() {
    return true;
  }
  preserveIncoming(ws, baseline, metadataOnly = false) {
    const live = this.store.get('workshops', ws.id);
    if (!live) return false;
    if (metadataOnly || this.active.has(ws.id) || live.documentSync?.queued) {
      preserveLocalContent(ws, live);
      return true;
    }
    return false;
  }
  // ---- Board changes -----------------------------------------------------
  async change(user, wsId, body, { now = Date.now() } = {}) {
    const p = body.payload || {};
    // The deck being left (with its unsent edits) is recorded before it is replaced.
    let leaving = null;
    if (['clearIdea', 'restoreIdea'].includes(body.action)) {
      const before = structuredClone(this.store.get('workshops', wsId) || {}),
        team = before.teams?.[p.teamId];
      if (before.notion && team && !(body.action === 'restoreIdea' && team.activeIdeaId === p.ideaId)) {
        try {
          patchDiscussion(team, p);
        } catch {}
        if (hasDeckContent(team)) leaving = this.capture(before, team, now);
      }
    }
    let ws = mutate(this.store, user, wsId, body);
    if (!ws.notion) return ws;
    if (leaving) ws = this.schedule(ws, p.teamId, 'save', now, leaving);
    if ((body.action === 'discussion' && p.snapshot === true) || body.action === 'saveIdea')
      return this.schedule(ws, p.teamId, 'save', now);
    if ((body.action === 'discussion' && !p.draftOnly) || body.action === 'deck')
      return this.schedule(ws, p.teamId, 'auto', now);
    // Votes show in the record (card votes on the map, idea votes in the ranking).
    if (body.action === 'vote' || body.action === 'timer') {
      const teamId = ws.teams[p.teamId] ? p.teamId : Object.keys(ws.teams)[0];
      return teamId ? this.schedule(ws, teamId, 'auto', now) : ws;
    }
    if (body.action === 'settings') return this.scheduleSettings(ws, now);
    return ws;
  }
}
