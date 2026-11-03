import { configuration } from '../server/index.js';
import { Notion } from '../server/notion.js';
import { Store, newWorkshop } from '../server/store.js';

const config = configuration();
const store = new Store(':memory:');
const notion = new Notion(store, config);
try {
  if (!notion.enabled())
    throw new Error('Notion接続が未設定です。NOTION_TOKENと対象データソースを設定してください。');
  const schema = await notion.call(`data_sources/${config.notionSource}`);
  for (const [name, type] of Object.entries({
    名前: 'title',
    終了日: 'date',
    ステータス: 'status',
  }))
    if (schema.properties?.[name]?.type !== type)
      throw new Error(`ワークショップ一覧の「${name}」の型を確認してください。`);
  const pages = await notion.list(`data_sources/${config.notionSource}/query`, 'POST');
  let participantDatabases = 0;
  const issues = [];
  for (const page of pages) {
    const ws = newWorkshop('接続確認', '');
    ws.members = {};
    ws.teams = {};
    ws.notion = { pageId: page.id };
    try {
      await notion.pullMembers(ws);
      participantDatabases++;
    } catch (error) {
      issues.push(error.message);
    }
  }
  console.log(
    JSON.stringify({
      connected: true,
      workshopCount: pages.length,
      readableParticipantDatabases: participantDatabases,
      issues,
    }),
  );
  console.log('読取りのみで確認しました。Notionのデータや実行中アプリのDBは変更していません。');
  if (issues.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
