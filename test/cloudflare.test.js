import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase } from '../cloudflare/database.js';
import { Store, newWorkshop, id } from '../server/store.js';
import { mutate } from '../server/domain.js';
import { Facilitator } from '../server/facilitator.js';
import { readFileSync } from 'node:fs';
import { scheduleAlarm } from '../cloudflare/scheduling.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA recursive_triggers=ON');
  t.after(() => db.close());
  const storage = {
    sql: {
      exec(sql, ...args) {
        const stmt = db.prepare(sql);
        if (/^SELECT/i.test(sql.trim())) return { toArray: () => stmt.all(...args) };
        const result = stmt.run(...args);
        return { toArray: () => [], rowsWritten: result.changes };
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, store: new Store(':durable:', new DurableDatabase(storage)), storage };
}
test('Cloudflare SQLite: 通常の保存・共同編集・トランザクションのロールバックを永続SQLへ適用', (t) => {
  const { store, storage } = fixture(t),
    user = { email: 'admin@example.test', admin: true },
    ws = newWorkshop('永続保存', user.email),
    team = Object.values(ws.teams)[0];
  store.put('workshops', ws.id, ws);
  const changed = mutate(store, user, ws.id, {
    action: 'createTopic',
    payload: { teamId: team.id, placement: 'main', text: 'クラウドの気づき' },
    revision: ws.revision,
    requestId: id(),
  });
  assert.equal(changed.teams[team.id].nodes[0].text, 'クラウドの気づき');
  assert.throws(() =>
    store.tx(() => {
      store.put('kv', 'rollback', { value: '残さない' });
      throw Error('rollback');
    }),
  );
  assert.equal(store.get('kv', 'rollback'), undefined);
  const restarted = new Store(':durable:', new DurableDatabase(storage));
  assert.deepEqual(restarted.get('workshops', ws.id).teams, changed.teams);
});
test('Cloudflare md: ファイルを使わず永続SQLで管理者用mdを保存・再読込みし競合を拒否', (t) => {
  const { store, storage } = fixture(t),
    config = { facilitatorDocument: readFileSync('config/ai-facilitator.md', 'utf8') },
    facilitator = new Facilitator(store, config, {}),
    original = facilitator.settings(true);
  const saved = facilitator.save(
    { version: original.version, markdown: original.markdown + '\nクラウド保存の確認\n' },
    'admin@example.test',
  );
  const restarted = new Facilitator(
    new Store(':durable:', new DurableDatabase(storage)),
    config,
    {},
  );
  assert.equal(restarted.document(), saved.markdown);
  assert.throws(
    () =>
      restarted.save(
        { version: original.version, markdown: original.markdown },
        'admin@example.test',
      ),
    (e) => e.status === 409,
  );
});

test('Cloudflareアラーム: 連続したブラウザー照会で送信予約を後ろへずらさない', async () => {
  let alarm = null;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (value) => {
      alarm = value;
    },
  };
  await scheduleAlarm(storage, 10000, 0);
  assert.equal(alarm, 10000);
  for (const now of [9500, 9900, 10000, 10500]) await scheduleAlarm(storage, 10000, now);
  assert.equal(alarm, 10000);
  await scheduleAlarm(storage, 5000, 1000);
  assert.equal(alarm, 5000);
  alarm = null;
  await scheduleAlarm(storage, 10000, 15000);
  assert.equal(alarm, 16000);
});

test('Cloudflare SQLite: 大きい画像等のJSONは行の上限内に分割し、Unicode復元・更新・期限削除を保つ', (t) => {
  const { store, db } = fixture(t),
    value = { text: 'あ😀'.repeat(400000), until: 5 };
  store.put('kv', 'large', value);
  assert.ok(db.prepare('SELECT length(body) AS size FROM kv WHERE id=?').get('large').size < 1000);
  assert.ok(db.prepare('SELECT count(*) AS n FROM app_body_chunks').get().n > 1);
  assert.deepEqual(store.get('kv', 'large'), value);
  assert.deepEqual(store.all('kv'), [value]);
  store.put('kv', 'large', value);
  assert.deepEqual(store.get('kv', 'large'), value);
  store.put('kv', 'large', { text: '短く更新' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM app_body_chunks').get().n, 0);
  store.put('kv', 'large', value);
  store.db.prepare("DELETE FROM kv WHERE json_extract(body,'$.until') < ?").run(10);
  assert.equal(store.get('kv', 'large'), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM app_body_chunks').get().n, 0);
});
