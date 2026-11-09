import express from 'express';
import { getDatabase } from '../database/db.js';
import registry from '../connectors/ConnectorRegistry.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'IncuBrix Distribution - Long-Tail Destination Network',
    version: '1.0.0'
  });
});

router.get('/ready', (req, res) => {
  try {
    const db = getDatabase();
    const destCount = db.get('SELECT COUNT(*) as count FROM destinations')?.count || 0;
    const connectors = registry.listConnectors();

    res.status(200).json({
      status: 'ready',
      database: 'connected',
      destinations_count: destCount,
      connectors_loaded: connectors.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      error: err.message
    });
  }
});

export default router;
