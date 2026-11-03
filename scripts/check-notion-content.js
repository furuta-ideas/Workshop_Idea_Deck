// Operational check: stop the app before running this against its data directory.
// Default: read only on Notion. Explicit flags initialize stage records and/or
// verify a disposable topic's create/edit/delete round trip. Never prints content or credentials.
import { configuration } from '../server/index.js';
import { Notion } from '../server/notion.js';
import { Store, id } from '../server/store.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const config = configuration(),
  store = new Store(join(config.dataDir, 'workshop.sqlite')),
  notion = new Notion(store, config);
const roundtrip =
  process.argv.includes('--roundtrip') || process.argv.includes('--resume-roundtrip');
const targetPage = process.argv.find((a) => a.startsWith('--page='))?.slice(7),
  targetTeam = process.argv.find((a) => a.startsWith('--team='))?.slice(7) || 'A班',
  normalize = process.argv.includes('--normalize');
try {
  if ((roundtrip || normalize) && !targetPage)
    throw Error('書込み対象の --page=対象NotionページID が必要です');
  if (process.argv.includes('--initialize') || roundtrip || normalize) await notion.sync();
  else
    for (const ws of store.all('workshops').filter((w) => w.notion)) {
      const page = await notion.call(`pages/${ws.notion.pageId}`);
      await notion.content.pull(ws, page.last_edited_time, true);
      store.put('workshops', ws.id, ws);
    }
  const targets = store
    .all('workshops')
    .filter(
      (w) =>
        w.notion &&
        (!targetPage || w.notion.pageId.replaceAll('-', '') === targetPage.replaceAll('-', '')),
    );
  if (targetPage && !targets.length) throw Error('指定されたNotionページが見つかりません');
  for (let ws of targets) {
    if (
      ws.documentSync?.error &&
      !(ws.documentSync.pending && (process.argv.includes('--initialize') || normalize))
    )
      throw Error(ws.documentSync.error);
    const state = notion.content.state(ws);
    if (!state?.doc) continue;
    writeFileSync(
      join(config.dataDir, `notion-content-backup-${Date.now()}.json`),
      JSON.stringify(state.doc),
    );
    console.log(
      JSON.stringify({
        stage: 'read',
        teams: Object.keys(ws.teams).length,
        topics: Object.values(ws.teams).reduce((s, t) => s + t.nodes.length, 0),
        sections: Object.keys(state.doc.sections).length,
      }),
    );
    if (process.argv.includes('--initialize') || normalize) {
      const canonical = (w) =>
        Object.values(w.teams).map((t) => ({
          team: t.id,
          nodes: t.nodes
            .map(({ notionBlockId, ...node }) => node)
            .sort((a, b) => a.id.localeCompare(b.id)),
          deck: t.deck,
        }));
      const before = canonical(ws);
      ws = ws.documentSync?.pending
        ? await notion.content.retry(ws)
        : await notion.content.push(ws);
      if (ws.documentSync?.pending) throw Error(ws.documentSync.error);
      if (normalize) {
        await notion.content.pull(ws, undefined, true);
        store.put('workshops', ws.id, ws);
        if (ws.documentSync?.error) throw Error(ws.documentSync.error);
        if (!isDeepStrictEqual(before, canonical(ws)))
          throw Error('移行後の本文・階層・ID・デッキが移行前と一致しません');
        const doc = notion.content.state(ws).doc;
        if (
          doc.sections[1].roots.length !== Object.keys(ws.teams).length ||
          notion.content.all({ sections: { 1: doc.sections[1] } }).some((b) => b.type !== 'toggle')
        )
          throw Error('チーム別トグルへの移行を確認できません');
      }
      console.log(JSON.stringify({ stage: normalize ? 'normalize' : 'initialize', synced: true }));
    }
    if (roundtrip) {
      const entry = Object.entries(ws.members).find(
          ([, m]) => m.role === '管理者' && ws.teams[m.teamId]?.name === targetTeam,
        ),
        user = { email: entry?.[0], admin: true },
        teamId = entry?.[1].teamId;
      if (!teamId) throw Error('管理者の割当チームが必要です');
      const act = async (action, payload) => {
        const current = store.get('workshops', ws.id);
        const result = await notion.content.change(user, ws.id, {
          action,
          payload,
          revision: current.revision,
          requestId: id(),
        });
        if (result.documentSync?.pending) throw Error(result.documentSync.error);
        return result;
      };
      let marker, node;
      if (process.argv.includes('--resume-roundtrip')) {
        const candidates = ws.teams[teamId].nodes.filter((n) =>
          /^同期確認用・一時トピック [a-f0-9-]{36} 更新$/.test(n.text),
        );
        if (candidates.length !== 1) throw Error('再開対象の一時トピックを一意に特定できません');
        node = candidates[0];
        marker = node.text.replace(/ 更新$/, '');
        const current = await notion.call(`blocks/${node.notionBlockId}`);
        if (
          current.type !== 'toggle' ||
          current.toggle.rich_text.map((x) => x.plain_text || x.text?.content || '').join('') !==
            node.text
        )
          throw Error('更新済みの一時トピックと一致しません');
        console.log(JSON.stringify({ stage: 'resume', updatedTemporaryTopicVerified: true }));
      } else {
        marker = `同期確認用・一時トピック ${id()}`;
        ws = await act('createTopic', {
          teamId,
          placement: 'child',
          anchorId: 'theme',
          text: marker,
        });
        node = ws.teams[teamId].nodes.find((n) => n.text === marker);
        const created = await notion.call(`blocks/${node.notionBlockId}`);
        if (created.type !== 'toggle') throw Error('メイントピックの型が一致しません');
        console.log(JSON.stringify({ stage: 'create', verified: true }));
        ws = await act('node', { teamId, id: node.id, text: marker + ' 更新' });
        const updated = await notion.call(`blocks/${node.notionBlockId}`);
        if (
          updated.toggle.rich_text.map((x) => x.plain_text || x.text?.content || '').join('') !==
          marker + ' 更新'
        )
          throw Error('文字更新を確認できません');
        console.log(JSON.stringify({ stage: 'edit', verified: true }));
      }
      ws = await act('deleteNode', { teamId, id: node.id });
      const reread = await notion.content.read(ws);
      if (notion.content.all(reread).some((b) => b.id === node.notionBlockId))
        throw Error('一時トピックが残っています');
      console.log(
        JSON.stringify({
          stage: 'roundtrip',
          create: true,
          edit: true,
          delete: true,
          temporaryTopicRemoved: true,
        }),
      );
    }
  }
} finally {
  store.close();
}
