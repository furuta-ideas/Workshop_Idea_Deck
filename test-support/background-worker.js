// Isolated native-runtime fixture. Never uses real credentials or workshop data.
import { WorkshopState as ProductionState } from '../cloudflare/worker.js';
import { NotionContent } from '../server/notion-content.js';
import { newWorkshop, hash } from '../server/store.js';

let release,
  waiting = false,
  sentTexts = [];
const document = { sections: {} };
NotionContent.prototype.read = async function () {
  waiting = true;
  await new Promise((resolve) => {
    release = resolve;
  });
  waiting = false;
  return structuredClone(document);
};
NotionContent.prototype.writeMap = async function (ws, _state, team) {
  sentTexts = team.nodes.map((n) => n.text);
  for (const node of team.nodes) node.notionBlockId = `physical-${node.id}`;
  this.store.put('workshops', ws.id, ws);
};
NotionContent.prototype.writeRecord = async () => {};

export class BackgroundProof extends ProductionState {
  constructor(ctx, env) {
    super(ctx, { APP_ORIGIN: 'http://localhost:4341', RP_ID: 'localhost' });
    this.app.notion.call = async () => ({ last_edited_time: 'fixture-edited' });
    this.ws = newWorkshop('Native background proof', 'native@example.test');
    this.ws.id = 'native-proof';
    this.team = Object.values(this.ws.teams)[0];
    this.team.nodes = [{ id: 'initial', text: 'frozen text', parent: null, group: 0 }];
    this.ws.notion = { pageId: 'fixture-page', checkedAt: Date.now() };
    this.store.put('users', 'native@example.test', { email: 'native@example.test', admin: true });
    this.store.put('workshops', this.ws.id, this.ws);
    this.store.put('kv', `notion-content:${this.ws.id}`, { doc: document });
    this.app.notion.content.schedule(this.ws, Date.now() - 11000);
    this.store.put('kv', 'cloud-maintenance', { at: Date.now() });
    this.store.db
      .prepare('INSERT OR REPLACE INTO sessions(token,email,expires,csrf) VALUES(?,?,?,?)')
      .run(hash('native-session'), 'native@example.test', Date.now() + 3600000, 'native-csrf');
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__proof/start') {
      await this.ctx.storage.setAlarm(Date.now() + 200);
      return Response.json({ started: true });
    }
    if (path === '/__proof/release') {
      release?.();
      return Response.json({ released: true });
    }
    if (path === '/__proof/state') {
      return Response.json({
        waiting,
        sentTexts,
        workshop: this.store.get('workshops', this.ws.id),
      });
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request, env) {
    return env.APP_STATE.get(env.APP_STATE.idFromName('isolated-proof')).fetch(request);
  },
};
