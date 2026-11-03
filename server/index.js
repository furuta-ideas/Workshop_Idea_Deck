import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { Store, id, hash, normalizeEmail, passwordHash, newWorkshop } from './store.js';
import { Auth, rateLimit } from './auth.js';
import { AI } from './ai.js';
import { Notion } from './notion.js';
import { validatePNG } from './png.js';
import {
  Fault,
  requireThat,
  text,
  access,
  view,
  mutate,
  createWorkshop,
  updateMeta,
  teamFor,
  markdown,
  expire,
} from './domain.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function configuration(env = process.env) {
  const config = {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4317),
    origin: env.APP_ORIGIN || 'http://localhost:4317',
    rpId: env.RP_ID || 'localhost',
    secure: env.SECURE_COOKIE === 'true',
    dataDir: resolve(env.DATA_DIR || join(root, 'data')),
    demo: false,
    adminEmail: normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL),
    adminPassword: env.BOOTSTRAP_ADMIN_PASSWORD,
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM,
    },
    notionToken: env.NOTION_TOKEN,
    notionSource: env.NOTION_WORKSHOPS_SOURCE,
    pollSeconds: Math.max(15, Number(env.NOTION_POLL_SECONDS || 30)),
    providers: JSON.parse(env.AI_APPROVED_PROVIDERS || '[]'),
  };
  const origin = new URL(config.origin);
  requireThat(['http:', 'https:'].includes(origin.protocol), 'APP_ORIGINの形式が不正です');
  requireThat(origin.origin === config.origin, 'APP_ORIGINは末尾スラッシュなしのオリジンです');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    requireThat(
      origin.protocol === 'https:' && config.secure,
      '外部公開にはHTTPSとSECURE_COOKIE=trueが必要です',
    );
  return config;
}
export function createApp(config = configuration(), overrides = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const store = overrides.store || new Store(join(config.dataDir, 'workshop.sqlite'));
  const auth = new Auth(store, config, overrides.sendOtp),
    ai = new AI(store, config, overrides.aiTransport),
    notion = new Notion(store, config, overrides.notionTransport);
  if (config.adminEmail && !store.get('users', config.adminEmail))
    store.put('users', config.adminEmail, {
      id: id(),
      email: config.adminEmail,
      admin: true,
      passkeys: [],
      ...(config.adminPassword ? { password: passwordHash(config.adminPassword) } : {}),
    });
  let remoteWrite = false;
  const available = () =>
    requireThat(
      !notion.running && !remoteWrite,
      'Notionと同期しています。少し待って再操作してください',
      409,
    );
  const remote = async (fn) => {
    available();
    remoteWrite = true;
    try {
      return await fn();
    } finally {
      remoteWrite = false;
    }
  };
  const userFor = (req) => {
    const user = auth.user(req);
    user.admin =
      !!user.admin ||
      store
        .all('workshops')
        .some(
          (w) =>
            !w.deleted &&
            w.members[user.email]?.role === '管理者' &&
            (!w.notion || (!w.notion.error && Date.now() - w.notion.checkedAt < 60000)),
        );
    return user;
  };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const read = async (req) => {
    let n = 0,
      parts = [];
    for await (const b of req) {
      n += b.length;
      requireThat(n < 12 * 1024 * 1024, '入力が大きすぎます', 413);
      parts.push(b);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString() || '{}');
    } catch {
      throw new Fault(400, 'JSON形式が不正です');
    }
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    try {
      const url = new URL(req.url, config.origin),
        path = url.pathname;
      if (!path.startsWith('/api/')) {
        requireThat(req.method === 'GET', '未対応のメソッドです', 405);
        const assets = {
          '/': 'public/index.html',
          '/app.js': 'public/app.js',
          '/style.css': 'public/style.css',
          '/WorkShop_Top.png': 'public/WorkShop_Top.png',
          '/webauthn.js': 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',
        };
        const file = assets[path];
        requireThat(file && existsSync(join(root, file)), 'ファイルがありません', 404);
        res.setHeader(
          'Content-Type',
          file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : file.endsWith('.png')
                ? 'image/png'
                : 'text/javascript; charset=utf-8',
        );
        res.end(readFileSync(join(root, file)));
        return;
      }
      requireThat(
        !req.headers.origin || req.headers.origin === config.origin,
        'オリジンが一致しません',
        403,
      );
      const write = req.method !== 'GET';
      const body = write ? await read(req) : {};
      const ip = req.socket.remoteAddress || 'unknown';
      if (path === '/api/health') {
        json(res, {
          ok: true,
          name: 'アイディアワークショップ支援ツール',
          demo: config.demo,
          auth: { emailOtpReady: auth.emailOtpReady() },
        });
        return;
      }
      if (path === '/api/auth/start' && req.method === 'POST') {
        rateLimit(store, `login-start:${ip}`, 20, 600000);
        if (notion.enabled() && !remoteWrite) {
          // Verify mailbox ownership even during a Notion outage. Workshop access
          // still requires fresh membership data and fails closed in access().
          try {
            await notion.sync();
          } catch {
            /* Persisted sync state is shown after login. */
          }
        }
        json(res, await auth.start(body, ip));
        return;
      }
      if (path === '/api/auth/verify' && req.method === 'POST') {
        rateLimit(store, `verify:${ip}`, 40, 600000);
        json(res, auth.verify(body, res));
        return;
      }
      if (path === '/api/auth/passkey/options' && req.method === 'POST') {
        json(res, await auth.options('login', null, body, ip));
        return;
      }
      if (path === '/api/auth/passkey/verify' && req.method === 'POST') {
        json(res, await auth.passkey('login', null, body, res));
        return;
      }
      if (path === '/api/demo' && req.method === 'POST') {
        requireThat(
          config.demo && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip),
          'この機能は利用できません',
          404,
        );
        requireThat(
          [
            'admin@example.test',
            'editor@example.test',
            'viewer@example.test',
            'other@example.test',
          ].includes(body.email),
          '体験ユーザーがありません',
        );
        json(res, auth.session(body.email, res));
        return;
      }
      const user = userFor(req);
      if (write)
        requireThat(
          req.headers['x-csrf-token'] === user.session.csrf,
          'セッションを再読込してください',
          403,
        );
      if (path === '/api/me') {
        json(res, {
          email: user.email,
          admin: user.admin,
          csrf: user.session.csrf,
          demo: config.demo,
          auth: { emailOtpReady: auth.emailOtpReady() },
          ai: ai.publicSettings(),
          notion: user.admin ? notion.status() : notion.connectionState(),
        });
        return;
      }
      if (path === '/api/logout' && req.method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE token=?').run(user.session.token);
        res.setHeader('Set-Cookie', 'wid_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        json(res, { ok: true });
        return;
      }
      if (path === '/api/password' && req.method === 'POST') {
        rateLimit(store, `password:${user.email}`, 10, 600000);
        json(res, auth.setPassword(user, body));
        return;
      }
      if (path === '/api/auth/register/options' && req.method === 'POST') {
        json(res, await auth.options('register', user, body, ip));
        return;
      }
      if (path === '/api/auth/register/verify' && req.method === 'POST') {
        json(res, await auth.passkey('register', user, body, res));
        return;
      }
      if (path === '/api/ai/settings' && req.method === 'POST') {
        requireThat(user.admin, '管理者のみ操作できます', 403);
        json(res, ai.save(body));
        return;
      }
      if (path === '/api/notion/sync' && req.method === 'POST') {
        requireThat(user.admin, '管理者のみ操作できます', 403);
        available();
        json(res, await notion.sync());
        return;
      }
      if (path === '/api/workshops') {
        if (req.method === 'POST') {
          available();
          json(res, view(createWorkshop(store, user, body), user), 201);
          return;
        }
        requireThat(req.method === 'GET', '未対応のメソッドです', 405);
        const workshops = [];
        for (const ws of store.all('workshops')) {
          try {
            access(store, ws, user);
            if (!ws.deleted || user.admin)
              workshops.push({
                id: ws.id,
                name: ws.name,
                status: ws.status,
                endDate: ws.endDate,
                role: user.admin ? '管理者' : ws.members[user.email]?.role,
                deleted: ws.deleted,
              });
          } catch (e) {
            if (![403, 503].includes(e.status)) throw e;
          }
        }
        json(res, workshops);
        return;
      }
      const match = /^\/api\/workshops\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      requireThat(match, 'APIがありません', 404);
      const [, wsId, route] = match;
      let ws = store.get('workshops', wsId);
      access(store, ws, user);
      if (!route && req.method === 'GET') {
        json(res, view(ws, user));
        return;
      }
      if (route === 'action' && req.method === 'POST') {
        available();
        json(res, view(mutate(store, user, wsId, body), user));
        return;
      }
      if (route === 'meta' && req.method === 'POST') {
        available();
        json(res, view(updateMeta(store, user, wsId, body), user));
        return;
      }
      if (route === 'members' && req.method === 'POST') {
        available();
        requireThat(user.admin, '管理者のみ操作できます', 403);
        requireThat(!ws.deleted, '削除済みです');
        const email = normalizeEmail(body.email);
        requireThat(
          email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
          'メールアドレスを確認してください',
        );
        requireThat(['管理者', '編集者', '閲覧者'].includes(body.role), '権限が不正です');
        requireThat(!body.teamId || ws.teams[body.teamId], 'チームがありません');
        if (body.password) {
          requireThat(!ws.notion, 'Notion参加者のパスワードは別途管理します');
          requireThat(
            typeof body.password === 'string' &&
              body.password.length >= 12 &&
              body.password.length <= 200,
            'パスワードは12〜200文字です',
          );
        }
        const member = { role: body.role, teamId: body.teamId || null };
        if (ws.notion) await remote(() => notion.setMember(ws, email, member));
        else {
          ws.members[email] = member;
          ws.revision++;
          store.put('workshops', ws.id, ws);
        }
        const account = store.get('users', email) || {
          id: id(),
          email,
          admin: false,
          passkeys: [],
        };
        if (body.password) account.password = passwordHash(body.password);
        store.put('users', email, account);
        json(res, view(store.get('workshops', wsId), user));
        return;
      }
      if (route === 'qr' && req.method === 'GET') {
        requireThat(user.admin, '管理者のみ操作できます', 403);
        res.setHeader('Content-Type', 'image/png');
        res.end(await QRCode.toBuffer(`${config.origin}/?workshop=${encodeURIComponent(ws.id)}`));
        return;
      }
      if (route === 'publish' && req.method === 'POST') {
        requireThat(user.admin, '管理者のみ操作できます', 403);
        requireThat(!ws.notion, '接続済みです');
        json(res, view(await remote(() => notion.publishNew(ws)), user));
        return;
      }
      if (route === 'resolve' && req.method === 'POST') {
        requireThat(user.admin, '管理者のみ操作できます', 403);
        json(res, await remote(() => notion.resolve(wsId, body.choice)));
        return;
      }
      if (route === 'results' && req.method === 'POST') {
        requireThat(
          user.admin && ws.status === '完了（変更不可）',
          '完了後に管理者が保存できます',
          403,
        );
        json(res, await remote(() => notion.saveResults(ws)));
        return;
      }
      if (route === 'export' && req.method === 'GET') {
        requireThat(
          user.admin && ws.status === '完了（変更不可）',
          '完了後に管理者がエクスポートできます',
          403,
        );
        const team = teamFor(ws, user, url.searchParams.get('team'));
        const image = url.searchParams.get('format') === 'png';
        if (image) requireThat(team.image, '画像がありません', 404);
        res.setHeader('Content-Type', image ? 'image/png' : 'text/markdown; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${ws.id}-${team.id}.${image ? 'png' : 'md'}"`,
        );
        res.end(image ? Buffer.from(team.image.base64, 'base64') : markdown(ws, team));
        return;
      }
      if (route === 'ai' && req.method === 'POST') {
        available();
        access(store, ws, user, true);
        const team = teamFor(ws, user, body.teamId);
        rateLimit(store, `ai:${user.email}`, 30, 600000);
        const revision = ws.revision;
        let input = {
          theme: ws.theme,
          nodes: team.nodes,
          deck: team.deck,
          discussion: team.discussion,
        };
        if (body.task === 'transcribe') {
          requireThat(
            ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/webm;codecs=opus'].includes(
              body.mimeType,
            ) &&
              typeof body.audio === 'string' &&
              body.audio.length < 8 * 1024 * 1024 &&
              ['map', 'discussion'].includes(body.destination),
            '録音形式またはサイズを確認してください',
          );
          input = { audio: body.audio, mimeType: body.mimeType };
        }
        const result = await ai.run(body.task, input, user.email);
        ws = store.get('workshops', wsId);
        access(store, ws, user, true);
        teamFor(ws, user, body.teamId);
        requireThat(ws.revision === revision, 'AI処理中に更新されました。再実行してください', 409);
        const proposal = id();
        store.put('challenges', proposal, {
          type: 'ai',
          email: user.email,
          wsId,
          teamId: body.teamId,
          revision,
          task: body.task,
          destination: body.destination,
          result,
          expires: Date.now() + 600000,
        });
        json(res, { proposal, task: body.task, result });
        return;
      }
      if (route === 'apply' && req.method === 'POST') {
        available();
        access(store, ws, user, true);
        const p = store.get('challenges', body.proposal);
        requireThat(
          p?.type === 'ai' && p.email === user.email && p.wsId === wsId && p.expires > Date.now(),
          '提案が無効または期限切れです',
        );
        requireThat(ws.revision === p.revision, '別の更新があるため再実行してください', 409);
        const team = teamFor(ws, user, p.teamId),
          r = p.result;
        if (p.task === 'image') {
          team.image = validatePNG(r.pngBase64);
          for (const ballot of Object.values(ws.votes.ideas)) delete ballot[team.id];
        } else if (p.task === 'transcribe') {
          if (p.destination === 'map') {
            requireThat(team.nodes.length < 500, '項目は500件以内です');
            const words = text(r.text, 500);
            requireThat(words, '文字起こしが空でした');
            team.nodes.push({ id: id(), text: words, parent: null, group: 0 });
          } else
            team.discussion.transcript = text(
              `${team.discussion.transcript}\n${text(r.text, 30000)}`,
              30000,
            );
        } else if (p.task === 'summarize') {
          for (const [key, max] of Object.entries({
            what: 40,
            who: 40,
            how: 120,
            points: 5000,
            keywords: 500,
          }))
            if (r[key] !== undefined) team.discussion[key] = text(r[key], max);
        } else if (p.task === 'keywords') team.discussion.keywords = text(r.keywords, 500);
        else if (p.task === 'classify') {
          requireThat(Array.isArray(r.groups) && r.groups.length <= 8, '分類形式が不正です', 502);
          const seen = new Set();
          for (const [i, g] of r.groups.entries()) {
            requireThat(Array.isArray(g.nodeIds), '分類形式が不正です', 502);
            for (const nodeId of g.nodeIds) {
              requireThat(!seen.has(nodeId), '分類が重複しています', 502);
              seen.add(nodeId);
              const node = team.nodes.find((n) => n.id === nodeId);
              requireThat(node, '分類項目が不正です', 502);
              node.group = i;
            }
          }
        } else throw new Fault(400, '質問は画面で参照し、回答を項目へ追加してください');
        ws.revision++;
        store.put('workshops', ws.id, ws);
        store.del('challenges', body.proposal);
        json(res, view(ws, user));
        return;
      }
      throw new Fault(404, 'APIがありません');
    } catch (e) {
      if (!res.headersSent)
        json(
          res,
          {
            error:
              e instanceof Fault ? e.message : '処理に失敗しました。サーバー設定を確認してください',
          },
          e.status || 500,
        );
      else res.end();
      if (!(e instanceof Fault)) console.error(e.name, e.message);
    }
  });
  let interval;
  const maintenance = () => {
    if (notion.running || remoteWrite) return;
    for (const ws of store.all('workshops')) expire(store, ws);
    if (notion.enabled()) notion.sync().catch((e) => console.error('Notion:', e.message));
    const now = Date.now();
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    store.db.prepare("DELETE FROM challenges WHERE json_extract(body,'$.expires') < ?").run(now);
    store.db
      .prepare("DELETE FROM requests WHERE json_extract(body,'$.at') < ?")
      .run(now - 86400000);
    store.db
      .prepare("DELETE FROM kv WHERE id LIKE 'limit:%' AND json_extract(body,'$.until') < ?")
      .run(now);
  };
  return {
    server,
    store,
    auth,
    ai,
    notion,
    start: async () => {
      await new Promise((r) => server.listen(config.port, config.host, r));
      maintenance();
      interval = setInterval(maintenance, config.pollSeconds * 1000);
      interval.unref();
      return server.address();
    },
    close: async () => {
      clearInterval(interval);
      await new Promise((r) => server.close(r));
      await notion.running;
      store.close();
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration();
  const app = createApp(config);
  await app.start();
  console.log(`アイディアワークショップ支援ツール: ${config.origin}`);
}
