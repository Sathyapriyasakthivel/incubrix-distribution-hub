import express from 'express';
import { getDatabase } from '../database/db.js';

const router = express.Router();

// GET /api/v1/audit/logs - Query audit logs
router.get('/logs', (req, res, next) => {
  try {
    const db = getDatabase();
    const eventType = req.query.event_type || null;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));

    const where = eventType ? 'WHERE event_type = ?' : '';
    const params = eventType ? [eventType, limit] : [limit];

    const rows = db.query(`
      SELECT * FROM audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `, ...params);

    res.json({
      logs: rows.map(r => ({
        ...r,
        payload: r.payload ? JSON.parse(r.payload) : {}
      }))
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/audit/dashboard-stats - Overview statistics for UI
router.get('/dashboard-stats', (req, res, next) => {
  try {
    const db = getDatabase();

    const totalDestinations = db.get('SELECT COUNT(*) as count FROM destinations')?.count || 0;
    const certifiedDestinations = db.get("SELECT COUNT(*) as count FROM destinations WHERE status = 'certified'")?.count || 0;
    const totalJobs = db.get('SELECT COUNT(*) as count FROM publications')?.count || 0;
    const succeededJobs = db.get("SELECT COUNT(*) as count FROM publications WHERE status = 'succeeded'")?.count || 0;
    const failedJobs = db.get("SELECT COUNT(*) as count FROM publications WHERE status = 'failed'")?.count || 0;
    const ruleViolations = db.get("SELECT COUNT(*) as count FROM audit_logs WHERE event_type = 'RULE_EVALUATION' AND payload LIKE '%BLOCK%'")?.count || 0;

    res.json({
      total_destinations: totalDestinations,
      certified_destinations: certifiedDestinations,
      certification_rate: totalDestinations > 0 ? Math.round((certifiedDestinations / totalDestinations) * 100) : 0,
      total_jobs: totalJobs,
      succeeded_jobs: succeededJobs,
      failed_jobs: failedJobs,
      rule_violations_caught: ruleViolations,
      uptime_seconds: process.uptime()
    });
  } catch (err) {
    next(err);
  }
});

export default router;
