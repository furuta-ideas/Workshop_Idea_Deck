// Workshop history in Notion (v0.14).
//
// Each time a team presses 「記録を保存」 or applies a generated image, the
// app appends one toggle under the 「ワークショップの履歴」 heading:
//
//   ▸ 20261108_221400_ビザスクセミナー＿A班
//       ▸ 求められる世界        → ▸ <map centre text>
//       ▸ マインドマップ        → nested toggles (the topic tree)
//       ▸ ペーパープロトタイプ  → generated image
//       ▸ 模擬プレスリリース    → paragraphs
//       ▸ アイデアの輪郭        → 一言で言うと／Who／What／How／特長1〜3／キーワード
//       ▸ 議論メモ              → paragraphs
//       ▸ 設定情報
//           ▸ AIファシリテータ（プロンプト）
//           ▸ ペーパープロトタイプ（プロンプト）
//           ▸ 模擬プレスリリース（プロンプト）
//           ▸ 投票結果            → JSON code block
//
// Notion is the master. When the newest entry of a team changes in Notion
// (or the server starts empty), the app restores that team from it.
import { hash } from './store.js';
import { requireThat, mutate, access, teamFor, totals } from './domain.js';
import { validatePNG } from './png.js';
import { preserveLocalContent } from './notion-outbox.js';
import { patchDiscussion, hasDeckContent } from './ideas.js';

export const historyHeading = 'ワークショップの履歴';
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
  schedule(ws, teamId, reason = 'save', now = Date.now(), snapshot) {
    const team = ws.teams[teamId];
    if (!ws.notion || !team) return ws;
    const sending = this.active.has(ws.id);
    let jobs = this.outbox(ws.id);
    if (!sending || jobs.length > 1)
      jobs = jobs.filter((j, i) => (sending && i === 0) || !(j.reason === 'auto' && j.snapshot?.teamId === teamId));
    jobs.push({ reason, snapshot: snapshot || this.capture(ws, team, now) });
    return this.queue(ws, jobs, now + (reason === 'auto' ? AUTO_DELAY_MS : 0));
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
    const character = { kashi: 'カシー（男の子）', leafy: 'リーフィー（女の子）' }[ws.character || 'kashi'];
    rows.push(
      { label: '③の文字サイズ', value: `${ws.textScale || 115}%` },
      { label: 'AIアドバイスのキャラクター', value: character },
      { label: '② カード選択の票数・投票時間', value: `${ws.budgets?.cards}票・${ws.durations?.cards}秒` },
      { label: '④ アイディア投票の票数・投票時間', value: `${ws.budgets?.ideas}票・${ws.durations?.ideas}秒` },
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
    let error = null;
    try {
      for (;;) {
        const jobs = this.outbox(wsId);
        if (!jobs.length) break;
        if (jobs[0].reason === 'settings') await this.writeSettings(ws);
        else await this.writeEntry(ws, jobs[0]);
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
  async writeEntry(ws, job) {
    const snap = job.snapshot;
    const top = await this.topBlocks(ws);
    // A half-written entry from an interrupted attempt has the same title.
    for (const b of top.filter((b) => b.type === 'toggle' && words(b) === snap.title))
      await this.notion.call(`blocks/${b.id}`, 'PATCH', { in_trash: true });
    const after = await this.anchor(ws, top);
    const [entry] = await this.append(
      ws.notion.pageId,
      [toggle(snap.title)],
      after ? { type: 'after_block', after_block: { id: after } } : undefined,
    );
    requireThat(entry?.id, 'Notionへの履歴の追加結果を確認できません', 502);
    let imageChildren = [block('paragraph', '（画像はまだありません）')];
    const base64 = snap.imageKey && this.store.blob(snap.imageKey);
    if (base64) {
      const upload = await this.uploadImage(base64, `${snap.imageKey.slice(0, 24)}.png`);
      imageChildren = [
        {
          object: 'block',
          type: 'image',
          image: {
            type: 'file_upload',
            file_upload: { id: upload },
            caption: rt(`image:${snap.imageKey}`),
          },
        },
      ];
    }
    const o = snap.outline;
    // Create the empty sections first, then fill each in batches of 100
    // blocks, so long texts (facilitator md, notes) are never cut short.
    const made = await this.append(
      entry.id,
      Object.values(sections).map((title) => toggle(title)),
    );
    const sectionId = (title) => made.find((b) => words(b) === title)?.id;
    await this.append(sectionId(sections.world), [toggle(snap.world || '（未設定）')]);
    await this.append(sectionId(sections.image), imageChildren);
    await this.append(sectionId(sections.press), paragraphs(snap.press));
    await this.append(
      sectionId(sections.outline),
      outlineFields.map(([key, label]) => block('paragraph', `${label}：${o[key] || ''}`)),
    );
    await this.append(sectionId(sections.memo), paragraphs(snap.memo));
    // The topic tree, one level at a time (Notion nests at most two levels per call).
    const blockIds = {};
    const level = async (parentNode, parentBlock) => {
      const kids = snap.nodes.filter((n) =>
        parentNode === 'theme'
          ? n.parent === 'theme' || n.parent === null
          : n.parent === parentNode,
      );
      if (!kids.length) return;
      const created = await this.append(
        parentBlock,
        kids.map((n) => toggle(n.text, null, colors[n.group] || 'default')),
      );
      for (const [i, n] of kids.entries()) blockIds[n.id] = created[i]?.id;
      for (const n of kids) if (blockIds[n.id]) await level(n.id, blockIds[n.id]);
    };
    await level('theme', sectionId(sections.map));
    const votes = {
      cards: Object.entries(snap.votes).map(([id, n]) => ({
        id,
        text: `${snap.nodes.find((x) => x.id === id)?.text || ''} #VOTES:${n}`,
        notionBlockId: blockIds[id] || null,
      })),
      deck: snap.deck.map((id) => ({ id, notionBlockId: blockIds[id] || null })),
      ideaVotes: snap.ideaVotes,
    };
    const settingBlocks = await this.append(
      sectionId(sections.settings),
      Object.values(settingTitles).map((title) => toggle(title)),
    );
    const settingId = (title) => settingBlocks.find((b) => words(b) === title)?.id;
    await this.append(settingId(settingTitles.facilitator), paragraphs(snap.settings.facilitator));
    await this.append(settingId(settingTitles.imagePrompt), paragraphs(snap.settings.imagePrompt));
    await this.append(settingId(settingTitles.pressPrompt), paragraphs(snap.settings.pressPrompt));
    await this.append(settingId(settingTitles.votes), [
      {
        object: 'block',
        type: 'code',
        code: { rich_text: rt(JSON.stringify(votes, null, 2)), language: 'javascript' },
      },
    ]);
    // Remember what we wrote, so the next read does not "restore" it.
    const parsed = this.parse(await this.readTree(entry.id), snap.teamName);
    const state = this.state(ws) || {};
    state.entries ||= {};
    state.entries[snap.teamName] = {
      id: entry.id,
      stamp: entryStamp(snap.title, snap.teamName),
      fp: parsed.fp,
      // Notion block → the app's card ID, so restores keep IDs stable.
      ids: Object.fromEntries(Object.entries(blockIds).map(([nodeId, b]) => [b, nodeId])),
    };
    this.save(ws, state);
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
      memo: memo ? clip(texts(memo).join('\n\n').trim(), 30000) : undefined,
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
  importVotes(ws, phase, ids, values) {
    ws.notionVoteBaseline ||= { cards: {}, ideas: {} };
    for (const id of ids) {
      const n = values[id] || 0;
      requireThat(
        Number.isInteger(n) && n >= 0 && n <= 1000000,
        'Notionの票数は0以上の整数で設定してください',
        409,
      );
      for (const ballot of Object.values(ws.votes[phase])) delete ballot[id];
      ws.notionVoteBaseline[phase][id] = n;
    }
  }
  async downloadImage(url) {
    const u = new URL(url || 'https://invalid.local');
    requireThat(
      u.protocol === 'https:' &&
        /\.amazonaws\.com$|\.notion-static\.com$|\.notion\.so$|\.notion\.com$/.test(u.hostname),
      'Notion画像はNotionへ直接アップロードしたPNGを使用してください',
      409,
    );
    const response = await this.notion.transport(u, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    requireThat(response.ok, 'Notion画像を読み込めませんでした', 502);
    const bytes = Buffer.from(await response.arrayBuffer());
    requireThat(bytes.length < 9 * 1024 * 1024, 'Notion画像が大きすぎます', 409);
    return validatePNG(bytes.toString('base64'));
  }
  // Overwrite one team with the newest Notion entry.
  async apply(ws, team, data, knownIds = {}) {
    requireThat(data.nodes.length <= 500, 'Notionのトピックは班ごとに500件以内です', 409);
    // Keep the app's card IDs where the entry or the board still knows them.
    const byBlock = new Map(Object.entries(knownIds));
    for (const c of [...(data.votes.cards || []), ...(data.votes.deck || [])])
      if (c?.notionBlockId && typeof c.id === 'string' && c.id.length <= 100)
        byBlock.set(c.notionBlockId, c.id);
    for (const n of team.nodes)
      if (n.notionBlockId && !byBlock.has(n.notionBlockId)) byBlock.set(n.notionBlockId, n.id);
    const idOf = (blockId) => byBlock.get(blockId) || blockId;
    team.nodes = data.nodes.map((n) => ({
      id: idOf(n.blockId),
      notionBlockId: n.blockId,
      text: n.text,
      parent: n.parent === 'theme' ? 'theme' : idOf(n.parent),
      group: n.group,
    }));
    team.mapVersion = 2;
    if (data.world) team.rootText = data.world;
    const d = team.discussion;
    d.pressRelease = data.press;
    for (const key of ['headline', 'who', 'what', 'how', 'keywords'])
      if (data.outline[key] !== undefined) d[key] = data.outline[key];
    if (['feature1', 'feature2', 'feature3'].some((k) => data.outline[k] !== undefined))
      d.features = ['feature1', 'feature2', 'feature3'].map((k) =>
        (data.outline[k] || '').replace(/[\r\n]+/g, ' '),
      );
    if (data.memo !== undefined) d.transcript = data.memo;
    const ids = new Set(team.nodes.map((n) => n.id));
    const values = Object.fromEntries(team.nodes.map((n) => [n.id, 0]));
    for (const c of data.votes.cards || []) {
      const id = c?.notionBlockId ? idOf(c.notionBlockId) : c?.id;
      const n = Number(/#VOTES:\s*(\d+)/.exec(c?.text || '')?.[1] ?? 0);
      if (ids.has(id)) values[id] = n;
    }
    this.importVotes(ws, 'cards', Object.keys(values), values);
    team.deck = (data.votes.deck || [])
      .map((c) => (typeof c === 'string' ? c : c?.notionBlockId ? idOf(c.notionBlockId) : c?.id))
      .filter((id) => ids.has(id))
      .slice(0, 5);
    team.deckSlots = [...team.deck, ...Array(5 - team.deck.length).fill(null)];
    // Notion holds one number per team; each deck keeps its own votes, so only a changed
    // number is imported, as the part not already held by the team's decks.
    if (Number.isInteger(data.votes.ideaVotes) && data.votes.ideaVotes !== teamIdeaVotes(ws, team)) {
      const held = teamIdeaVotes(ws, team) - (totals(ws, 'ideas')[team.id] || 0);
      this.importVotes(ws, 'ideas', [team.id], { [team.id]: Math.max(0, data.votes.ideaVotes - held) });
    }
    if (!data.image) team.image = null;
    else if (!(team.image && data.image.key && hash(team.image.base64) === data.image.key))
      team.image = await this.downloadImage(data.image.url);
    const s = data.settings;
    const rows = [
      ['ai:facilitator', s.facilitator],
      ['ai:imagePrompt', s.imagePrompt],
      ['ai:pressReleasePrompt', s.pressPrompt],
    ]
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, value }));
    if (rows.length) this.notion.settingsConsumer?.(rows);
  }
  // Read the newest entry of every team and restore the teams whose entry
  // changed in Notion since the app last wrote or read it.
  async pull(ws, edited, force = false, { discardPending = false } = {}) {
    if (this.active.has(ws.id) || this.reading.has(ws.id)) return false;
    const state = this.state(ws) || {};
    if (!force && Date.now() - (state.at || 0) < 60000) return true;
    this.reading.add(ws.id);
    try {
      const top = await this.topBlocks(ws);
      const latest = this.latestEntries(ws, top);
      const changed = [];
      state.entries ||= {};
      for (const [name, entry] of Object.entries(latest)) {
        const data = this.parse(await this.readTree(entry.id), name);
        const known = state.entries[name];
        if (force || !known || known.id !== entry.id || known.fp !== data.fp)
          changed.push({ name, entry, data });
      }
      if (discardPending) this.store.del('kv', outboxKey(ws.id));
      const live = this.store.get('workshops', ws.id) || ws;
      let applied = false;
      for (const c of changed) {
        const team = Object.values(live.teams).find((t) => t.name === c.name);
        if (!team) continue;
        const known = state.entries[c.name];
        await this.apply(live, team, c.data, known?.id === c.entry.id ? known.ids : {});
        state.entries[c.name] = {
          id: c.entry.id,
          stamp: c.entry.stamp,
          fp: c.data.fp,
          ids: Object.fromEntries(team.nodes.map((n) => [n.notionBlockId, n.id])),
        };
        applied = true;
      }
      if (applied) live.revision++;
      const queued = this.outbox(ws.id).length > 0;
      const s = live.documentSync || {};
      live.documentSync = {
        ...s,
        queued,
        pending: queued,
        readError: null,
        ...(discardPending
          ? { error: null, retryAt: 0, retries: 0, retryable: false }
          : { error: s.error ?? null }),
      };
      state.at = Date.now();
      this.save(ws, state);
      this.store.put('workshops', live.id, live);
      for (const key of Object.keys(ws)) delete ws[key];
      Object.assign(ws, live);
      return true;
    } catch (e) {
      const live = this.store.get('workshops', ws.id);
      if (live) {
        // A restore problem must not stop new saves from being sent.
        live.documentSync = { ...live.documentSync, readError: e.message };
        this.store.put('workshops', live.id, live);
        ws.documentSync = live.documentSync;
      }
      return false;
    } finally {
      this.reading.delete(ws.id);
    }
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
    if (body.action === 'settings') return this.scheduleSettings(ws, now);
    return ws;
  }
}
