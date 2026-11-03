import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { timingSafeEqual } from 'node:crypto';
import { configuration, createApp } from '../server/index.js';
import { Store, hash } from '../server/store.js';
import { DurableDatabase } from './database.js';
import defaultDocument from '../config/ai-facilitator.md';
import { mailTransport } from '../server/mail.js';
import { scheduleAlarm } from './scheduling.js';

const assetPaths = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/build-info.js',
  '/style.css',
  '/WorkShop_Top.png',
  '/webauthn.js',
  '/fonts/BIZUDPGothic-Regular.ttf',
  '/fonts/BIZUDPGothic-Bold.ttf',
]);

export class WorkshopState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(':durable:', new DurableDatabase(ctx.storage));
    const config = configuration({
      ...env,
      HOST: '127.0.0.1',
      PORT: '8080',
      DATA_DIR: '/tmp/workshop',
      SECURE_COOKIE: 'true',
    });
    config.facilitatorDocument = defaultDocument;
    config.clientIpHeader = 'x-workshop-client-ip';
    this.app = createApp(config, { store: this.store });
    this.app.notion.content.recoverScheduled();
    this.http = httpServerHandler(this.app.server);
    this.env = env;
  }
  async nextAlarm() {
    const status = this.store.get('kv', 'cloud-maintenance') || { at: 0 };
    let next = status.at + this.app.notion.config.pollSeconds * 1000;
    for (const ws of this.store.all('workshops'))
      if (ws.documentSync?.queued && !ws.documentSync.error)
        next = Math.min(next, ws.documentSync.dueAt);
    await scheduleAlarm(this.ctx.storage, next);
  }
  async alarm() {
    if (this.env.MIGRATION_TOKEN) return;
    const tasks = [];
    const job = this.app.flushPending();
    if (job) tasks.push(job);
    const previous = this.store.get('kv', 'cloud-maintenance') || { at: 0 };
    if (Date.now() - previous.at >= this.app.notion.config.pollSeconds * 1000)
      tasks.push(
        Promise.resolve(this.app.maintain()).then(() => {
          this.store.put('kv', 'cloud-maintenance', { at: Date.now() });
        }),
      );
    let finished = !tasks.length;
    const completed = Promise.allSettled(tasks).then(() => {
      finished = true;
    });
    // Keep membership fresh even when a large outgoing document takes minutes.
    do {
      if (!finished) {
        let timer;
        try {
          await Promise.race([
            completed,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 15000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!finished) await this.app.notion.refreshAuthority();
      }
    } while (!finished);
    await this.nextAlarm();
  }
  async fetch(request) {
    // One-use operator bootstrap. Disabled unless its short-lived secret exists;
    // it cannot replace an initialized database or expose any stored data.
    if (new URL(request.url).pathname === '/api/_bootstrap') {
      const supplied = request.headers.get('authorization') || '';
      const expected = this.env.MIGRATION_TOKEN && `Bearer ${this.env.MIGRATION_TOKEN}`;
      if (
        !expected ||
        supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(expected)))
      ) {
        await request.body?.cancel();
        return new Response('Not found', { status: 404 });
      }
      const length = Number(request.headers.get('content-length') || 0);
      if (length > 8 * 1024 * 1024) {
        await request.body?.cancel();
        return new Response('Too large', { status: 413 });
      }
      const raw = await request.text();
      if (raw.length > 8 * 1024 * 1024) return new Response('Too large', { status: 413 });
      if (request.method === 'POST' && new URL(request.url).searchParams.get('probe') === '1') {
        const checks = await Promise.allSettled([
          mailTransport(this.app.auth.config.smtp).verify(),
          this.app.notion.call(`data_sources/${this.app.notion.config.notionSource}`),
        ]);
        return Response.json({
          smtp: checks[0].status === 'fulfilled',
          notion: checks[1].status === 'fulfilled',
          smtpError: checks[0].reason?.code || null,
          notionError: checks[1].reason?.notionStatus || checks[1].reason?.name || null,
          notionDetail: checks[1].reason
            ? String(checks[1].reason.message || '')
                .replaceAll(this.app.notion.config.notionToken || '[unset]', '[redacted]')
                .slice(0, 200)
            : null,
        });
      }
      if (
        request.method === 'POST' &&
        new URL(request.url).searchParams.get('verify') === '1' &&
        this.store.get('kv', 'cloud-bootstrap-complete')
      ) {
        const content = this.store.all('workshops').map((w) => ({
          id: w.id,
          teams: w.teams,
          votes: w.votes,
          baseline: w.notionVoteBaseline,
          theme: w.theme,
        }));
        return Response.json({
          contentHash: hash(JSON.stringify(content)),
          facilitatorHash: hash(this.app.facilitator.document()),
          topics: content.reduce(
            (s, w) => s + Object.values(w.teams).reduce((n, t) => n + t.nodes.length, 0),
            0,
          ),
        });
      }
      if (
        request.method !== 'POST' ||
        this.store.get('kv', 'cloud-bootstrap-complete') ||
        this.store.all('workshops').length
      )
        return new Response('Bootstrap unavailable', { status: 409 });
      const data = JSON.parse(raw);
      const tables = ['users', 'workshops', 'kv'];
      this.store.tx(() => {
        for (const table of tables)
          for (const row of data[table] || []) {
            const key = table === 'users' ? row.email : row.id;
            if (typeof key !== 'string' || typeof row.body !== 'string')
              throw Error('Invalid import');
            this.store.put(table, key, JSON.parse(row.body));
          }
        if (typeof data.facilitator === 'string')
          this.store.put('kv', 'facilitator-document', { markdown: data.facilitator });
        this.store.put('kv', 'cloud-bootstrap-complete', { at: Date.now() });
      });
      this.app.notion.content.recoverScheduled();
      return Response.json({ imported: true, workshops: this.store.all('workshops').length });
    }
    if (this.env.MIGRATION_TOKEN && new URL(request.url).pathname !== '/api/health')
      return Response.json(
        { error: '公開用データを準備しています。しばらくお待ちください。' },
        { status: 503 },
      );
    const response = await this.http.fetch(request, this.env, this.ctx);
    // Before operator bootstrap, health requests must not trigger a Notion import.
    if (!this.env.MIGRATION_TOKEN) await this.nextAlarm();
    return response;
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) {
      if (!assetPaths.has(path) || !['GET', 'HEAD'].includes(request.method))
        return new Response('Not found', { status: 404 });
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Frame-Options', 'DENY');
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return new Response(response.body, { status: response.status, headers });
    }
    const headers = new Headers(request.headers);
    headers.set('X-Workshop-Client-IP', request.headers.get('CF-Connecting-IP') || 'unknown');
    const id = env.APP_STATE.idFromName('workshop-idea-deck');
    return env.APP_STATE.get(id).fetch(new Request(request, { headers }));
  },
};
