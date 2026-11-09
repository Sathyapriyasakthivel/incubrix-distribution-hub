import express from 'express';
import registry from '../connectors/ConnectorRegistry.js';
import catalogueService from '../services/catalogue/catalogueService.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// POST /api/v1/assisted/generate - Generate human posting pack
router.post('/generate', async (req, res, next) => {
  try {
    const { destination_id, rendition = {} } = req.body;
    if (!destination_id) {
      throw new IncuBrixError('VALIDATION_ERROR', 'destination_id is required', {}, 400);
    }

    const destination = catalogueService.getDestination(destination_id);
    if (!destination) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${destination_id}' not found`, {}, 404);
    }

    const pack = await registry.buildAssistPack('assisted', rendition, destination);
    res.json(pack);
  } catch (err) {
    next(err);
  }
});

export default router;
