import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyService } from '../../src/services/idempotency/idempotencyService.js';
import { initDatabase } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { IdempotencyConflictError } from '../../src/utils/errors.js';

describe('Idempotency Service Unit Tests', () => {
  let db;
  let service;

  beforeEach(() => {
    db = initDatabase(':memory:');
    runMigrations(db);
    service = new IdempotencyService(db);
  });

  it('Acquires a new key cleanly', () => {
    const key = 'idem_key_001';
    const payload = { title: 'First Post', body: 'Hello World' };
    const res = service.acquire(key, payload, 'job_101');

    expect(res.isNew).toBe(true);
    expect(res.existingRecord).toBeNull();
  });

  it('Returns existing record when identical key and payload are retried', () => {
    const key = 'idem_key_002';
    const payload = { title: 'Repeat Post', body: 'Same Content' };

    service.acquire(key, payload, 'job_202');
    service.complete(key, 200, { success: true, live_url: 'https://example.com/post/202' });

    const secondCall = service.acquire(key, payload, null);
    expect(secondCall.isNew).toBe(false);
    expect(secondCall.existingRecord).not.toBeNull();
    expect(secondCall.existingRecord.job_id).toBe('job_202');
    expect(secondCall.existingRecord.status).toBe('completed');
  });

  it('Throws IdempotencyConflictError when same key is reused with different payload', () => {
    const key = 'idem_key_conflict';
    const originalPayload = { title: 'Original Title', body: 'Original Body' };
    const alteredPayload = { title: 'Altered Title', body: 'Different Body' };

    service.acquire(key, originalPayload, 'job_orig');

    expect(() => {
      service.acquire(key, alteredPayload, 'job_alt');
    }).toThrow(IdempotencyConflictError);
  });
});
