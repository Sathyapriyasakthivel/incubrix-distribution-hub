import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BaseConnector from '../base/BaseConnector.js';
import { PlatformUnavailableError, ConnectionSecretMissingError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class LemmyConnector extends BaseConnector {
  constructor() {
    super(path.join(__dirname, 'manifest.yaml'));
  }

  async validate(rendition, destination, connection) {
    const baseValidation = await super.validate(rendition, destination, connection);
    const violations = [...baseValidation.violations];

    if (!rendition.title || rendition.title.trim().length < 3) {
      violations.push({
        field: 'title',
        rule: 'min_length',
        message: 'Lemmy post name must be at least 3 characters'
      });
    }

    if (rendition.title && rendition.title.length > 200) {
      violations.push({
        field: 'title',
        rule: 'max_length',
        message: 'Lemmy post name must not exceed 200 characters'
      });
    }

    if (!rendition.body || rendition.body.trim().length < 5) {
      violations.push({
        field: 'body',
        rule: 'min_length',
        message: 'Lemmy post body must be at least 5 characters'
      });
    }

    return {
      ok: violations.length === 0,
      violations
    };
  }

  resolveUrl(destination = {}, connection = {}) {
    const rawUrl = connection.base_url || connection.baseUrl || destination.url || '';
    const isMock = rawUrl && rawUrl.includes('/mock');
    if (!isMock && process.env.LEMMY_LOCAL_URL && (rawUrl.includes('localhost:8536') || rawUrl.includes('127.0.0.1:8536') || rawUrl.includes('lemmy:8536') || rawUrl === 'http://lemmy' || rawUrl === 'http://lemmy/')) {
      return process.env.LEMMY_LOCAL_URL.replace(/\/+$/, '');
    }
    if (!destination.simulation_mode && destination.simulation_mode !== undefined && destination.simulation_mode !== null) {
      return rawUrl.replace(/\/+$/, '');
    }
    if (connection.simulation_mode === 0 || connection.simulation_mode === false || (!connection.simulation_mode && connection.simulation === false)) {
      return rawUrl.replace(/\/+$/, '');
    }
    if (rawUrl && (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1') || rawUrl.includes('mock'))) {
      return rawUrl.replace(/\/+$/, '');
    }
    return (process.env.MOCK_LEMMY_URL || 'http://127.0.0.1:4000/mock/lemmy').replace(/\/+$/, '');
  }

  async publish(rendition, destination, connection = {}, idempotencyKey) {
    const baseUrl = this.resolveUrl(destination, connection);
    const postUrl = `${baseUrl}/api/v3/post`;

    const isSimulation = Boolean(destination?.simulation_mode && destination?.simulation_mode !== 0 && destination?.simulation_mode !== '0');
    const token = connection.token || connection.jwt;
    if (!token && !isSimulation) {
      throw new ConnectionSecretMissingError('Lemmy auth token missing from connection/secret_ref');
    }
    const resolvedToken = token || (isSimulation ? 'lemmy_mock_jwt_token' : '');

    const marker = idempotencyKey ? `<!-- incubrix_marker:${idempotencyKey} -->` : '';
    let bodyText = rendition.body + (rendition.canonical_url ? `\n\n[Discussion link](${rendition.canonical_url})` : '');
    if (marker) {
      bodyText += `\n\n${marker}`;
    }

    const payload = {
      name: rendition.title,
      body: bodyText,
      community_id: connection.community_id || 1
    };

    try {
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedToken}`,
          ...(connection.mockFault ? { 'X-Mock-Fault': connection.mockFault } : {})
        },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      // Hard Case: Validate expected schema via need()
      const postId = this.need(body, 'post_view.post.id');
      const postView = body.post_view;
      const liveUrl = (postView?.post?.ap_id && postView.post.ap_id.startsWith('http'))
        ? postView.post.ap_id
        : `${baseUrl}/post/${postId}`;

      return {
        platform_post_id: String(postId),
        live_url: liveUrl,
        status: 'published',
        http_status: response.status,
        request_url: postUrl
      };
    } catch (err) {
      if (err.name === 'IncuBrixError' || err.code) throw err;
      throw new PlatformUnavailableError(`Lemmy publish failed: ${err.message}`);
    }
  }

  async findByMarker(marker, destination = {}, connection = {}) {
    if (!marker) return null;
    const baseUrl = this.resolveUrl(destination, connection);
    const searchUrl = `${baseUrl}/api/v3/search?q=${encodeURIComponent(marker)}&type_=Posts`;
    const token = connection.token || 'lemmy_mock_jwt_token';

    try {
      const response = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      const posts = data.posts || [];
      const matched = posts.find(p => {
        const post = p.post || p;
        return post.body && post.body.includes(marker);
      });
      if (matched) {
        const post = matched.post || matched;
        return {
          platform_post_id: String(post.id),
          live_url: post.ap_id || `${baseUrl}/post/${post.id}`,
          status: 'published'
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getStatus(platformPostId, connection = {}) {
    const baseUrl = this.resolveUrl({}, connection);
    const postUrl = `${baseUrl}/api/v3/post?id=${platformPostId}`;
    const isSimulation = Boolean(connection.simulation_mode && connection.simulation_mode !== 0 && connection.simulation_mode !== '0');
    const token = connection.token || connection.jwt;
    if (!token && !isSimulation) {
      throw new ConnectionSecretMissingError('Lemmy auth token missing from connection/secret_ref');
    }
    const resolvedToken = token || (isSimulation ? 'lemmy_mock_jwt_token' : '');

    try {
      const response = await fetch(postUrl, {
        headers: {
          Authorization: `Bearer ${resolvedToken}`
        }
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw this.mapError(response.status, body, response.headers);
      }

      const postView = body.post_view;
      return {
        status: postView?.post?.deleted ? 'deleted' : 'published',
        live_url: (postView?.post?.ap_id && postView.post.ap_id.startsWith('http'))
          ? postView.post.ap_id
          : `${baseUrl}/post/${platformPostId}`,
        http_status: response.status,
        request_url: postUrl
      };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Lemmy getStatus failed: ${err.message}`);
    }
  }

  async delete(platformPostId, connection = {}) {
    const baseUrl = this.resolveUrl({}, connection);
    const deleteUrl = `${baseUrl}/api/v3/post/delete`;
    const isSimulation = Boolean(connection.simulation_mode && connection.simulation_mode !== 0 && connection.simulation_mode !== '0');
    const token = connection.token || connection.jwt;
    if (!token && !isSimulation) {
      throw new ConnectionSecretMissingError('Lemmy auth token missing from connection/secret_ref');
    }
    const resolvedToken = token || (isSimulation ? 'lemmy_mock_jwt_token' : '');

    try {
      const response = await fetch(deleteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedToken}`
        },
        body: JSON.stringify({
          post_id: isNaN(parseInt(platformPostId, 10)) ? platformPostId : parseInt(platformPostId, 10),
          deleted: true
        })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw this.mapError(response.status, body, response.headers);
      }

      return {
        deleted: true,
        http_status: response.status,
        request_url: deleteUrl
      };
    } catch (err) {
      if (err.name === 'IncuBrixError') throw err;
      throw new PlatformUnavailableError(`Lemmy delete failed: ${err.message}`);
    }
  }

  async verifyCredentials(destination, connection = {}) {
    const isSimulation = Boolean(destination?.simulation_mode && destination?.simulation_mode !== 0 && destination?.simulation_mode !== '0');
    const token = connection.token || connection.jwt;
    if (!token && !isSimulation) {
      throw new ConnectionSecretMissingError('Lemmy auth token missing from connection/secret_ref');
    }
    const resolvedToken = token || (isSimulation ? 'lemmy_mock_jwt_token' : '');
    const baseUrl = this.resolveUrl(destination, connection);
    const authUrl = `${baseUrl}/api/v3/site`;
    const response = await fetch(authUrl, {
      headers: { Authorization: `Bearer ${resolvedToken}` }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw this.mapError(response.status, body, response.headers);
    }
    return {
      ok: true,
      http_status: response.status,
      request_url: authUrl
    };
  }

  async fetchMetrics(platformPostId, connection = {}, since) {
    const baseUrl = this.resolveUrl({}, connection);
    const postUrl = `${baseUrl}/api/v3/post?id=${platformPostId}`;

    try {
      const response = await fetch(postUrl, {
        headers: { Authorization: `Bearer ${connection.token || 'lemmy_mock_jwt_token'}` }
      });

      if (!response.ok) return super.fetchMetrics(platformPostId, connection, since);

      const body = await response.json().catch(() => ({}));
      const counts = body.post_view?.counts || {};

      return {
        views: 0,
        likes: counts.score || counts.upvotes || 0,
        comments: counts.comments || 0,
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

export default LemmyConnector;
