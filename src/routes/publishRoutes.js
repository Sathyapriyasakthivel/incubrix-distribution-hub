import express from 'express';
import publishingService from '../services/publishing/publishingService.js';
import rulesEngine from '../services/rules/rulesEngine.js';
import tailoringRecommender from '../services/ai/tailoringRecommender.js';
import catalogueService from '../services/catalogue/catalogueService.js';
import registry from '../connectors/ConnectorRegistry.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// POST /api/v1/publish - Submit Publication Job (Async background job with 202 Accepted)
router.post('/', async (req, res, next) => {
  const idempotencyKey = req.headers['idempotency-key'] || null;
  const correlationId = req.correlationId;

  try {
    const { destination_id, title, body } = req.body;
    if (!destination_id || !title || !body) {
      throw new IncuBrixError('VALIDATION_ERROR', 'destination_id, title, and body are required fields', {}, 400);
    }

    const result = await publishingService.submitPublication(req.body, {
      idempotencyKey,
      correlationId
    });

    // Integration Standard Point 3: Return 202 with job_id for background processing
    const statusCode = result.is_replay ? 200 : 202;
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publish/rules/evaluate - Pre-flight Rule Evaluation
router.post('/rules/evaluate', async (req, res, next) => {
  try {
    const { destination_id, ...rendition } = req.body;
    if (!destination_id) {
      throw new IncuBrixError('VALIDATION_ERROR', 'destination_id is required', {}, 400);
    }

    const destination = catalogueService.getDestination(destination_id);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${destination_id}' not found`, {}, 404);
    }

    const evaluation = rulesEngine.evaluate(rendition, destination, {
      correlationId: req.correlationId,
      tailor: req.body.tailor
    });

    // Call connector.validate() in pre-flight evaluation as well
    if (registry.hasConnector(destination.connector_key)) {
      const connector = registry.getConnector(destination.connector_key);
      const validation = await connector.validate(rendition, destination, {});
      if (!validation.ok) {
        evaluation.decision = 'BLOCK';
        if (!evaluation.triggered_rules.includes('DEST_SPEC_VIOLATION')) {
          evaluation.triggered_rules.push('DEST_SPEC_VIOLATION');
        }
        for (const v of validation.violations) {
          evaluation.violations.push({
            rule: 'DEST_SPEC_VIOLATION',
            field: v.field,
            message: v.message
          });
          evaluation.reasons.push(v.message);
        }
        evaluation.reason = evaluation.violations.map(v => v.message).join('; ');
      }
    }

    res.json({
      destination: {
        id: destination.id,
        name: destination.name,
        platform_key: destination.platform_key
      },
      ...evaluation
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publish/tailor - Content Tailoring
router.post('/tailor', (req, res, next) => {
  try {
    const { destination_id, ...content } = req.body;
    if (!destination_id) {
      throw new IncuBrixError('VALIDATION_ERROR', 'destination_id is required', {}, 400);
    }

    const destination = catalogueService.getDestination(destination_id);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${destination_id}' not found`, {}, 404);
    }

    const tailored = tailoringRecommender.tailorContent(content, destination);
    res.json(tailored);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publish/recommender - Destination Recommendation
router.post('/recommender', (req, res, next) => {
  try {
    const { limit = 10, ...contentItem } = req.body;
    const recommendations = tailoringRecommender.recommendDestinations(contentItem, limit);
    res.json(recommendations);
  } catch (err) {
    next(err);
  }
});

export default router;
