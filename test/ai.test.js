import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { AI, tasks } from '../server/ai.js';
import { testPNG } from '../test-support/fixtures.js';
test('全7種類のAI処理は未認可・未設定なら送信ゼロ、別会社への変更も拒否', async (t) => {
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

test('Genspark公式API: 秘密キー非公開・文章とImage2.5をGensparkだけに送信し、プロンプトを保持', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const ai = new AI(store, { providers: [] }, async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, ...init });
    if (u.endsWith('/me')) return new Response(JSON.stringify({ email: 'fixture@example.test' }));
    if (u.endsWith('/opencode-config'))
      return new Response(
        JSON.stringify({
          provider: {
            'genspark-llm-proxy': {
              options: { baseURL: 'https://www.genspark.ai/api/llm_proxy/v1' },
              models: { 'fixture-model': {} },
            },
          },
          model: 'genspark-llm-proxy/fixture-model',
        }),
      );
    if (u.endsWith('/chat/completions'))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '地域をつなぐ新しい提案\n地域の課題を解決する構想。' } }],
        }),
      );
    if (u.endsWith('/image_generation'))
      return new Response(
        JSON.stringify({ version: 1, heartbeat: 1 }) +
          '\n' +
          JSON.stringify({
            version: 1,
            status: 'ok',
            data: { generated_images: [{ image_urls: ['https://www.genspark.ai/fixture.png'] }] },
          }),
      );
    if (u.endsWith('/fixture.png')) return new Response(Buffer.from(testPNG(), 'base64'));
    throw Error('Unexpected request');
  });
  await ai.connect('gsk-fixture-secret-only');
  assert.doesNotMatch(JSON.stringify(ai.publicSettings()), /fixture-secret-only/);
  assert.equal(ai.publicSettings().approved.find((p) => p.id === 'genspark-gsk').ready, true);
  ai.save({
    provider: 'genspark-gsk',
    model: '',
    pressReleasePrompt: 'カスタマイズした新聞記事用プロンプト',
    imagePrompt: 'カスタマイズした企画シート',
  });
  const result = await ai.run(
    'pressRelease',
    { discussion: { headline: '地域をつなぐ' } },
    'user@example.test',
  );
  assert.match(result.text, /地域/);
  const textCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.equal(
    JSON.parse(textCall.body).messages[0].content,
    'カスタマイズした新聞記事用プロンプト',
  );
  const image = await ai.run(
    'image',
    { discussion: { headline: '地域をつなぐ' } },
    'user@example.test',
  );
  assert.equal(image.pngBase64, testPNG());
  const imageCall = JSON.parse(calls.find((c) => c.url.endsWith('/image_generation')).body);
  assert.equal(imageCall.model, 'gpt-image-2.5');
  assert.equal(imageCall.aspect_ratio, '16:9');
  assert.match(imageCall.query, /カスタマイズした企画シート/);
  assert.ok(calls.every((c) => new URL(c.url).hostname === 'www.genspark.ai'));
  assert.doesNotMatch(
    JSON.stringify(store.db.prepare('SELECT body FROM audit').all()),
    /fixture-secret-only/,
  );
});

test('Genspark公式API: 認証不可のキーは保存せず、別サービスへの自動送信をしない', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let sent = 0;
  const ai = new AI(store, { providers: [] }, async () => {
    sent++;
    return new Response('{}', { status: 401 });
  });
  await assert.rejects(() => ai.connect('gsk-invalid-fixture-key'), /401/);
  assert.equal(store.get('kv', 'genspark-credential'), undefined);
  assert.equal(sent, 1);
  await assert.rejects(() => ai.run('image', {}, 'user@example.test'));
  assert.equal(sent, 1);
});

test('Genspark録音: 公式アップロード→Genspark文字起こし、空のfull_textはsegmentsを読む', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const ai = new AI(store, { providers: [] }, async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, ...init });
    if (u.endsWith('/me')) return new Response('{}');
    if (u.endsWith('/file/upload_url'))
      return new Response(
        JSON.stringify({ heartbeat: 1 }) +
          '\n' +
          JSON.stringify({
            status: 'ok',
            data: {
              upload_url: 'https://fixture.blob.core.windows.net/recording?sig=fixture',
              file_wrapper_url: '/api/files/s/private-audio',
            },
          }),
      );
    if (u.startsWith('https://fixture.blob.core.windows.net/')) {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['X-Api-Key'], undefined);
      return new Response('');
    }
    if (u.endsWith('/audio_transcribe'))
      return new Response(
        JSON.stringify({
          status: 'ok',
          data: {
            transcriptions: [
              { full_text: '', segments: [{ text: '地域の課題を' }, { text: '話し合います。' }] },
            ],
          },
        }),
      );
    throw Error('Unexpected request');
  });
  await ai.connect('gsk-fixture-secret-only');
  const result = await ai.run(
    'transcribe',
    { audio: 'AA==', mimeType: 'audio/webm' },
    'fixture@example.test',
  );
  assert.equal(result.text, '地域の課題を話し合います。');
  assert.ok(
    calls
      .filter((c) => c.method !== 'PUT')
      .every((c) => new URL(c.url).hostname === 'www.genspark.ai'),
  );
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
  await ai.run('image', {}, 'u@example.test');
  assert.equal(sent.length, 2);
  assert.equal(JSON.parse(sent[1].body).model, 'gpt-image-2.5');
  assert.match(JSON.parse(sent[1].body).prompt, /企画提案シート/);
  const fail = new AI(store, { providers: [provider] }, async () => {
    sent.push('failure');
    throw Error('network');
  });
  await assert.rejects(() => fail.run('questions', {}, 'u@example.test'));
  assert.equal(sent.length, 3);
});
