import { randomBytes, randomInt } from 'node:crypto';
import { mailConfigured, mailTransport, mailFailure } from './mail.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { id, hash, normalizeEmail, checkPassword, passwordHash } from './store.js';
import { Fault, requireThat } from './domain.js';

// memory: true keeps the counter in process memory. Use it for frequent,
// low-risk calls (AI hints every few seconds) so each call is not a storage write.
export function rateLimit(store, key, limit, windowMs, { memory = false } = {}) {
  const now = Date.now();
  store.limits ||= new Map();
  const old = memory ? store.limits.get(key) : store.get('kv', `limit:${key}`);
  const value = old && old.until > now ? old : { count: 0, until: now + windowMs };
  requireThat(value.count++ < limit, 'しばらく待ってからお試しください', 429);
  if (memory) store.limits.set(key, value);
  else store.put('kv', `limit:${key}`, value);
}
// How long one OTP login is trusted on the same browser (and how long a session lasts).
export const TRUST_MS = 24 * 3600000;
export class Auth {
  constructor(store, config, sendOtp) {
    this.store = store;
    this.config = config;
    this.mailConfigured = !!sendOtp || mailConfigured(config.smtp);
    this.sendOtp =
      sendOtp ||
      (async (email, code) => {
        requireThat(
          mailConfigured(config.smtp),
          'メール配信が未設定です。管理者へご連絡ください',
          503,
        );
        const transport = mailTransport(config.smtp);
        await transport.sendMail({
          from: config.smtp.from,
          to: email,
          subject: 'アイディアワークショップ 認証コード',
          text: `認証コード: ${code}\n10分以内に入力してください。心当たりがない場合は破棄してください。`,
        });
      });
  }
  emailOtpReady() {
    return !this.config.demo && this.mailConfigured;
  }
  user(req) {
    const token = /(?:^|;\s*)wid_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!token) throw new Fault(401, 'ログインしてください');
    const session = this.store.db
      .prepare('SELECT * FROM sessions WHERE token=? AND expires>?')
      .get(hash(token), Date.now());
    requireThat(session, 'セッションが失効しました', 401);
    const user = this.store.get('users', session.email);
    requireThat(user && !user.disabled, 'アカウントが無効です', 401);
    return { ...user, session };
  }
  // A session lasts until `expires` (24 hours by default). With `trust`, the browser also
  // gets a cookie that lets the same email log in again without an OTP until then.
  session(email, res, { expires = Date.now() + TRUST_MS, trust = false } = {}) {
    const token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(24).toString('base64url'),
      secure = this.config.secure ? '; Secure' : '',
      maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    this.store.db
      .prepare('INSERT INTO sessions(token,email,expires,csrf) VALUES(?,?,?,?)')
      .run(hash(token), email, expires, csrf);
    const cookies = [`wid_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`];
    if (trust) {
      const pass = randomBytes(32).toString('base64url');
      this.store.put('challenges', hash(pass), { type: 'otp-trust', email, expires });
      cookies.push(`wid_trust=${pass}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
    }
    res.setHeader('Set-Cookie', cookies.length > 1 ? cookies : cookies[0]);
    this.store.audit('login', { user: hash(email), otp: trust });
    return { csrf };
  }
  // The OTP pass this browser holds for `email`, if it is still within its 24 hours.
  trusted(req, email) {
    const pass = /(?:^|;\s*)wid_trust=([^;]+)/.exec(req?.headers?.cookie || '')?.[1];
    const c = pass && this.store.get('challenges', hash(pass));
    return c?.type === 'otp-trust' && c.email === email && c.expires > Date.now() ? c : null;
  }
  async start(body, ip, req, res) {
    requireThat(
      !this.config.demo,
      '現在は体験モードです。OTPメールは送信しません。ログイン画面の「管理者」「編集者」「閲覧者」から参加してください。',
      503,
    );
    requireThat(
      this.emailOtpReady(),
      'OTPメールの送信設定がありません。管理者がメール送信元を設定してからご利用ください。',
      503,
    );
    const email = normalizeEmail(body.email);
    requireThat(
      email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      'メールアドレスを確認してください',
    );
    rateLimit(this.store, `otp-ip:${ip}`, 20, 600000);
    rateLimit(this.store, `otp:${email}`, 4, 600000);
    const user = this.store.get('users', email);
    const invitation =
      body.workshopId && this.store.get('workshops', body.workshopId)?.members[email];
    const allowed =
      user &&
      !user.disabled &&
      (!user.password ||
        invitation ||
        checkPassword(String(body.password || '').slice(0, 1024), user.password));
    // Within 24 hours of an OTP login on this browser, the same email logs in directly.
    const pass = allowed && res && this.trusted(req, email);
    if (pass) return { ...this.session(email, res, { expires: pass.expires }), trusted: true };
    const challenge = id();
    if (allowed) {
      const code = String(randomInt(100000, 1000000));
      this.store.put('challenges', challenge, {
        type: 'otp',
        email,
        digest: hash(`${challenge}:${code}`),
        expires: Date.now() + 600000,
        attempts: 0,
      });
      try {
        await this.sendOtp(email, code);
      } catch (e) {
        this.store.del('challenges', challenge);
        if (e instanceof Fault) throw e;
        throw new Fault(503, mailFailure(e, this.config.smtp));
      }
    }
    return { challenge, message: '登録と入力内容が有効であれば、認証コードを送信しました。' };
  }
  verify(body, res) {
    const c = this.store.get('challenges', body.challenge);
    requireThat(
      c?.type === 'otp' && c.expires > Date.now() && c.attempts < 5,
      '認証コードが無効または期限切れです',
      401,
    );
    c.attempts++;
    this.store.put('challenges', body.challenge, c);
    requireThat(
      c.digest === hash(`${body.challenge}:${String(body.code)}`),
      '認証コードを確認してください',
      401,
    );
    this.store.del('challenges', body.challenge);
    requireThat(!this.store.get('users', c.email)?.disabled, 'アカウントが無効です', 401);
    return this.session(c.email, res, { trust: true });
  }
  async options(kind, user, body, ip) {
    rateLimit(this.store, `passkey:${ip}`, 30, 600000);
    const email = kind === 'register' ? user.email : normalizeEmail(body.email);
    const account = this.store.get('users', email);
    requireThat(account && !account.disabled, 'パスキーを利用できません', 401);
    const options =
      kind === 'register'
        ? await generateRegistrationOptions({
            rpName: 'アイディアワークショップ支援ツール',
            rpID: this.config.rpId,
            userName: email,
            userID: new TextEncoder().encode(account.id),
            attestationType: 'none',
            excludeCredentials: (account.passkeys || []).map((p) => ({
              id: p.id,
              transports: p.transports,
            })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          })
        : await generateAuthenticationOptions({
            rpID: this.config.rpId,
            userVerification: 'required',
            allowCredentials: (account.passkeys || []).map((p) => ({
              id: p.id,
              transports: p.transports,
            })),
          });
    if (kind === 'login')
      requireThat(account.passkeys?.length, '登録済みのパスキーがありません', 401);
    const challengeId = id();
    this.store.put('challenges', challengeId, {
      type: kind,
      email,
      expected: options.challenge,
      session: user?.session?.token,
      expires: Date.now() + 300000,
    });
    return { options, challengeId };
  }
  async passkey(kind, user, body, res) {
    const c = this.store.get('challenges', body.challengeId);
    requireThat(
      c?.type === kind &&
        c.expires > Date.now() &&
        (kind !== 'register' || c.session === user.session.token),
      'パスキーチャレンジが無効です',
      401,
    );
    this.store.del('challenges', body.challengeId);
    const account = this.store.get('users', c.email);
    requireThat(account && !account.disabled, 'アカウントが無効です', 401);
    const common = {
      response: body.response,
      expectedChallenge: c.expected,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: true,
    };
    try {
      if (kind === 'register') {
        const result = await verifyRegistrationResponse(common);
        requireThat(result.verified, 'パスキーを検証できません', 401);
        const credential = result.registrationInfo.credential;
        const fresh = this.store.get('users', c.email);
        fresh.passkeys ||= [];
        requireThat(
          !this.store.all('users').some((u) => u.passkeys?.some((p) => p.id === credential.id)),
          'このパスキーは登録済みです',
        );
        fresh.passkeys.push({
          ...credential,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        });
        this.store.put('users', c.email, fresh);
        return { registered: true };
      }
      const stored = account.passkeys?.find((p) => p.id === body.response.id);
      requireThat(stored, 'パスキーがありません', 401);
      const result = await verifyAuthenticationResponse({
        ...common,
        credential: {
          ...stored,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        },
      });
      requireThat(result.verified, 'パスキーを検証できません', 401);
      const fresh = this.store.get('users', c.email);
      const current = fresh.passkeys.find((p) => p.id === stored.id);
      requireThat(
        current.counter === stored.counter,
        '同時認証が発生しました。再試行してください',
        409,
      );
      current.counter = result.authenticationInfo.newCounter;
      this.store.put('users', c.email, fresh);
      return this.session(c.email, res);
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault(401, 'パスキーを検証できませんでした');
    }
  }
  setPassword(user, body) {
    requireThat(
      typeof body.password === 'string' &&
        body.password.length >= 12 &&
        body.password.length <= 200,
      'パスワードは12〜200文字です',
    );
    const fresh = this.store.get('users', user.email);
    if (fresh.password)
      requireThat(
        checkPassword(String(body.currentPassword || '').slice(0, 1024), fresh.password),
        '現在のパスワードを確認してください',
        401,
      );
    else
      requireThat(
        user.session.expires - TRUST_MS > Date.now() - 15 * 60000,
        '新しいパスワードの設定前に、再ログインしてください',
        403,
      );
    fresh.password = passwordHash(body.password);
    this.store.put('users', user.email, fresh);
    this.store.db
      .prepare('DELETE FROM sessions WHERE email=? AND token<>?')
      .run(user.email, user.session.token);
    return { ok: true };
  }
}
