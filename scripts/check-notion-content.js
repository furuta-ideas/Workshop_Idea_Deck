// Operational check: stop the app before running this against its data directory.
// Default: read only on Notion. Explicit flags initialize stage records and/or
// verify a disposable topic's create/edit/delete round trip. Never prints content or credentials.
import { configuration } from '../server/index.js';
import { Notion } from '../server/notion.js';
import { Store, id } from '../server/store.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const config = configuration(),
  store = new Store(join(config.dataDir, 'workshop.sqlite')),
  notion = new Notion(store, config);
try {
  if (process.argv.includes('--initialize') || process.argv.includes('--roundtrip'))
    await notion.sync();
  else
    for (const ws of store.all('workshops').filter((w) => w.notion)) {
      const page = await notion.call(`pages/${ws.notion.pageId}`);
      await notion.content.pull(ws, page.last_edited_time, true);
      store.put('workshops', ws.id, ws);
    }
  for (let ws of store.all('workshops').filter((w) => w.notion)) {
    if (
      ws.documentSync?.error &&
      !(ws.documentSync.pending && process.argv.includes('--initialize'))
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
    if (process.argv.includes('--initialize')) {
      ws = await notion.content.push(ws);
      if (ws.documentSync?.pending) throw Error(ws.documentSync.error);
      console.log(JSON.stringify({ stage: 'initialize', synced: true }));
    }
    if (process.argv.includes('--roundtrip')) {
      const entry = Object.entries(ws.members).find(([, m]) => m.role === '管理者' && m.teamId),
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
      const marker = `同期確認用・一時トピック ${id()}`;
      ws = await act('createTopic', {
        teamId,
        placement: 'child',
        anchorId: 'theme',
        text: marker,
      });
      const node = ws.teams[teamId].nodes.find((n) => n.text === marker);
      const created = await notion.call(`blocks/${node.notionBlockId}`);
      if (created.type !== 'heading_2') throw Error('メイントピックの型が一致しません');
      ws = await act('node', { teamId, id: node.id, text: marker + ' 更新' });
      const updated = await notion.call(`blocks/${node.notionBlockId}`);
      if (
        updated.heading_2.rich_text.map((x) => x.plain_text || x.text?.content || '').join('') !==
        marker + ' 更新'
      )
        throw Error('文字更新を確認できません');
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
