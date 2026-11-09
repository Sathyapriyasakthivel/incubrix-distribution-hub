import express from 'express';
import certificationHarness from '../services/certification/certificationHarness.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// POST /api/v1/certification/run/:destination_id - Run 10-step certification on destination
router.post('/run/:destination_id', async (req, res, next) => {
  try {
    const options = {
      forceLive: req.body?.force_live || false,
      faultInjection: req.body?.fault_injection || req.query.fault || null
    };

    const result = await certificationHarness.certifyDestination(req.params.destination_id, options);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/certification/run-all - Run batch certification
router.post('/run-all', async (req, res, next) => {
  try {
    const result = await certificationHarness.certifyAll({
      forceLive: req.body?.force_live || false
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/certification/history - List run history
router.get('/history', (req, res, next) => {
  try {
    const destinationId = req.query.destination_id || null;
    const limit = parseInt(req.query.limit || '50', 10);
    const history = certificationHarness.getHistory(destinationId, limit);
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/certification/recertify-due - Run automated recertification on destinations older than max_age_days
router.post('/recertify-due', async (req, res, next) => {
  try {
    const { default: recertificationScheduler } = await import('../services/certification/recertificationScheduler.js');
    const maxAgeDays = req.body?.max_age_days ? parseInt(req.body.max_age_days, 10) : 30;
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 50;

    const summary = await recertificationScheduler.runCycle({ maxAgeDays, limit });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

export default router;
