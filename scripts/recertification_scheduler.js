#!/usr/bin/env node

/**
 * Recertification Scheduler CLI Runner
 * Runs automated destination re-testing for all destinations older than 30 days
 * (or user-specified --days flag).
 *
 * Usage:
 *   node scripts/recertification_scheduler.js [--days 30] [--limit 100]
 */

import 'dotenv/config';
import { recertificationScheduler } from '../src/services/certification/recertificationScheduler.js';
import logger from '../src/utils/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
let maxAgeDays = 30;
let limit = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) {
    maxAgeDays = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1], 10);
    i++;
  }
}

console.log('='.repeat(70));
console.log(' IncuBrix Automated Recertification Scheduler');
console.log(` Target Threshold: Destinations older than ${maxAgeDays} days`);
console.log(` Batch Limit: ${limit} destinations`);
console.log('='.repeat(70));

async function main() {
  try {
    const report = await recertificationScheduler.runCycle({ maxAgeDays, limit });

    console.log('\n--- Recertification Execution Summary ---');
    console.log(`Total Due:    ${report.total_due}`);
    console.log(`Passed:       ${report.passed}`);
    console.log(`Failed:       ${report.failed}`);
    console.log(`Duration:     ${report.duration_ms} ms`);

    if (report.demoted.length > 0) {
      console.log('\n⚠️  Demoted Destinations:');
      for (const d of report.demoted) {
        console.log(` - [${d.destination_id}] ${d.name}: ${d.error}`);
      }
    } else {
      console.log('\n✅ All evaluated destinations passed recertification successfully.');
    }

    process.exit(report.failed > 0 ? 1 : 0);
  } catch (err) {
    logger.error('Fatal recertification failure', { error: err.message, stack: err.stack });
    console.error('Fatal recertification failure:', err.message);
    process.exit(2);
  }
}

main();
