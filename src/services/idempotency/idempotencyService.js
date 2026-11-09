import crypto from 'node:crypto';
import { getDatabase } from '../../database/db.js';
import { IdempotencyConflictError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';

export function computeRequestHash(reqOrPayload) {
  const content = typeof reqOrPayload === 'string'
    ? reqOrPayload
    : JSON.stringify(reqOrPayload, Object.keys(reqOrPayload).sort());
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class IdempotencyService {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Acquire or check an idempotency key
   * @param {string} key
   * @param {Object} payload
   * @param {string} jobId
   * @returns {{ isNew: boolean, existingRecord: Object|null }}
   */
  acquire(key, payload, jobId) {
    if (!key) {
      return { isNew: true, existingRecord: null };
    }

    const requestHash = computeRequestHash(payload);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 24h retention

    return this.db.transaction((tx) => {
      const existing = tx.get('SELECT * FROM idempotency_records WHERE key = ?', key);

      if (existing) {
        // Verify payload match
        if (existing.request_hash !== requestHash) {
          throw new IdempotencyConflictError(
            `Idempotency key '${key}' was previously used with a different request payload.`,
            { key }
          );
        }

        logger.info(`Idempotency match found for key: ${key}`, {
          job_id: existing.job_id,
          status: existing.status
        });

        return {
          isNew: false,
          existingRecord: {
            ...existing,
            response_body: existing.response_body ? JSON.parse(existing.response_body) : null
          }
        };
      }

      // Insert new record
      tx.run(`
        INSERT INTO idempotency_records (key, request_hash, job_id, status, created_at, expires_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `, key, requestHash, jobId, now.toISOString(), expiresAt);

      return { isNew: true, existingRecord: null };
    });
  }

  /**
   * Complete an idempotency record with the final response
   */
  complete(key, responseStatus, responseBody) {
    if (!key) return;

    try {
      this.db.run(`
        UPDATE idempotency_records
        SET status = 'completed',
            response_status = ?,
            response_body = ?
        WHERE key = ?
      `, responseStatus, JSON.stringify(responseBody), key);
    } catch (err) {
      logger.warn(`Failed to update idempotency record completion: ${err.message}`, { key });
    }
  }

  /**
   * Fail an idempotency record
   */
  fail(key, errorDetails) {
    if (!key) return;

    try {
      this.db.run(`
        UPDATE idempotency_records
        SET status = 'failed',
            response_body = ?
        WHERE key = ?
      `, JSON.stringify({ error: errorDetails }), key);
    } catch (err) {
      logger.warn(`Failed to update idempotency record failure: ${err.message}`, { key });
    }
  }

  /**
   * Reset an idempotency record back to pending for retry after failure
   */
  reset(key) {
    if (!key) return;

    try {
      this.db.run(`
        UPDATE idempotency_records
        SET status = 'pending',
            response_status = NULL,
            response_body = NULL
        WHERE key = ?
      `, key);
    } catch (err) {
      logger.warn(`Failed to reset idempotency record: ${err.message}`, { key });
    }
  }
}

export const idempotencyService = new IdempotencyService();
export default idempotencyService;
