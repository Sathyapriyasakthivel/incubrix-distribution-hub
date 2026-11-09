import express from 'express';
import registry from '../connectors/ConnectorRegistry.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// GET /api/v1/connectors - List registered connectors
router.get('/', (req, res) => {
  res.json({
    connectors: registry.listConnectors()
  });
});

// POST /api/v1/connectors/:key/kill-switch - Toggle kill switch
router.post('/:key/kill-switch', (req, res, next) => {
  try {
    const { key } = req.params;
    if (!registry.hasConnector(key)) {
      throw new IncuBrixError('CONNECTOR_NOT_FOUND', `Connector '${key}' does not exist`, {}, 404);
    }

    const { enable } = req.body;
    if (enable === true) {
      registry.enable(key);
    } else if (enable === false) {
      registry.disable(key);
    } else {
      // Toggle
      if (registry.isKillSwitchActive(key)) {
        registry.enable(key);
      } else {
        registry.disable(key);
      }
    }

    res.json({
      connector_key: key,
      is_disabled: registry.isKillSwitchActive(key),
      status: registry.isKillSwitchActive(key) ? 'disabled' : 'active'
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/connectors/:key/metrics - Fetch normalized metrics (Outstanding level)
router.get('/:key/metrics', async (req, res, next) => {
  try {
    const { key } = req.params;
    const { post_id, since } = req.query;

    if (!post_id) {
      throw new IncuBrixError('VALIDATION_ERROR', 'post_id query parameter is required', {}, 400);
    }

    const metrics = await registry.fetchMetrics(key, post_id, {}, since);
    res.json({
      connector_key: key,
      platform_post_id: post_id,
      metrics
    });
  } catch (err) {
    next(err);
  }
});

export default router;
