import { getDatabase } from './db.js';
import { schemaSql } from './migrations/schema.js';
import logger from '../utils/logger.js';

export function runMigrations(db = getDatabase()) {
  try {
    logger.info('Running database migrations...');
    db.exec(schemaSql);
    try {
      db.run('ALTER TABLE destinations ADD COLUMN rate_limited_until TEXT;');
    } catch {}
    try {
      db.run('ALTER TABLE destinations ADD COLUMN secret_ref TEXT;');
    } catch {}
    try {
      db.run('ALTER TABLE auth_configs ADD COLUMN secret_ref TEXT;');
    } catch {}
    try {
      db.run('ALTER TABLE publications ADD COLUMN is_test INTEGER DEFAULT 0;');
    } catch {}
    try {
      db.run('ALTER TABLE publications ADD COLUMN run_at TEXT;');
    } catch {}
    try {
      db.run("ALTER TABLE publications ADD COLUMN tailoring_warnings TEXT DEFAULT '[]';");
    } catch {}
    try {
      db.run('ALTER TABLE destinations ADD COLUMN source_url TEXT;');
    } catch {}
    try {
      db.run('ALTER TABLE destinations ADD COLUMN researched_at TEXT;');
    } catch {}
    logger.info('Database migrations applied successfully.');
  } catch (err) {
    logger.error('Failed to run migrations', { error: err.message, stack: err.stack });
    throw err;
  }
}

// Run directly if invoked via CLI
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  runMigrations();
  console.log('Migrations complete.');
  process.exit(0);
}

export default runMigrations;
