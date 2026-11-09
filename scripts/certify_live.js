#!/usr/bin/env node
import { getDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { CertificationHarness, executeHold } from '../src/services/certification/certificationHarness.js';
import { checkUrlReachable, seedLocalDestinations } from './bootstrap_local.js';
import logger from '../src/utils/logger.js';

export { executeHold };

/**
 * Parse CLI arguments for certify_live
 * @param {string[]} argv
 * @returns {{ hold: number }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let hold = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hold') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        hold = parseInt(next, 10) || 0;
        i++;
      }
    } else if (arg.startsWith('--hold=')) {
      hold = parseInt(arg.slice(7), 10) || 0;
    }
  }
  return { hold: Math.max(0, hold) };
}

export async function certifyLive(options = {}) {
  const cliArgs = parseArgs();
  const hold = options.hold !== undefined
    ? Math.max(0, parseInt(options.hold, 10) || 0)
    : cliArgs.hold;

  const db = options.db || getDatabase();
  runMigrations(db);

  const ghostUrl = (process.env.GHOST_LOCAL_URL || process.env.GHOST_URL || 'http://localhost:2368').replace(/\/+$/, '');
  const lemmyUrl = (process.env.LEMMY_LOCAL_URL || 'http://localhost:8536').replace(/\/+$/, '');

  console.log('====================================================');
  console.log('   IncuBrix Live Destination Certification (M8)    ');
  console.log('====================================================');
  console.log(`Ghost URL: ${ghostUrl}`);
  console.log(`Lemmy URL: ${lemmyUrl}`);
  if (hold > 0) {
    console.log(`Hold Duration: ${hold}s before post deletion`);
  }
  console.log('Testing live reachability to avoid false PASS...');

  // 1. Live reachability check
  const ghostEndpoint = `${ghostUrl}/ghost/api/admin/site/`;
  const lemmyEndpoint = `${lemmyUrl}/api/v3/site`;

  const ghostResp = await fetch(ghostEndpoint, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  const lemmyResp = await fetch(lemmyEndpoint, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  const ghostStatus = ghostResp ? ghostResp.status : null;
  const lemmyStatus = lemmyResp ? lemmyResp.status : null;
  const ghostLive = Boolean(ghostResp && (ghostResp.ok || ghostResp.status < 500));
  const lemmyLive = Boolean(lemmyResp && (lemmyResp.ok || lemmyResp.status < 500));
  console.log(`  Ghost probe: ${ghostLive ? '[PASS]' : '[FAIL]'} (HTTP ${ghostStatus || 'unreachable'} ${ghostEndpoint})`);
  console.log(`  Lemmy probe: ${lemmyLive ? '[PASS]' : '[FAIL]'} (HTTP ${lemmyStatus || 'unreachable'} ${lemmyEndpoint})`);

  if (!ghostLive || !lemmyLive) {
    const unreachable = [];
    if (!ghostLive) unreachable.push(`Ghost (${ghostUrl})`);
    if (!lemmyLive) unreachable.push(`Lemmy (${lemmyUrl})`);

    console.error('\n[REFUSED] Cannot certify without a live fetch.');
    console.error(`The following target instances are not reachable: ${unreachable.join(', ')}.`);
    console.error('IncuBrix strictly refuses to mark PASS without a real live HTTP fetch against running containers.');
    console.error('To run live certification, please start the containers:');
    console.error('  1. docker compose up -d');
    console.error('  2. node scripts/bootstrap_local.js');
    console.error('  3. node scripts/certify_live.js\n');

    return {
      success: false,
      refused: true,
      reason: `Live instances unreachable: ${unreachable.join(', ')}`,
      results: {}
    };
  }

  // Ensure local-ghost and local-lemmy destinations exist
  const ghostRow = db.get('SELECT * FROM destinations WHERE id = ?', 'local-ghost');
  const lemmyRow = db.get('SELECT * FROM destinations WHERE id = ?', 'local-lemmy');

  if (!ghostRow || !lemmyRow) {
    logger.info('Seeding local destinations for live certification...');
    seedLocalDestinations(db, {
      ghostUrl,
      lemmyUrl,
      lemmyCommunityId: parseInt(process.env.LEMMY_COMMUNITY_ID || '1', 10)
    });
  }

  const harness = new CertificationHarness(db);
  const results = {};

  // 2. Certify local-ghost with forceLive: true
  console.log('\n--- Running 10-Step Live Certification: local-ghost ---');
  try {
    const ghostResult = await harness.certifyDestination('local-ghost', {
      forceLive: true,
      hold,
      sleepFn: options.sleepFn,
      logger: options.logger
    });
    results['local-ghost'] = ghostResult;
    if (ghostResult.steps && ghostResult.steps.length > 0) {
      for (const step of ghostResult.steps) {
        const isPass = step.status === 'passed';
        const isSkip = step.status === 'skipped';
        const tag = isPass ? '[PASS]' : (isSkip ? '[SKIP]' : '[FAIL]');
        const httpInfo = step.details?.http_status && step.details?.url
          ? ` (HTTP ${step.details.http_status} ${step.details.url})`
          : (step.details?.url ? ` (${step.details.url})` : '');
        console.log(`  ${tag} Step ${step.step}: ${step.name}${httpInfo}`);
      }
    }
    if (ghostResult.status === 'certified') {
      console.log(`\n=> [PASS] local-ghost certified successfully via live fetch (Level: ${ghostResult.level})`);
    } else {
      console.error(`\n=> [FAIL] local-ghost failed live certification: ${ghostResult.error?.message || ghostResult.status}`);
    }
  } catch (err) {
    console.error(`[FAIL] local-ghost exception during live certification: ${err.message}`);
    results['local-ghost'] = { status: 'failed', error: err.message };
  }

  // 3. Certify local-lemmy with forceLive: true
  console.log('\n--- Running 10-Step Live Certification: local-lemmy ---');
  try {
    const lemmyResult = await harness.certifyDestination('local-lemmy', {
      forceLive: true,
      hold,
      sleepFn: options.sleepFn,
      logger: options.logger
    });
    results['local-lemmy'] = lemmyResult;
    if (lemmyResult.steps && lemmyResult.steps.length > 0) {
      for (const step of lemmyResult.steps) {
        const isPass = step.status === 'passed';
        const isSkip = step.status === 'skipped';
        const tag = isPass ? '[PASS]' : (isSkip ? '[SKIP]' : '[FAIL]');
        const httpInfo = step.details?.http_status && step.details?.url
          ? ` (HTTP ${step.details.http_status} ${step.details.url})`
          : (step.details?.url ? ` (${step.details.url})` : '');
        console.log(`  ${tag} Step ${step.step}: ${step.name}${httpInfo}`);
      }
    }
    if (lemmyResult.status === 'certified') {
      console.log(`\n=> [PASS] local-lemmy certified successfully via live fetch (Level: ${lemmyResult.level})`);
    } else {
      console.error(`\n=> [FAIL] local-lemmy failed live certification: ${lemmyResult.error?.message || lemmyResult.status}`);
    }
  } catch (err) {
    console.error(`[FAIL] local-lemmy exception during live certification: ${err.message}`);
    results['local-lemmy'] = { status: 'failed', error: err.message };
  }

  const allPassed = results['local-ghost']?.status === 'certified' && results['local-lemmy']?.status === 'certified';

  if (!allPassed) {
    console.error('\n[FAIL] Live certification did not pass for all destinations.');
    return { success: false, refused: false, results };
  }

  console.log('\n[PASS] All local destinations passed live certification!');
  return { success: true, refused: false, results };
}

// Direct CLI invocation
if (process.argv[1] && process.argv[1].endsWith('certify_live.js')) {
  const { hold } = parseArgs();
  certifyLive({ hold })
    .then(res => {
      if (!res.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error in certify_live:', err);
      process.exit(1);
    });
}
