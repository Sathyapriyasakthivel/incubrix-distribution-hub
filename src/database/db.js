import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config/index.js';
import logger from '../utils/logger.js';

let instance = null;

export function initDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Optimize SQLite settings
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  return {
    raw: db,

    exec(sql) {
      return db.exec(sql);
    },

    prepare(sql) {
      return db.prepare(sql);
    },

    query(sql, ...params) {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    get(sql, ...params) {
      const stmt = db.prepare(sql);
      const row = stmt.get(...params);
      return row === undefined ? null : row;
    },

    run(sql, ...params) {
      const stmt = db.prepare(sql);
      return stmt.run(...params);
    },

    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(this);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      try {
        db.close();
      } catch {}
    }
  };
}

export function getDatabase() {
  if (!instance) {
    instance = initDatabase();
  }
  return instance;
}

export function setDatabase(customDb) {
  instance = customDb;
}

export function resetDatabase() {
  if (instance) {
    try {
      instance.close();
    } catch {}
    instance = null;
  }
}

export default getDatabase;
