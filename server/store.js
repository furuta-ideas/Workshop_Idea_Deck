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
export class Store {
  constructor(file, database) {
    if (database) this.db = database;
    else {
      mkdirSync(dirname(file), { recursive: true });
      this.db = new DatabaseSync(file);
    }
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
  get(table, key) {
    const row = this.db
      .prepare(
        `SELECT body FROM ${this.table(table)} WHERE ${table === 'users' ? 'email' : 'id'}=?`,
      )
      .get(key);
    return row && JSON.parse(row.body);
  }
  all(table) {
    return this.db
      .prepare(`SELECT body FROM ${this.table(table)}`)
      .all()
      .map((x) => JSON.parse(x.body));
  }
  put(table, key, body) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.table(table)}(${table === 'users' ? 'email' : 'id'},body) VALUES(?,?)`,
      )
      .run(key, JSON.stringify(body));
    return body;
  }
  del(table, key) {
    this.db
      .prepare(`DELETE FROM ${this.table(table)} WHERE ${table === 'users' ? 'email' : 'id'}=?`)
      .run(key);
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
