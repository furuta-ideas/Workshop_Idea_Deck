import { id, newWorkshop, newTeam, normalizeEmail } from './store.js';
import { requireThat, Fault, expire, markdown } from './domain.js';
import { NotionContent, stageTitles } from './notion-content.js';

const rt = (content) => [{ type: 'text', text: { content } }];
const title = (p) => (p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const visibleState = (w) =>
  JSON.stringify({
    name: w.name,
    status: w.status,
    endDate: w.endDate,
    deleted: w.deleted,
    members: w.members,
    teams: w.teams,
    error: w.notion?.error,
    conflict: w.notion?.conflict,
    documentPending: w.documentSync?.pending,
    documentError: w.documentSync?.error,
  });
export const participantSchema = {
  名前: { title: {} },
  選択: { select: { options: ['管理者', '編集者', '閲覧者'].map((name) => ({ name })) } },
  グループ: { select: { options: [] } },
  OTP認証結果: { select: { options: [{ name: '認証済' }] } },
  OTP認証日時: { date: {} },
};
export class Notion {
  constructor(store, config, transport = fetch) {
    this.store = store;
    this.config = config;
    this.liveTransport = transport === fetch;
    this.transport = this.liveTransport ? fetch.bind(globalThis) : transport;
    this.running = null;
    this.content = new NotionContent(this);
    this.lastRequestAt = 0;
  }
  enabled() {
    return !!(this.config.notionToken && this.config.notionSource);
  }
  async call(path, method = 'GET', body) {
    requireThat(this.enabled(), 'Notion連携が未設定です', 503);
    const form = body instanceof FormData;
    if (this.liveTransport) {
      const wait = 350 - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    }
    const response = await this.transport(`https://api.notion.com/v1/${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${this.config.notionToken}`,
        'Notion-Version': '2026-03-11',
        ...(!form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
    if (!response.ok) {
      const error = new Fault(
        502,
        `Notion同期失敗（HTTP ${response.status}）。設定・共有権限を確認してください`,
      );
      error.notionStatus = response.status;
      throw error;
    }
    return response.json();
  }
  async list(path, method = 'GET') {
    const results = [];
    let cursor;
    do {
      const r = await this.call(
        method === 'GET' ? `${path}${cursor ? `?start_cursor=${cursor}` : ''}` : path,
        method,
        method === 'POST'
          ? { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
          : undefined,
      );
      results.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return results;
  }
  async sourceFor(ws, create = false) {
    if (ws.notion.participantSource) return ws.notion.participantSource;
    const children = await this.list(`blocks/${ws.notion.pageId}/children`);
    const dbs = children.filter(
      (b) => b.type === 'child_database' && b.child_database.title === '参加者一覧',
    );
    requireThat(dbs.length <= 1, '参加者一覧DBが複数あります。構成を確認してください', 409);
    let db;
    if (dbs.length) db = await this.call(`databases/${dbs[0].id}`);
    else if (create) {
      requireThat(
        !ws.notion.childCreateAttempt,
        '子DB作成結果が不明です。Notion側を確認し再接続してください',
        409,
      );
      ws.notion.childCreateAttempt = true;
      this.store.put('workshops', ws.id, ws);
      db = await this.call('databases', 'POST', {
        parent: { type: 'page_id', page_id: ws.notion.pageId },
        title: rt('参加者一覧'),
        is_inline: true,
        initial_data_source: { properties: participantSchema },
      });
    } else throw new Fault(409, '参加者一覧DBがありません。テンプレートから追加してください');
    requireThat(
      db.data_sources?.length === 1,
      '参加者一覧DBのデータソースを一意に特定できません',
      409,
    );
    ws.notion.participantSource = db.data_sources[0].id;
    this.store.put('workshops', ws.id, ws);
    return ws.notion.participantSource;
  }
  async pullMembers(ws) {
    const source = await this.sourceFor(ws);
    const schema = await this.call(`data_sources/${source}`);
    for (const [name, type] of Object.entries({
      名前: 'title',
      選択: 'select',
      グループ: 'select',
      OTP認証結果: 'select',
      OTP認証日時: 'date',
    }))
      requireThat(
        schema.properties?.[name]?.type === type,
        `参加者DBの「${name}」を${type}型で用意してください`,
        409,
      );
    const rows = await this.list(`data_sources/${source}/query`, 'POST'),
      members = {};
    for (const row of rows.filter((x) => !x.archived && !x.in_trash)) {
      const email = normalizeEmail(title(row.properties.名前)),
        role = row.properties.選択?.select?.name;
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !['管理者', '編集者', '閲覧者'].includes(role)
      )
        continue;
      requireThat(!members[email], '参加者メールが重複しています。Notion側で修正してください', 409);
      const group = row.properties.グループ?.select?.name;
      let team = Object.values(ws.teams).find((t) => t.name === group);
      if (group && !team) {
        team = newTeam(group);
        ws.teams[team.id] = team;
      }
      members[email] = { role, teamId: team?.id || null, notionPageId: row.id };
      const user = this.store.get('users', email) || {
        email,
        id: id(),
        admin: false,
        passkeys: [],
      };
      this.store.put('users', email, user);
    }
    ws.members = members;
  }
  meta(page) {
    return {
      name: title(page.properties.名前),
      endDate: page.properties.終了日?.date?.end || page.properties.終了日?.date?.start || null,
      status: page.properties.ステータス?.status?.name || '未着手',
      deleted: !!(page.archived || page.in_trash),
    };
  }
  properties(ws) {
    return {
      名前: { title: rt(ws.name) },
      終了日: { date: ws.endDate ? { start: ws.endDate } : null },
      ステータス: { status: { name: ws.status } },
    };
  }
  async publishNew(ws) {
    requireThat(
      !ws.createAttempt,
      'Notionページ作成結果が不明です。重複作成を防ぐため手動の照合が必要です',
      409,
    );
    ws.createAttempt = true;
    this.store.put('workshops', ws.id, ws);
    const page = await this.call('pages', 'POST', {
      parent: { type: 'data_source_id', data_source_id: this.config.notionSource },
      properties: this.properties(ws),
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: rt(`Workshop Idea Deck ID: ${ws.id}`) },
        },
        ...stageTitles.map((name) => ({
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: rt(name), color: 'green_background', is_toggleable: false },
        })),
      ],
    });
    ws.notion = {
      pageId: page.id,
      baseEdited: page.last_edited_time,
      checkedAt: 0,
      provisioning: true,
    };
    ws.dirty = false;
    this.store.put('workshops', ws.id, ws);
    await this.completeProvision(ws);
    return this.store.get('workshops', ws.id);
  }
  async completeProvision(ws) {
    const source = await this.sourceFor(ws, true);
    const existing = await this.list(`data_sources/${source}/query`, 'POST');
    for (const [email, member] of Object.entries(ws.members)) {
      if (!existing.some((p) => normalizeEmail(title(p.properties.名前)) === email))
        await this.call('pages', 'POST', {
          parent: { type: 'data_source_id', data_source_id: source },
          properties: {
            名前: { title: rt(email) },
            選択: { select: { name: member.role } },
            グループ: { select: member.teamId ? { name: ws.teams[member.teamId].name } : null },
          },
        });
    }
    ws.notion.provisioning = false;
    this.store.put('workshops', ws.id, ws);
  }
  async sync() {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async perform() {
    requireThat(this.enabled(), 'Notion連携が未設定です', 503);
    try {
      const schema = await this.call(`data_sources/${this.config.notionSource}`);
      for (const [name, type] of Object.entries({
        名前: 'title',
        終了日: 'date',
        ステータス: 'status',
      }))
        requireThat(
          schema.properties?.[name]?.type === type,
          `WS一覧の「${name}」の型が不正です`,
          409,
        );
      const remote = await this.list(`data_sources/${this.config.notionSource}/query`, 'POST');
      for (const page of remote) {
        let ws = this.store.all('workshops').find((w) => w.notion?.pageId === page.id);
        if (!ws) {
          ws = newWorkshop(this.meta(page).name, '');
          ws.members = {};
          ws.teams = {};
          ws.notion = { pageId: page.id, baseEdited: page.last_edited_time };
        }
        const before = visibleState(ws);
        try {
          if (ws.notion.provisioning) await this.completeProvision(ws);
          await this.pullMembers(ws);
          const meta = this.meta(page);
          if (ws.dirty && ws.notion.baseEdited !== page.last_edited_time) {
            ws.notion.conflict = { remote: meta, edited: page.last_edited_time };
          } else if (ws.dirty) {
            const updated = await this.call(`pages/${page.id}`, 'PATCH', {
              properties: this.properties(ws),
              ...(ws.deleted ? { archived: true } : {}),
            });
            ws.notion.baseEdited = updated.last_edited_time;
            ws.dirty = false;
          } else {
            Object.assign(ws, meta);
            ws.notion.baseEdited = page.last_edited_time;
          }
          ws.notion.checkedAt = Date.now();
          await this.content.pull(ws, page.last_edited_time);
          ws.notion.checkedAt = Date.now();
          delete ws.notion.error;
          if (before !== visibleState(ws)) ws.revision++;
          expire(this.store, ws);
          this.store.put('workshops', ws.id, ws);
        } catch (e) {
          ws.notion.error = e.message;
          if (before !== visibleState(ws)) ws.revision++;
          this.store.put('workshops', ws.id, ws);
        }
      }
      const ids = new Set(remote.map((p) => p.id));
      for (const ws of this.store
        .all('workshops')
        .filter((w) => w.notion && !ids.has(w.notion.pageId))) {
        try {
          const p = await this.call(`pages/${ws.notion.pageId}`);
          Object.assign(ws, this.meta(p));
          ws.notion.checkedAt = Date.now();
          ws.revision++;
          this.store.put('workshops', ws.id, ws);
        } catch {
          ws.notion.error = 'Notionページへアクセスできません';
          this.store.put('workshops', ws.id, ws);
        }
      }
      this.store.put('kv', 'notion-sync', { at: Date.now(), error: null });
      return this.status();
    } catch (e) {
      for (const ws of this.store.all('workshops').filter((w) => w.notion)) {
        if (ws.notion.error !== e.message) ws.revision++;
        ws.notion.error = e.message;
        this.store.put('workshops', ws.id, ws);
      }
      this.store.put('kv', 'notion-sync', { at: Date.now(), error: e.message });
      throw e;
    }
  }
  status() {
    return {
      ...this.connectionState(),
      ...(this.store.get('kv', 'notion-sync') || {}),
      workshops: this.store
        .all('workshops')
        .filter((w) => w.notion)
        .map((w) => ({
          id: w.id,
          error: w.notion.error,
          conflict: w.notion.conflict,
          dirty: w.dirty,
        })),
    };
  }
  connectionState() {
    if (!this.enabled()) return { enabled: false, state: 'unconfigured' };
    const sync = this.store.get('kv', 'notion-sync');
    if (!sync) return { enabled: true, state: 'pending' };
    const workshops = this.store.all('workshops').filter((w) => w.notion);
    const state =
      sync.error || workshops.some((w) => w.notion.error || w.notion.conflict)
        ? 'error'
        : Date.now() - sync.at >= 60000
          ? 'stale'
          : 'ready';
    return { enabled: true, state, at: sync.at };
  }
  async resolve(wsId, choice) {
    const ws = this.store.get('workshops', wsId);
    requireThat(ws?.notion?.conflict, '競合がありません');
    const current = await this.call(`pages/${ws.notion.pageId}`);
    requireThat(
      current.last_edited_time === ws.notion.conflict.edited,
      'Notionが再更新されました。再同期してください',
      409,
    );
    requireThat(['notion', 'app'].includes(choice), '競合の解決方法が不正です');
    if (choice === 'notion') {
      Object.assign(ws, ws.notion.conflict.remote);
      ws.dirty = false;
    } else ws.dirty = true;
    ws.notion.baseEdited = current.last_edited_time;
    delete ws.notion.conflict;
    ws.revision++;
    this.store.put('workshops', ws.id, ws);
    return this.sync();
  }
  async setMember(ws, email, member) {
    const source = await this.sourceFor(ws);
    const old = ws.members[email];
    const properties = {
      名前: { title: rt(email) },
      選択: { select: { name: member.role } },
      グループ: { select: member.teamId ? { name: ws.teams[member.teamId].name } : null },
    };
    await this.call(
      old?.notionPageId ? `pages/${old.notionPageId}` : 'pages',
      old?.notionPageId ? 'PATCH' : 'POST',
      old?.notionPageId
        ? { properties }
        : { parent: { type: 'data_source_id', data_source_id: source }, properties },
    );
    await this.sync();
  }
  async saveResults(ws) {
    requireThat(ws.notion, '先にNotionへ接続してください', 409);
    const output = [];
    for (const team of Object.values(ws.teams)) {
      const marker = `Workshop result: ${ws.id}/${team.id}/r${ws.revision}`;
      const children = await this.list(`blocks/${ws.notion.pageId}/children`);
      const found = children.find(
        (b) =>
          b.type === 'child_page' && b.child_page.title === `${team.name} 成果 r${ws.revision}`,
      );
      if (found) {
        output.push(found.id);
        continue;
      }
      const blocks = [];
      const md = markdown(ws, team);
      for (let i = 0; i < md.length; i += 1800)
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: rt(md.slice(i, i + 1800)) },
        });
      if (team.image) {
        const upload = await this.call('file_uploads', 'POST', {
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
        await this.call(`file_uploads/${upload.id}/send`, 'POST', form);
        blocks.push({
          object: 'block',
          type: 'image',
          image: { type: 'file_upload', file_upload: { id: upload.id } },
        });
      }
      requireThat(blocks.length <= 100, '成果が大きすぎます。Markdownをエクスポートしてください');
      const page = await this.call('pages', 'POST', {
        parent: { type: 'page_id', page_id: ws.notion.pageId },
        properties: { title: { title: rt(`${team.name} 成果 r${ws.revision}`) } },
        children: [
          { object: 'block', type: 'paragraph', paragraph: { rich_text: rt(marker) } },
          ...blocks,
        ],
      });
      output.push(page.id);
    }
    return { pages: output };
  }
}
