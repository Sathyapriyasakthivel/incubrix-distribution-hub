import express from 'express';
import registry from '../connectors/ConnectorRegistry.js';
import { formatErrorResponse, IncuBrixError } from '../utils/errors.js';

const router = express.Router();

// GET /connector/v1/ - List all connectors and manifests
router.get('/', (req, res) => {
  res.json({
    connectors: registry.listConnectors()
  });
});

// GET /connector/v1/:connector_key/manifest - Get single connector manifest
router.get('/:connector_key/manifest', (req, res) => {
  try {
    const connector = registry.getConnector(req.params.connector_key);
    res.json(connector.manifest);
  } catch (err) {
    const formatted = formatErrorResponse(err);
    res.status(formatted.status).json(formatted.body);
  }
});

// POST /connector/v1/:connector_key/:method - Official IncuBrix Connector Contract Endpoint
router.post('/:connector_key/:method', async (req, res) => {
  const { connector_key, method } = req.params;
  const body = req.body || {};
  const destination = body.destination || {};
  const connection = body.connection || {};

  if (destination.url && !connection.base_url && !connection.baseUrl) {
    connection.base_url = destination.url;
  }
  if (destination.secret_ref && process.env[destination.secret_ref]) {
    const envSecret = process.env[destination.secret_ref];
    connection.secret = connection.secret || envSecret;
    connection.token = connection.token || envSecret;
    connection.jwt = connection.jwt || envSecret;
    connection.apiKey = connection.apiKey || envSecret;
    connection.api_key = connection.api_key || envSecret;
  }

  try {
    switch (method) {
      case 'validate': {
        const { rendition = {} } = body;
        const result = await registry.validate(connector_key, rendition, destination, connection);
        return res.status(200).json(result);
      }

      case 'publish': {
        const { rendition = {}, destination = {}, connection = {}, idempotency_key = null } = body;
        const result = await registry.publish(connector_key, rendition, destination, connection, idempotency_key);
        return res.status(200).json(result);
      }

      case 'get_status': {
        const { platform_post_id, connection = {} } = body;
        if (!platform_post_id) {
          throw new IncuBrixError('VALIDATION_ERROR', 'platform_post_id is required', {}, 400);
        }
        const result = await registry.getStatus(connector_key, platform_post_id, connection);
        return res.status(200).json(result);
      }

      case 'delete': {
        const { platform_post_id, connection = {} } = body;
        if (!platform_post_id) {
          throw new IncuBrixError('VALIDATION_ERROR', 'platform_post_id is required', {}, 400);
        }
        const result = await registry.delete(connector_key, platform_post_id, connection);
        return res.status(200).json(result);
      }

      case 'fetch_metrics': {
        const { platform_post_id, connection = {}, since = null } = body;
        if (!platform_post_id) {
          throw new IncuBrixError('VALIDATION_ERROR', 'platform_post_id is required', {}, 400);
        }
        const result = await registry.fetchMetrics(connector_key, platform_post_id, connection, since);
        return res.status(200).json(result);
      }

      case 'refresh_auth': {
        const { connection = {} } = body;
        const result = await registry.refreshAuth(connector_key, connection);
        return res.status(200).json(result);
      }

      case 'build_assist_pack': {
        const { rendition = {}, destination = {} } = body;
        const result = await registry.buildAssistPack(connector_key, rendition, destination);
        return res.status(200).json(result);
      }

      default:
        throw new IncuBrixError(
          'METHOD_NOT_SUPPORTED',
          `Unknown contract method '${method}' on connector '${connector_key}'`,
          { supported_methods: ['validate', 'publish', 'get_status', 'delete', 'fetch_metrics', 'refresh_auth', 'build_assist_pack'] },
          404
        );
    }
  } catch (err) {
    const formatted = formatErrorResponse(err);
    res.status(formatted.status).json(formatted.body);
  }
});

export default router;
