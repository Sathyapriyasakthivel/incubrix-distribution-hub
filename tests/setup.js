import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { beforeAll, afterAll } from 'vitest';
import { getDatabase, resetDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';

// Generate unique isolated directory for this test file
const testRunId = `test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${process.pid}`;
const tempDir = path.join(os.tmpdir(), 'incubrix_tests', testRunId);
const tempDbPath = path.join(tempDir, 'test.db');
const tempStorageDir = path.join(tempDir, 'storage');

fs.mkdirSync(tempStorageDir, { recursive: true });

// Ensure process.env points to the isolated temporary DB and storage
process.env.DB_PATH = tempDbPath;
process.env.STORAGE_DIR = tempStorageDir;
process.env.NODE_ENV = 'test';
process.env.STORAGE_BACKEND = 'local';

// Prevent tests from accidentally contacting live containers or using live credentials
delete process.env.GHOST_ADMIN_KEY;
delete process.env.LEMMY_JWT_TOKEN;

beforeAll(() => {
  resetDatabase();
  const db = getDatabase();
  runMigrations(db);
});

afterAll(() => {
  resetDatabase();
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {}
});

