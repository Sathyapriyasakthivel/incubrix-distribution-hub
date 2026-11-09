/**
 * Idempotency middleware for POST requests under /api/v1.
 * Checks the Idempotency-Key header, prevents duplicate processing, returns
 * cached responses with Idempotent-Replayed: true, and enforces 409 conflict
 * on payload mismatch and 400 on missing key.
 */
import crypto from 'node:crypto';
import idempotencyService, { computeRequestHash } from '../services/idempotency/idempotencyService.js';
import { ERROR_CODES } from '../utils/errors.js';
import logger from '../utils/logger.js';

export function idempotencyMiddleware(req, res, next) {
  if (req.method !== 'POST') {
    return next();
  }

  // Pure query or simulation endpoints using POST are exempt from requiring Idempotency-Key
  const exemptPaths = [
    '/publish/rules/evaluate',
    '/publish/recommender',
    '/rules/evaluate',
    '/sim/inject',
    '/sim/reset'
  ];
  const isExempt = exemptPaths.some(p => req.path.endsWith(p));

  const key = req.headers['idempotency-key'];
  if (!key) {
    if (isExempt) {
      return next();
    }
    return res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required for all POST requests under /api/v1',
        retryable: false,
        details: { path: req.originalUrl || req.path }
      }
    });
  }

  try {
    const requestHash = computeRequestHash(req.body || {});
    const existing = idempotencyService.db.get(
      'SELECT * FROM idempotency_records WHERE key = ?',
      key
    );

    if (existing) {
      // Detect mismatched payload for same key -> 409 Conflict
      if (existing.request_hash !== requestHash) {
        return res.status(409).json({
          error: {
            code: ERROR_CODES.IDEMPOTENCY_CONFLICT || 'IDEMPOTENCY_CONFLICT',
            message: `Idempotency key '${key}' was previously used with a different request payload.`,
            retryable: false,
            details: { key }
          }
        });
      }

      // Retrying the same Idempotency-Key with same body after a failed job must re-queue the same job instead of replaying failure
      let existingJob = null;
      if (existing.job_id) {
        existingJob = idempotencyService.db.get('SELECT * FROM publications WHERE id = ?', existing.job_id);
      }
      if (existingJob && existingJob.status === 'failed') {
        logger.info(`Idempotency retry after failed job: re-queueing for key ${key}`, {
          key,
          job_id: existing.job_id
        });
        idempotencyService.reset(key);
        const originalJson = res.json.bind(res);
        res.json = (body) => {
          try {
            const jobId = body?.job_id || existing.job_id;
            const status = (res.statusCode >= 200 && res.statusCode < 400) ? 'completed' : 'failed';
            idempotencyService.db.run(`
              UPDATE idempotency_records
              SET status = ?,
                  job_id = COALESCE(?, job_id),
                  response_status = ?,
                  response_body = ?
              WHERE key = ?
            `, status, jobId, res.statusCode, JSON.stringify(body), key);
          } catch (err) {
            logger.warn(`Failed to update idempotency record: ${err.message}`, { key });
          }
          return originalJson(body);
        };
        return next();
      }

      // Replay cached completed response
      if (existing.response_body) {
        res.setHeader('Idempotent-Replayed', 'true');
        logger.info(`Idempotency replay: returning cached response for key ${key}`, {
          key,
          job_id: existing.job_id
        });
        const responseBody = JSON.parse(existing.response_body);
        const replayStatus = existing.response_status === 202 ? 200 : (existing.response_status || 200);
        return res.status(replayStatus).json({
          ...responseBody,
          is_replay: true
        });
      }

      // If existing is pending
      if (existing.status === 'pending') {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(200).json({
          job_id: existing.job_id,
          status: 'pending',
          is_replay: true,
          message: 'Operation currently in progress'
        });
      }
    }

    // New request: insert pending record
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const assignedJobId = `req_${crypto.randomUUID()}`;
    idempotencyService.db.run(`
      INSERT INTO idempotency_records (key, request_hash, job_id, status, created_at, expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `, key, requestHash, assignedJobId, now.toISOString(), expiresAt);

    // Intercept response to store completion
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const jobId = body?.job_id || null;
        const status = (res.statusCode >= 200 && res.statusCode < 400) ? 'completed' : 'failed';
        idempotencyService.db.run(`
          UPDATE idempotency_records
          SET status = ?,
              job_id = COALESCE(?, job_id),
              response_status = ?,
              response_body = ?
          WHERE key = ?
        `, status, jobId, res.statusCode, JSON.stringify(body), key);
      } catch (err) {
        logger.warn(`Idempotency completion write failed: ${err.message}`, { key });
      }
      return originalJson(body);
    };

    next();
  } catch (err) {
    next(err);
  }
}

export default idempotencyMiddleware;
