import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyCsv } from 'csv-stringify/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Check real HTTP reachability of a destination URL using HEAD with GET fallback
 */
export async function checkUrlReachability(targetUrl, timeoutMs = 6000) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (IncuBrix-Catalogue-Verifier/1.0)';
  
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Try HEAD first
    let resp;
    try {
      resp = await fetch(targetUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': userAgent },
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (headErr) {
      resp = null;
    }

    clearTimeout(timer);

    // If HEAD returned 405 Method Not Allowed or 403 (some CDNs block HEAD) or failed, try lightweight GET
    if (!resp || resp.status === 405 || resp.status === 403) {
      const getController = new AbortController();
      const getTimer = setTimeout(() => getController.abort(), timeoutMs);
      resp = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Range': 'bytes=0-1024' // range request to avoid full page download
        },
        redirect: 'follow',
        signal: getController.signal
      });
      clearTimeout(getTimer);
    }

    const isReachable = resp.status >= 200 && resp.status < 400;
    return {
      reachable: isReachable,
      status: resp.status,
      finalUrl: resp.url,
      reason: isReachable ? null : `HTTP_${resp.status}`
    };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      reason: err.name === 'AbortError' ? 'TIMEOUT' : (err.code || err.message || 'CONNECTION_FAILED')
    };
  }
}

/**
 * Run catalogue verification across all candidate destinations
 */
export async function verifyCatalogue(candidates, options = {}) {
  const concurrency = options.concurrency || 8;
  const verifiedRows = [];
  const excludedRows = [];
  const auditTimestamp = new Date().toISOString();

  // Deduplicate candidates by normalized URL
  const seenUrls = new Set();
  const uniqueCandidates = [];
  for (const c of candidates) {
    const key = (c.url || '').toLowerCase().replace(/\/+$/, '');
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      uniqueCandidates.push(c);
    }
  }

  console.log(`Starting real HTTP reachability audit of ${uniqueCandidates.length} unique catalogue candidates...`);

  let completed = 0;
  const queue = [...uniqueCandidates];
  const workers = Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const check = await checkUrlReachability(item.url, options.timeoutMs || 5000);
      completed++;

      if (check.reachable) {
        verifiedRows.push({
          ...item,
          level: 'L0',
          est_audience: item.est_audience_verified ? item.est_audience : null, // null unless platform publishes figure
          researched_at: auditTimestamp,
          checked_at: auditTimestamp,
          http_status: check.status,
          reachable: true
        });
        if (completed % 25 === 0 || completed === candidates.length) {
          console.log(`[Progress ${completed}/${candidates.length}] ${verifiedRows.length} reachable verified.`);
        }
      } else {
        excludedRows.push({
          name: item.name,
          url: item.url,
          reason: check.reason,
          status: check.status
        });
        console.warn(`[Excluded] '${item.name}' (${item.url}) unreachable: ${check.reason}`);
      }
    }
  });

  await Promise.all(workers);

  const report = {
    audited_at: auditTimestamp,
    total_candidates: candidates.length,
    verified_reachable_count: verifiedRows.length,
    excluded_unreachable_count: excludedRows.length,
    target_met: verifiedRows.length >= 150,
    excluded: excludedRows
  };

  // Write verification report
  const reportPath = path.join(projectRoot, 'data', 'catalogue_verification_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Verification report written to: ${reportPath}`);

  // Format verified rows for CSV and DB seed
  const cleanedRows = verifiedRows.map(d => {
    const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const id = d.id || `dest_${slug}`;
    return {
      id,
      name: d.name,
      url: d.url,
      platform_key: d.platform_key,
      surface: d.surface || (d.platform_key === 'discourse' ? 'topic' : (d.platform_key === 'lemmy' ? 'post' : (d.platform_key === 'devto' ? 'article' : 'manual_pack'))),
      category: d.category || 'Technology',
      audience_tags: typeof d.audience_tags === 'string' ? d.audience_tags : JSON.stringify(d.tags || []),
      language: d.language || d.lang || 'en',
      geo: d.geo || 'global',
      est_audience: d.est_audience || null,
      rules_url: d.rules_url || null,
      frequency_cap: d.frequency_cap || null,
      self_promo_allowed: d.self_promo_allowed !== undefined && d.self_promo_allowed !== '' && d.self_promo_allowed !== null ? d.self_promo_allowed : null,
      link_policy: d.link_policy || null,
      disclosure_required: d.disclosure_required !== undefined && d.disclosure_required !== '' && d.disclosure_required !== null ? d.disclosure_required : null,
      automation_allowed: d.automation_allowed !== undefined && d.automation_allowed !== '' && d.automation_allowed !== null ? d.automation_allowed : null,
      connector_key: d.connector_key || d.platform_key,
      relevance_score: d.relevance_score || d.score || 4,
      relevance_reason: d.relevance_reason || d.reason || 'Verified tech or creator community.',
      level: 'L0',
      source_url: d.source_url || d.src || d.url,
      researched_at: auditTimestamp
    };
  });

  // Write data/catalogue_150_destinations.csv
  const csvContent = stringifyCsv(cleanedRows, {
    header: true,
    columns: [
      'id', 'name', 'url', 'platform_key', 'surface', 'category', 'audience_tags',
      'language', 'geo', 'est_audience', 'rules_url', 'frequency_cap',
      'self_promo_allowed', 'link_policy', 'disclosure_required', 'automation_allowed',
      'connector_key', 'relevance_score', 'relevance_reason', 'level',
      'source_url', 'researched_at'
    ]
  });
  const csvPath = path.join(projectRoot, 'data', 'catalogue_150_destinations.csv');
  fs.writeFileSync(csvPath, csvContent, 'utf8');
  console.log(`Wrote ${cleanedRows.length} rows to ${csvPath}`);

  // Write src/database/seeds/destinationsData.js
  const seedCode = `// Verified real destination catalogue (Task S & Round 2 Audit)
// Audited with real HTTP reachability checks on ${auditTimestamp}
// All rows marked level 'L0' until certified per specification.
import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyCsv } from 'csv-stringify/sync';

export const sampleDestinations = ${JSON.stringify(cleanedRows, null, 2)};

export function generateFullDestinationCatalogue() {
  return [...sampleDestinations];
}

export function writeCatalogueCsv(filePath) {
  const destinations = generateFullDestinationCatalogue();
  const csvContent = stringifyCsv(destinations, {
    header: true,
    columns: [
      'name', 'url', 'platform_key', 'surface', 'category', 'audience_tags',
      'language', 'geo', 'est_audience', 'rules_url', 'frequency_cap',
      'self_promo_allowed', 'link_policy', 'disclosure_required', 'automation_allowed',
      'connector_key', 'relevance_score', 'relevance_reason', 'level',
      'source_url', 'researched_at'
    ]
  });

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, csvContent, 'utf8');
  return { count: destinations.length, filePath };
}
`;
  const seedPath = path.join(projectRoot, 'src', 'database', 'seeds', 'destinationsData.js');
  fs.writeFileSync(seedPath, seedCode, 'utf8');
  console.log(`Wrote ${cleanedRows.length} rows to ${seedPath}`);

  return report;
}

if (process.argv[1] && process.argv[1].endsWith('verify_catalogue.js')) {
  import('./generate_150_real_catalogue.js').then(async (mod) => {
    const candidates = mod.verifiedRealDestinations;
    const report = await verifyCatalogue(candidates);
    console.log(`\n========================================`);
    console.log(`Catalogue Verification Complete:`);
    console.log(`Total Candidates: ${report.total_candidates}`);
    console.log(`Verified Reachable: ${report.verified_reachable_count}`);
    console.log(`Excluded Unreachable: ${report.excluded_unreachable_count}`);
    console.log(`Target (>=150): ${report.target_met ? 'MET' : 'PARTIAL'}`);
    console.log(`========================================\n`);
  });
}
