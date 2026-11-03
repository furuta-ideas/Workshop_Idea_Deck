// Adapt the app's synchronous SQLite interface to Durable Object SQL storage.
export class DurableDatabase {
  constructor(storage) {
    this.storage = storage;
  }
  exec(sql) {
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      if (!/^PRAGMA\s/i.test(statement)) this.storage.sql.exec(statement);
  }
  prepare(sql) {
    return {
      all: (...args) => this.storage.sql.exec(sql, ...args).toArray(),
      get: (...args) => this.storage.sql.exec(sql, ...args).toArray()[0],
      run: (...args) => {
        const cursor = this.storage.sql.exec(sql, ...args);
        cursor.toArray();
        return { changes: cursor.rowsWritten };
      },
    };
  }
  transaction(fn) {
    return this.storage.transactionSync(fn);
  }
  close() {}
}
