import express from 'express';
import jobQueue from '../services/jobs/jobQueue.js';
import { getDatabase } from '../database/db.js';
import { IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// GET /api/v1/jobs/:id - Poll job status, progress, and result links
router.get('/:id', (req, res, next) => {
  try {
    const job = jobQueue.getJob(req.params.id);
    if (!job) {
      throw new IncuBrixError('JOB_NOT_FOUND', `Job '${req.params.id}' was not found`, {}, 404);
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/jobs - List recent jobs for admin dashboard
router.get('/', (req, res, next) => {
  try {
    const db = getDatabase();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const rows = db.query(`
      SELECT p.id as job_id, p.destination_id, d.name as destination_name,
             p.connector_key, p.title, p.status, p.progress, p.live_url,
             p.error_code, p.created_at, p.updated_at
      FROM publications p
      LEFT JOIN destinations d ON p.destination_id = d.id
      ORDER BY p.created_at DESC
      LIMIT ?
    `, limit);

    res.json({
      jobs: rows
    });
  } catch (err) {
    next(err);
  }
});

export default router;
