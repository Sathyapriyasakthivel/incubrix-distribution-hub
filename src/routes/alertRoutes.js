import express from 'express';
import { getDatabase } from '../database/db.js';

const router = express.Router();

/**
 * GET /api/v1/alerts
 * Lists operational and certification failure alerts
 */
router.get('/', (req, res, next) => {
  try {
    const db = getDatabase();
    const level = req.query.level;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));

    let query = 'SELECT * FROM alerts';
    const params = [];

    if (level) {
      query += ' WHERE level = ?';
      params.push(level);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params);

    res.json({
      alerts: rows.map(r => ({
        ...r,
        details: r.details ? JSON.parse(r.details) : {}
      }))
    });
  } catch (err) {
    next(err);
  }
});

export default router;
