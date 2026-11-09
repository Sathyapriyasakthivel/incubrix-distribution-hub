import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { BaseConnector } from '../base/BaseConnector.js';
import { getDatabase } from '../../database/db.js';
import { IncuBrixError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MrssConnector extends BaseConnector {
  constructor(manifestPath = path.join(__dirname, 'manifest.yaml')) {
    super(manifestPath);
  }

  get db() {
    return getDatabase();
  }

  /**
   * Validate rendition against MRSS video feed specification
   */
  async validate(rendition, destination, connection) {
    const base = await super.validate(rendition, destination, connection);
    const violations = [...base.violations];

    if (!rendition.title || rendition.title.trim().length === 0) {
      violations.push({
        field: 'title',
        rule: 'required',
        message: 'MRSS video feed item requires a non-empty title'
      });
    }

    if (rendition.media_urls && Array.isArray(rendition.media_urls) && rendition.media_urls.length > 0) {
      const allowedExts = ['.mp4', '.webm', '.m4v', '.jpg', '.jpeg', '.png', '.webp'];
      for (const mediaUrl of rendition.media_urls) {
        try {
          const parsed = new URL(mediaUrl);
          const ext = path.extname(parsed.pathname).toLowerCase();
          if (ext && !allowedExts.includes(ext)) {
            violations.push({
              field: 'media_urls',
              rule: 'allowed_media_types',
              message: `Media format '${ext}' is not supported by MRSS video feed. Allowed: video/mp4, video/webm, image/jpeg, image/png`
            });
          }
        } catch {}
      }
    }

    return {
      ok: violations.length === 0,
      violations
    };
  }

  /**
   * Publish item to the MRSS video feed
   */
  async publish(rendition, destination, connection, idempotencyKey) {
    const validation = await this.validate(rendition, destination, connection);
    if (!validation.ok) {
      throw new IncuBrixError('DEST_SPEC_VIOLATION', 'Content failed MRSS feed validation', { violations: validation.violations }, 422);
    }

    const marker = idempotencyKey ? `incubrix_marker:${idempotencyKey}` : null;

    if (marker && destination?.id) {
      const existing = await this.findByMarker(destination.id, marker);
      if (existing) {
        logger.info(`Idempotent match found for MRSS feed item: ${existing.id}`);
        return {
          platform_post_id: existing.id,
          live_url: existing.live_url,
          status: 'published'
        };
      }
    }

    const id = `mrss_${crypto.randomUUID()}`;
    const destinationId = destination.id || 'default_feed';
    const appUrl = connection.base_url || process.env.APP_URL || 'http://localhost:3000';
    const baseUrl = appUrl.replace(/\/+$/, '');
    const liveUrl = `${baseUrl}/feeds/${destinationId}.xml#${id}`;
    const now = new Date().toISOString();

    const mediaUrl = (rendition.media_urls && rendition.media_urls[0]) || rendition.canonical_url || `${baseUrl}/media/default-video.mp4`;
    const thumbnailUrl = (rendition.media_urls && rendition.media_urls.length > 1) ? rendition.media_urls[1] : null;

    this.db.prepare(`
      INSERT INTO feed_items (
        id, destination_id, title, description, link,
        guid, media_url, media_type, media_duration,
        thumbnail_url, status, idempotency_marker,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
    `).run(
      id,
      destinationId,
      rendition.title,
      rendition.body || '',
      rendition.canonical_url || liveUrl,
      id,
      mediaUrl,
      'video/mp4',
      120,
      thumbnailUrl,
      marker,
      now,
      now
    );

    logger.info(`Published item to MRSS feed ${destinationId}: ${id}`);

    return {
      platform_post_id: id,
      live_url: liveUrl,
      status: 'published'
    };
  }

  /**
   * Check status of item in MRSS feed
   */
  async getStatus(platformPostId, connection) {
    const row = this.db.prepare(`
      SELECT * FROM feed_items WHERE id = ?
    `).get(platformPostId);

    if (!row || row.status === 'deleted') {
      return {
        status: 'deleted',
        live_url: null
      };
    }

    const appUrl = connection?.base_url || process.env.APP_URL || 'http://localhost:3000';
    const baseUrl = appUrl.replace(/\/+$/, '');

    return {
      status: 'published',
      live_url: `${baseUrl}/feeds/${row.destination_id}.xml#${row.id}`
    };
  }

  /**
   * Delete item from MRSS feed (soft delete / remove from syndication)
   */
  async delete(platformPostId, connection) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE feed_items
      SET status = 'deleted', updated_at = ?
      WHERE id = ?
    `).run(now, platformPostId);

    if (result.changes === 0) {
      return {
        deleted: true,
        platform_post_id: platformPostId,
        note: 'Item already deleted or not found'
      };
    }

    logger.info(`Deleted item ${platformPostId} from MRSS feed`);

    return {
      deleted: true,
      platform_post_id: platformPostId
    };
  }

  /**
   * Find item by idempotency marker
   */
  async findByMarker(destinationId, marker) {
    const row = this.db.prepare(`
      SELECT * FROM feed_items
      WHERE destination_id = ? AND idempotency_marker = ? AND status != 'deleted'
      LIMIT 1
    `).get(destinationId, marker);

    if (!row) return null;

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const baseUrl = appUrl.replace(/\/+$/, '');

    return {
      id: row.id,
      live_url: `${baseUrl}/feeds/${row.destination_id}.xml#${row.id}`,
      title: row.title,
      status: row.status
    };
  }

  /**
   * Metric fetching (MRSS feeds do not provide platform-side metrics)
   */
  async fetchMetrics(platformPostId, connection, since) {
    return {
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      watch_time_s: 0,
      clicks: 0
    };
  }
}

export default MrssConnector;
