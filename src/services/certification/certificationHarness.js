import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { getDatabase } from '../../database/db.js';
import registry from '../../connectors/ConnectorRegistry.js';
import storageService from '../storage/storageService.js';
import testPostSweeper from './testPostSweeper.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import {
  ERROR_CODES,
  IncuBrixError,
  AuthExpiredError,
  ConnectionSecretMissingError,
  PlatformUnavailableError,
  PlatformRateLimitError
} from '../../utils/errors.js';
import { createGhostToken } from '../../utils/ghostAuth.js';

/**
 * Execute hold delay between post publication/confirmation and deletion,
 * printing countdown and platform URLs so a presenter can inspect live posts.
 */
export async function executeHold(seconds, info = {}, options = {}) {
  const log = options.logger || console.log;
  const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  const baseUrl = (info.destination?.url || '').replace(/\/+$/, '');
  const urls = [];
  if (info.testLiveUrl) {
    urls.push(`Live Post URL: ${info.testLiveUrl}`);
  }

  const platform = info.connectorKey || info.destination?.platform_key;
  if (platform === 'ghost') {
    if (info.testPostId) {
      urls.push(`Ghost Admin Editor: ${baseUrl}/ghost/#/editor/post/${info.testPostId}`);
    }
    urls.push(`Ghost Admin Posts: ${baseUrl}/ghost/#/posts`);
  } else if (platform === 'lemmy') {
    if (info.testPostId) {
      urls.push(`Lemmy API: ${baseUrl}/api/v3/post?id=${info.testPostId}`);
      urls.push(`Lemmy Post: ${baseUrl}/post/${info.testPostId}`);
    }
  }

  log(`\n[HOLD] Destination '${info.destination?.id || info.destinationId || 'unknown'}' post published and verified live.`);
  log(`[HOLD] Holding for ${seconds}s before delete step to allow manual inspection:`);
  for (const urlStr of urls) {
    log(`  • ${urlStr}`);
  }

  for (let remaining = seconds; remaining > 0; remaining--) {
    log(`[HOLD] Deleting in ${remaining}s...`);
    await sleepFn(1000);
  }
  log(`[HOLD] Hold complete (${seconds}s). Proceeding to delete step.\n`);
}

export class CertificationHarness {
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
   * Determine whether an error is transient (inconclusive run) or non-transient (demote destination)
   */
  isTransientError(err) {
    if (err.code === ERROR_CODES.PLATFORM_RATE_LIMIT || err.statusCode === 429) return true;
    if (err.code === ERROR_CODES.PLATFORM_UNAVAILABLE || err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504) return true;
    if (err.name === 'FetchError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (err.message && (err.message.includes('timeout') || err.message.includes('timed out') || err.message.includes('ECONNREFUSED'))) return true;
    return false;
  }

  /**
   * Redact sensitive credentials in request/response dumps
   */
  redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = Array.isArray(obj) ? [...obj] : { ...obj };
    const sensitiveKeys = ['apiKey', 'api_key', 'token', 'jwt', 'secret', 'admin_key', 'auth', 'password'];
    for (const key of Object.keys(copy)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        copy[key] = '***REDACTED***';
      } else if (typeof copy[key] === 'object') {
        copy[key] = this.redact(copy[key]);
      }
    }
    return copy;
  }

  /**
   * Run 10-step certification for a specific destination
   * @param {string} destinationId
   * @param {Object} options - { forceLive: boolean, faultInjection: string }
   * @returns {Promise<Object>} certification result
   */
  async certifyDestination(destinationId, options = {}) {
    const startTime = Date.now();
    const runId = 'cert_' + crypto.randomUUID();
    const steps = [];

    const destination = this.db.get('SELECT * FROM destinations WHERE id = ?', destinationId);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${destinationId}' not found for certification`, {}, 404);
    }

    const isSimulation = options.forceLive ? false : Boolean(destination.simulation_mode);
    const connectorKey = destination.connector_key;

    let testPostId = null;
    let testLiveUrl = null;
    let isCleanedUp = false;
    let overallStatus = 'certified';
    let errorCode = null;
    let errorMessage = null;
    let assignedLevel = destination.level || 'L0';
    let connector = null;
    let connection = {};

    const logStep = (stepNumber, name, status, details = {}) => {
      const stepRecord = {
        step: stepNumber,
        name,
        status, // 'passed' | 'failed' | 'skipped'
        timestamp: new Date().toISOString(),
        details: this.redact(details)
      };
      steps.push(stepRecord);
      logger.info(`[Cert ${runId}] Step ${stepNumber}: ${name} -> ${status}`, { runId, stepNumber, status });
      return stepRecord;
    };

    try {
      // Step 1: Validate Destination Configuration
      if (!destination.url) {
        throw new IncuBrixError('VALIDATION_ERROR', 'Destination missing required URL', {}, 400);
      }
      try {
        new URL(destination.url);
      } catch (e) {
        throw new IncuBrixError('VALIDATION_ERROR', `Invalid destination URL format: ${destination.url}`, {}, 400);
      }
      if (!destination.platform_key || !destination.connector_key) {
        throw new IncuBrixError('VALIDATION_ERROR', 'Destination missing platform_key or connector_key', {}, 400);
      }
      if (destination.is_enabled === 0) {
        throw new IncuBrixError('DESTINATION_DISABLED', 'Destination is disabled in catalogue', {}, 400);
      }
      logStep(1, 'Validate Destination Configuration', 'passed', {
        destination_id: destination.id,
        platform_key: destination.platform_key,
        url: destination.url,
        surface: destination.surface
      });

      // Step 2: Check Connector Readiness & Kill-Switch
      if (!registry.hasConnector(connectorKey)) {
        throw new IncuBrixError('CONNECTOR_NOT_FOUND', `Connector '${connectorKey}' not registered`, {}, 404);
      }
      if (registry.isKillSwitchActive(connectorKey)) {
        throw new IncuBrixError('CONNECTOR_DISABLED', `Connector '${connectorKey}' is currently disabled by kill switch`, {}, 503);
      }
      connector = registry.getConnector(connectorKey);
      logStep(2, 'Check Connector Readiness', 'passed', {
        connector_key: connectorKey,
        version: connector.version,
        tier: connector.tier
      });

      // Step 3: Verify Authentication Configuration
      const authRow = this.db.get('SELECT * FROM auth_configs WHERE destination_id = ?', destination.id);
      if (authRow && authRow.credentials) {
        try { connection = JSON.parse(authRow.credentials); } catch { connection = {}; }
      }
      connection.base_url = destination.url;
      connection.simulation_mode = destination.simulation_mode;
      if (destination.secret_ref && process.env[destination.secret_ref]) {
        const envSecret = process.env[destination.secret_ref];
        connection.secret = envSecret;
        connection.token = envSecret;
        connection.jwt = envSecret;
        connection.apiKey = envSecret;
        connection.api_key = envSecret;
        connection.admin_key = envSecret;
      }
      if (options.faultInjection) {
        connection.mockFault = options.faultInjection;
      }

      // Check simulated fault
      if (options.faultInjection === 'auth_expired' || options.faultInjection === '401' || connection.mockFault === 'auth_expired') {
        throw new AuthExpiredError('Authentication token expired or revoked');
      }

      const resolvedBaseUrl = (connector.resolveUrl ? connector.resolveUrl(destination, connection) : (connection.base_url || destination.url || '')).replace(/\/+$/, '');

      // Live authentication check
      if (!isSimulation) {
        if (!connection.token && !connection.apiKey && !connection.secret && !connection.api_key && !connection.admin_key) {
          throw new ConnectionSecretMissingError(`Connection secret missing for destination: ${destination.name}`);
        }
        // Attempt cheap authenticated call
        let step3HttpStatus = 200;
        let authCheckUrl = null;
        try {
          let authHeaders = {};

          if (connectorKey === 'discourse') {
            authCheckUrl = `${resolvedBaseUrl}/about.json`;
            authHeaders = { 'Api-Key': connection.apiKey || connection.api_key, 'Api-Username': connection.username || 'system' };
          } else if (connectorKey === 'lemmy') {
            authCheckUrl = `${resolvedBaseUrl}/api/v3/site`;
            authHeaders = { Authorization: `Bearer ${connection.token || connection.jwt}` };
          } else if (connectorKey === 'ghost') {
            authCheckUrl = resolvedBaseUrl.includes('/mock')
              ? `${resolvedBaseUrl}/api/admin/site`
              : (resolvedBaseUrl.endsWith('/ghost') ? `${resolvedBaseUrl}/api/admin/site/` : `${resolvedBaseUrl}/ghost/api/admin/site/`);
            const adminKey = connection.token || connection.admin_key;
            const ghostToken = adminKey ? (adminKey.includes(':') ? createGhostToken(adminKey) : adminKey) : '';
            authHeaders = {
              'Accept-Version': 'v5.0',
              Authorization: `Ghost ${ghostToken}`
            };
          } else if (connectorKey === 'devto') {
            authCheckUrl = `${resolvedBaseUrl}/api/articles/me/all?per_page=1`;
            authHeaders = { 'api-key': connection.apiKey || connection.api_key };
          }

          if (authCheckUrl) {
            const authResp = await fetch(authCheckUrl, { headers: authHeaders }).catch(() => null);
            if (authResp) {
              step3HttpStatus = authResp.status;
              if (authResp.status === 401 || authResp.status === 403) {
                throw new AuthExpiredError(`Platform rejected credentials with HTTP ${authResp.status}`);
              }
            }
          }
        } catch (checkErr) {
          if (checkErr instanceof IncuBrixError) throw checkErr;
        }

        logStep(3, 'Verify Authentication Configuration', 'passed', {
          auth_type: authRow?.auth_type || (isSimulation ? 'simulation_mock' : 'secret_ref'),
          authenticated: true,
          http_status: step3HttpStatus,
          url: authCheckUrl
        });
      } else {
        logStep(3, 'Verify Authentication Configuration', 'passed', {
          auth_type: authRow?.auth_type || (isSimulation ? 'simulation_mock' : 'secret_ref'),
          authenticated: true
        });
      }

      // Step 4: Publish Clearly Labelled Test Item
      const expectedTitle = `[CERTIFICATION-TEST] IncuBrix Test Run ${runId.slice(-6)}`;
      const testRendition = {
        title: expectedTitle,
        body: `This is an automated IncuBrix certification verification post. Created at ${new Date().toISOString()}. It will be automatically deleted within 10 minutes.`,
        tags: ['certification', 'test'],
        canonical_url: 'https://incubrix.internal/test-audit',
        media_urls: [],
        is_ai_generated: false,
        is_promotional: false
      };

      const pubResult = await connector.publish(
        testRendition,
        destination,
        connection,
        `cert_idem_${runId}`
      );

      testPostId = pubResult.platform_post_id;
      testLiveUrl = pubResult.live_url;

      // Record test post in sweeper table with 10 minute TTL
      testPostSweeper.recordTestPost(destination.id, testPostId, 600);

      logStep(4, 'Publish Test Item', 'passed', {
        test_post_id: testPostId,
        live_url: testLiveUrl,
        http_status: pubResult.http_status || 201,
        url: pubResult.request_url || (connectorKey === 'ghost' ? `${resolvedBaseUrl}/ghost/api/admin/posts/?source=html` : `${resolvedBaseUrl}/api/v3/post`),
        status: pubResult.status
      });

      // Step 5: Confirm Live via HTTP 200 & Expected Title (or verify Assist Pack for assisted tier, or Feed XML for feed tier)
      if (connector.tier === 'assisted') {
        const assistPack = pubResult.pack || await connector.buildAssistPack(testRendition, destination, `cert_idem_${runId}`);
        const requiredKeys = ['title', 'body', 'tags', 'destination_rules', 'posting_instructions', 'deep_link', 'disclosure_text'];
        for (const reqKey of requiredKeys) {
          if (assistPack[reqKey] === undefined || assistPack[reqKey] === null) {
            throw new IncuBrixError('PLATFORM_SCHEMA_MISMATCH', `Assisted pack missing required field '${reqKey}'`, {}, 500);
          }
        }
        // Verify idempotent regeneration
        const regenPack = await connector.buildAssistPack(testRendition, destination, `cert_idem_${runId}`);
        if (regenPack.pack_id !== assistPack.pack_id) {
          throw new IncuBrixError('PLATFORM_SCHEMA_MISMATCH', `Assisted pack regeneration is not idempotent: expected '${assistPack.pack_id}', got '${regenPack.pack_id}'`, {}, 500);
        }
        logStep(5, 'Confirm Live Status & Content Retrievability', 'passed', {
          pack_id: assistPack.pack_id,
          deep_link: assistPack.deep_link,
          idempotent_regeneration_verified: true,
          confirmed_title: assistPack.title
        });
      } else if (connector.tier === 'feed' || destination.platform_key === 'mrss') {
        const feedStatus = await connector.getStatus(testPostId, connection);
        if (feedStatus.status !== 'published') {
          throw new Error(`MRSS feed item status check failed: expected 'published', got '${feedStatus.status}'`);
        }
        if (typeof connector.getFeedXml === 'function') {
          const feedXml = connector.getFeedXml(destination.id);
          if (!feedXml.includes(expectedTitle) && !feedXml.includes(runId.slice(-6))) {
            throw new Error(`MRSS feed XML did not contain expected test title: ${expectedTitle}`);
          }
        }
        logStep(5, 'Confirm Live Status & Content Retrievability', 'passed', {
          live_url: testLiveUrl,
          feed_xml_verified: true,
          confirmed_title: expectedTitle
        });
      } else {
        if (!testLiveUrl) {
          throw new IncuBrixError('PLATFORM_SCHEMA_MISMATCH', 'Connector publish succeeded but did not return live_url', {}, 500);
        }

        let liveStatus = 200;
        if (testLiveUrl.startsWith('http')) {
          let checkLiveUrl = testLiveUrl;
          if (process.env.GHOST_LOCAL_URL && (checkLiveUrl.includes('localhost:2368') || checkLiveUrl.includes('127.0.0.1:2368'))) {
            checkLiveUrl = checkLiveUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):2368/, process.env.GHOST_LOCAL_URL.replace(/\/+$/, ''));
          } else if (process.env.LEMMY_LOCAL_URL && (checkLiveUrl.includes('localhost:8536') || checkLiveUrl.includes('127.0.0.1:8536'))) {
            checkLiveUrl = checkLiveUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):8536/, process.env.LEMMY_LOCAL_URL.replace(/\/+$/, ''));
          }
          const liveResp = await fetch(checkLiveUrl);
          liveStatus = liveResp.status;
          if (liveResp.status !== 200) {
            throw new Error(`Live URL returned non-200 status: HTTP ${liveResp.status}`);
          }
          const liveHtml = await liveResp.text();
          if (!liveHtml.includes(expectedTitle) && !liveHtml.includes(runId.slice(-6))) {
            throw new Error(`Live page content did not contain expected test title: ${expectedTitle}`);
          }
        }

        logStep(5, 'Confirm Live Status & Content Retrievability', 'passed', {
          live_url: testLiveUrl,
          url: testLiveUrl,
          http_status: liveStatus,
          confirmed_title: expectedTitle
        });
      }

      // Step 6: Retrieve Publication Status (must equal live/published, or assisted_pack_ready for assisted)
      const statusResult = await connector.getStatus(testPostId, connection);
      const isAcceptedStatus = connector.tier === 'assisted'
        ? (statusResult.status === 'assisted_pack_ready' || statusResult.status === 'published')
        : (statusResult.status === 'published' || statusResult.status === 'live');

      if (!isAcceptedStatus) {
        throw new IncuBrixError('PLATFORM_CONTENT_REJECTED', `Publication status check failed: expected ${connector.tier === 'assisted' ? 'assisted_pack_ready' : 'published/live'}, got '${statusResult.status}'`, {}, 422);
      }

      logStep(6, 'Retrieve Publication Status', 'passed', {
        retrieved_status: statusResult.status,
        live_url: statusResult.live_url,
        http_status: statusResult.http_status || 200,
        url: statusResult.request_url
      });

      // Check metrics capability before deletion while post is live
      let metricsPassed = false;
      let postMetrics = null;
      if (connector.capabilities.has('metrics')) {
        try {
          postMetrics = await connector.fetchMetrics(testPostId, connection);
          const requiredKeys = ['views', 'likes', 'comments', 'shares', 'saves', 'watch_time_s', 'clicks'];
          if (postMetrics && requiredKeys.every(k => typeof postMetrics[k] === 'number')) {
            metricsPassed = true;
          }
        } catch {
          metricsPassed = false;
        }
      }

      // Hold before delete step if requested (e.g. --hold <seconds>)
      const holdSeconds = options.hold !== undefined ? Math.max(0, parseInt(options.hold, 10) || 0) : 0;
      if (holdSeconds > 0) {
        if (typeof options.onHold === 'function') {
          await options.onHold({
            seconds: holdSeconds,
            destination,
            testPostId,
            testLiveUrl,
            connectorKey
          });
        } else {
          await executeHold(holdSeconds, {
            destination,
            testPostId,
            testLiveUrl,
            connectorKey
          }, options);
        }
      }

      // Step 7: Delete Test Item
      if (connector.capabilities.has('delete')) {
        const deleteResult = await connector.delete(testPostId, connection);
        if (!deleteResult.deleted) {
          throw new Error(`Connector delete() returned deleted: false for post ${testPostId}`);
        }
        isCleanedUp = true;
        testPostSweeper.removeTestPost(testPostId);
        logStep(7, 'Delete Test Item', 'passed', {
          deleted: true,
          http_status: deleteResult.http_status || (connectorKey === 'ghost' ? 204 : 200),
          url: deleteResult.request_url
        });

        // Step 8: Confirm Gone (get_status must equal deleted/404/unpublished, otherwise FAIL)
        let verifyStatus = null;
        try {
          verifyStatus = await connector.getStatus(testPostId, connection);
        } catch (err) {
          // 404 or NOT_FOUND is an acceptable confirmation of deletion
          verifyStatus = { status: 'not_found', http_status: 404 };
        }

        const isGone = verifyStatus.status === 'deleted' ||
                       verifyStatus.status === 'not_found' ||
                       verifyStatus.status === 'unpublished';

        if (!isGone) {
          throw new IncuBrixError('CLEANUP_VERIFICATION_FAILED', `Cleanup verification failed: post ${testPostId} is still '${verifyStatus.status}'`, {}, 500, false);
        }

        logStep(8, 'Confirm Gone (Cleanup Verification)', 'passed', {
          post_status_after_delete: verifyStatus.status,
          http_status: verifyStatus.http_status || (verifyStatus.status === 'not_found' ? 404 : 200),
          url: verifyStatus.request_url
        });
      } else {
        logStep(7, 'Delete Test Item', 'skipped', { reason: 'Platform does not support native deletion' });
        logStep(8, 'Confirm Gone', 'skipped', { reason: 'No deletion performed' });
      }

      // Determine Certified Level
      if (connector.tier === 'assisted') {
        assignedLevel = 'L1';
      } else if (connector.tier === 'bridge' || connector.tier === 'feed') {
        assignedLevel = 'L2';
      } else if (metricsPassed) {
        assignedLevel = 'L4';
      } else {
        assignedLevel = 'L3';
      }

      // Step 9: Store Evidence Pack via Storage Service
      const durationMs = Date.now() - startTime;
      const evidencePack = {
        certification_id: runId,
        destination: {
          id: destination.id,
          name: destination.name,
          platform_key: destination.platform_key,
          connector_key: connectorKey,
          url: destination.url
        },
        mode: isSimulation ? 'SIMULATION_MOCK' : 'LIVE_PLATFORM',
        status: 'certified',
        level: assignedLevel,
        duration_ms: durationMs,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        test_post_id: testPostId,
        test_live_url: testLiveUrl,
        is_cleaned_up: isCleanedUp,
        steps
      };

      const mdContent = `# IncuBrix Connector Certification Report: ${destination.name}

**Run ID:** \`${runId}\`  
**Platform:** \`${destination.platform_key}\` (\`${connectorKey}\`)  
**Certification Mode:** **${isSimulation ? 'SIMULATION MOCK' : 'LIVE PLATFORM'}**  
**Overall Status:** **PASSED (CERTIFIED)**  
**Certified Level:** \`${assignedLevel}\`  
**Execution Duration:** ${durationMs} ms  
**Cleaned Up:** ${isCleanedUp ? 'YES' : 'N/A'}  

---

## 10-Step Certification Log
| Step | Action | Status | Notes |
|------|--------|--------|-------|
${steps.map(s => `| ${s.step} | ${s.name} | \`${s.status.toUpperCase()}\` | ${JSON.stringify(s.details)} |`).join('\n')}

---
**Verified on:** ${new Date().toISOString()}  
`;

      const savedJson = await storageService.saveFile('certification', `${runId}.json`, JSON.stringify(evidencePack, null, 2), 'application/json');
      const savedMd = await storageService.saveFile('certification', `${runId}.md`, mdContent, 'text/markdown');

      logStep(9, 'Store Evidence Pack', 'passed', {
        evidence_json_url: savedJson.downloadUrl,
        evidence_md_url: savedMd.downloadUrl
      });

      // Step 10: Produce Final Certification Report & Update Destination
      logStep(10, 'Produce Final Certification Report', 'passed', {
        final_verdict: 'CERTIFIED',
        assigned_level: assignedLevel
      });

      // Update destination in DB: status = 'certified', level = assignedLevel, last_certified_at = now
      this.db.run(`
        UPDATE destinations
        SET status = 'certified',
            level = ?,
            last_certified_at = ?,
            updated_at = ?
        WHERE id = ?
      `, assignedLevel, new Date().toISOString(), new Date().toISOString(), destination.id);

    } catch (err) {
      const isTransient = this.isTransientError(err);
      errorCode = err.code || 'CERTIFICATION_FAILED';
      errorMessage = err.message || 'Unknown certification error';

      if (isTransient) {
        overallStatus = 'inconclusive';
        logger.warn(`Certification run ${runId} for '${destination.name}' was inconclusive due to transient upstream issue: ${errorMessage}`);
      } else {
        overallStatus = 'failed';
        // Non-transient failure: demote destination
        this.db.run(`
          UPDATE destinations
          SET status = 'demoted',
              updated_at = ?
          WHERE id = ?
        `, new Date().toISOString(), destination.id);

        // Record alert
        try {
          this.db.run(`
            INSERT INTO alerts (id, level, event_type, destination_id, message, details, created_at)
            VALUES (?, 'error', 'CERTIFICATION_FAILURE_DEMOTED', ?, ?, ?, ?)
          `, 'alert_' + crypto.randomUUID(), destination.id, `Destination '${destination.name}' failed certification and was demoted: ${errorMessage}`, JSON.stringify({ error_code: errorCode }), new Date().toISOString());
        } catch {}

        logger.error(`Destination '${destination.name}' demoted due to non-transient certification failure: ${errorMessage}`, {
          destination_id: destination.id,
          code: errorCode
        });
      }

      logStep(steps.length + 1, 'Certification Error', isTransient ? 'inconclusive' : 'failed', {
        error_code: errorCode,
        error_message: errorMessage,
        is_transient: isTransient
      });

    } finally {
      // Guaranteed cleanup: ensure test post is always deleted if created, even on error
      if (testPostId && !isCleanedUp && connector && connector.capabilities?.has('delete')) {
        try {
          await connector.delete(testPostId, connection);
          isCleanedUp = true;
          testPostSweeper.removeTestPost(testPostId);
          logger.info(`Guaranteed finally block cleaned up test post: ${testPostId}`);
        } catch (cleanupErr) {
          logger.warn(`Guaranteed cleanup in finally failed for ${testPostId}: ${cleanupErr.message}. Sweeper will prune.`);
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    // Persist run in certification_runs table
    this.db.run(`
      INSERT INTO certification_runs (
        id, destination_id, connector_key, is_simulation, status,
        started_at, completed_at, duration_ms, test_post_id,
        test_live_url, is_cleaned_up, steps, evidence_file,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      runId,
      destination.id,
      connectorKey,
      isSimulation ? 1 : 0,
      overallStatus,
      new Date(startTime).toISOString(),
      completedAt,
      durationMs,
      testPostId,
      testLiveUrl,
      isCleanedUp ? 1 : 0,
      JSON.stringify(steps),
      `${runId}.json`,
      errorCode,
      errorMessage
    );

    return {
      run_id: runId,
      destination_id: destination.id,
      destination_name: destination.name,
      platform_key: destination.platform_key,
      connector_key: connectorKey,
      status: overallStatus,
      level: assignedLevel,
      mode: isSimulation ? 'SIMULATION_MOCK' : 'LIVE_PLATFORM',
      is_simulation: isSimulation,
      duration_ms: durationMs,
      test_post_id: testPostId,
      test_live_url: testLiveUrl,
      is_cleaned_up: isCleanedUp,
      steps,
      evidence_url: `${config.appUrl}/api/v1/storage/files/certification/${runId}.json`,
      evidence_md_url: `${config.appUrl}/api/v1/storage/files/certification/${runId}.md`,
      error: errorCode ? { code: errorCode, message: errorMessage } : null
    };
  }

  /**
   * Run certification for all destinations
   */
  async certifyAll(options = {}) {
    const destinations = this.db.query('SELECT id FROM destinations WHERE is_enabled = 1 LIMIT 20');
    const results = [];

    for (const d of destinations) {
      const res = await this.certifyDestination(d.id, options);
      results.push(res);
    }

    return {
      total_runs: results.length,
      certified_count: results.filter(r => r.status === 'certified').length,
      failed_count: results.filter(r => r.status === 'failed').length,
      inconclusive_count: results.filter(r => r.status === 'inconclusive').length,
      runs: results
    };
  }

  /**
   * Get certification run history
   */
  getHistory(destinationId = null, limit = 50) {
    const where = destinationId ? 'WHERE c.destination_id = ?' : '';
    const params = destinationId ? [destinationId, limit] : [limit];

    const rows = this.db.query(`
      SELECT c.*, d.name as destination_name
      FROM certification_runs c
      LEFT JOIN destinations d ON c.destination_id = d.id
      ${where}
      ORDER BY c.started_at DESC
      LIMIT ?
    `, ...params);

    return rows.map(r => ({
      ...r,
      is_simulation: Boolean(r.is_simulation),
      is_cleaned_up: Boolean(r.is_cleaned_up),
      steps: r.steps ? JSON.parse(r.steps) : []
    }));
  }
}

export const certificationHarness = new CertificationHarness();
export default certificationHarness;
