import crypto from 'node:crypto';
import { getDatabase } from '../../database/db.js';
import registry from '../../connectors/ConnectorRegistry.js';
import logger from '../../utils/logger.js';

export class TestPostSweeper {
  constructor(db = null) {
    this._db = db;
    this.timer = null;
    this.isSweeping = false;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Record a test post with TTL for deletion
   * @param {string} destinationId
   * @param {string} platformPostId
   * @param {number} ttlSeconds - Defaults to TEST_POST_TTL_S or 600 seconds (10 minutes)
   */
  recordTestPost(destinationId, platformPostId, ttlSeconds = null) {
    const ttl = ttlSeconds || parseInt(process.env.TEST_POST_TTL_S || '600', 10);
    const id = 'tp_' + crypto.randomUUID();
    const now = new Date();
    const deleteBy = new Date(now.getTime() + ttl * 1000).toISOString();

    try {
      this.db.run(`
        INSERT INTO test_posts (id, destination_id, platform_post_id, delete_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, id, destinationId, platformPostId, deleteBy, now.toISOString());
      logger.info(`Recorded test post for sweeper: ${platformPostId} (delete_by: ${deleteBy})`, {
        destination_id: destinationId,
        platform_post_id: platformPostId,
        delete_by: deleteBy
      });
      return { id, delete_by: deleteBy };
    } catch (err) {
      logger.error('Failed to record test post for sweeper', { error: err.message });
      return null;
    }
  }

  /**
   * Remove a test post that was already cleaned up
   */
  removeTestPost(platformPostId) {
    try {
      this.db.run('DELETE FROM test_posts WHERE platform_post_id = ?', platformPostId);
    } catch (err) {
      logger.warn(`Failed to remove test post ${platformPostId} from tracker: ${err.message}`);
    }
  }

  /**
   * Sweep and delete all test posts whose delete_by <= now
   */
  async sweepExpiredPosts() {
    if (this.isSweeping) return { swept: 0, failed: 0 };
    this.isSweeping = true;

    const now = new Date().toISOString();
    let swept = 0;
    let failed = 0;

    try {
      const expiredPosts = this.db.query(
        'SELECT * FROM test_posts WHERE delete_by <= ?',
        now
      );

      if (expiredPosts.length > 0) {
        logger.info(`Test post sweeper found ${expiredPosts.length} expired test posts due for deletion`);
      }

      for (const item of expiredPosts) {
        const dest = this.db.get('SELECT * FROM destinations WHERE id = ?', item.destination_id);
        if (!dest) {
          // Destination gone, remove entry
          this.db.run('DELETE FROM test_posts WHERE id = ?', item.id);
          continue;
        }

        const authRow = this.db.get('SELECT * FROM auth_configs WHERE destination_id = ?', dest.id);
        let connection = {};
        if (authRow && authRow.credentials) {
          try { connection = JSON.parse(authRow.credentials); } catch {}
        }
        connection.base_url = dest.url;
        connection.simulation_mode = dest.simulation_mode;
        if (dest.secret_ref && process.env[dest.secret_ref]) {
          const envSecret = process.env[dest.secret_ref];
          connection.secret = envSecret;
          connection.token = envSecret;
          connection.jwt = envSecret;
          connection.apiKey = envSecret;
          connection.api_key = envSecret;
        }

        try {
          if (registry.hasConnector(dest.connector_key)) {
            const connector = registry.getConnector(dest.connector_key);
            if (connector.capabilities.has('delete')) {
              await connector.delete(item.platform_post_id, connection);
              logger.info(`Sweeper successfully deleted expired test post ${item.platform_post_id}`);
            }
          }
          this.db.run('DELETE FROM test_posts WHERE id = ?', item.id);
          swept++;
        } catch (delErr) {
          if (delErr.message?.includes('404') || delErr.statusCode === 404 || delErr.message?.toLowerCase().includes('not found')) {
            logger.info(`Test post ${item.platform_post_id} already gone (404), removing from tracker`);
            this.db.run('DELETE FROM test_posts WHERE id = ?', item.id);
            swept++;
          } else {
            logger.error(`Sweeper failed to delete test post ${item.platform_post_id}`, {
              error: delErr.message,
              destination_id: dest.id
            });
            failed++;
          }
        }
      }
    } catch (err) {
      logger.error('Error during test post sweeping cycle', { error: err.message });
    } finally {
      this.isSweeping = false;
    }

    return { swept, failed };
  }

  /**
   * Start background sweeper interval timer
   */
  start(intervalMs = null) {
    if (this.timer) return;
    const interval = intervalMs || parseInt(process.env.TEST_POST_SWEEP_INTERVAL_MS || '30000', 10);
    this.timer = setInterval(() => {
      this.sweepExpiredPosts().catch(err => {
        logger.error('Sweeper background task error', { error: err.message });
      });
    }, interval);
    if (this.timer.unref) this.timer.unref();
    logger.info(`Test post sweeper started (interval: ${interval}ms)`);
  }

  /**
   * Stop background sweeper
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Test post sweeper stopped');
    }
  }
}

export const testPostSweeper = new TestPostSweeper();
export default testPostSweeper;
