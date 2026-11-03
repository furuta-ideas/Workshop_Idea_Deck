import { hash } from './store.js';
import { requireThat, mutate, totals } from './domain.js';
import { validatePNG } from './png.js';

export const stageTitles = [
  '① もやもやの言語化（N1）',
  '② 言語化の絞込み（カードの選択）',
  '③ アイデアの可視化（カードの可視化）',
  '④ アイデアの絞込み（投票）',
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
  'heading_2',
  'heading_3',
  'heading_4',
  'toggle',
  'bulleted_list_item',
  'numbered_list_item',
  'paragraph',
  'to_do',
]);
const words = (b) =>
  (b[b.type]?.rich_text || []).map((x) => x.plain_text ?? x.text?.content ?? '').join('');
const rt = (text) =>
  Array.from({ length: Math.max(1, Math.ceil(text.length / 1800)) }, (_, i) => ({
    type: 'text',
    text: { content: text.slice(i * 1800, (i + 1) * 1800) },
  }));
const phaseOf = (b) =>
  /^heading_/.test(b.type) && !b[b.type]?.is_toggleable
    ? '①②③④'.indexOf(words(b).trim()[0]) + 1
    : 0;
const teamName = (b) =>
  b.type === 'toggle' && /^チーム[：:]\s*/.test(words(b))
    ? words(b).replace(/^チーム[：:]\s*/, '')
    : null;
const signature = (tree) =>
  hash(
    JSON.stringify(
      tree.map((b) => ({
        id: b.id,
        type: b.type,
        p: b.parentId,
        text: words(b),
        color: b[b.type]?.color,
        caption: (b[b.type]?.caption || [])
          .map((x) => x.plain_text ?? x.text?.content ?? '')
          .join(''),
        children: signature(b.children || []),
      })),
    ),
  );
const typeAt = (depth) =>
  depth === 1 ? 'heading_2' : depth === 2 ? 'heading_3' : depth === 3 ? 'heading_4' : 'toggle';
const payload = (type, text, color = 'default') => ({
  object: 'block',
  type,
  [type]: {
    rich_text: rt(text),
    color,
    ...(type.startsWith('heading_') ? { is_toggleable: true } : {}),
  },
});
const snapshotMarker = 'Workshop Idea Deck state v1';
const applyBlockUpdate = (block, body) => {
  const type = block.type,
    content = body[type] ? { ...block[type], ...body[type] } : null;
  Object.assign(block, body);
  if (content) block[type] = content;
};
export class NotionContent {
  constructor(notion) {
    this.notion = notion;
    this.store = notion.store;
    this.loaded = new Set();
  }
  state(ws) {
    return this.store.get('kv', `notion-content:${ws.id}`);
  }
  save(ws, state) {
    this.store.put('kv', `notion-content:${ws.id}`, state);
  }
  async read(ws) {
    const top = await this.notion.list(`blocks/${ws.notion.pageId}/children`),
      sections = {};
    let current;
    for (const b of top) {
      const phase = phaseOf(b);
      if (phase) {
        requireThat(!sections[phase], '同じ番号のNotion見出しが重複しています', 409);
        current = sections[phase] = { id: b.id, heading: b, roots: [] };
      } else if (current) current.roots.push(b);
    }
    if (!sections[1]) return null;
    let count = 0;
    const load = async (b, parentId, depth) => {
      requireThat(
        depth < 510 && ++count <= 5000,
        'Notionの階層・ブロック数が上限を超えています',
        409,
      );
      const copy = { ...b, parentId, children: [] };
      if (b.has_children && b.type !== 'child_database' && b.type !== 'child_page')
        for (const c of await this.notion.list(`blocks/${b.id}/children`))
          copy.children.push(await load(c, b.id, depth + 1));
      return copy;
    };
    for (const [phase, section] of Object.entries(sections)) {
      const roots = [];
      for (const b of section.roots) {
        if (phase === '1' || teamName(b) !== null) roots.push(await load(b, ws.notion.pageId, 0));
      }
      section.roots = roots;
    }
    return { sections, top: top.map((b) => ({ id: b.id, phase: phaseOf(b) })) };
  }
  fingerprint(doc) {
    return hash(
      JSON.stringify(
        Object.entries(doc.sections).map(([p, s]) => [
          p,
          s.id,
          words(s.heading),
          signature(s.roots),
        ]),
      ),
    );
  }
  all(doc) {
    return Object.values(doc.sections).flatMap((s) => {
      const out = [];
      const visit = (b) => {
        out.push(b);
        b.children.forEach(visit);
      };
      s.roots.forEach(visit);
      return out;
    });
  }
  teamRoots(ws, doc, team) {
    const roots = doc.sections[1].roots,
      wrapper = roots.find((b) => teamName(b) === team.name);
    if (wrapper) return { parentId: wrapper.id, roots: wrapper.children };
    const first =
      Object.values(ws.teams).find((t) => t.name === 'A班') || Object.values(ws.teams)[0];
    return first?.id === team.id
      ? { parentId: ws.notion.pageId, roots: roots.filter((b) => teamName(b) === null) }
      : { parentId: null, roots: [] };
  }
  parseNodes(ws, doc, team) {
    const old = new Map(
        Object.values(ws.teams)
          .flatMap((t) => t.nodes)
          .filter((n) => n.notionBlockId)
          .map((n) => [n.notionBlockId, n]),
      ),
      nodes = [];
    const recorded = this.parseRecord(this.record(doc, team, 2).code, 2);
    if (recorded?.cards) {
      requireThat(
        Array.isArray(recorded.cards) && recorded.cards.length <= 500,
        'Notionのカード対応表が不正です',
        409,
      );
      for (const card of recorded.cards)
        if (card.notionBlockId && !old.has(card.notionBlockId)) {
          requireThat(/^[a-z0-9-]{1,100}$/i.test(card.id), 'NotionのカードIDが不正です', 409);
          old.set(card.notionBlockId, { id: card.id });
        }
    }
    const visit = (b, parent) => {
      if (textTypes.has(b.type) && words(b).trim()) {
        requireThat(
          [...words(b)].length <= 500,
          'Notionのトピックは500文字以内で設定してください',
          409,
        );
        const previous = old.get(b.id);
        const node = {
          id: previous?.id || b.id,
          notionBlockId: b.id,
          text: words(b),
          group: Math.max(0, colors.indexOf(b[b.type]?.color)),
          parent,
        };
        requireThat(!nodes.some((n) => n.id === node.id), 'NotionのカードIDが重複しています', 409);
        nodes.push(node);
        requireThat(nodes.length <= 500, 'Notionのトピックは班ごとに500件以内です', 409);
        for (const c of b.children) visit(c, node.id);
      } else for (const c of b.children) visit(c, parent);
    };
    for (const b of this.teamRoots(ws, doc, team).roots) visit(b, 'theme');
    return nodes;
  }
  record(doc, team, phase) {
    const wrapper = doc.sections[phase]?.roots.find((b) => teamName(b) === team.name);
    const code = wrapper?.children.find(
      (b) =>
        b.type === 'code' &&
        (b.code.caption || []).map((x) => x.plain_text ?? x.text?.content ?? '').join('') ===
          snapshotMarker,
    );
    return { wrapper, code };
  }
  parseRecord(code, phase) {
    if (!code) return null;
    let record;
    try {
      record = JSON.parse(words(code));
    } catch {
      requireThat(false, `${stageTitles[phase - 1]}のJSON記録が不正です`, 409);
    }
    requireThat(
      record?.schema === snapshotMarker && record.phase === phase,
      'Notionの記録形式・フェーズが不正です',
      409,
    );
    return record;
  }
  applyRecord(ws, team, phase, r) {
    if (phase === 2) {
      requireThat(
        Array.isArray(r.deck) && r.deck.length <= 5 && new Set(r.deck).size === r.deck.length,
        'Notionのデッキは重複なし5枚以内です',
        409,
      );
      this.importVotes(
        ws,
        'cards',
        team.nodes.map((n) => n.id),
        r.totals || {},
      );
      team.deck = r.deck.filter(
        (id) => team.nodes.some((n) => n.id === id) && totals(ws, 'cards')[id] > 0,
      );
      if (typeof r.rootText === 'string' && [...r.rootText].length <= 500)
        team.rootText = r.rootText;
    }
    if (phase === 3) {
      requireThat(
        r.discussion && typeof r.discussion === 'object',
        'Notionの議論記録が不正です',
        409,
      );
      for (const [key, max] of Object.entries({
        transcript: 30000,
        what: 40,
        who: 40,
        how: 120,
        points: 5000,
        keywords: 500,
      })) {
        requireThat(
          typeof r.discussion[key] === 'string' && [...r.discussion[key]].length <= max,
          `Notionの${key}の文字数・形式を確認してください`,
          409,
        );
        team.discussion[key] = r.discussion[key];
      }
      if (r.discussion.rounds !== undefined) {
        requireThat(
          Array.isArray(r.discussion.rounds) && r.discussion.rounds.length <= 100,
          '議論履歴は100回以内です',
          409,
        );
        for (const round of r.discussion.rounds)
          for (const value of Object.values(round))
            requireThat(
              typeof value === 'string' && value.length <= 30000,
              '議論履歴の形式を確認してください',
              409,
            );
        team.discussion.rounds = r.discussion.rounds;
      }
      if (typeof r.discussion.running === 'boolean') team.discussion.running = r.discussion.running;
    }
    if (phase === 4) this.importVotes(ws, 'ideas', [team.id], { [team.id]: r.totalVotes ?? 0 });
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
  async pull(ws, edited, force = false) {
    if (ws.documentSync?.pending) return;
    const state = this.state(ws);
    if (
      !force &&
      this.loaded.has(ws.id) &&
      state?.edited === edited &&
      Date.now() - (state.at || 0) < 60000
    )
      return;
    const original = structuredClone(ws);
    try {
      const doc = await this.read(ws);
      if (!doc) {
        this.loaded.add(ws.id);
        ws.documentSync = {
          pending: false,
          error: 'Notionページに「① もやもやの言語化（N1）」の見出しを作成してください',
        };
        return;
      }
      const fp = this.fingerprint(doc);
      if (state?.fingerprint !== fp) {
        for (const team of Object.values(ws.teams)) {
          const nodes = this.parseNodes(ws, doc, team);
          if (!state && !this.store.get('kv', `notion-import-backup:${ws.id}:${team.id}`))
            this.store.put('kv', `notion-import-backup:${ws.id}:${team.id}`, {
              at: Date.now(),
              team: structuredClone(team),
            });
          team.nodes = nodes;
          team.mapVersion = 2;
          for (const phase of [2, 3, 4]) {
            const { code } = this.record(doc, team, phase),
              r = this.parseRecord(code, phase);
            const oldCode = state?.doc && this.record(state.doc, team, phase).code;
            if (r && (!oldCode || words(oldCode) !== words(code)))
              this.applyRecord(ws, team, phase, r);
            if (r && phase === 3) await this.readImage(ws, doc, team, r, state);
          }
        }
        const valid = new Set(Object.values(ws.teams).flatMap((t) => t.nodes.map((n) => n.id)));
        requireThat(
          valid.size === Object.values(ws.teams).reduce((sum, t) => sum + t.nodes.length, 0),
          'Notionのチーム間でカードIDが重複しています',
          409,
        );
        for (const team of Object.values(ws.teams))
          team.deck = team.deck.filter((id) => valid.has(id));
        for (const ballot of Object.values(ws.votes.cards))
          for (const id of Object.keys(ballot)) if (!valid.has(id)) delete ballot[id];
        ws.revision++;
      }
      ws.documentSync = { at: Date.now(), pending: false, error: null };
      this.save(ws, { ...state, doc, fingerprint: fp, edited, at: Date.now() });
      this.loaded.add(ws.id);
    } catch (e) {
      for (const k of Object.keys(ws)) delete ws[k];
      Object.assign(ws, original);
      ws.documentSync = { ...ws.documentSync, error: e.message };
    }
  }
  remove(doc, id) {
    for (const s of Object.values(doc.sections)) {
      const prune = (list) =>
        list.filter((b) => b.id !== id).map((b) => ({ ...b, children: prune(b.children) }));
      s.roots = prune(s.roots);
    }
  }
  async readImage(ws, doc, team, record, state) {
    const wrapper = this.record(doc, team, 3).wrapper,
      image = wrapper?.children.filter((b) => b.type === 'image').at(-1);
    if (!image) {
      if (record.imageKey === null) team.image = null;
      return;
    }
    const oldImage =
      state?.doc &&
      this.record(state.doc, team, 3)
        .wrapper?.children.filter((b) => b.type === 'image')
        .at(-1);
    if (team.image && oldImage?.id === image.id) return;
    const url = new URL(
      image.image.file?.url || image.image.external?.url || 'https://invalid.local',
    );
    requireThat(
      url.protocol === 'https:' &&
        /\.amazonaws\.com$|\.notion-static\.com$|\.notion\.so$/.test(url.hostname),
      'Notion画像はNotionへ直接アップロードしたPNGを使用してください',
      409,
    );
    const response = await this.notion.transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    requireThat(response.ok, 'Notion画像を読み込めませんでした', 502);
    requireThat(
      Number(response.headers?.get('content-length') || 0) < 9 * 1024 * 1024,
      'Notion画像が大きすぎます',
      409,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    requireThat(bytes.length < 9 * 1024 * 1024, 'Notion画像が大きすぎます', 409);
    team.image = validatePNG(bytes.toString('base64'));
  }
  add(doc, parentId, b, after) {
    const parent = this.all(doc).find((x) => x.id === parentId);
    const list = parent ? parent.children : doc.sections[b._phase || 1].roots;
    if (after === null || (!parent && after === doc.sections[b._phase || 1].id)) list.unshift(b);
    else if (after !== undefined) {
      const index = list.findIndex((x) => x.id === after);
      list.splice(index < 0 ? list.length : index + 1, 0, b);
    } else list.push(b);
  }
  async append(ws, state, parentId, body, phase = 1, options = {}) {
    const attempt = state.attempt;
    if (attempt) {
      const now = await this.notion.list(`blocks/${attempt.parentId}/children`);
      const matches = now.filter(
        (b) =>
          !attempt.before.includes(b.id) &&
          b.type === attempt.body.type &&
          words(b) === words(attempt.body),
      );
      requireThat(
        matches.length === 1,
        'Notionの追加結果が未確定です。重複防止のため再追加せず停止しています。Notion側を確認してください',
        409,
      );
      const b = { ...matches[0], parentId: attempt.parentId, children: [], _phase: attempt.phase };
      this.add(state.doc, attempt.parentId, b, attempt.after);
      if (attempt.nodeId) {
        const node = Object.values(ws.teams)
          .flatMap((t) => t.nodes)
          .find((n) => n.id === attempt.nodeId);
        if (node) node.notionBlockId = b.id;
        this.store.put('workshops', ws.id, ws);
      }
      state.recovered = { key: attempt.key, blockId: b.id };
      delete state.attempt;
      this.save(ws, state);
    }
    const key = `${parentId}:${hash(JSON.stringify(body))}`;
    if (state.recovered?.key === key) {
      const recovered = this.all(state.doc).find((b) => b.id === state.recovered.blockId);
      delete state.recovered;
      this.save(ws, state);
      return recovered;
    }
    const before = await this.notion.list(`blocks/${parentId}/children`);
    const after =
      options.after !== undefined
        ? options.after
        : parentId === ws.notion.pageId
          ? this.lastInSection(state.doc, phase)
          : undefined;
    state.attempt = {
      parentId,
      body,
      phase,
      before: before.map((b) => b.id),
      key,
      after,
      nodeId: options.nodeId,
    };
    this.save(ws, state);
    let result;
    try {
      result = await this.notion.call(`blocks/${parentId}/children`, 'PATCH', {
        children: [body],
        ...(after !== undefined
          ? {
              position:
                after === null
                  ? { type: 'start' }
                  : { type: 'after_block', after_block: { id: after } },
            }
          : {}),
        notifications: { mode: 'silent' },
      });
    } catch (e) {
      if (e.notionStatus >= 400 && e.notionStatus < 500 && e.notionStatus !== 408) {
        delete state.attempt;
        this.save(ws, state);
      }
      throw e;
    }
    let created = (result.results || []).filter(
      (b) =>
        !state.attempt.before.includes(b.id) && b.type === body.type && words(b) === words(body),
    );
    if (created.length !== 1)
      created = (await this.notion.list(`blocks/${parentId}/children`)).filter(
        (b) =>
          !state.attempt.before.includes(b.id) && b.type === body.type && words(b) === words(body),
      );
    requireThat(created.length === 1, 'Notionの追加結果が未確定です', 502);
    const block = { ...created[0], parentId, children: [], _phase: phase };
    this.add(state.doc, parentId, block, after);
    delete state.attempt;
    this.save(ws, state);
    return block;
  }
  lastInSection(doc, phase) {
    const s = doc.sections[phase];
    return s.roots.at(-1)?.id || s.id;
  }
  async patch(ws, state, block, body) {
    const current = await this.notion.call(`blocks/${block.id}`);
    requireThat(
      current.type === block.type && words(current) === words(block),
      'Notionの同じ項目が変更されました。Notionから再読込みしてください',
      409,
    );
    state.patchAttempt = { id: block.id, body };
    this.save(ws, state);
    await this.notion.call(`blocks/${block.id}`, 'PATCH', body);
    applyBlockUpdate(block, body);
    delete state.patchAttempt;
    this.save(ws, state);
  }
  async archive(ws, state, block) {
    if (block.children.length) {
      const children = await this.notion.list(`blocks/${block.id}/children`);
      requireThat(
        JSON.stringify(children.map((b) => b.id)) ===
          JSON.stringify(block.children.map((b) => b.id)),
        'Notionで子の項目が変更されています。再読込みしてください',
        409,
      );
    }
    state.archiveAttempt = { id: block.id, parentId: block.parentId };
    this.save(ws, state);
    await this.notion.call(`blocks/${block.id}`, 'PATCH', { in_trash: true });
    this.remove(state.doc, block.id);
    delete state.archiveAttempt;
    this.save(ws, state);
  }
  async ensureSection(ws, state, phase) {
    if (state.doc.sections[phase]) {
      const heading = state.doc.sections[phase].heading;
      if (words(heading) !== stageTitles[phase - 1])
        await this.patch(ws, state, heading, {
          [heading.type]: {
            rich_text: rt(stageTitles[phase - 1]),
            color: 'green_background',
            is_toggleable: false,
          },
        });
      return;
    }
    const previous =
      Object.keys(state.doc.sections)
        .map(Number)
        .filter((p) => p < phase)
        .at(-1) || 1;
    if (state.sectionAttempt) {
      const top = await this.notion.list(`blocks/${ws.notion.pageId}/children`);
      const found = top.filter((b) => phaseOf(b) === state.sectionAttempt);
      requireThat(
        found.length === 1,
        '見出しの追加結果が未確定です。Notion側を確認してください',
        409,
      );
      const b = found[0];
      state.doc.sections[state.sectionAttempt] = { id: b.id, heading: b, roots: [] };
      delete state.sectionAttempt;
      this.save(ws, state);
      if (state.doc.sections[phase]) return;
    }
    state.sectionAttempt = phase;
    this.save(ws, state);
    const result = await this.notion.call(`blocks/${ws.notion.pageId}/children`, 'PATCH', {
      children: [
        {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: rt(stageTitles[phase - 1]),
            color: 'green_background',
            is_toggleable: false,
          },
        },
      ],
      position: {
        type: 'after_block',
        after_block: { id: this.lastInSection(state.doc, previous) },
      },
      notifications: { mode: 'silent' },
    });
    const b =
      (result.results || []).find((b) => phaseOf(b) === phase) ||
      (await this.notion.list(`blocks/${ws.notion.pageId}/children`)).find(
        (b) => phaseOf(b) === phase,
      );
    requireThat(b, 'Notionの見出し追加結果が未確定です', 502);
    state.doc.sections[phase] = { id: b.id, heading: b, roots: [] };
    delete state.sectionAttempt;
    this.save(ws, state);
  }
  async writeMap(ws, state, team) {
    const layout = this.teamRoots(ws, state.doc, team);
    let container = layout.parentId;
    if (!container && team.nodes.length) {
      const wrapper = await this.append(
        ws,
        state,
        ws.notion.pageId,
        payload('toggle', `チーム：${team.name}`),
      );
      container = wrapper.id;
    }
    if (!container) return;
    const oldNodes = this.parseNodes(ws, state.doc, team),
      oldById = new Map(),
      all = this.all(state.doc),
      byBlock = new Map(all.map((b) => [b.id, b]));
    for (const n of oldNodes)
      if (
        !oldById.has(n.id) ||
        n.notionBlockId === team.nodes.find((d) => d.id === n.id)?.notionBlockId
      )
        oldById.set(n.id, n);
    const desiredIds = new Set(team.nodes.map((n) => n.id)),
      retained = new Set(),
      stale = new Set();
    const checkSafe = (b) => {
      requireThat(
        textTypes.has(b.type),
        '画像や未対応ブロックを含む枝の構造変更はNotion側で行ってください',
        409,
      );
      for (const c of b.children) checkSafe(c);
    };
    const visit = async (parent, blockParent, depth, recreate = false) => {
      const nodes = team.nodes.filter((n) =>
        parent === 'theme' ? n.parent === 'theme' || n.parent === null : n.parent === parent,
      );
      let previous = blockParent === ws.notion.pageId ? state.doc.sections[1].id : null;
      for (const n of nodes) {
        const old = oldById.get(n.id),
          original = old && byBlock.get(old.notionBlockId);
        const type = typeAt(depth);
        let b = original;
        const changedParent =
          old && old.parent !== n.parent && !(old.parent === 'theme' && n.parent === null);
        if (!original || recreate || changedParent) {
          if (original) checkSafe(original);
          b = await this.append(ws, state, blockParent, payload(type, n.text, colors[n.group]), 1, {
            nodeId: n.id,
            after: previous,
          });
          n.notionBlockId = b.id;
          if (original) stale.add(original.id);
        } else if (
          words(b) !== n.text ||
          Math.max(0, colors.indexOf(b[b.type]?.color)) !== n.group
        ) {
          await this.patch(ws, state, b, {
            [b.type]: { rich_text: rt(n.text), color: colors[n.group] },
          });
        }
        retained.add(b.id);
        previous = b.id;
        this.store.put('workshops', ws.id, ws);
        await visit(n.id, b.id, depth + 1, b.id !== original?.id);
      }
    };
    await visit('theme', container, 1);
    for (const old of oldNodes)
      if (!retained.has(old.notionBlockId)) {
        const b = this.all(state.doc).find((b) => b.id === old.notionBlockId);
        if (b) {
          checkSafe(b);
          requireThat(
            !this.descendantBlocks(b).some((c) => retained.has(c.id)),
            '子の枝を保護するためNotionへの削除を停止しました',
            409,
          );
          await this.archive(ws, state, b);
        }
      }
  }
  descendantBlocks(b) {
    return b.children.flatMap((c) => [c, ...this.descendantBlocks(c)]);
  }
  stageRecord(ws, team, phase) {
    const base = { schema: snapshotMarker, phase, team: team.name };
    if (phase === 2)
      return {
        ...base,
        rootText: team.rootText || ws.theme,
        cards: team.nodes.map((n) => ({
          id: n.id,
          notionBlockId: n.notionBlockId,
          text: n.text,
          group: n.group,
        })),
        totals: Object.fromEntries(team.nodes.map((n) => [n.id, totals(ws, 'cards')[n.id] || 0])),
        deck: team.deck,
        budget: ws.budgets.cards,
      };
    if (phase === 3)
      return {
        ...base,
        deck: team.deck,
        discussion: Object.fromEntries(
          ['transcript', 'what', 'who', 'how', 'points', 'keywords', 'rounds', 'running'].map(
            (k) => [k, team.discussion[k]],
          ),
        ),
        imageKey: team.image ? hash(team.image.base64) : null,
      };
    return { ...base, totalVotes: totals(ws, 'ideas')[team.id] || 0, budget: ws.budgets.ideas };
  }
  async writeRecord(ws, state, team, phase) {
    await this.ensureSection(ws, state, phase);
    let { wrapper, code } = this.record(state.doc, team, phase);
    if (!wrapper)
      wrapper = await this.append(
        ws,
        state,
        ws.notion.pageId,
        payload('toggle', `チーム：${team.name}`),
        phase,
      );
    const record = this.stageRecord(ws, team, phase),
      data = JSON.stringify(record, null, 2);
    requireThat(data.length < 160000, 'Notionの記録が大きすぎます', 409);
    const body = {
      object: 'block',
      type: 'code',
      code: { rich_text: rt(data), language: 'json', caption: rt(snapshotMarker) },
    };
    if (!code) code = await this.append(ws, state, wrapper.id, body, phase);
    else if (words(code) !== data) await this.patch(ws, state, code, { code: body.code });
    const summary =
      phase === 2
        ? `記録：${team.nodes.length}枚のカード／選択 ${team.deck.length}枚／合計 ${Object.values(record.totals).reduce((a, b) => a + b, 0)}票`
        : phase === 3
          ? `記録：WHAT ${team.discussion.what || '未記入'}／WHO ${team.discussion.who || '未記入'}／HOW ${team.discussion.how || '未記入'}`
          : `記録：アイデアへの投票 ${record.totalVotes}票`;
    const p = wrapper.children.find((b) => b.type === 'paragraph' && words(b).startsWith('記録：'));
    if (p) {
      if (words(p) !== summary)
        await this.patch(ws, state, p, { paragraph: { rich_text: rt(summary) } });
    } else await this.append(ws, state, wrapper.id, payload('paragraph', summary), phase);
    if (phase === 3 && team.image) {
      const oldKey = state.imageKeys?.[team.id];
      const marker = `Workshop image ${record.imageKey}`;
      const found = wrapper.children.some(
        (b) =>
          b.type === 'image' &&
          (b.image.caption || []).some((x) => (x.text?.content || x.plain_text) === marker),
      );
      if (oldKey !== record.imageKey && !found) {
        const upload = await this.notion.call('file_uploads', 'POST', {
          mode: 'single_part',
          filename: `${team.id}.png`,
          content_type: 'image/png',
        });
        const form = new FormData();
        form.append(
          'file',
          new Blob([Buffer.from(team.image.base64, 'base64')], { type: 'image/png' }),
          `${team.id}.png`,
        );
        await this.notion.call(`file_uploads/${upload.id}/send`, 'POST', form);
        await this.append(
          ws,
          state,
          wrapper.id,
          {
            object: 'block',
            type: 'image',
            image: { type: 'file_upload', file_upload: { id: upload.id }, caption: rt(marker) },
          },
          phase,
        );
        state.imageKeys ||= {};
        state.imageKeys[team.id] = record.imageKey;
        this.save(ws, state);
      }
    }
  }
  async push(ws, { verified = false } = {}) {
    const state = this.state(ws);
    requireThat(state?.doc, 'Notionの①見出しを確認して同期してください', 409);
    try {
      if (state.patchAttempt) {
        const a = state.patchAttempt,
          b = this.all(state.doc).find((b) => b.id === a.id),
          fresh = await this.notion.call(`blocks/${a.id}`);
        const desired = { ...b, ...a.body };
        if (
          words(fresh) === words(desired) &&
          fresh[fresh.type]?.color === desired[desired.type]?.color
        ) {
          applyBlockUpdate(b, a.body);
          delete state.patchAttempt;
          this.save(ws, state);
        } else await this.patch(ws, state, b, a.body);
      }
      if (state.archiveAttempt) {
        const a = state.archiveAttempt,
          children = await this.notion.list(`blocks/${a.parentId}/children`);
        if (children.some((b) => b.id === a.id))
          await this.archive(
            ws,
            state,
            this.all(state.doc).find((b) => b.id === a.id),
          );
        else {
          this.remove(state.doc, a.id);
          delete state.archiveAttempt;
          this.save(ws, state);
        }
      }
      if (state.attempt) {
        const a = state.attempt;
        await this.append(ws, state, a.parentId, a.body, a.phase);
      }
      if (state.sectionAttempt) await this.ensureSection(ws, state, state.sectionAttempt);
      const fresh = verified ? state.doc : await this.read(ws);
      requireThat(
        fresh && this.fingerprint(fresh) === this.fingerprint(state.doc),
        'Notionが別途更新されました。内容を確認してから再読込みしてください',
        409,
      );
      for (const team of Object.values(ws.teams)) await this.writeMap(ws, state, team);
      for (const team of Object.values(ws.teams))
        for (const phase of [2, 3, 4]) await this.writeRecord(ws, state, team, phase);
      const page = await this.notion.call(`pages/${ws.notion.pageId}`);
      ws.notion.baseEdited = page.last_edited_time;
      state.edited = null;
      state.fingerprint = this.fingerprint(state.doc);
      state.at = Date.now();
      this.save(ws, state);
      ws.documentSync = { at: Date.now(), pending: false, error: null };
    } catch (e) {
      ws.documentSync = { ...ws.documentSync, pending: true, error: e.message };
    }
    ws.revision++;
    this.store.put('workshops', ws.id, ws);
    return ws;
  }
  async change(user, wsId, body) {
    let ws = this.store.get('workshops', wsId);
    if (!ws.notion) return mutate(this.store, user, wsId, body);
    requireThat(
      !ws.documentSync?.pending,
      'Notionへの未同期操作があります。同期を再試行してください',
      409,
    );
    const before = ws.revision,
      state = this.state(ws),
      p = body.payload || {};
    const node = Object.values(ws.teams)
      .flatMap((t) => t.nodes)
      .find((n) => n.id === p.id);
    const fast =
      state?.doc &&
      (['vote', 'discussion', 'deck', 'topicTheme', 'createTopic'].includes(body.action) ||
        (body.action === 'node' && node && p.parent === undefined));
    if (fast) {
      const checks = [];
      if (body.action === 'node' && node?.notionBlockId)
        checks.push(this.all(state.doc).find((b) => b.id === node.notionBlockId));
      const team =
        ws.teams[p.teamId] ||
        Object.values(ws.teams).find(
          (t) =>
            body.action === 'vote' &&
            (p.phase === 'ideas' ? t.id === p.target : t.nodes.some((n) => n.id === p.target)),
        );
      const phase =
        body.action === 'discussion' ? 3 : body.action === 'vote' && p.phase === 'ideas' ? 4 : 2;
      if (team) checks.push(this.record(state.doc, team, phase).code);
      let changed = false;
      for (const b of checks.filter(Boolean)) {
        const current = await this.notion.call(`blocks/${b.id}`);
        if (words(current) !== words(b) || current[current.type]?.color !== b[b.type]?.color)
          changed = true;
      }
      if (changed) {
        await this.pull(ws, undefined, true);
        this.store.put('workshops', ws.id, ws);
        requireThat(false, 'Notion側の変更を読み込みました。最新の内容を確認してください', 409);
      }
    } else await this.pull(ws, undefined, true);
    this.store.put('workshops', ws.id, ws);
    requireThat(
      !ws.documentSync?.error,
      ws.documentSync?.error || 'Notionの記録を確認してください',
      409,
    );
    requireThat(
      ws.revision === before,
      'Notion側に更新があったため読み込みました。最新の内容を確認して再操作してください',
      409,
    );
    ws = mutate(this.store, user, wsId, body);
    if (!this.state(ws)?.doc) return ws;
    ws.documentSync = { ...ws.documentSync, pending: true, error: null };
    this.store.put('workshops', ws.id, ws);
    return this.push(ws, { verified: true });
  }
  async retry(ws) {
    return this.push(ws);
  }
}
