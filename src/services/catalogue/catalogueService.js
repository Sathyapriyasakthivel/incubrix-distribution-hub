import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../config/index.js';
import { getDatabase } from '../../database/db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import { IncuBrixError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import storageService from '../storage/storageService.js';
import { detectLanguage } from '../../utils/languageDetect.js';

export function normalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  let urlStr = rawUrl.trim()
    .replace(/^https?:\/\/www\./i, m => m.toLowerCase().startsWith('https') ? 'https://' : 'http://')
    .replace(/^www\./i, '');

  const hasScheme = /^https?:\/\//i.test(urlStr);
  if (!hasScheme) {
    urlStr = `http://${urlStr}`;
  }

  try {
    const parsed = new URL(urlStr);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    const port = parsed.port ? `:${parsed.port}` : '';
    let pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    if (pathname === '/') pathname = '';

    // Filter out tracking query parameters: utm_*, ref, source, fbclid, gclid
    const searchParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (!lowerKey.startsWith('utm_') && !['ref', 'source', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(lowerKey)) {
        searchParams.append(key, value);
      }
    }
    const search = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const protocol = parsed.protocol;
    return `${protocol}//${host}${port}${pathname}${search}`;
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  }
}

export class CatalogueService {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  set db(val) {
    this._db = val;
  }

  listDestinations({
    search = '',
    platform = '',
    status = '',
    level = '',
    enabled = null,
    page = 1,
    limit = 50
  } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(name LIKE ? OR url LIKE ? OR category LIKE ?)');
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    if (platform) {
      conditions.push('platform_key = ?');
      params.push(platform);
    }

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (level) {
      conditions.push('level = ?');
      params.push(level);
    }

    if (enabled !== null && enabled !== undefined && enabled !== '') {
      conditions.push('is_enabled = ?');
      params.push(enabled === 'true' || enabled === true || enabled === 1 ? 1 : 0);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.get(`SELECT COUNT(*) as total FROM destinations ${whereClause}`, ...params);
    const total = countRow?.total || 0;

    const rows = this.db.query(`
      SELECT
        id, name, url, platform_key, surface, category, audience_tags,
        language, geo, est_audience, rules_url, frequency_cap,
        self_promo_allowed, link_policy, disclosure_required, automation_allowed,
        connector_key, relevance_score, relevance_reason, level,
        last_certified_at, is_enabled, simulation_mode, status, source_url, researched_at, created_at, updated_at
      FROM destinations
      ${whereClause}
      ORDER BY relevance_score DESC, name ASC
      LIMIT ? OFFSET ?
    `, ...params, limitNum, offset);

    const items = rows.map(r => ({
      ...r,
      audience_tags: r.audience_tags ? JSON.parse(r.audience_tags) : [],
      self_promo_allowed: Boolean(r.self_promo_allowed),
      disclosure_required: Boolean(r.disclosure_required),
      automation_allowed: Boolean(r.automation_allowed),
      is_enabled: Boolean(r.is_enabled),
      simulation_mode: Boolean(r.simulation_mode)
    }));

    return {
      items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    };
  }

  getDestination(id) {
    const row = this.db.get(`
      SELECT
        id, name, url, platform_key, surface, category, audience_tags,
        language, geo, est_audience, rules_url, frequency_cap,
        self_promo_allowed, link_policy, disclosure_required, automation_allowed,
        connector_key, relevance_score, relevance_reason, level,
        last_certified_at, is_enabled, simulation_mode, status, source_url, researched_at, created_at, updated_at
      FROM destinations
      WHERE id = ?
    `, id);

    if (!row) return null;

    return {
      ...row,
      audience_tags: row.audience_tags ? JSON.parse(row.audience_tags) : [],
      self_promo_allowed: row.self_promo_allowed !== null && row.self_promo_allowed !== undefined ? Boolean(row.self_promo_allowed) : null,
      disclosure_required: row.disclosure_required !== null && row.disclosure_required !== undefined ? Boolean(row.disclosure_required) : null,
      automation_allowed: row.automation_allowed !== null && row.automation_allowed !== undefined ? Boolean(row.automation_allowed) : null,
      is_enabled: Boolean(row.is_enabled),
      simulation_mode: Boolean(row.simulation_mode)
    };
  }

  createDestination(data, authCredentials = null) {
    if (!data.name || !data.url || !data.platform_key) {
      throw new IncuBrixError('VALIDATION_ERROR', 'name, url, and platform_key are mandatory', {}, 400);
    }

    const normUrl = normalizeUrl(data.url);
    const existing = this.db.get(
      'SELECT id FROM destinations WHERE platform_key = ? AND (url = ? OR url = ? OR url = ?)',
      data.platform_key,
      data.url,
      normUrl,
      normUrl + '/'
    );

    if (existing) {
      throw new IncuBrixError('DUPLICATE_DESTINATION', `Destination already exists for ${data.platform_key} at ${data.url}`, { existingId: existing.id }, 409);
    }

    const id = data.id || 'dest_' + crypto.randomUUID();
    const now = new Date().toISOString();

    const connectorKey = data.connector_key || data.platform_key;
    const audienceTags = Array.isArray(data.audience_tags) ? JSON.stringify(data.audience_tags) : '[]';

    this.db.transaction((tx) => {
      tx.run(`
        INSERT INTO destinations (
          id, name, url, platform_key, surface, category, audience_tags,
          language, geo, est_audience, rules_url, frequency_cap,
          self_promo_allowed, link_policy, disclosure_required, automation_allowed,
          connector_key, relevance_score, relevance_reason, level,
          is_enabled, simulation_mode, status, source_url, researched_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        )
      `,
        id,
        data.name,
        data.url,
        data.platform_key,
        data.surface || 'default',
        data.category || null,
        audienceTags,
        data.language || 'en',
        data.geo || 'global',
        data.est_audience || 0,
        data.rules_url || null,
        data.frequency_cap || null,
        data.self_promo_allowed !== undefined && data.self_promo_allowed !== null && data.self_promo_allowed !== '' ? (data.self_promo_allowed ? 1 : 0) : null,
        data.link_policy || null,
        data.disclosure_required !== undefined && data.disclosure_required !== null && data.disclosure_required !== '' ? (data.disclosure_required ? 1 : 0) : null,
        data.automation_allowed !== undefined && data.automation_allowed !== null && data.automation_allowed !== '' ? (data.automation_allowed ? 1 : 0) : null,
        connectorKey,
        data.relevance_score || 3,
        data.relevance_reason || null,
        data.level || 'L0',
        data.is_enabled !== false ? 1 : 0,
        data.simulation_mode !== false ? 1 : 0,
        data.status || 'uncertified',
        data.source_url || null,
        data.researched_at || null,
        now,
        now
      );

      // Save credentials separately if provided
      if (authCredentials) {
        const authId = 'auth_' + crypto.randomUUID();
        tx.run(`
          INSERT INTO auth_configs (id, destination_id, auth_type, credentials, created_at)
          VALUES (?, ?, ?, ?, ?)
        `, authId, id, data.auth_type || 'api_key', JSON.stringify(authCredentials), now);
      }
    });

    logger.info(`Created destination: ${data.name} (${id})`, { destination_id: id });
    return this.getDestination(id);
  }

  updateDestination(id, data, authCredentials = null) {
    const existing = this.getDestination(id);
    if (!existing) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${id}' not found`, {}, 404);
    }

    const now = new Date().toISOString();
    const audienceTags = data.audience_tags !== undefined
      ? JSON.stringify(data.audience_tags)
      : JSON.stringify(existing.audience_tags);

    this.db.transaction((tx) => {
      tx.run(`
        UPDATE destinations
        SET name = COALESCE(?, name),
            url = COALESCE(?, url),
            category = COALESCE(?, category),
            audience_tags = ?,
            rules_url = COALESCE(?, rules_url),
            frequency_cap = COALESCE(?, frequency_cap),
            self_promo_allowed = COALESCE(?, self_promo_allowed),
            link_policy = COALESCE(?, link_policy),
            disclosure_required = COALESCE(?, disclosure_required),
            relevance_score = COALESCE(?, relevance_score),
            relevance_reason = COALESCE(?, relevance_reason),
            is_enabled = COALESCE(?, is_enabled),
            simulation_mode = COALESCE(?, simulation_mode),
            status = COALESCE(?, status),
            updated_at = ?
        WHERE id = ?
      `,
        data.name,
        data.url,
        data.category,
        audienceTags,
        data.rules_url,
        data.frequency_cap,
        data.self_promo_allowed !== undefined ? (data.self_promo_allowed ? 1 : 0) : null,
        data.link_policy,
        data.disclosure_required !== undefined ? (data.disclosure_required ? 1 : 0) : null,
        data.relevance_score,
        data.relevance_reason,
        data.is_enabled !== undefined ? (data.is_enabled ? 1 : 0) : null,
        data.simulation_mode !== undefined ? (data.simulation_mode ? 1 : 0) : null,
        data.status,
        now,
        id
      );

      if (authCredentials) {
        tx.run('DELETE FROM auth_configs WHERE destination_id = ?', id);
        const authId = 'auth_' + crypto.randomUUID();
        tx.run(`
          INSERT INTO auth_configs (id, destination_id, auth_type, credentials, created_at)
          VALUES (?, ?, ?, ?, ?)
        `, authId, id, data.auth_type || 'api_key', JSON.stringify(authCredentials), now);
      }
    });

    return this.getDestination(id);
  }

  deleteDestination(id) {
    const existing = this.getDestination(id);
    if (!existing) {
      throw new IncuBrixError('DESTINATION_NOT_FOUND', `Destination '${id}' not found`, {}, 404);
    }

    this.db.run('DELETE FROM destinations WHERE id = ?', id);
    logger.info(`Deleted destination: ${id}`);
    return { deleted: true, id };
  }

  async importCsv(csvString, options = {}) {
    const startTime = Date.now();
    let records = [];

    try {
      records = parseCsv(csvString, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } catch (err) {
      throw new IncuBrixError('CSV_PARSE_ERROR', `Failed to parse CSV: ${err.message}`, {}, 400);
    }

    let importedCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const reportRows = [];
    const seenBatch = new Set();
    const validRowsToProcess = [];

    // 1. Initial validation & intra-batch deduplication
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2; // 1-indexed plus header row

      if (!row.name || !row.url || !row.platform_key) {
        const errMsg = 'Missing required field: name, url, or platform_key';
        errors.push({
          row: rowNum,
          name: row.name || 'Unknown',
          error: errMsg
        });
        reportRows.push({
          row: rowNum,
          name: row.name || 'Unknown',
          platform_key: row.platform_key || 'unknown',
          url: row.url || '',
          status: 'validation_error',
          error: errMsg,
          language: 'unknown',
          enriched: false
        });
        continue;
      }

      const normUrl = normalizeUrl(row.url);
      const dedupeKey = `${row.platform_key}:${normUrl}`;

      if (seenBatch.has(dedupeKey)) {
        duplicateCount++;
        reportRows.push({
          row: rowNum,
          name: row.name,
          platform_key: row.platform_key,
          url: normUrl,
          status: 'duplicate',
          error: 'Duplicate within CSV batch',
          language: row.language || 'en',
          enriched: false
        });
        continue;
      }
      seenBatch.add(dedupeKey);

      // Check existing in DB
      const existing = this.db.get(
        'SELECT id FROM destinations WHERE platform_key = ? AND (url = ? OR url LIKE ?)',
        row.platform_key,
        normUrl,
        normUrl + '%'
      );

      if (existing) {
        duplicateCount++;
        reportRows.push({
          row: rowNum,
          name: row.name,
          platform_key: row.platform_key,
          url: normUrl,
          status: 'duplicate',
          error: 'Destination already exists in database',
          language: row.language || 'en',
          enriched: false
        });
        continue;
      }

      validRowsToProcess.push({ row, rowNum, normUrl });
    }

    // 2. Concurrency pool for reachability & enrichment
    const concurrency = options.concurrency || 25;
    const processedRows = [];

    let processIndex = 0;
    const worker = async () => {
      while (processIndex < validRowsToProcess.length) {
        const current = validRowsToProcess[processIndex++];
        const { row, rowNum, normUrl } = current;

        let reachable = true;
        let enrichedTitle = null;
        let enrichedDesc = null;
        let enrichedAudience = null;

        // Skip network call if dryRun or synthetic benchmark flag set
        if (!options.skipNetwork) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);

          try {
            if (row.platform_key === 'discourse') {
              const resp = await fetch(`${normUrl}/about.json`, { signal: controller.signal });
              if (resp.ok) {
                const body = await resp.json().catch(() => null);
                if (body?.about) {
                  enrichedTitle = body.about.title || null;
                  enrichedDesc = body.about.description || null;
                  enrichedAudience = body.about.stats?.topic_count || null;
                }
              } else if (resp.status >= 500) {
                reachable = false;
              }
            } else if (row.platform_key === 'lemmy') {
              const resp = await fetch(`${normUrl}/api/v3/site`, { signal: controller.signal });
              if (resp.ok) {
                const body = await resp.json().catch(() => null);
                if (body?.site_view?.site) {
                  enrichedTitle = body.site_view.site.name || null;
                  enrichedDesc = body.site_view.site.description || null;
                }
              } else if (resp.status >= 500) {
                reachable = false;
              }
            } else {
              // Generic reachability check via HEAD/GET
              const headResp = await fetch(normUrl, { method: 'HEAD', signal: controller.signal }).catch(() => null);
              if (!headResp || headResp.status >= 500) {
                const getResp = await fetch(normUrl, { method: 'GET', signal: controller.signal }).catch(() => null);
                if (!getResp || getResp.status >= 500) {
                  reachable = false;
                }
              }
            }
          } catch {
            reachable = false;
          } finally {
            clearTimeout(timer);
          }
        }

        // Language detection
        const lang = row.language || detectLanguage(`${row.name} ${row.category || ''} ${row.relevance_reason || ''}`);

        // Enrichment formatting
        let relevanceReason = row.relevance_reason || null;
        if (enrichedTitle || enrichedDesc) {
          const detail = enrichedTitle || enrichedDesc;
          relevanceReason = relevanceReason ? `${relevanceReason} [${detail}]` : detail;
        }

        const estAudience = enrichedAudience || parseInt(row.est_audience || '0', 10);

        processedRows.push({
          row,
          rowNum,
          normUrl,
          reachable,
          lang,
          relevanceReason,
          estAudience,
          enriched: Boolean(enrichedTitle || enrichedDesc || enrichedAudience)
        });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, validRowsToProcess.length || 1) }, () => worker());
    await Promise.all(workers);

    // 3. Batch insert valid rows in database transaction
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const item of processedRows) {
        const { row, rowNum, normUrl, lang, relevanceReason, estAudience, enriched } = item;
        const id = 'dest_' + crypto.randomUUID();

        // Process audience tags
        let tags = '[]';
        if (row.audience_tags) {
          try {
            tags = JSON.stringify(
              row.audience_tags.startsWith('[')
                ? JSON.parse(row.audience_tags)
                : row.audience_tags.split(';').map(t => t.trim())
            );
          } catch {
            tags = JSON.stringify([row.audience_tags]);
          }
        }

        tx.run(`
          INSERT INTO destinations (
            id, name, url, platform_key, surface, category, audience_tags,
            language, geo, est_audience, rules_url, frequency_cap,
            self_promo_allowed, link_policy, disclosure_required, automation_allowed,
            connector_key, relevance_score, relevance_reason, level,
            is_enabled, simulation_mode, status, source_url, researched_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'uncertified', ?, ?, ?, ?)
        `,
          id,
          row.name,
          normUrl,
          row.platform_key,
          row.surface || 'default',
          row.category || null,
          tags,
          lang,
          row.geo || 'global',
          estAudience,
          row.rules_url || null,
          row.frequency_cap || null,
          row.self_promo_allowed !== undefined && row.self_promo_allowed !== '' && row.self_promo_allowed !== null ? (row.self_promo_allowed === '1' || row.self_promo_allowed === 'true' || row.self_promo_allowed === 1 ? 1 : 0) : null,
          row.link_policy || null,
          row.disclosure_required !== undefined && row.disclosure_required !== '' && row.disclosure_required !== null ? (row.disclosure_required === '1' || row.disclosure_required === 'true' || row.disclosure_required === 1 ? 1 : 0) : null,
          row.automation_allowed !== undefined && row.automation_allowed !== '' && row.automation_allowed !== null ? (row.automation_allowed === '1' || row.automation_allowed === 'true' || row.automation_allowed === 1 ? 1 : 0) : null,
          row.connector_key || row.platform_key,
          parseInt(row.relevance_score || '3', 10),
          relevanceReason,
          row.level || 'L0',
          row.source_url || null,
          row.researched_at || null,
          now,
          now
        );

        importedCount++;
        reportRows.push({
          row: rowNum,
          name: row.name,
          platform_key: row.platform_key,
          url: normUrl,
          status: 'imported',
          error: null,
          language: lang,
          enriched
        });
      }
    });

    const durationMs = Date.now() - startTime;
    logger.info(`CSV import finished: ${importedCount} imported, ${duplicateCount} duplicates, ${errors.length} errors in ${durationMs}ms`);

    // 4. Generate JSON and CSV reports and save to MinIO/S3 storage
    const reportJson = JSON.stringify(reportRows, null, 2);
    const reportCsv = stringifyCsv(reportRows, { header: true });
    const timestamp = Date.now();

    const jsonFile = await storageService.saveFile('reports', `catalogue_import_${timestamp}.json`, reportJson, 'application/json');
    const csvFile = await storageService.saveFile('reports', `catalogue_import_${timestamp}.csv`, reportCsv, 'text/csv');

    return {
      total_rows: records.length,
      imported_count: importedCount,
      duplicate_count: duplicateCount,
      error_count: errors.length,
      errors,
      report_json_url: jsonFile.downloadUrl,
      report_csv_url: csvFile.downloadUrl,
      duration_ms: durationMs
    };
  }

  exportCsv() {
    const rows = this.db.query(`
      SELECT
        name, url, platform_key, surface, category, audience_tags,
        language, geo, est_audience, rules_url, frequency_cap,
        self_promo_allowed, link_policy, disclosure_required, automation_allowed,
        connector_key, relevance_score, relevance_reason, level, last_certified_at
      FROM destinations
      ORDER BY relevance_score DESC, name ASC
    `);

    return stringifyCsv(rows, { header: true });
  }

  ensureCatalogue150Loaded(csvPath = null) {
    const targetPath = csvPath || path.join(config.paths.data, 'catalogue_150_destinations.csv');
    if (!fs.existsSync(targetPath)) {
      logger.warn(`Catalogue CSV not found at ${targetPath}`);
      return { loaded: 0, skipped: 0, total: 0 };
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    const records = parseCsv(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const existingRows = this.db.query('SELECT platform_key, url FROM destinations');
    const existingSet = new Set(existingRows.map(r => `${r.platform_key}::${r.url}`));

    let loaded = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    this.db.transaction((tx) => {
      for (const row of records) {
        const normUrl = normalizeUrl(row.url);
        const key = `${row.platform_key}::${normUrl}`;
        if (existingSet.has(key)) {
          skipped++;
          continue;
        }

        const id = 'dest_' + crypto.randomUUID();
        let tags = '[]';
        if (row.audience_tags) {
          try {
            tags = JSON.stringify(
              row.audience_tags.startsWith('[')
                ? JSON.parse(row.audience_tags)
                : row.audience_tags.split(';').map(t => t.trim())
            );
          } catch {
            tags = JSON.stringify([row.audience_tags]);
          }
        }

        tx.run(`
          INSERT INTO destinations (
            id, name, url, platform_key, surface, category, audience_tags,
            language, geo, est_audience, rules_url, frequency_cap,
            self_promo_allowed, link_policy, disclosure_required, automation_allowed,
            connector_key, relevance_score, relevance_reason, level,
            is_enabled, simulation_mode, status, source_url, researched_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'catalogued', ?, ?, ?, ?)
        `,
          id,
          row.name,
          normUrl,
          row.platform_key,
          row.surface || 'default',
          row.category || null,
          tags,
          row.language || 'en',
          row.geo || 'global',
          row.est_audience ? Number(row.est_audience) : null,
          row.rules_url || null,
          row.frequency_cap || null,
          row.self_promo_allowed !== undefined && row.self_promo_allowed !== '' && row.self_promo_allowed !== null ? (row.self_promo_allowed === '1' || row.self_promo_allowed === 'true' || row.self_promo_allowed === 1 ? 1 : 0) : null,
          row.link_policy || null,
          row.disclosure_required !== undefined && row.disclosure_required !== '' && row.disclosure_required !== null ? (row.disclosure_required === '1' || row.disclosure_required === 'true' || row.disclosure_required === 1 ? 1 : 0) : null,
          row.automation_allowed !== undefined && row.automation_allowed !== '' && row.automation_allowed !== null ? (row.automation_allowed === '1' || row.automation_allowed === 'true' || row.automation_allowed === 1 ? 1 : 0) : null,
          row.connector_key || row.platform_key,
          parseInt(row.relevance_score || '3', 10),
          row.relevance_reason || null,
          row.level || 'L0',
          row.source_url || null,
          row.researched_at || null,
          now,
          now
        );

        existingSet.add(key);
        loaded++;
      }
    });

    logger.info(`ensureCatalogue150Loaded: ${loaded} imported, ${skipped} already existed (total in file: ${records.length}).`);
    return { loaded, skipped, total: records.length };
  }
}

export const catalogueService = new CatalogueService();
export default catalogueService;
