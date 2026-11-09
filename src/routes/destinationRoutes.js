import express from 'express';
import multer from 'multer';
import catalogueService from '../services/catalogue/catalogueService.js';
import tailoringRecommender from '../services/ai/tailoringRecommender.js';
import { IncuBrixError } from '../utils/errors.js';
import { safeFetch } from '../utils/urlSecurity.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = express.Router();

// List destinations with pagination, search, filters
router.get('/', (req, res, next) => {
  try {
    const result = catalogueService.listDestinations({
      search: req.query.search,
      platform: req.query.platform,
      status: req.query.status,
      level: req.query.level,
      enabled: req.query.enabled,
      page: req.query.page,
      limit: req.query.limit
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Export catalogue as CSV
router.get('/export-csv', (req, res, next) => {
  try {
    const csvData = catalogueService.exportCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="incubrix_destinations.csv"');
    res.send(csvData);
  } catch (err) {
    next(err);
  }
});

// Get single destination
router.get('/:id', (req, res, next) => {
  try {
    const item = catalogueService.getDestination(req.params.id);
    if (!item) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${req.params.id}' not found`, {}, 404);
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// Create new destination (Configuration, not code!)
router.post('/', (req, res, next) => {
  try {
    const { auth_credentials, ...destData } = req.body;
    const created = catalogueService.createDestination(destData, auth_credentials);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// Update destination
router.put('/:id', (req, res, next) => {
  try {
    const { auth_credentials, ...updateData } = req.body;
    const updated = catalogueService.updateDestination(req.params.id, updateData, auth_credentials);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Delete destination
router.delete('/:id', (req, res, next) => {
  try {
    const result = catalogueService.deleteDestination(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Import CSV with row-by-row error report
router.post('/import-csv', upload.single('file'), async (req, res, next) => {
  try {
    let csvString = '';
    if (req.file) {
      csvString = req.file.buffer.toString('utf8');
    } else if (req.body.url) {
      const isTestLoopback = Boolean(
        process.env.NODE_ENV === 'test' &&
        (req.body.url.includes('127.0.0.1') || req.body.url.includes('localhost'))
      );
      const fetchResp = await safeFetch(req.body.url, {
        maxBytes: 10 * 1024 * 1024,
        allowPrivate: Boolean(
          req.body.allow_private ||
          process.env.ALLOW_LOCAL_NETWORK === 'true' ||
          process.env.ALLOW_PRIVATE_DEV === 'true' ||
          isTestLoopback
        )
      });
      csvString = fetchResp.text;
    } else if (req.body.csv_content) {
      csvString = req.body.csv_content;
    } else {
      throw new IncuBrixError('VALIDATION_ERROR', 'No CSV file, url, or csv_content provided', {}, 400);
    }

    const report = await catalogueService.importCsv(csvString);
    res.status(200).json({
      message: 'CSV import processed successfully',
      ...report
    });
  } catch (err) {
    next(err);
  }
});

// AI Rules capture from URL
router.post('/capture-rules', async (req, res, next) => {
  try {
    const { rules_url, destination_id } = req.body;
    if (!rules_url && !destination_id) {
      throw new IncuBrixError('VALIDATION_ERROR', 'rules_url or destination_id is required', {}, 400);
    }
    const { rulesCaptureAdapter } = await import('../services/ai/rulesCaptureAdapter.js');
    let url = rules_url;
    if (!url && destination_id) {
      const dest = catalogueService.getDestination(destination_id);
      url = dest.rules_url;
      if (!url) {
        throw new IncuBrixError('VALIDATION_ERROR', `Destination ${destination_id} has no rules_url configured`, {}, 400);
      }
    }
    const captured = await rulesCaptureAdapter.captureRules(url, req.body || {});
    if (destination_id) {
      const proposal = rulesCaptureAdapter.saveProposal(destination_id, url, captured);
      return res.json(proposal);
    }
    res.json(captured);
  } catch (err) {
    next(err);
  }
});

// Destination-specific capture rules
router.post('/:id/capture-rules', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dest = catalogueService.getDestination(id);
    const url = req.body.rules_url || dest.rules_url;
    if (!url) {
      throw new IncuBrixError('VALIDATION_ERROR', `Destination ${id} has no rules_url configured`, {}, 400);
    }
    const { rulesCaptureAdapter } = await import('../services/ai/rulesCaptureAdapter.js');
    const captured = await rulesCaptureAdapter.captureRules(url, req.body || {});
    const proposal = rulesCaptureAdapter.saveProposal(id, url, captured);
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// Confirm proposed rules for destination
router.post('/:id/rules/confirm', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rulesCaptureAdapter } = await import('../services/ai/rulesCaptureAdapter.js');
    const result = rulesCaptureAdapter.confirmProposal(id, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;

