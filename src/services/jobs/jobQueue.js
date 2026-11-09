import crypto from 'node:crypto';
import { getDatabase } from '../../database/db.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { RETRY_POLICY } from '../../utils/errors.js';

export class JobQueue {
  constructor(db = null) {
    this._db = db;
    this.handlers = new Map();
    this.isRunning = false;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  registerHandler(type, handlerFn) {
    this.handlers.set(type, handlerFn);
  }

  createJob(jobData) {
    const jobId = jobData.id || 'job_' + crypto.randomUUID();
    const now = new Date().toISOString();
    const runAt = jobData.run_at || null;
    const initialStatus = 'queued';

    this.db.run(`
      INSERT INTO publications (
        id, destination_id, connector_key, idempotency_key, title, body,
        canonical_url, media_urls, is_ai_generated, is_promotional,
        tailoring_warnings, status, progress, run_at, callback_url, simulation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `,
      jobId,
      jobData.destination_id,
      jobData.connector_key,
      jobData.idempotency_key || null,
      jobData.title,
      jobData.body,
      jobData.canonical_url || null,
      JSON.stringify(jobData.media_urls || []),
      jobData.is_ai_generated ? 1 : 0,
      jobData.is_promotional ? 1 : 0,
      jobData.tailoring_warnings || '[]',
      initialStatus,
      runAt,
      jobData.callback_url || null,
      jobData.simulation ? 1 : 0,
      now,
      now
    );

    logger.info(`Job created (${initialStatus}): ${jobId}`, { job_id: jobId, destination_id: jobData.destination_id, run_at: runAt });

    if (runAt && new Date(runAt) > new Date()) {
      const delay = Math.max(0, new Date(runAt).getTime() - Date.now());
      setTimeout(() => {
        this.processJob(jobId);
      }, delay);
    } else {
      setImmediate(() => {
        this.processJob(jobId);
      });
    }

    return {
      job_id: jobId,
      status: initialStatus,
      run_at: runAt,
      retry_at: runAt,
      progress: 0,
      created_at: now
    };
  }

  updateProgress(jobId, progress, status = 'running') {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE publications
      SET progress = ?, status = ?, updated_at = ?
      WHERE id = ?
    `, progress, status, now, jobId);
  }

  completeJob(jobId, result) {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE publications
      SET status = 'succeeded',
          progress = 100,
          platform_post_id = ?,
          live_url = ?,
          output_manifest = ?,
          updated_at = ?
      WHERE id = ?
    `,
      result.platform_post_id || null,
      result.live_url || null,
      JSON.stringify(result.manifest || {}),
      now,
      jobId
    );

    logger.info(`Job completed successfully: ${jobId}`, {
      job_id: jobId,
      live_url: result.live_url,
      platform_post_id: result.platform_post_id
    });

    this.dispatchCallback(jobId);
  }

  failJob(jobId, err) {
    const now = new Date().toISOString();
    const errorCode = err.code || 'INTERNAL_ERROR';
    const errorMessage = err.message || 'Operation failed';
    const detailsObj = { ...(err.details || {}) };
    const retryable = err.retryable !== undefined
      ? Boolean(err.retryable)
      : (RETRY_POLICY[errorCode] ?? false);
    detailsObj.retryable = retryable;
    const details = JSON.stringify(detailsObj);

    this.db.run(`
      UPDATE publications
      SET status = 'failed',
          progress = 100,
          error_code = ?,
          error_message = ?,
          error_details = ?,
          updated_at = ?
      WHERE id = ?
    `, errorCode, errorMessage, details, now, jobId);

    logger.error(`Job failed: ${jobId}`, {
      job_id: jobId,
      error_code: errorCode,
      error_message: errorMessage,
      retryable
    });

    this.dispatchCallback(jobId);
  }

  requeueJob(jobId) {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE publications
      SET status = 'queued',
          progress = 0,
          error_code = NULL,
          error_message = NULL,
          error_details = NULL,
          updated_at = ?
      WHERE id = ?
    `, now, jobId);

    logger.info(`Job re-queued after failure: ${jobId}`, { job_id: jobId });

    setImmediate(() => {
      this.processJob(jobId);
    });

    return {
      job_id: jobId,
      status: 'queued',
      progress: 0,
      updated_at: now
    };
  }

  rescheduleJob(jobId, retryAt) {
    const now = new Date().toISOString();
    const retryAtIso = retryAt instanceof Date ? retryAt.toISOString() : retryAt;

    this.db.run(`
      UPDATE publications
      SET status = 'queued',
          progress = 0,
          run_at = ?,
          updated_at = ?
      WHERE id = ?
    `, retryAtIso, now, jobId);

    logger.info(`Job queued to run at ${retryAtIso}: ${jobId}`, { job_id: jobId, run_at: retryAtIso });

    const delay = Math.max(0, new Date(retryAtIso).getTime() - Date.now());
    setTimeout(() => {
      this.processJob(jobId);
    }, delay);

    return {
      job_id: jobId,
      status: 'queued',
      run_at: retryAtIso,
      retry_at: retryAtIso
    };
  }

  recoverStuckJobs() {
    try {
      const stuckJobs = this.db.all(`
        SELECT id, status, run_at
        FROM publications
        WHERE status IN ('queued', 'running')
      `);

      for (const job of stuckJobs) {
        if (job.run_at && new Date(job.run_at) > new Date()) {
          const delay = Math.max(0, new Date(job.run_at).getTime() - Date.now());
          logger.info(`Recovered scheduled job ${job.id}, scheduled for ${job.run_at}`);
          setTimeout(() => {
            this.processJob(job.id);
          }, delay);
        } else {
          logger.info(`Recovering stuck job on startup: ${job.id} (was ${job.status})`);
          this.requeueJob(job.id);
        }
      }
    } catch (err) {
      logger.warn(`Failed to recover stuck jobs on startup: ${err.message}`);
    }
  }

  getJob(jobId) {
    const row = this.db.get(`
      SELECT p.*, d.name as destination_name
      FROM publications p
      LEFT JOIN destinations d ON p.destination_id = d.id
      WHERE p.id = ?
    `, jobId);

    if (!row) return null;

    let errorObj = null;
    if (row.error_code) {
      let detailsObj = {};
      try {
        detailsObj = row.error_details ? JSON.parse(row.error_details) : {};
      } catch {
        detailsObj = {};
      }
      const retryableVal = typeof detailsObj.retryable === 'boolean'
        ? detailsObj.retryable
        : (RETRY_POLICY[row.error_code] ?? false);

      errorObj = {
        code: row.error_code,
        message: row.error_message || 'Operation failed',
        retryable: retryableVal,
        details: detailsObj
      };
    }

    return {
      job_id: row.id,
      destination_id: row.destination_id,
      destination_name: row.destination_name,
      connector_key: row.connector_key,
      idempotency_key: row.idempotency_key,
      status: row.status,
      progress: row.progress,
      run_at: row.run_at,
      retry_at: row.run_at,
      title: row.title,
      platform_post_id: row.platform_post_id,
      live_url: row.live_url,
      rule_decision: row.rule_decision,
      rule_violations: row.rule_violations ? JSON.parse(row.rule_violations) : [],
      manifest: row.output_manifest ? JSON.parse(row.output_manifest) : null,
      output_manifest: row.output_manifest ? JSON.parse(row.output_manifest) : null,
      tailoring_warnings: row.tailoring_warnings ? JSON.parse(row.tailoring_warnings) : [],
      error: errorObj,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async processJob(jobId) {
    const job = this.db.get('SELECT * FROM publications WHERE id = ?', jobId);
    if (!job || job.status !== 'queued') return;

    this.updateProgress(jobId, 10, 'running');
    const handler = this.handlers.get('publish');
    if (!handler) {
      this.failJob(jobId, new Error('No publisher registered for job queue'));
      return;
    }

    try {
      await handler(job, (progress) => this.updateProgress(jobId, progress, 'running'));
    } catch (err) {
      this.failJob(jobId, err);
    }
  }

  async dispatchCallback(jobId) {
    const job = this.getJob(jobId);
    if (!job || !job.callback_url) return;

    const secret = config.security.callbackSigningSecret;
    const payload = JSON.stringify({
      event: 'job_completed',
      job_id: job.job_id,
      status: job.status,
      live_url: job.live_url,
      platform_post_id: job.platform_post_id,
      error: job.error,
      completed_at: job.updated_at
    });

    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

    try {
      await fetch(job.callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-IncuBrix-Signature': signature
        },
        body: payload,
        signal: AbortSignal.timeout(4000)
      });
      logger.info(`Dispatched HMAC-signed callback for job ${jobId} to ${job.callback_url}`);
    } catch (err) {
      logger.warn(`Failed to dispatch callback for job ${jobId}: ${err.message}`);
    }
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
