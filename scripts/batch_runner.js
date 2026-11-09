#!/usr/bin/env node

/**
 * IncuBrix Batch Runner CLI
 * Usage: node scripts/batch_runner.js <input_path> <output_folder> [--api <url>] [--token <token>]
 * Command-line batch runner for content syndication.
 *
 * Calls the public HTTP API (not internal services), accepts files or folders,
 * writes all results to one folder, supports --api and --token, and validates expected outcomes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';

export async function runBatch(options = {}) {
  const args = process.argv.slice(2);

  // Parse positional and flag arguments
  let inputPath = options.input;
  let outputDir = options.output;
  let apiBaseUrl = options.api;
  let apiToken = options.token;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api' && args[i + 1]) {
      apiBaseUrl = args[++i];
    } else if (arg === '--token' && args[i + 1]) {
      apiToken = args[++i];
    } else if (!arg.startsWith('--')) {
      if (!inputPath) inputPath = arg;
      else if (!outputDir) outputDir = arg;
    }
  }

  // Fallbacks and defaults
  inputPath = inputPath || path.resolve(process.cwd(), 'tests', 'fixtures', 'hard_cases_batch.json');
  outputDir = outputDir || path.resolve(process.cwd(), 'storage', 'batches', `batch_${Date.now()}`);
  apiBaseUrl = apiBaseUrl || process.env.API_URL || process.env.APP_URL || 'http://localhost:3000';
  apiToken = apiToken || process.env.API_ACCESS_TOKEN || null;

  const apiUrl = apiBaseUrl.replace(/\/+$/, '') + '/api/v1';

  console.log(`\n======================================================`);
  console.log(`   IncuBrix Batch Runner CLI`);
  console.log(`======================================================`);
  console.log(`API Target:    ${apiUrl}`);
  console.log(`Auth Token:    ${apiToken ? '[CONFIGURED]' : '[NONE]'}`);
  console.log(`Input Source:  ${inputPath}`);
  console.log(`Output Folder: ${outputDir}\n`);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file or directory '${inputPath}' does not exist.`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 1. Gather all input test items (support single file or directory of json/csv files)
  const items = [];
  const stat = fs.statSync(inputPath);

  if (stat.isDirectory()) {
    const files = fs.readdirSync(inputPath);
    for (const file of files) {
      const fullPath = path.join(inputPath, file);
      if (file.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) items.push(...parsed);
          else items.push(parsed);
        } catch (err) {
          console.warn(`Warning: Could not parse ${file}: ${err.message}`);
        }
      } else if (file.endsWith('.csv')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const records = parseCsv(raw, { columns: true, skip_empty_lines: true });
          items.push(...records);
        } catch (err) {
          console.warn(`Warning: Could not parse ${file}: ${err.message}`);
        }
      }
    }
  } else if (inputPath.endsWith('.json')) {
    const raw = fs.readFileSync(inputPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items.push(...parsed);
    else items.push(parsed);
  } else if (inputPath.endsWith('.csv')) {
    const raw = fs.readFileSync(inputPath, 'utf8');
    const records = parseCsv(raw, { columns: true, skip_empty_lines: true });
    items.push(...records);
  }

  console.log(`Loaded ${items.length} items to process.\n`);

  // Prepare standard HTTP request headers
  const getHeaders = (correlationId, idemKey) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
      'Idempotency-Key': idemKey
    };
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`;
      headers['x-api-key'] = apiToken;
    }
    return headers;
  };

  // Fetch destination catalogue to resolve friendly platform keys (e.g. "discourse" -> certified destination id)
  let destinations = [];
  try {
    const listRes = await fetch(`${apiUrl}/destinations?limit=100`, {
      headers: getHeaders(`batch-init-${Date.now()}`, `init_dest_list_${Date.now()}`)
    });
    if (listRes.ok) {
      const dData = await listRes.json();
      destinations = dData.items || [];
    }
  } catch (err) {
    console.warn(`Note: Could not preload destinations from ${apiUrl}/destinations: ${err.message}`);
  }

  let succeeded = 0;
  let failed = 0;
  let matchesCount = 0;
  const results = [];
  const batchStart = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const indexStr = String(i + 1).padStart(3, '0');
    const caseId = item.id || `item_${indexStr}`;
    const expected = item.expected_outcome || null;

    // Resolve friendly platform keys like "discourse", "devto", "webhook" to an actual certified destination
    let resolvedDestId = item.destination_id;
    if (resolvedDestId && destinations.length > 0) {
      const matched = destinations.find(d =>
        d.id === resolvedDestId ||
        (d.platform_key === resolvedDestId && d.status === 'certified') ||
        d.platform_key === resolvedDestId
      );
      if (matched) {
        resolvedDestId = matched.id;
      }
    }

    const payload = {
      ...item,
      destination_id: resolvedDestId
    };
    // Strip metadata not recognized by the publish API
    delete payload.expected_outcome;
    delete payload.case_description;
    delete payload.id;

    console.log(`[${indexStr}/${items.length}] Running: "${item.title || caseId}" -> Dest: ${resolvedDestId || 'default'}`);

    const itemStart = Date.now();
    const correlationId = `batch-${Date.now()}-${indexStr}`;
    const idemKey = `batch_run_${Date.now()}_${indexStr}`;

    let actualStatus = 'unknown';
    let actualErrorCode = null;
    let finalData = null;
    let liveUrl = null;
    let platformPostId = null;

    try {
      const response = await fetch(`${apiUrl}/publish`, {
        method: 'POST',
        headers: getHeaders(correlationId, idemKey),
        body: JSON.stringify(payload)
      });

      const body = await response.json();

      if (response.status === 202) {
        // Poll asynchronous job
        let pollAttempts = 0;
        finalData = body;
        while (pollAttempts < 25) {
          pollAttempts++;
          await new Promise(r => setTimeout(r, 400));
          const pollRes = await fetch(`${apiUrl}/jobs/${body.job_id}`, {
            headers: getHeaders(correlationId, `poll_${idemKey}_${pollAttempts}`)
          });
          if (pollRes.ok) {
            finalData = await pollRes.json();
            if (finalData.status === 'succeeded' || finalData.status === 'failed') {
              break;
            }
          }
        }
        actualStatus = finalData.status;
        actualErrorCode = finalData.error?.code || null;
        liveUrl = finalData.live_url || null;
        platformPostId = finalData.platform_post_id || null;
      } else if (!response.ok) {
        actualStatus = 'failed';
        actualErrorCode = body.error?.code || `HTTP_${response.status}`;
        finalData = body;
      } else {
        actualStatus = body.status || 'succeeded';
        finalData = body;
        liveUrl = body.live_url || null;
      }
    } catch (err) {
      actualStatus = 'error';
      actualErrorCode = err.code || 'NETWORK_ERROR';
      finalData = { error: { message: err.message } };
    }

    const itemDuration = Date.now() - itemStart;

    // Check expectation match if expected_outcome was specified
    let expectationMatched = true;
    if (expected) {
      if (expected.status && expected.status !== actualStatus) {
        expectationMatched = false;
      }
      if (expected.error_code && expected.error_code !== actualErrorCode) {
        expectationMatched = false;
      }
      if (expectationMatched) matchesCount++;
    }

    if (actualStatus === 'succeeded') {
      succeeded++;
      console.log(`   ✓ SUCCEEDED (${itemDuration}ms) -> Live URL: ${liveUrl || 'n/a'}`);
    } else {
      failed++;
      console.log(`   ✗ FAILED (${itemDuration}ms) -> [${actualErrorCode}] ${finalData?.error?.message || 'Failed'}`);
    }

    if (expected) {
      console.log(`     Expectation: ${expectationMatched ? '✓ MATCHED' : '✗ MISMATCH'} (Expected ${JSON.stringify(expected)} vs actual status=${actualStatus}, error=${actualErrorCode})`);
    }

    const itemResult = {
      index: i + 1,
      id: caseId,
      case_description: item.case_description || null,
      expected_outcome: expected,
      actual_status: actualStatus,
      actual_error_code: actualErrorCode,
      expectation_matched: expected ? expectationMatched : null,
      duration_ms: itemDuration,
      live_url: liveUrl,
      platform_post_id: platformPostId,
      response_data: finalData
    };

    results.push(itemResult);

    // Save individual item result to output folder
    const outFilename = `result_${indexStr}_${caseId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    fs.writeFileSync(path.join(outputDir, outFilename), JSON.stringify(itemResult, null, 2), 'utf8');
  }

  const totalDuration = Date.now() - batchStart;
  const summary = {
    batch_runner_version: '2.0.0',
    timestamp: new Date().toISOString(),
    api_target: apiUrl,
    input_path: inputPath,
    output_dir: outputDir,
    total_items: items.length,
    succeeded,
    failed,
    expectations_evaluated: items.filter(it => it.expected_outcome).length,
    expectations_matched: matchesCount,
    total_duration_ms: totalDuration,
    results
  };

  const summaryPath = path.join(outputDir, 'batch_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n======================================================`);
  console.log(`Batch execution complete in ${(totalDuration / 1000).toFixed(2)}s`);
  console.log(`Total: ${items.length} | Succeeded: ${succeeded} | Failed: ${failed}`);
  if (items.some(it => it.expected_outcome)) {
    console.log(`Expectations Matched: ${matchesCount} / ${items.filter(it => it.expected_outcome).length}`);
  }
  console.log(`Summary written to: ${summaryPath}`);
  console.log(`======================================================\n`);

  return summary;
}

// CLI Execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('batch_runner.js')) {
  runBatch()
    .then((summary) => {
      // Exit 0 if all expected outcomes matched or there are no unhandled crashes
      const mismatches = summary.results.filter(r => r.expectation_matched === false);
      if (mismatches.length > 0) {
        console.warn(`Warning: ${mismatches.length} batch items did not match expected outcomes.`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Batch runner fatal error: ${err.message}`);
      process.exit(1);
    });
}
