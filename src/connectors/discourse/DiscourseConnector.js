import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import { PlatformUnavailableError, ConnectionSecretMissingError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DiscourseConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  async validate(rendition, destination, connection) {
    const baseValidation = await super.validate(rendition, destination, connection);
    const violations = [...baseValidation.violations];

    if (!rendition.title || rendition.title.trim().length < 15) {
      violations.push({
        field: 'title',
        rule: 'min_length',
        message: 'Discourse requires topic title to be at least 15 characters'
      });
    }

    if (!rendition.body || rendition.body.trim().length < 20) {
      violations.push({
        field: 'body',
        rule: 'min_length',
        message: 'Discourse requires post body to be at least 20 characters'
      });
    }

    return {
      ok: violations.length === 0,
      violations
    };
  }

  resolveUrl(destination = {}, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || destination.url || '';
    if (!destination.simulation_mode && destination.simulation_mode !== undefined && destination.simulation_mode !== null) {
      return rawUrl.replace(/\/+$/, '');
    }
    if (rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'))) {
      return rawUrl.replace(/\/+$/, '');
    }
    return (process.env.MOCK_DISCOURSE_URL || 'http://127.0.0.1:4000/mock/discourse').replace(/\/+$/, '');
  }

  async publish(rendition, destination, connection = {}, idempotencyKey) {
    const baseUrl = this.resolveUrl(destination, connection);
    const postUrl = `${baseUrl}/posts.json`;

    const isSimulation = Boolean(destination?.simulation_mode && destination?.simulation_mode !== 0 && destination?.simulation_mode !== '0');
    const apiKey = connection.apiKey || connection.api_key;
    if (!apiKey && !isSimulation) {
      throw new ConnectionSecretMissingError('Discourse API key missing from connection/secret_ref');
    }
    const resolvedApiKey = apiKey || (isSimulation ? 'test_discourse_key' : '');
    const apiUsername = connection.username || connection.api_username || 'system';

    const marker = idempotencyKey ? `<!-- incubrix_marker:${idempotencyKey} -->` : '';
    let rawContent = rendition.body + (rendition.canonical_url ? `\n\n[Original Source](${rendition.canonical_url})` : '');
    if (marker) {
      rawContent += `\n\n${marker}`;
    }

    const payload = {
      title: rendition.title,
      raw: rawContent,
      category: connection.categoryId || 1
    };

    try {
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': resolvedApiKey,
          'Api-Username': apiUsername,
          ...(connection.mockFault ? { 'X-Mock-Fault': connection.mockFault } : {})
        },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      // Hard Case: Validate expected schema via need()
      const postId = this.need(body, 'id');
      const liveUrl = (body.url && body.url.startsWith('http')) ? body.url : `${baseUrl}/t/topic/${postId}`;

      return {
        platform_post_id: String(postId),
        live_url: liveUrl,
        status: 'published'
      };
    } catch (err) {
      if (err.name === 'IncuBrixError' || err.code) throw err;
      throw new PlatformUnavailableError(`Discourse communication failed: ${err.message}`);
    }
  }

  async findByMarker(marker, destination = {}, connection = {}) {
    if (!marker) return null;
    const baseUrl = this.resolveUrl(destination, connection);
    const searchUrl = `${baseUrl}/search.json?q=${encodeURIComponent(marker)}`;
    const apiKey = connection.apiKey || connection.api_key || 'test_discourse_key';
    const apiUsername = connection.username || connection.api_username || 'system';

    try {
      const response = await fetch(searchUrl, {
        headers: {
          'Api-Key': apiKey,
          'Api-Username': apiUsername
        }
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      const posts = data.posts || [];
      const matched = posts.find(p => (p.raw && p.raw.includes(marker)) || (p.blurb && p.blurb.includes(marker)));
      if (matched) {
        return {
          platform_post_id: String(matched.id),
          live_url: `${baseUrl}/t/topic/${matched.id}`,
          status: 'published'
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getStatus(platformPostId, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false || (!connection.simulation_mode && connection.simulation === false);
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DISCOURSE_URL || 'http://127.0.0.1:4000/mock/discourse')).replace(/\/+$/, '');
    const postUrl = `${baseUrl}/posts/${platformPostId}.json`;

    const isSimulation = Boolean(connection.simulation_mode && connection.simulation_mode !== 0 && connection.simulation_mode !== '0');
    const apiKey = connection.apiKey || connection.api_key;
    if (!apiKey && !isSimulation) {
      throw new ConnectionSecretMissingError('Discourse API key missing from connection/secret_ref');
    }
    const resolvedApiKey = apiKey || (isSimulation ? 'test_discourse_key' : '');
    const apiUsername = connection.username || connection.api_username || 'system';

    try {
      const response = await fetch(postUrl, {
        method: 'GET',
        headers: {
          'Api-Key': resolvedApiKey,
          'Api-Username': apiUsername
        }
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      return {
        status: 'published',
        live_url: (body.url && body.url.startsWith('http')) ? body.url : `${baseUrl}/t/topic/${platformPostId}`
      };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Discourse getStatus failed: ${err.message}`);
    }
  }

  async delete(platformPostId, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false || (!connection.simulation_mode && connection.simulation === false);
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DISCOURSE_URL || 'http://127.0.0.1:4000/mock/discourse')).replace(/\/+$/, '');
    const postUrl = `${baseUrl}/posts/${platformPostId}.json`;

    const isSimulation = Boolean(connection.simulation_mode && connection.simulation_mode !== 0 && connection.simulation_mode !== '0');
    const apiKey = connection.apiKey || connection.api_key;
    if (!apiKey && !isSimulation) {
      throw new ConnectionSecretMissingError('Discourse API key missing from connection/secret_ref');
    }
    const resolvedApiKey = apiKey || (isSimulation ? 'test_discourse_key' : '');
    const apiUsername = connection.username || connection.api_username || 'system';

    try {
      const response = await fetch(postUrl, {
        method: 'DELETE',
        headers: {
          'Api-Key': resolvedApiKey,
          'Api-Username': apiUsername
        }
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw this.mapError(response.status, body, response.headers);
      }

      return { deleted: true };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Discourse delete failed: ${err.message}`);
    }
  }

  async verifyCredentials(destination, connection = {}) {
    const isSimulation = Boolean(destination?.simulation_mode && destination?.simulation_mode !== 0 && destination?.simulation_mode !== '0');
    const apiKey = connection.apiKey || connection.api_key;
    if (!apiKey && !isSimulation) {
      throw new ConnectionSecretMissingError('Discourse API key missing from connection/secret_ref');
    }
    const resolvedApiKey = apiKey || (isSimulation ? 'test_discourse_key' : '');
    const apiUsername = connection.username || connection.api_username || 'system';
    const baseUrl = this.resolveUrl(destination, connection);
    const authUrl = `${baseUrl}/about.json`;
    const response = await fetch(authUrl, {
      headers: {
        'Api-Key': resolvedApiKey,
        'Api-Username': apiUsername
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw this.mapError(response.status, body, response.headers);
    }
    return { ok: true };
  }

  async fetchMetrics(platformPostId, connection = {}, since) {
    const rawUrl = connection.base_url || connection.baseUrl || '';
    const isRealInstance = connection.simulation_mode === 0 || connection.simulation_mode === false || (!connection.simulation_mode && connection.simulation === false);
    const isLocal = rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'));
    const baseUrl = (isRealInstance || isLocal
      ? rawUrl
      : (process.env.MOCK_DISCOURSE_URL || 'http://127.0.0.1:4000/mock/discourse')).replace(/\/+$/, '');
    const topicUrl = `${baseUrl}/topics/${platformPostId}.json`;

    try {
      const response = await fetch(topicUrl, {
        headers: {
          'Api-Key': connection.apiKey || 'test_discourse_key',
          'Api-Username': connection.username || 'system'
        }
      });

      if (!response.ok) {
        return super.fetchMetrics(platformPostId, connection, since);
      }

      const data = await response.json().catch(() => ({}));
      return {
        views: data.views || 0,
        likes: data.like_count || 0,
        comments: Math.max(0, (data.posts_count || 1) - 1),
        shares: 0,
        saves: 0,
        watch_time_s: 0,
        clicks: 0
      };
    } catch {
      return super.fetchMetrics(platformPostId, connection, since);
    }
  }
}

export default DiscourseConnector;
