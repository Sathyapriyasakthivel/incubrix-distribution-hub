import DiscourseConnector from './discourse/DiscourseConnector.js';
import LemmyConnector from './lemmy/LemmyConnector.js';
import DevtoConnector from './devto/DevtoConnector.js';
import GhostConnector from './ghost/GhostConnector.js';
import WebhookConnector from './webhook/WebhookConnector.js';
import AssistedConnector from './assisted/AssistedConnector.js';
import HashnodeConnector from './hashnode/HashnodeConnector.js';
import SlackConnector from './slack/SlackConnector.js';
import MrssConnector from './mrss/MrssConnector.js';
import { ConnectorDisabledError, IncuBrixError } from '../utils/errors.js';
import logger from '../utils/logger.js';

class ConnectorRegistry {
  constructor() {
    this.connectors = new Map();
    this.disabledConnectors = new Set();
    this.registerDefaults();
  }

  registerDefaults() {
    this.register(new DiscourseConnector());
    this.register(new LemmyConnector());
    this.register(new DevtoConnector());
    this.register(new GhostConnector());
    this.register(new WebhookConnector());
    this.register(new AssistedConnector());
    this.register(new HashnodeConnector());
    this.register(new SlackConnector());
    this.register(new MrssConnector());
  }

  register(connector) {
    this.connectors.set(connector.key, connector);
    logger.info(`Registered connector: ${connector.key} (v${connector.version})`);
  }

  getConnector(key) {
    const connector = this.connectors.get(key);
    if (!connector) {
      throw new IncuBrixError('CONNECTOR_NOT_FOUND', `Connector '${key}' is not registered`, { key }, 404);
    }
    if (this.disabledConnectors.has(key)) {
      throw new ConnectorDisabledError(`Connector '${key}' has been disabled by kill-switch`, { key });
    }
    return connector;
  }

  hasConnector(key) {
    return this.connectors.has(key);
  }

  disable(key) {
    this.disabledConnectors.add(key);
    logger.warn(`Connector kill switch activated: ${key}`);
  }

  enable(key) {
    this.disabledConnectors.delete(key);
    logger.info(`Connector kill switch deactivated: ${key}`);
  }

  isKillSwitchActive(key) {
    return this.disabledConnectors.has(key);
  }

  listConnectors() {
    return Array.from(this.connectors.values()).map(c => ({
      key: c.key,
      version: c.version,
      tier: c.tier,
      name: c.manifest.name || c.key,
      capabilities: Array.from(c.capabilities),
      surfaces: c.manifest.surfaces || [],
      rate_limits: c.manifest.rate_limits || {},
      auth: c.manifest.auth,
      status: this.disabledConnectors.has(c.key) ? 'disabled' : 'active'
    }));
  }

  async validate(key, rendition, destination, connection) {
    const connector = this.getConnector(key);
    return connector.validate(rendition, destination, connection);
  }

  async publish(key, rendition, destination, connection, idempotencyKey) {
    const connector = this.getConnector(key);
    return connector.publish(rendition, destination, connection, idempotencyKey);
  }

  async getStatus(key, platformPostId, connection) {
    const connector = this.getConnector(key);
    return connector.getStatus(platformPostId, connection);
  }

  async delete(key, platformPostId, connection) {
    const connector = this.getConnector(key);
    return connector.delete(platformPostId, connection);
  }

  async fetchMetrics(key, platformPostId, connection, since) {
    const connector = this.getConnector(key);
    return connector.fetchMetrics(platformPostId, connection, since);
  }

  async refreshAuth(key, connection) {
    const connector = this.getConnector(key);
    return connector.refreshAuth(connection);
  }

  async buildAssistPack(key, rendition, destination) {
    const connector = this.getConnector(key);
    return connector.buildAssistPack(rendition, destination);
  }
}

export const registry = new ConnectorRegistry();
export default registry;
