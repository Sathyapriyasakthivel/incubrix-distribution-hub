import { getDatabase } from '../../database/db.js';
import logger from '../../utils/logger.js';

export class ResilienceService {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  // --- Rate Limit Tracking ---

  setRateLimit(destinationId, connectorKey, retryAt) {
    const now = new Date().toISOString();
    const retryAtIso = retryAt instanceof Date ? retryAt.toISOString() : retryAt;

    if (destinationId) {
      try {
        this.db.run(
          'UPDATE destinations SET rate_limited_until = ?, updated_at = ? WHERE id = ?',
          retryAtIso, now, destinationId
        );
      } catch (err) {
        logger.warn(`Failed to update destination rate limit: ${err.message}`);
      }
    }

    if (connectorKey) {
      try {
        this.db.run(
          `INSERT INTO connector_rate_limits (connector_key, rate_limited_until, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(connector_key) DO UPDATE SET rate_limited_until = excluded.rate_limited_until, updated_at = excluded.updated_at`,
          connectorKey, retryAtIso, now
        );
      } catch (err) {
        logger.warn(`Failed to update connector rate limit: ${err.message}`);
      }
    }

    logger.info(`Recorded rate limit until ${retryAtIso}`, { destination_id: destinationId, connector_key: connectorKey });
  }

  getRateLimit(destinationId, connectorKey) {
    const now = new Date().toISOString();

    if (destinationId) {
      const dest = this.db.get('SELECT rate_limited_until FROM destinations WHERE id = ?', destinationId);
      if (dest?.rate_limited_until && dest.rate_limited_until > now) {
        return { isRateLimited: true, retry_at: dest.rate_limited_until };
      }
    }

    if (connectorKey) {
      const conn = this.db.get('SELECT rate_limited_until FROM connector_rate_limits WHERE connector_key = ?', connectorKey);
      if (conn?.rate_limited_until && conn.rate_limited_until > now) {
        return { isRateLimited: true, retry_at: conn.rate_limited_until };
      }
    }

    return { isRateLimited: false, retry_at: null };
  }

  clearRateLimits() {
    this.db.run('UPDATE destinations SET rate_limited_until = NULL');
    this.db.run('DELETE FROM connector_rate_limits');
  }

  // --- Circuit Breaker ---

  recordSuccess(key) {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO circuit_breakers (key, consecutive_failures, is_open, opened_at, updated_at)
       VALUES (?, 0, 0, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET consecutive_failures = 0, is_open = 0, updated_at = excluded.updated_at`,
      key, now
    );
  }

  recordFailure(key, threshold = 5) {
    const now = new Date().toISOString();
    const existing = this.db.get('SELECT * FROM circuit_breakers WHERE key = ?', key);
    const count = (existing?.consecutive_failures || 0) + 1;
    const isOpen = count >= threshold ? 1 : 0;
    const openedAt = isOpen ? (existing?.opened_at || now) : null;

    this.db.run(
      `INSERT INTO circuit_breakers (key, consecutive_failures, is_open, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET consecutive_failures = ?, is_open = ?, opened_at = ?, updated_at = ?`,
      key, count, isOpen, openedAt, now,
      count, isOpen, openedAt, now
    );

    if (isOpen) {
      logger.error(`Circuit breaker TRIPPED (OPEN) for key: ${key} after ${count} consecutive failures`, {
        circuit_open: true,
        key,
        failures: count
      });
    } else {
      logger.warn(`Failure recorded for circuit breaker key: ${key} (${count}/${threshold})`, { key, count });
    }

    return { isOpen: Boolean(isOpen), count };
  }

  isCircuitOpen(destinationId, connectorKey) {
    if (destinationId) {
      const row = this.db.get('SELECT is_open FROM circuit_breakers WHERE key = ?', `dest:${destinationId}`);
      if (row?.is_open === 1) return true;
    }
    if (connectorKey) {
      const row = this.db.get('SELECT is_open FROM circuit_breakers WHERE key = ?', `conn:${connectorKey}`);
      if (row?.is_open === 1) return true;
    }
    return false;
  }

  resetCircuit(key) {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE circuit_breakers SET consecutive_failures = 0, is_open = 0, opened_at = NULL, updated_at = ? WHERE key = ?`,
      now, key
    );
  }

  resetAll() {
    this.clearRateLimits();
    this.db.run('DELETE FROM circuit_breakers');
  }
}

export const resilienceService = new ResilienceService();
export default resilienceService;
