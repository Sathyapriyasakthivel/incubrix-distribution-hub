import crypto from 'node:crypto';
import { getDatabase } from '../../database/db.js';
import registry from '../../connectors/ConnectorRegistry.js';
import rulesEngine from '../rules/rulesEngine.js';
import idempotencyService from '../idempotency/idempotencyService.js';
import jobQueue from '../jobs/jobQueue.js';
import buildOutputManifest from '../../utils/manifest.js';
import {
  IncuBrixError,
  FrequencyCapError,
  DestinationSpecViolationError,
  DestinationNotCertifiedError,
  DestinationDemotedError,
  DestinationSelfPromoError,
  DestinationLinkPolicyError,
  DestinationAiDisclosureError
} from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/index.js';
import resilienceService from '../resilience/resilienceService.js';

export class PublishingService {
  constructor(db = null) {
    this._db = db;
    // Register background job queue handler
    jobQueue.registerHandler('publish', this.executePublishJob.bind(this));
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  /**
   * Submit publication request (Coordinates idempotency, rules, and background queue)
   * @param {Object} input - { destination_id, title, body, canonical_url, media_urls, is_ai_generated, is_promotional, callback_url, simulation, tailor }
   * @param {Object} context - { idempotencyKey, correlationId }
   */
  async submitPublication(input, context = {}) {
    const startTime = Date.now();
    const { idempotencyKey, correlationId } = context;

    // 1. Fetch Destination
    const destination = this.db.get('SELECT * FROM destinations WHERE id = ?', input.destination_id);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination with ID '${input.destination_id}' not found`, {}, 404);
    }

    // 1b. Enforce Certification Check
    if (destination.status === 'demoted') {
      const demotedErr = new DestinationDemotedError(`Destination '${destination.name}' has been demoted and cannot accept publications.`);
      if (idempotencyKey) idempotencyService.fail(idempotencyKey, demotedErr.toJSON());
      throw demotedErr;
    }
    if (destination.status !== 'certified') {
      const notCertErr = new DestinationNotCertifiedError(`Destination '${destination.name}' is not certified (current status: '${destination.status}'). Publishing requires certified status.`);
      if (idempotencyKey) idempotencyService.fail(idempotencyKey, notCertErr.toJSON());
      throw notCertErr;
    }

    // 1c. Circuit Breaker Check
    if (resilienceService.isCircuitOpen(destination.id, destination.connector_key)) {
      const circuitErr = new IncuBrixError(
        'PLATFORM_CIRCUIT_OPEN',
        `Circuit breaker is OPEN for destination '${destination.name}' (${destination.connector_key}) after consecutive failures. Calls are suspended until reset.`,
        { circuit_open: true },
        503,
        true
      );
      if (idempotencyKey) idempotencyService.fail(idempotencyKey, circuitErr.toJSON());
      throw circuitErr;
    }

    // 1d. Header-based Rate Limit / Reschedule Check
    const rateLimit = resilienceService.getRateLimit(destination.id, destination.connector_key);
    if (rateLimit.isRateLimited) {
      logger.info(`Destination '${destination.name}' or connector '${destination.connector_key}' is rate-limited until ${rateLimit.retry_at}. Returning rescheduled job.`, {
        destination_id: destination.id,
        connector_key: destination.connector_key,
        retry_at: rateLimit.retry_at
      });

      const rescheduledJob = jobQueue.createJob({
        id: 'job_' + crypto.randomUUID(),
        destination_id: destination.id,
        connector_key: destination.connector_key,
        idempotency_key: idempotencyKey,
        title: input.title,
        body: input.body,
        canonical_url: input.canonical_url,
        media_urls: input.media_urls,
        is_ai_generated: input.is_ai_generated,
        is_promotional: input.is_promotional,
        callback_url: input.callback_url,
        simulation: input.simulation !== undefined ? input.simulation : destination.simulation_mode,
        run_at: rateLimit.retry_at,
        status: 'queued'
      });

      if (idempotencyKey) {
        try {
          this.db.run('UPDATE idempotency_records SET job_id = ? WHERE key = ?', rescheduledJob.job_id, idempotencyKey);
        } catch {}
      }

      return {
        job_id: rescheduledJob.job_id,
        status: 'queued',
        run_at: rateLimit.retry_at,
        retry_at: rateLimit.retry_at,
        progress: 0
      };
    }

    // 2. Pre-generate Job ID and Check Idempotency Key
    const jobId = 'job_' + crypto.randomUUID();

    if (idempotencyKey) {
      const { isNew, existingRecord } = idempotencyService.acquire(idempotencyKey, input, jobId);
      if (!isNew && existingRecord) {
        // Return existing job status or result
        const existingJob = jobQueue.getJob(existingRecord.job_id);
        if (existingJob) {
          // Retrying the same Idempotency-Key with same body after a failed job must re-queue the same job
          if (existingJob.status === 'failed') {
            logger.info(`Re-queueing failed job for idempotency key: ${idempotencyKey}`, { job_id: existingJob.job_id });
            idempotencyService.reset(idempotencyKey);
            return jobQueue.requeueJob(existingJob.job_id);
          }
          logger.info(`Replaying existing job for idempotency key: ${idempotencyKey}`, { job_id: existingJob.job_id });
          return {
            is_replay: true,
            job_id: existingJob.job_id,
            status: existingJob.status,
            progress: existingJob.progress,
            live_url: existingJob.live_url,
            platform_post_id: existingJob.platform_post_id
          };
        }
      }
    }

    // 2b. Pre-flight connector.validate() call
    if (registry.hasConnector(destination.connector_key)) {
      const connector = registry.getConnector(destination.connector_key);
      const validation = await connector.validate(input, destination, {});
      if (!validation.ok) {
        const specError = new DestinationSpecViolationError(
          validation.violations.map(v => v.message).join('; '),
          {
            code: 'DEST_SPEC_VIOLATION',
            violations: validation.violations.map(v => ({
              rule: 'DEST_SPEC_VIOLATION',
              field: v.field,
              message: v.message
            }))
          }
        );
        if (idempotencyKey) {
          idempotencyService.fail(idempotencyKey, specError.toJSON());
        }
        throw specError;
      }
    }

    // 2c. Pre-flight secret_ref verification outside simulation mode
    const isDestSimulation = Boolean(destination.simulation_mode && destination.simulation_mode !== 0 && destination.simulation_mode !== '0');
    if (!isDestSimulation && destination.secret_ref && !process.env[destination.secret_ref]) {
      const { ConnectionSecretMissingError } = await import('../../utils/errors.js');
      const secretErr = new ConnectionSecretMissingError(`Connection secret '${destination.secret_ref}' missing from environment for destination '${destination.name}'`);
      if (idempotencyKey) {
        idempotencyService.fail(idempotencyKey, secretErr.toJSON());
      }
      throw secretErr;
    }

    // 3. Pre-flight Rule Evaluation
    const ruleResult = rulesEngine.evaluate(input, destination, { correlationId, tailor: input.tailor });

    if (ruleResult.decision === 'BLOCK') {
      let violationError;
      if (ruleResult.triggered_rules.includes('DEST_DEMOTED')) {
        violationError = new DestinationDemotedError(ruleResult.reason, { violations: ruleResult.violations });
      } else if (ruleResult.triggered_rules.includes('DEST_NOT_CERTIFIED')) {
        violationError = new DestinationNotCertifiedError(ruleResult.reason, { violations: ruleResult.violations });
      } else if (ruleResult.triggered_rules.includes('DEST_RULE_SELF_PROMO')) {
        violationError = new DestinationSelfPromoError(ruleResult.reason, { violations: ruleResult.violations });
      } else if (ruleResult.triggered_rules.includes('DEST_RULE_LINK_POLICY')) {
        violationError = new DestinationLinkPolicyError(ruleResult.reason, { violations: ruleResult.violations });
      } else if (ruleResult.triggered_rules.includes('DEST_RULE_AI_DISCLOSURE')) {
        violationError = new DestinationAiDisclosureError(ruleResult.reason, { violations: ruleResult.violations });
      } else if (ruleResult.triggered_rules.includes('DEST_SPEC_VIOLATION')) {
        violationError = new DestinationSpecViolationError(ruleResult.reason, { violations: ruleResult.violations });
      } else {
        violationError = new IncuBrixError('RULE_VIOLATION_BLOCK', ruleResult.reason, { violations: ruleResult.violations }, 422, false);
      }

      if (idempotencyKey) {
        idempotencyService.fail(idempotencyKey, violationError.toJSON());
      }
      throw violationError;
    }

    if (ruleResult.decision === 'RESCHEDULE') {
      const freqError = new FrequencyCapError(ruleResult.reason, {
        code: 'DEST_RULE_FREQUENCY_CAP',
        retry_at: ruleResult.retry_at,
        reschedule_after: ruleResult.retry_at,
        violations: ruleResult.violations
      });

      if (idempotencyKey) {
        idempotencyService.fail(idempotencyKey, freqError.toJSON());
      }
      throw freqError;
    }

    // 4. Content Tailoring
    let publishTitle = input.title;
    let publishBody = input.body;
    let publishCanonicalUrl = input.canonical_url;
    let tailoringWarnings = [];

    if (input.tailor) {
      const { default: tailoringRecommender } = await import('../ai/tailoringRecommender.js');
      const tailored = tailoringRecommender.tailorContent(input, destination);
      publishTitle = tailored.title;
      publishBody = tailored.body;
      publishCanonicalUrl = tailored.canonical_url;
      tailoringWarnings = tailored.warnings || [];
    }

    // 5. Create Job in Database Queue
    const jobRecord = jobQueue.createJob({
      id: jobId,
      destination_id: destination.id,
      connector_key: destination.connector_key,
      idempotency_key: idempotencyKey,
      title: publishTitle,
      body: publishBody,
      canonical_url: publishCanonicalUrl,
      media_urls: input.media_urls,
      is_ai_generated: input.is_ai_generated,
      is_promotional: input.is_promotional,
      tailoring_warnings: JSON.stringify(tailoringWarnings),
      callback_url: input.callback_url,
      simulation: input.simulation !== undefined ? input.simulation : destination.simulation_mode
    });

    // Update idempotency record with created job_id
    if (idempotencyKey) {
      try {
        this.db.run('UPDATE idempotency_records SET job_id = ? WHERE key = ?', jobRecord.job_id, idempotencyKey);
      } catch (err) {
        logger.warn('Failed to link idempotency record to job', { error: err.message });
      }
    }

    return jobRecord;
  }

  /**
   * Execute publish job with retry and backoff handling
   */
  async executePublishJob(job, onProgress) {
    const startTime = Date.now();
    const destination = this.db.get('SELECT * FROM destinations WHERE id = ?', job.destination_id);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', 'Destination not found during execution', {}, 404);
    }

    onProgress(30);

    // Retrieve connection credentials if present
    const authRow = this.db.get('SELECT * FROM auth_configs WHERE destination_id = ?', destination.id);
    let connection = {};
    if (authRow && authRow.credentials) {
      try {
        connection = JSON.parse(authRow.credentials);
      } catch {
        connection = {};
      }
    }
    // Propagate destination's own base URL
    connection.base_url = connection.base_url || destination.url;

    // Resolve secrets from env via secret_ref
    if (destination.secret_ref && process.env[destination.secret_ref]) {
      const envSecret = process.env[destination.secret_ref];
      connection.secret = envSecret;
      connection.token = envSecret;
      connection.jwt = envSecret;
      connection.apiKey = envSecret;
      connection.api_key = envSecret;
      connection.admin_key = envSecret;
    }

    // Format rendition
    const rendition = {
      title: job.title,
      body: job.body,
      canonical_url: job.canonical_url,
      media_urls: job.media_urls ? JSON.parse(job.media_urls) : [],
      is_ai_generated: Boolean(job.is_ai_generated),
      is_promotional: Boolean(job.is_promotional)
    };

    // Circuit Breaker Check
    if (resilienceService.isCircuitOpen(destination.id, destination.connector_key)) {
      const circuitErr = new IncuBrixError(
        'PLATFORM_CIRCUIT_OPEN',
        `Circuit breaker is OPEN for destination '${destination.name}' (${destination.connector_key}) after consecutive failures. Calls are suspended until reset.`,
        { circuit_open: true },
        503,
        true
      );
      jobQueue.failJob(job.id, circuitErr);
      if (job.idempotency_key) idempotencyService.fail(job.idempotency_key, circuitErr.message);
      return;
    }

    // Rate Limit Check
    const activeRateLimit = resilienceService.getRateLimit(destination.id, destination.connector_key);
    if (activeRateLimit.isRateLimited) {
      logger.info(`Job ${job.id} deferred due to active rate limit until ${activeRateLimit.retry_at}`);
      jobQueue.rescheduleJob(job.id, activeRateLimit.retry_at);
      return;
    }

    onProgress(50);

    // Safe retries across timeout: check or record publish_attempts and findByMarker
    let publishResult = null;
    let lastError = null;
    let attempt = 0;

    if (job.idempotency_key) {
      const marker = `<!-- incubrix_marker:${job.idempotency_key} -->`;
      const connector = registry.getConnector(job.connector_key);

      // Check existing attempt in publish_attempts
      const existingAttempt = this.db.get(
        'SELECT * FROM publish_attempts WHERE connector_key = ? AND destination_id = ? AND idempotency_key = ?',
        job.connector_key, destination.id, job.idempotency_key
      );

      if (existingAttempt) {
        if (existingAttempt.state === 'done' && existingAttempt.result) {
          try {
            publishResult = JSON.parse(existingAttempt.result);
          } catch {
            publishResult = null;
          }
        } else if (existingAttempt.state === 'pending') {
          // Before any re-publish of a pending attempt, call findByMarker()
          try {
            const found = await connector.findByMarker(marker, destination, connection)
              || (job.connector_key === 'webhook' ? await connector.findByMarker(job.idempotency_key, destination, connection) : null);
            if (found) {
              publishResult = found;
              this.db.run(
                "UPDATE publish_attempts SET state = 'done', result = ?, updated_at = ? WHERE id = ?",
                JSON.stringify(found), new Date().toISOString(), existingAttempt.id
              );
            }
          } catch (markerErr) {
            logger.warn(`findByMarker check failed: ${markerErr.message}`);
          }
        }
      } else {
        // Record new pending attempt
        const attemptId = 'att_' + crypto.randomUUID();
        const now = new Date().toISOString();
        this.db.run(
          "INSERT INTO publish_attempts (id, connector_key, destination_id, idempotency_key, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)",
          attemptId, job.connector_key, destination.id, job.idempotency_key, now, now
        );
      }
    }

    if (!publishResult) {
      // Bounded retries for retryable errors
      attempt = 0;
      const maxRetries = config.limits.maxRetries || 3;

      while (attempt < maxRetries) {
        attempt++;
        try {
          // If this is a retry (attempt > 1) and we have an idempotency key, check findByMarker before posting again
          if (attempt > 1 && job.idempotency_key) {
            const marker = `<!-- incubrix_marker:${job.idempotency_key} -->`;
            const connector = registry.getConnector(job.connector_key);
            try {
              const found = await connector.findByMarker(marker, destination, connection)
                || (job.connector_key === 'webhook' ? await connector.findByMarker(job.idempotency_key, destination, connection) : null);
              if (found) {
                publishResult = found;
                lastError = null;
                break;
              }
            } catch (markerErr) {
              logger.warn(`findByMarker on retry attempt ${attempt} failed: ${markerErr.message}`);
            }
          }

          publishResult = await registry.publish(
            job.connector_key,
            rendition,
            destination,
            connection,
            job.idempotency_key
          );
          lastError = null;

          // Record success for circuit breaker
          resilienceService.recordSuccess('dest:' + destination.id);
          resilienceService.recordSuccess('conn:' + destination.connector_key);
          break; // Success
        } catch (err) {
          lastError = err;
          logger.warn(`Publish attempt ${attempt} failed: ${err.message}`, {
            job_id: job.id,
            code: err.code,
            retryable: err.retryable
          });

          // Even if err occurred (e.g. timeout_after_commit), check if post was actually committed on platform!
          if (job.idempotency_key) {
            const marker = `<!-- incubrix_marker:${job.idempotency_key} -->`;
            const connector = registry.getConnector(job.connector_key);
            try {
              const found = await connector.findByMarker(marker, destination, connection)
                || (job.connector_key === 'webhook' ? await connector.findByMarker(job.idempotency_key, destination, connection) : null);
              if (found) {
                publishResult = found;
                lastError = null;
                resilienceService.recordSuccess('dest:' + destination.id);
                resilienceService.recordSuccess('conn:' + destination.connector_key);
                break;
              }
            } catch {}
          }

          // Rate limit or daily quota exhausted: store reset time and reschedule job
          if (err.code === 'PLATFORM_RATE_LIMIT' || err.code === 'PLATFORM_QUOTA_EXHAUSTED') {
            const retryAt = err.details?.retry_at || new Date(Date.now() + (err.details?.retryAfter || 60) * 1000).toISOString();
            resilienceService.setRateLimit(destination.id, job.connector_key, retryAt);
            logger.info(`Platform rate limit or quota hit. Rescheduling job ${job.id} to ${retryAt}`);
            jobQueue.rescheduleJob(job.id, retryAt);
            if (job.idempotency_key) {
              idempotencyService.complete(job.idempotency_key, 200, {
                job_id: job.id,
                status: 'queued',
                run_at: retryAt,
                retry_at: retryAt
              });
            }
            return;
          }

          // Record failure on circuit breaker for unavailable platforms
          if (err.code === 'PLATFORM_UNAVAILABLE') {
            resilienceService.recordFailure('dest:' + destination.id);
            resilienceService.recordFailure('conn:' + destination.connector_key);
          }

          if (!err.retryable || attempt >= maxRetries) {
            break; // Stop immediately for non-retryable errors
          }

          // Backoff wait using exact header-indicated retryAfter or linear fallback (no 3s cap)
          const retryAfterSeconds = err.details?.retryAfter || 1;
          const backoffMs = retryAfterSeconds * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    if (publishResult && job.idempotency_key) {
      this.db.run(
        "UPDATE publish_attempts SET state = 'done', result = ?, updated_at = ? WHERE idempotency_key = ? AND destination_id = ?",
        JSON.stringify(publishResult), new Date().toISOString(), job.idempotency_key, destination.id
      );
    } else if (lastError && job.idempotency_key) {
      this.db.run(
        "UPDATE publish_attempts SET state = 'failed', result = ?, updated_at = ? WHERE idempotency_key = ? AND destination_id = ?",
        JSON.stringify({ error: lastError.message, code: lastError.code }), new Date().toISOString(), job.idempotency_key, destination.id
      );
    }

    if (lastError || !publishResult) {
      const err = lastError || new Error('Publication failed after max retries');
      jobQueue.failJob(job.id, err);
      if (job.idempotency_key) {
        idempotencyService.fail(job.idempotency_key, err.message);
      }
      return;
    }

    onProgress(85);

    // Build output manifest with populated warnings from execution
    const warnings = [];
    if (job.tailoring_warnings) {
      try {
        const tw = JSON.parse(job.tailoring_warnings);
        if (Array.isArray(tw)) warnings.push(...tw);
      } catch {}
    }
    if (rendition.is_ai_generated) {
      warnings.push('Content marked as AI-generated; verified disclosure compatibility');
    }
    if (attempt > 1) {
      warnings.push(`Post recovered and completed after attempt ${attempt}`);
    }

    const manifest = buildOutputManifest({
      connectorKey: job.connector_key,
      startTime,
      endTime: Date.now(),
      warnings,
      isAiGenerated: rendition.is_ai_generated,
      settings: {
        destination_id: destination.id,
        platform_key: destination.platform_key
      }
    });

    jobQueue.completeJob(job.id, {
      platform_post_id: publishResult.platform_post_id,
      live_url: publishResult.live_url,
      manifest
    });

    if (job.idempotency_key) {
      idempotencyService.complete(job.idempotency_key, 200, {
        job_id: job.id,
        status: 'succeeded',
        live_url: publishResult.live_url,
        platform_post_id: publishResult.platform_post_id
      });
    }
  }
}

export const publishingService = new PublishingService();
export default publishingService;
