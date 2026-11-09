import { createApp } from './app.js';
import config from './config/index.js';
import { runMigrations } from './database/migrate.js';
import { seedDatabase } from './database/seed.js';
import { catalogueService } from './services/catalogue/catalogueService.js';
import { getDatabase } from './database/db.js';
import logger from './utils/logger.js';

async function bootstrap() {
  try {
    logger.info('Starting IncuBrix Distribution Network Service...');

    // 1. Initialize Database & Migrations
    const db = getDatabase();
    runMigrations(db);

    // 2. Check if catalogue is loaded
    const catalogueCount = db.get("SELECT COUNT(*) as count FROM destinations WHERE id NOT IN ('local-ghost', 'local-lemmy')")?.count || 0;
    if (catalogueCount < 50) {
      logger.info('Catalogue not loaded. Idempotently importing 150 destinations from catalogue CSV...');
      catalogueService.ensureCatalogue150Loaded();
    }

    // 3. Start Express HTTP Server
    const app = createApp();
    const server = app.listen(config.port, config.host, () => {
      logger.info(`Server listening on http://${config.host}:${config.port}`);
      logger.info(`REST API base: http://${config.host}:${config.port}/api/v1/`);
      logger.info(`Connector contract endpoint: http://${config.host}:${config.port}/connector/v1/`);
      logger.info(`Dashboard UI: http://localhost:${config.port}/`);
    });

    // 4. Start Recertification Scheduler
    if (process.env.RECERT_INTERVAL_MS || process.env.NODE_ENV === 'production') {
      const intervalMs = Number(process.env.RECERT_INTERVAL_MS || 86400000);
      const { recertificationScheduler } = await import('./services/certification/recertificationScheduler.js');
      recertificationScheduler.start(intervalMs);
    }

    // Graceful Shutdown
    const shutdown = async () => {
      logger.info('Received termination signal. Shutting down gracefully...');
      try {
        const { recertificationScheduler } = await import('./services/certification/recertificationScheduler.js');
        recertificationScheduler.stop();
      } catch {}
      server.close(() => {
        try {
          db.close();
          logger.info('Database connection closed.');
        } catch (err) {
          logger.warn(`Error closing database: ${err.message}`);
        }
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    logger.error(`Bootstrap fatal error: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

bootstrap();
