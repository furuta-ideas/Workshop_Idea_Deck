import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const hash = (x) => createHash('sha256').update(x).digest('hex');
export const normalizeEmail = (x) =>
  String(x || '')
    .trim()
    .toLowerCase();
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, value] = stored.split(':');
  const calculated = scryptSync(password, salt, 64);
  return (
    calculated.length === Buffer.from(value, 'hex').length &&
    timingSafeEqual(calculated, Buffer.from(value, 'hex'))
  );
}
// Values that change on every poll or heartbeat but carry no durable meaning.
// They are kept in memory only, so an otherwise unchanged row is never
// rewritten. Cloudflare bills Durable Object storage by rows written, and the
// free tier allows 100,000 per day. A missing value reads back as 0, which is
// always the safe default (stale permission check, due sync, no cooldown).
const volatileRules = [
  {
    table: 'workshops',
    test: () => true,
    paths: [
      ['notion', 'checkedAt'],
      ['documentSync', 'dueAt'],
    ],
  },
  { table: 'kv', test: (k) => k === 'notion-sync' || k === 'cloud-maintenance', paths: [['at']] },
  { table: 'kv', test: (k) => k.startsWith('notion-content:'), paths: [['at']] },
  {
    table: 'kv',
    test: (k) => k.startsWith('facilitator:'),
    paths: [['pendingUntil'], ['lastAttemptAt']],
  },
];
const blobKey = (key) => `blob:${key}`;
export class Store {
  constructor(file, database) {
    if (database) this.db = database;
    else {
      mkdirSync(dirname(file), { recursive: true });
      this.db = new DatabaseSync(file);
    }
    this.volatile = new Map();
    this.blobs = new Map();
    this.writes = 0;
    this.skipped = 0;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workshops(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, email TEXT, expires INTEGER, csrf TEXT);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, time TEXT, kind TEXT, body TEXT);`);
    this.migrateMaps();
  }
  migrateMaps() {
    this.tx(() => {
      for (const ws of this.all('workshops')) {
        let changed = false;
        for (const team of Object.values(ws.teams)) {
          if (team.mapVersion === 2) continue;
          for (const node of team.nodes) if (node.parent === null) node.parent = 'theme';
          team.mapVersion = 2;
          changed = true;
        }
        if (changed) {
          ws.revision++;
          this.put('workshops', ws.id, ws);
        }
      }
    });
  }
  keyColumn(table) {
    return table === 'users' ? 'email' : 'id';
  }
  raw(table, key) {
    return this.db
      .prepare(`SELECT body FROM ${this.table(table)} WHERE ${this.keyColumn(table)}=?`)
      .get(key)?.body;
  }
  rule(table, key) {
    return volatileRules.find((r) => r.table === table && r.test(String(key)));
  }
  // Remove volatile fields from a copy of body and remember them in memory.
  detach(table, key, body) {
    const rule = this.rule(table, key);
    if (!rule || !body || typeof body !== 'object') return body;
    const values = {};
    const copy = { ...body };
    for (const path of rule.paths) {
      if (path.length === 1) {
        if (path[0] in copy) {
          values[path[0]] = copy[path[0]];
          delete copy[path[0]];
        }
      } else if (copy[path[0]] && typeof copy[path[0]] === 'object' && path[1] in copy[path[0]]) {
        copy[path[0]] = { ...copy[path[0]] };
        values[path.join('.')] = copy[path[0]][path[1]];
        delete copy[path[0]][path[1]];
      }
    }
    this.volatile.set(`${table}:${key}`, values);
    return copy;
  }
  attach(table, key, body) {
    const rule = this.rule(table, key);
    if (!rule || !body || typeof body !== 'object') return body;
    const values = this.volatile.get(`${table}:${key}`) || {};
    for (const path of rule.paths) {
      const name = path.join('.');
      const target = path.length === 1 ? body : body[path[0]];
      if (!target || typeof target !== 'object') continue;
      const last = path.at(-1);
      if (!(last in target)) target[last] = name in values ? values[name] : 0;
    }
    return body;
  }
  // Team images are large base64 PNGs. Store each image once, by content hash,
  // so that ordinary map edits do not rewrite megabytes of image chunks.
  packImages(table, body) {
    if (table !== 'workshops' || !body?.teams) return body;
    let teams;
    for (const [teamId, team] of Object.entries(body.teams)) {
      if (typeof team?.image?.base64 !== 'string') continue;
      const key = hash(team.image.base64);
      if (!this.blobs.has(key)) {
        if (this.raw('kv', blobKey(key)) === undefined)
          this.write('kv', blobKey(key), JSON.stringify({ base64: team.image.base64 }));
        this.blobs.set(key, team.image.base64);
      }
      teams ||= { ...body.teams };
      const { base64, ...rest } = team.image;
      teams[teamId] = { ...team, image: { ...rest, blob: key } };
    }
    return teams ? { ...body, teams } : body;
  }
  unpackImages(table, body) {
    if (table !== 'workshops' || !body?.teams) return body;
    for (const team of Object.values(body.teams)) {
      const key = team?.image?.blob;
      if (!key) continue;
      let base64 = this.blobs.get(key);
      if (base64 === undefined) {
        const stored = this.raw('kv', blobKey(key));
        base64 = stored === undefined ? undefined : JSON.parse(stored).base64;
        if (base64 !== undefined) this.blobs.set(key, base64);
      }
      const { blob, ...rest } = team.image;
      team.image = base64 === undefined ? null : { ...rest, base64 };
    }
    return body;
  }
  // The base64 of a stored image, by content hash (see packImages).
  blob(key) {
    if (!this.blobs.has(key)) {
      const stored = this.raw('kv', blobKey(key));
      if (stored === undefined) return undefined;
      this.blobs.set(key, JSON.parse(stored).base64);
    }
    return this.blobs.get(key);
  }
  decodeRow(table, key, json) {
    return this.attach(table, key, this.unpackImages(table, JSON.parse(json)));
  }
  get(table, key) {
    const json = this.raw(table, key);
    return json === undefined ? undefined : this.decodeRow(table, key, json);
  }
  all(table) {
    const column = this.keyColumn(table);
    return this.db
      .prepare(`SELECT ${column} AS k, body FROM ${this.table(table)}`)
      .all()
      .filter((x) => !(table === 'kv' && String(x.k).startsWith('blob:')))
      .map((x) => this.decodeRow(table, x.k, x.body));
  }
  write(table, key, json) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.table(table)}(${this.keyColumn(table)},body) VALUES(?,?)`,
      )
      .run(key, json);
    this.writes++;
  }
  put(table, key, body) {
    const json = JSON.stringify(this.packImages(table, this.detach(table, key, body)));
    // Reads are cheap; writes are what the free tier limits. Skip no-op writes.
    if (this.raw(table, key) === json) this.skipped++;
    else this.write(table, key, json);
    return body;
  }
  del(table, key) {
    this.volatile.delete(`${table}:${key}`);
    this.db.prepare(`DELETE FROM ${this.table(table)} WHERE ${this.keyColumn(table)}=?`).run(key);
  }
  table(x) {
    if (!['users', 'workshops', 'challenges', 'kv', 'requests'].includes(x)) throw Error('table');
    return x;
  }
  tx(fn) {
    if (this.db.transaction) return this.db.transaction(fn);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  audit(kind, body) {
    this.db
      .prepare('INSERT INTO audit(time,kind,body) VALUES(?,?,?)')
      .run(new Date().toISOString(), kind, JSON.stringify(body));
  }
  close() {
    this.db.close();
  }
}

export function newTeam(name) {
  return {
    id: id(),
    name,
    mapVersion: 2,
    nodes: [],
    deck: [],
    discussion: {
      running: false,
      transcript: '',
      headline: '',
      features: ['', '', ''],
      pressRelease: '',
      what: '',
      who: '',
      how: '',
      points: '',
      keywords: '',
      rounds: [],
    },
    image: null,
  };
}
export function newWorkshop(name, email) {
  const team = newTeam('A班');
  return {
    id: id(),
    name,
    status: '進行中',
    endDate: null,
    revision: 1,
    theme: name,
    teams: { [team.id]: team },
    members: { [email]: { role: '管理者', teamId: team.id } },
    budgets: { cards: 10, ideas: 10 },
    durations: { cards: 180, ideas: 180 },
    timers: { cards: null, ideas: null },
    votes: { cards: {}, ideas: {} },
    notion: null,
    dirty: false,
  };
}
