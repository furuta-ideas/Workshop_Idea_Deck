import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { Auth } from '../server/auth.js';
import { Store, id } from '../server/store.js';

// Test-only software authenticator. It never participates in a production login.
function cbor(value) {
  const head = (major, n) =>
    n < 24
      ? Buffer.from([major * 32 + n])
      : n < 256
        ? Buffer.from([major * 32 + 24, n])
        : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -value - 1);
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  throw Error('test CBOR type');
}
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const email = 'passkey@example.test';
  store.put('users', email, { id: id(), email, admin: false, passkeys: [] });
  const auth = new Auth(
    store,
    { rpId: 'localhost', origin: 'http://localhost:4317', secure: false, smtp: {} },
    async () => {},
  );
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    jwk = publicKey.export({ format: 'jwk' }),
    credId = randomBytes(32).toString('base64url');
  const cose = cbor(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
  const user = { email, session: { token: 'test-session' } },
    res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
    };
  const sha = (b) => createHash('sha256').update(b).digest();
  const registration = (options) => {
    const counter = Buffer.alloc(4),
      length = Buffer.alloc(2);
    length.writeUInt16BE(32);
    const authData = Buffer.concat([
      sha('localhost'),
      Buffer.from([0x45]),
      counter,
      Buffer.alloc(16),
      length,
      Buffer.from(credId, 'base64url'),
      cose,
    ]);
    const client = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        origin: 'http://localhost:4317',
        challenge: options.challenge,
      }),
    );
    return {
      id: credId,
      rawId: credId,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        attestationObject: cbor(
          new Map([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
          ]),
        ).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  };
  const assertion = (
    options,
    { origin = 'http://localhost:4317', uv = true, count = 1, corrupt = false } = {},
  ) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    const data = Buffer.concat([sha('localhost'), Buffer.from([uv ? 0x05 : 0x01]), counter]);
    const client = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', origin, challenge: options.challenge }),
      ),
      signature = sign('sha256', Buffer.concat([data, sha(client)]), privateKey);
    if (corrupt) signature[signature.length - 1] ^= 1;
    return {
      id: credId,
      rawId: credId,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        authenticatorData: data.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
    };
  };
  return { store, auth, email, user, res, registration, assertion };
}
test('WebAuthn: 登録の検証と保存→実署名の検証→カウンター更新と再送拒否', async (t) => {
  const f = fixture(t);
  const reg = await f.auth.options('register', f.user, {}, 'test');
  assert.equal(
    (
      await f.auth.passkey(
        'register',
        f.user,
        { challengeId: reg.challengeId, response: f.registration(reg.options) },
        f.res,
      )
    ).registered,
    true,
  );
  assert.equal(f.store.get('users', f.email).passkeys.length, 1);
  const login = await f.auth.options('login', null, { email: f.email }, 'test');
  const body = { challengeId: login.challengeId, response: f.assertion(login.options) };
  assert.ok((await f.auth.passkey('login', null, body, f.res)).csrf);
  assert.equal(f.store.get('users', f.email).passkeys[0].counter, 1);
  assert.match(f.res.headers['Set-Cookie'], /wid_session/);
  await assert.rejects(
    () => f.auth.passkey('login', null, body, f.res),
    (e) => e.status === 401,
  );
});
test('WebAuthn: Origin・ユーザー検証・署名の不正は拒否', async (t) => {
  const f = fixture(t),
    reg = await f.auth.options('register', f.user, {}, 'test');
  await f.auth.passkey(
    'register',
    f.user,
    { challengeId: reg.challengeId, response: f.registration(reg.options) },
    f.res,
  );
  for (const params of [{ origin: 'https://attacker.example' }, { uv: false }, { corrupt: true }]) {
    const o = await f.auth.options('login', null, { email: f.email }, 'test');
    await assert.rejects(
      () =>
        f.auth.passkey(
          'login',
          null,
          { challengeId: o.challengeId, response: f.assertion(o.options, params) },
          f.res,
        ),
      (e) => e.status === 401,
    );
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('OTP: 体験モードでは登録済みでも送信・チャレンジ発行を行わない', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.put('users', 'admin@example.test', { id: id(), email: 'admin@example.test' });
  let sent = 0;
  const auth = new Auth(store, { demo: true, smtp: {} }, async () => {
    sent++;
  });
  assert.equal(auth.emailOtpReady(), false);
  await assert.rejects(
    () => auth.start({ email: 'admin@example.test' }, 'test'),
    (e) => e.status === 503 && e.message.includes('体験モード'),
  );
  assert.equal(sent, 0);
  assert.equal(store.all('challenges').length, 0);
});

test('OTP: SMTP未設定は未知メールでも未設定と通知し、送信済みの案内に進まない', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store, { demo: false, smtp: {} });
  assert.equal(auth.emailOtpReady(), false);
  await assert.rejects(
    () => auth.start({ email: 'unknown@example.test' }, 'test'),
    (e) => e.status === 503 && e.message.includes('送信設定がありません'),
  );
  assert.equal(store.all('challenges').length, 0);
});
