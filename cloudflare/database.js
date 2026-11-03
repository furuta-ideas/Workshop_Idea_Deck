// Adapt the app's synchronous SQLite interface to Durable Object SQL storage.
export class DurableDatabase {
  constructor(storage) {
    this.storage = storage;
    this.depth = 0;
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_body_chunks(owner TEXT, part INTEGER, bytes BLOB, PRIMARY KEY(owner,part))',
    );
  }
  exec(sql) {
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      if (!/^PRAGMA\s/i.test(statement)) {
        this.storage.sql.exec(statement);
        const table =
          /^CREATE TABLE IF NOT EXISTS (workshops|users|challenges|requests|kv)\(/i.exec(
            statement,
          )?.[1];
        if (table)
          this.storage.sql.exec(
            `CREATE TRIGGER IF NOT EXISTS ${table}_chunk_cleanup AFTER DELETE ON ${table} BEGIN DELETE FROM app_body_chunks WHERE owner='${table}:'||OLD.${table === 'users' ? 'email' : 'id'}; END`,
          );
      }
  }
  decode(row) {
    if (!row?.body?.includes('__wid_sql_chunks_v1__')) return row;
    const marker = JSON.parse(row.body).__wid_sql_chunks_v1__;
    if (typeof marker !== 'string') return row;
    const chunks = this.storage.sql
      .exec('SELECT bytes FROM app_body_chunks WHERE owner=? ORDER BY part', marker)
      .toArray();
    if (!chunks.length) throw Error('Stored document chunks are missing');
    return {
      ...row,
      body: Buffer.concat(chunks.map((c) => Buffer.from(c.bytes))).toString('utf8'),
    };
  }
  prepare(sql) {
    return {
      all: (...args) =>
        this.storage.sql
          .exec(sql, ...args)
          .toArray()
          .map((row) => this.decode(row)),
      get: (...args) => this.decode(this.storage.sql.exec(sql, ...args).toArray()[0]),
      run: (...args) => {
        const table = /^INSERT OR REPLACE INTO (workshops|users|challenges|requests|kv)\(/i.exec(
          sql,
        )?.[1];
        if (table)
          return this.transaction(() => {
            const owner = table + ':' + args[0];
            this.storage.sql.exec('DELETE FROM app_body_chunks WHERE owner=?', owner);
            const bytes = Buffer.from(args[1], 'utf8');
            if (bytes.length > 512000) {
              const body = JSON.parse(args[1]);
              args[1] = JSON.stringify({
                __wid_sql_chunks_v1__: owner,
                expires: body.expires,
                at: body.at,
                until: body.until,
              });
            }
            const cursor = this.storage.sql.exec(sql, ...args);
            cursor.toArray();
            if (bytes.length > 512000)
              for (let i = 0; i < bytes.length; i += 512000)
                this.storage.sql.exec(
                  'INSERT INTO app_body_chunks(owner,part,bytes) VALUES(?,?,?)',
                  owner,
                  i / 512000,
                  bytes.subarray(i, i + 512000),
                );
            return { changes: cursor.rowsWritten };
          });
        const cursor = this.storage.sql.exec(sql, ...args);
        cursor.toArray();
        return { changes: cursor.rowsWritten };
      },
    };
  }
  transaction(fn) {
    if (this.depth) return fn();
    this.depth++;
    try {
      return this.storage.transactionSync(fn);
    } finally {
      this.depth--;
    }
  }
  close() {}
}
