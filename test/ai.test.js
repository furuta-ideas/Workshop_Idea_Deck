import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { AI, tasks } from '../server/ai.js';
import { pickTextModel } from '../server/genspark.js';
import { testPNG } from '../test-support/fixtures.js';
import { extractTranscript } from '../server/audio.js';
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
  assert.equal(imageCall.model, 'gpt-image-2');
  assert.equal(imageCall.aspect_ratio, '16:9');
  // The default is the affordable standard setting: 1K, no premium tier.
  assert.equal(imageCall.image_size, '1k');
  assert.equal('tier' in imageCall, false);
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
  const ai = new AI(store, { providers: [] }, async (url) => {
    // The WAF token-pass bootstrap goes to Genspark only and is not a data send.
    if (String(url).includes('/api/native-waf/token-pass')) {
      assert.equal(new URL(String(url)).hostname, 'www.genspark.ai');
      return new Response('{}', { status: 404 });
    }
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
            transcriptions: [],
          },
          session_state: {
            audio_transcribe_result: {
              full_text: '',
              segments: [],
              result: JSON.stringify({ transcription: '地域の課題を話し合います。' }),
            },
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

test('認識結果: 空segments・JSON文字列・別名・エラーを区別し、認識文だけ取り出す', () => {
  assert.equal(
    extractTranscript({ segments: [], data: { fullText: 'テスト音声のテストです。' } }),
    'テスト音声のテストです。',
  );
  assert.equal(
    extractTranscript({ result: '{"transcript":"文字は入力されますか。"}' }),
    '文字は入力されますか。',
  );
  assert.equal(extractTranscript({ status: 'error', text: '認識できません' }), '');
  assert.equal(extractTranscript({ message: '完了', segments: [] }), '');
  assert.equal(
    extractTranscript({ segments: [{ text: 'こんにちは。' }, { text: 'テストです。' }] }),
    'こんにちは。テストです。',
  );
});

test('Gensparkブラウザー認証: 所有者・期限・ポーリング制限を守り、キーを返さず登録', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const ai = new AI(store, { providers: [] }, async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (String(url).endsWith('device_code'))
      return new Response(
        JSON.stringify({
          device_code: 'private-device-code',
          auth_url: 'https://www.genspark.ai/auth?code=fixture',
          poll_interval: 2,
          expires_in: 300,
        }),
      );
    if (String(url).includes('/token?'))
      return new Response(
        JSON.stringify({ status: 'approved', api_key: 'gsk_fixture_secret_only' }),
      );
    if (String(url).endsWith('/me')) return new Response('{}');
    throw Error('Unexpected URL');
  });
  const login = await ai.beginLogin('admin@example.test');
  assert.doesNotMatch(JSON.stringify(login), /private-device-code|gsk_fixture_secret/);
  await assert.rejects(() => ai.finishLogin(login.requestId, 'other@example.test'));
  assert.equal((await ai.finishLogin(login.requestId, 'admin@example.test')).status, 'pending');
  const c = store.get('challenges', login.requestId);
  c.nextPoll = 0;
  store.put('challenges', login.requestId, c);
  const result = await ai.finishLogin(login.requestId, 'admin@example.test');
  assert.equal(result.status, 'connected');
  assert.equal(result.ai.provider, 'genspark-gsk');
  assert.doesNotMatch(JSON.stringify(result), /gsk_fixture_secret/);
  assert.equal(store.get('challenges', login.requestId), undefined);
  assert.equal(store.get('kv', 'genspark-credential').key, 'gsk_fixture_secret_only');
  assert.ok(calls.every((c) => new URL(c.url).hostname === 'www.genspark.ai'));
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
  assert.equal(JSON.parse(sent[1].body).model, 'gpt-image-2');
  assert.match(JSON.parse(sent[1].body).prompt, /企画提案シート/);
  const fail = new AI(store, { providers: [provider] }, async () => {
    sent.push('failure');
    throw Error('network');
  });
  await assert.rejects(() => fail.run('questions', {}, 'u@example.test'));
  assert.equal(sent.length, 3);
});

// A Genspark fixture for image generation: token pass, live tool schema, and the image.
function imageFixture(t, { models = ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6'], bytes } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const pass = '1767225600-' + 'a'.repeat(43);
  const ai = new AI(store, { providers: [] }, async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, ...init });
    if (u.includes('/native-waf/token-pass'))
      return new Response(JSON.stringify({ data: { token: pass, family: 'tool' } }));
    if (u.endsWith('/me')) return new Response('{}');
    if (u.endsWith('/tool_cli/tools'))
      return new Response(
        JSON.stringify({
          tools: [
            {
              name: 'image_generation',
              parameters: {
                properties: {
                  model: { enum: models },
                  tier: { enum: ['flare', 'sunburst'] },
                  image_size: { enum: ['auto', '1k', '2k'] },
                },
              },
            },
          ],
        }),
      );
    if (u.endsWith('/image_generation'))
      return new Response(
        JSON.stringify({
          version: 1,
          status: 'ok',
          data: { generated_images: [{ image_urls: ['https://www.genspark.ai/api/files/s/x'] }] },
        }),
      );
    if (u.endsWith('/api/files/s/x'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://gensparkpublicblob.blob.core.windows.net/x.img' },
      });
    if (u.endsWith('/x.img')) return new Response(bytes || Buffer.from(testPNG(), 'base64'));
    throw Error('Unexpected request ' + u);
  });
  return { store, ai, calls, pass };
}

test('Genspark画像: WAF通行証を付け、設定した画像モデル（2.6）で生成し、転送先の画像も取得する', async (t) => {
  const f = imageFixture(t);
  await f.ai.connect('gsk-fixture-secret-only');
  f.ai.save({ provider: 'genspark-gsk', model: '', imageModel: 'gpt-image-2.6' });
  assert.equal(f.ai.settings().imageModel, 'gpt-image-2.6');
  const image = await f.ai.run('image', { discussion: {} }, 'user@example.test');
  assert.equal(image.pngBase64, testPNG());
  const call = f.calls.find((c) => c.url.endsWith('/image_generation'));
  assert.equal(JSON.parse(call.body).model, 'gpt-image-2.6');
  assert.equal(JSON.parse(call.body).tier, 'flare');
  assert.equal(call.headers['X-Genspark-Token-Pass'], f.pass);
  assert.deepEqual((await f.ai.imageModels()).usable, true);
});

test('Genspark画像: 使えないモデルは送信前に止め、使えるGPT画像モデルを示す', async (t) => {
  const f = imageFixture(t, { models: ['gpt-image-2', 'gpt-image-2.5', 'nano-banana-2.1'] });
  await f.ai.connect('gsk-fixture-secret-only');
  f.ai.save({ provider: 'genspark-gsk', imageModel: 'gpt-image-2.6' });
  await assert.rejects(
    () => f.ai.run('image', {}, 'user@example.test'),
    (e) => e.status === 400 && /gpt-image-2.6/.test(e.message) && /gpt-image-2.5/.test(e.message),
  );
  assert.equal(f.calls.some((c) => c.url.endsWith('/image_generation')), false);
  assert.equal((await f.ai.imageModels()).usable, false);
});

test('AI設定: 文章モデル欄に書いた画像モデル名は画像モデルとして扱う', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.put('kv', 'ai', { provider: 'genspark-gsk', model: 'gpt-image-2.6' });
  const ai = new AI(store, { providers: [] }, async () => new Response('{}'));
  // Stored settings move once to the low-cost defaults.
  assert.equal(ai.settings().model, '');
  assert.equal(ai.settings().imageModel, 'gpt-image-2');
  ai.save({ provider: 'genspark-gsk', model: 'gpt-image-2.5' });
  assert.equal(ai.settings().imageModel, 'gpt-image-2.5');
  assert.equal(ai.settings().model, '');
  assert.throws(() => ai.save({ provider: 'genspark-gsk', imageModel: 'bad model!' }));
});

test('Genspark画像: JPEGが返ったらPNGに変換するまで保存しない形で返す', async (t) => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const f = imageFixture(t, { bytes: jpeg });
  await f.ai.connect('gsk-fixture-secret-only');
  f.ai.save({ provider: 'genspark-gsk' });
  const image = await f.ai.run('image', {}, 'user@example.test');
  assert.equal(image.mime, 'image/jpeg');
  assert.equal(image.pngBase64, undefined);
  assert.equal(image.imageBase64, jpeg.toString('base64'));
});

test('Genspark残クレジット: /meの残高を読み、処理前後の差を処理ごとの消費量として記録する', async (t) => {
  const { creditBalance } = await import('../server/ai.js');
  assert.equal(creditBalance({ data: { plan: 'plus', credit_balance: 1200, credit_card: 'x' } }), 1200);
  assert.equal(creditBalance({ data: { remaining_credits: '850.5' } }), 850.5);
  assert.equal(creditBalance({ data: { email: 'a@example.test' } }), null);
  const { creditTotal } = await import('../server/ai.js');
  assert.equal(creditTotal({ data: { credit_balance: 300, monthly_credits: 10000 } }), 10000);
  assert.equal(creditTotal({ data: { credit_balance: 300 } }), null);
  const f = imageFixture(t);
  let balance = 1000;
  const transport = f.ai.transport;
  f.ai.transport = f.ai.genspark.transport = async (url, init) => {
    if (String(url).endsWith('/tool_cli/me'))
      return new Response(JSON.stringify({ status: 'ok', data: { credit_balance: balance } }));
    if (String(url).endsWith('/image_generation')) balance -= 40;
    return transport(url, init);
  };
  await f.ai.connect('gsk-fixture-secret-only');
  f.ai.save({ provider: 'genspark-gsk' });
  await f.ai.run('image', {}, 'user@example.test');
  const status = f.ai.creditStatus();
  assert.equal(status.balance, 960);
  // No allowance reported: the month's highest balance (1000) is "full".
  assert.equal(status.total, 1000);
  assert.deepEqual(
    { count: status.usage.image.count, last: status.usage.image.last },
    { count: 1, last: 40 },
  );
});

test('Genspark接続: 保存済みキーがあれば未設定のEnterprise選択でもGensparkを使い、WAFの403は一度だけ通行証を取り直す', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  let refused = 1;
  const ai = new AI(store, { providers: [] }, async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('native-waf'))
      return new Response(JSON.stringify({ data: { family: 'tool', token: '1700000000-' + 'a'.repeat(43) } }));
    if (u.endsWith('/me') && refused-- > 0) return new Response('<html>Sorry, you have been blocked</html>', { status: 403 });
    if (u.endsWith('/me')) return new Response(JSON.stringify({ email: 'fixture@example.test' }));
    if (u.endsWith('/tools')) return new Response(JSON.stringify({ tools: [{ name: 'a' }, { name: 'b' }] }));
    return new Response('{}', { status: 404 });
  });
  store.put('kv', 'genspark-credential', { key: 'gsk-' + 'x'.repeat(30) });
  store.put('kv', 'ai', { provider: 'genspark-enterprise', model: '' });
  assert.equal(ai.settings().provider, 'genspark-gsk');
  assert.equal(ai.publicSettings().approved.find((p) => p.id === 'genspark-gsk').ready, true);
  await ai.genspark.verify(ai.gskKey());
  assert.equal(calls.filter((u) => u.endsWith('/me')).length, 2);
  assert.equal(calls.filter((u) => u.includes('native-waf')).length, 2);
  const d = await ai.diagnose();
  assert.equal(d.ok, true);
  assert.equal(d.keyType, 'gsk-');
  assert.deepEqual(d.steps.map((s) => s.name), ['WAF通行証', 'アカウント確認（me）', 'ツール一覧（tools）']);
  assert.equal(d.toolCount, 2);
  assert.ok(!JSON.stringify(d).includes('x'.repeat(30)));
});

test('Genspark接続: 通信エラーは原因を添えて表示し、最後のAIエラーとして管理画面に残す', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ai = new AI(store, { providers: [] }, async (url) => {
    if (String(url).includes('native-waf')) return new Response('{}', { status: 404 });
    throw new TypeError('fetch failed');
  });
  store.put('kv', 'genspark-credential', { key: 'gsk_' + 'y'.repeat(30) });
  await assert.rejects(() => ai.run('questions', { theme: 'テスト' }, 'user@example.test'), /fetch failed/);
  assert.match(ai.publicSettings().lastError.message, /fetch failed/);
  assert.equal(ai.publicSettings().lastError.task, 'questions');
});

test('文章モデル未指定: 無料→最安→軽量モデルの順に選び、Gensparkの既定は最後', () => {
  assert.equal(pickTextModel({ 'big-pro': { cost: { input: 5, output: 15 } }, 'small': { cost: { input: 0, output: 0 } } }, 'big-pro'), 'small');
  assert.equal(pickTextModel({ 'a': { cost: { input: 3, output: 9 } }, 'b': { cost: { input: 1, output: 2 } } }, 'a'), 'b');
  assert.equal(pickTextModel({ 'claude-opus': {}, 'claude-haiku-4-5': {} }, 'claude-opus'), 'claude-haiku-4-5');
  assert.equal(pickTextModel({ 'model-x': {} }, 'model-x'), 'model-x');
});
test('AI設定: 移行後に管理者が選んだモデルは次の読込みでも保持する', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.put('kv', 'ai', { provider: 'genspark-gsk', model: 'old', imageModel: 'gpt-image-2.5' });
  const ai = new AI(store, { providers: [] }, async () => new Response('{}'));
  assert.equal(ai.settings().imageModel, 'gpt-image-2');
  ai.save({ provider: 'genspark-gsk', model: 'chosen-model', imageModel: 'gpt-image-2.5' });
  assert.equal(ai.settings().imageModel, 'gpt-image-2.5');
  assert.equal(ai.settings().model, 'chosen-model');
});
