import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { AI, tasks } from '../server/ai.js';
test('全6種類のAI処理は未認可・未設定なら送信ゼロ、別会社への変更も拒否', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let sent = 0;
  const ai = new AI(store, { providers: [] }, async () => {
    sent++;
    throw Error();
  });
  for (const task of tasks)
    await assert.rejects(
      () => ai.run(task, { private: 'data' }, 'user@example.test'),
      (e) => e.status === 503,
    );
  assert.equal(sent, 0);
  assert.throws(() => ai.save({ provider: 'other-company', model: 'test' }));
  assert.equal(ai.settings().model, '');
});
test('機能ごとに認可を照合・既定モデル未指定・認可済みgatewayだけに送信・自動再送なし', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const provider = {
    id: 'genspark-enterprise',
    label: '社内Gateway',
    endpoint: 'https://approved.example.test/ai',
    keyEnv: 'WORKSHOP_TEST_ONLY_KEY',
    capabilities: ['questions', 'image'],
    approvalReference: 'test-fixture-only',
  };
  process.env.WORKSHOP_TEST_ONLY_KEY = 'test-only';
  t.after(() => delete process.env.WORKSHOP_TEST_ONLY_KEY);
  const sent = [];
  const ai = new AI(store, { providers: [provider] }, async (url, init) => {
    sent.push({ url: String(url), ...init });
    return { ok: true, text: async () => JSON.stringify({ questions: ['誰の体験？'] }) };
  });
  assert.deepEqual(await ai.run('questions', { nodes: [] }, 'u@example.test'), {
    questions: ['誰の体験？'],
  });
  assert.equal(sent.length, 1);
  assert.equal('model' in JSON.parse(sent[0].body), false);
  assert.equal(sent[0].url, provider.endpoint);
  assert.equal(sent[0].redirect, 'manual');
  await assert.rejects(() => ai.run('transcribe', { audio: 'private' }, 'u@example.test'));
  await assert.rejects(() => ai.run('image', {}, 'u@example.test'));
  assert.equal(sent.length, 1);
  const fail = new AI(store, { providers: [provider] }, async () => {
    sent.push('failure');
    throw Error('network');
  });
  await assert.rejects(() => fail.run('questions', {}, 'u@example.test'));
  assert.equal(sent.length, 2);
});
