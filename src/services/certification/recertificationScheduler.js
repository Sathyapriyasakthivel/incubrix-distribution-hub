import { getDatabase } from '../../database/db.js';
import certificationHarness from './certificationHarness.js';
import logger from '../../utils/logger.js';

export class RecertificationScheduler {
  constructor(db = null, harness = certificationHarness) {
    this._db = db;
    this.harness = harness;
    this.timer = null;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Find destinations due for recertification (older than maxAgeDays or never certified)
   * @param {number} maxAgeDays - Threshold in days (default: 30)
   * @returns {Array} List of destination rows
   */
  getDueDestinations(maxAgeDays = Number(process.env.RECERT_BEFORE_DAYS || 25)) {
    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.query(`
      SELECT * FROM destinations
      WHERE is_enabled = 1
        AND (last_certified_at IS NULL OR last_certified_at <= ?)
      ORDER BY last_certified_at ASC NULLS FIRST
    `, cutoffDate);
  }

  /**
   * Run recertification cycle for all due destinations
   * @param {Object} options - { maxAgeDays: 25, limit: 50, forceLive: false }
   * @returns {Promise<Object>} Summary report of the recertification cycle
   */
  async runCycle(options = {}) {
    const maxAgeDays = options.maxAgeDays ?? Number(process.env.RECERT_BEFORE_DAYS || 25);
    const limit = options.limit ?? 50;
    const startTime = Date.now();

    const dueDestinations = this.getDueDestinations(maxAgeDays).slice(0, limit);
    logger.info(`Starting automated recertification cycle: ${dueDestinations.length} destinations due (> ${maxAgeDays} days)`);

    const results = {
      timestamp: new Date().toISOString(),
      max_age_days: maxAgeDays,
      total_due: dueDestinations.length,
      passed: 0,
      failed: 0,
      demoted: [],
      runs: []
    };

    for (const dest of dueDestinations) {
      try {
        const certResult = await this.harness.certifyDestination(dest.id, {
          forceLive: options.forceLive || false
        });

        results.runs.push({
          destination_id: dest.id,
          destination_name: dest.name,
          status: certResult.status,
          run_id: certResult.run_id,
          duration_ms: certResult.duration_ms
        });

        if (certResult.status === 'certified') {
          results.passed++;
          this.recordAuditEvent('RECERTIFICATION_SUCCESS', {
            destination_id: dest.id,
            destination_name: dest.name,
            run_id: certResult.run_id
          });
        } else {
          results.failed++;
          results.demoted.push({
            destination_id: dest.id,
            name: dest.name,
            error: certResult.error_message
          });

          await this.recordAlert(
            'error',
            'RECERTIFICATION_FAILURE',
            dest.id,
            `Destination '${dest.name}' (${dest.id}) failed recertification and was demoted: ${certResult.error_message || 'Non-transient certification failure'}`,
            { run_id: certResult.run_id, error: certResult.error_message }
          );

          this.recordAuditEvent('RECERTIFICATION_FAILURE_ALERT', {
            destination_id: dest.id,
            destination_name: dest.name,
            run_id: certResult.run_id,
            error: certResult.error_message,
            alert_level: 'HIGH',
            action_taken: 'DEMOTED_TO_UNCERTIFIED'
          });

          logger.error(`RECERTIFICATION_FAILURE_ALERT: Destination '${dest.name}' (${dest.id}) failed recertification and was demoted.`, {
            destination_id: dest.id,
            error: certResult.error_message
          });
        }
      } catch (err) {
        results.failed++;
        results.demoted.push({
          destination_id: dest.id,
          name: dest.name,
          error: err.message
        });

        await this.recordAlert(
          'error',
          'RECERTIFICATION_FAILURE',
          dest.id,
          `Destination '${dest.name}' (${dest.id}) failed recertification and was demoted: ${err.message}`,
          { error: err.message }
        );

        this.recordAuditEvent('RECERTIFICATION_FAILURE_ALERT', {
          destination_id: dest.id,
          destination_name: dest.name,
          error: err.message,
          alert_level: 'CRITICAL',
          action_taken: 'DEMOTED_TO_UNCERTIFIED'
        });
      }
    }

    results.duration_ms = Date.now() - startTime;
    logger.info(`Recertification cycle complete: ${results.passed} passed, ${results.failed} failed in ${results.duration_ms}ms`);

    return results;
  }

  /**
   * Start recurring scheduler timer
   * @param {number} intervalMs - Interval in milliseconds (e.g. 24 hours)
   * @param {Object} cycleOptions
   */
  start(intervalMs = 24 * 60 * 60 * 1000, cycleOptions = {}) {
    if (this.timer) return;
    logger.info(`Recertification scheduler started with interval ${intervalMs}ms`);
    this.timer = setInterval(() => {
      this.runCycle(cycleOptions).catch(err => {
        logger.error('Error during scheduled recertification cycle', { error: err.message });
      });
    }, intervalMs);
  }

  /**
   * Stop recurring scheduler timer
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Recertification scheduler stopped');
    }
  }

  recordAuditEvent(eventType, payload) {
    try {
      this.db.run(`
        INSERT INTO audit_logs (id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `, 'audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), eventType, JSON.stringify(payload), new Date().toISOString());
    } catch (err) {
      logger.warn('Failed to insert recertification audit log', { error: err.message });
    }
  }

  async recordAlert(level, eventType, destinationId, message, details = {}) {
    const alertId = 'alert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO alerts (id, level, event_type, destination_id, message, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(alertId, level, eventType, destinationId, message, JSON.stringify(details), now);
    } catch (err) {
      logger.warn('Failed to insert alert record into alerts table', { error: err.message });
    }

    if (process.env.ALERT_WEBHOOK_URL) {
      try {
        await fetch(process.env.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: alertId,
            level,
            event_type: eventType,
            destination_id: destinationId,
            message,
            details,
            created_at: now
          }),
          signal: AbortSignal.timeout(3000)
        });
      } catch (webhookErr) {
        logger.warn('Failed to dispatch alert webhook', { error: webhookErr.message });
      }
    }
  }
}

export const recertificationScheduler = new RecertificationScheduler();
export default recertificationScheduler;

