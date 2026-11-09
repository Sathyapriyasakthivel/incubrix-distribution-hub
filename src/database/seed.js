import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { generateFullDestinationCatalogue, writeCatalogueCsv } from './seeds/destinationsData.js';
import { catalogueService } from '../services/catalogue/catalogueService.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function seedDatabase(db = getDatabase(), force = false) {
  logger.info('Initializing database seed process...');

  const shouldForce = force || (typeof process !== 'undefined' && process.argv && process.argv.includes('--force'));

  // 1. Ensure migrations are applied
  runMigrations(db);

  // 2. Generate data/catalogue_150_destinations.csv
  const csvPath = path.join(config.paths.data, 'catalogue_150_destinations.csv');
  const csvResult = writeCatalogueCsv(csvPath);
  logger.info(`Generated catalogue CSV with ${csvResult.count} destinations at: ${csvPath}`);

  // 3. Check existing catalogue destinations (excluding local test instances)
  const catalogueCount = db.get("SELECT COUNT(*) as count FROM destinations WHERE id NOT IN ('local-ghost', 'local-lemmy')")?.count || 0;
  if (catalogueCount >= 50 && !shouldForce) {
    logger.info(`Database already contains ${catalogueCount} catalogue destinations. Use --force to replace.`);
    return { count: catalogueCount, csvPath };
  }

  if (shouldForce && catalogueCount > 0) {
    logger.info(`Force re-seeding: clearing ${catalogueCount} existing non-local destination rows...`);
    db.run("DELETE FROM destinations WHERE id NOT IN ('local-ghost', 'local-lemmy');");
  }

  // 4. Idempotently import 150 destinations from catalogue CSV with status 'catalogued'
  const loadResult = catalogueService.ensureCatalogue150Loaded(csvPath);
  logger.info(`Database successfully seeded: ${loadResult.loaded} imported, ${loadResult.skipped} existing.`);
  return { count: loadResult.loaded, csvPath };
}

// Execute if run directly from CLI
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedDatabase()
    .then((res) => {
      console.log(`Seeding complete: ${res.count} destinations loaded.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

export default seedDatabase;
