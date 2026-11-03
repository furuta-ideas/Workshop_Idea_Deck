import { configuration, createApp } from './index.js';
import { id, newWorkshop } from './store.js';
const config = configuration({
  ...process.env,
  HOST: '127.0.0.1',
  APP_ORIGIN: 'http://localhost:4317',
  PORT: '4317',
  DATA_DIR: './demo-data',
  NOTION_TOKEN: '',
  NOTION_WORKSHOPS_SOURCE: '',
  AI_APPROVED_PROVIDERS: '[]',
  BOOTSTRAP_ADMIN_EMAIL: '',
});
config.demo = true;
const app = createApp(config);
if (!app.store.all('workshops').length) {
  const ws = newWorkshop('いつもの日常に、小さな新しい価値を。', 'admin@example.test');
  ws.theme = '暮らしの中の「もやもや」から、新しい体験を考えよう';
  const team = Object.values(ws.teams)[0];
  team.name = 'A班';
  const labels = [
    '帰宅しても気持ちが切り替わらない',
    '近所に知り合いがいない',
    '自分の時間をつくりたい',
    '新しいことを始めるきっかけがない',
    '家族との会話を増やしたい',
    '地域で気軽に集まる場所がほしい',
    '一人の時間も大切にしたい',
    '小さな達成感がほしい',
  ];
  labels.forEach((text, i) =>
    team.nodes.push({ id: id(), text, parent: i === 4 ? team.nodes[0].id : null, group: i % 4 }),
  );
  ws.members['editor@example.test'] = { role: '編集者', teamId: team.id };
  ws.members['viewer@example.test'] = { role: '閲覧者', teamId: team.id };
  ws.members['other@example.test'] = { role: '編集者', teamId: null };
  app.store.put('workshops', ws.id, ws);
  for (const email of Object.keys(ws.members))
    app.store.put('users', email, {
      id: id(),
      email,
      admin: email === 'admin@example.test',
      passkeys: [],
    });
}
await app.start();
console.log('ローカル体験モード（本番認証・Notion・AI送信は無効）: http://localhost:4317');
