import express from 'express';
import simulationService from '../services/simulation/simulationService.js';
import resilienceService from '../services/resilience/resilienceService.js';
import config from '../config/index.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

/**
 * Middleware: Verify optional API_ACCESS_TOKEN and enforce simulation environment
 */
function simAuthMiddleware(req, res, next) {
  // Enforce optional API_ACCESS_TOKEN if configured in environment
  const expectedToken = process.env.API_ACCESS_TOKEN;
  if (expectedToken) {
    const headerAuth = req.headers['authorization'];
    const apiKey = req.headers['x-api-key'];
    const queryToken = req.query.token;

    const providedToken = headerAuth?.startsWith('Bearer ')
      ? headerAuth.slice(7)
      : (headerAuth || apiKey || queryToken);

    if (providedToken !== expectedToken) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Valid API_ACCESS_TOKEN required to access reviewer simulation controls',
          retryable: false
        }
      });
    }
  }

  // Simulation mode only guard
  if (config.env === 'production' && !config.simulation?.defaultEnabled) {
    return res.status(403).json({
      error: {
        code: 'SIMULATION_DISABLED',
        message: 'Reviewer fault injection is restricted to simulation mode',
        retryable: false
      }
    });
  }

  next();
}

router.use(simAuthMiddleware);

/**
 * POST /api/v1/sim/inject
 * Inject simulation platform fault
 * Supported faults: 429, 401, 422, 500, timeout_before_commit, timeout_after_commit, rename_field, revoke
 */
router.post('/inject', (req, res, next) => {
  const { fault, reset_s, platform, destination_id } = req.body || {};

  if (!fault) {
    return res.status(400).json({
      error: {
        code: 'INVALID_FAULT',
        message: 'Parameter "fault" is required. Supported: 429, 401, 422, 500, timeout_before_commit, timeout_after_commit, rename_field, revoke',
        retryable: false
      }
    });
  }

  const supported = [
    '429', 'rate_limit',
    '401', 'auth_expired',
    '422', 'content_rejected',
    '500', 'server_error',
    'timeout_before_commit',
    'timeout_after_commit',
    'rename_field', 'field_rename',
    'revoke'
  ];

  if (!supported.includes(String(fault).toLowerCase())) {
    return res.status(400).json({
      error: {
        code: 'INVALID_FAULT',
        message: `Unsupported fault '${fault}'. Supported: 429, 401, 422, 500, timeout_before_commit, timeout_after_commit, rename_field, revoke`,
        retryable: false,
        details: { supported_faults: simulationService.getAvailableFaults() }
      }
    });
  }

  const record = simulationService.injectFault({
    fault,
    reset_s,
    platform: platform || 'all',
    destination_id
  });

  return res.status(200).json({
    status: 'injected',
    active_fault: record,
    message: `Simulation fault '${record.fault}' injected for platform '${record.platform}'`
  });
});

/**
 * POST /api/v1/sim/reset
 * Reset all active injected faults, rate limits, and circuit breakers
 */
router.post('/reset', (req, res) => {
  simulationService.resetFaults();
  resilienceService.resetAll();

  return res.status(200).json({
    status: 'ok',
    message: 'All simulation faults, active rate limits, and circuit breakers have been reset'
  });
});

/**
 * GET /api/v1/sim/faults
 * Retrieve currently active faults and catalogue of supported chaos tests
 */
router.get('/faults', (req, res) => {
  return res.status(200).json({
    active_faults: simulationService.getActiveFaults(),
    available_faults: simulationService.getAvailableFaults()
  });
});

export default router;
