// Operational check (read only on Notion): for each connected workshop, list
// the newest 「ワークショップの履歴」 entry per team and whether it parses.
// Stop the app before running this against its data directory.
// Prints titles and counts only, never content or credentials.
import { configuration } from '../server/index.js';
import { Notion } from '../server/notion.js';
import { Store } from '../server/store.js';
import { join } from 'node:path';

const config = configuration(),
  store = new Store(join(config.dataDir, 'workshop.sqlite')),
  notion = new Notion(store, config);
let failed = false;
try {
  for (const ws of store.all('workshops').filter((w) => w.notion && !w.deleted)) {
    const top = await notion.content.topBlocks(ws);
    const latest = notion.content.latestEntries(ws, top);
    console.log(`WS ${ws.id}: 履歴のあるチーム ${Object.keys(latest).length}`);
    for (const [team, entry] of Object.entries(latest)) {
      try {
        const data = notion.content.parse(await notion.content.readTree(entry.id), team);
        console.log(
          `  ${team}: ${entry.stamp} トピック${data.nodes.length}件 画像${data.image ? 'あり' : 'なし'} 投票カード${data.votes.cards?.length || 0}件`,
        );
      } catch (e) {
        failed = true;
        console.log(`  ${team}: ${entry.stamp} 読込み失敗 ${e.message}`);
      }
    }
  }
} finally {
  store.close();
}
process.exitCode = failed ? 1 : 0;
