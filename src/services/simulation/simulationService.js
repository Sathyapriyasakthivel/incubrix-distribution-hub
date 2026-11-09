import config from '../../config/index.js';
import logger from '../../utils/logger.js';

export class SimulationService {
  constructor() {
    this.defaultSimulation = config.simulation.default ?? true;
    this.mockEndpoints = {
      discourse: () => process.env.MOCK_DISCOURSE_URL || `http://${config.host}:${config.port}/mock/discourse`,
      lemmy: () => process.env.MOCK_LEMMY_URL || `http://${config.host}:${config.port}/mock/lemmy`,
      devto: () => process.env.MOCK_DEVTO_URL || `http://${config.host}:${config.port}/mock/devto`,
      ghost: () => process.env.MOCK_GHOST_URL || `http://${config.host}:${config.port}/mock/ghost`,
      webhook: () => process.env.MOCK_WEBHOOK_RECEIVER_URL || `http://${config.host}:${config.port}/mock/webhook`,
      slack: () => `http://${config.host}:${config.port}/mock/slack`,
      hashnode: () => `http://${config.host}:${config.port}/mock/hashnode`
    };

    // Simulation active faults
    this.activeFaults = new Map();
  }

  /**
   * Determine whether a publication or destination should execute in simulation mode
   * @param {Object} destination
   * @param {Object} requestOverride
   * @returns {boolean}
   */
  isSimulation(destination = {}, requestOverride = undefined) {
    if (requestOverride !== undefined) {
      return Boolean(requestOverride);
    }
    if (destination.simulation_mode !== undefined && destination.simulation_mode !== null) {
      return Boolean(destination.simulation_mode);
    }
    return Boolean(this.defaultSimulation);
  }

  /**
   * Resolve platform endpoint url, redirecting to local mock server when simulation is active
   * @param {string} platformKey
   * @param {Object} destination
   * @param {boolean} simulation
   * @returns {string}
   */
  resolveEndpoint(platformKey, destination = {}, simulation = true) {
    if (!simulation) {
      return destination.url?.replace(/\/+$/, '') || '';
    }

    const resolver = this.mockEndpoints[platformKey];
    if (resolver) {
      return resolver().replace(/\/+$/, '');
    }

    return destination.url?.replace(/\/+$/, '') || `http://${config.host}:${config.port}/mock/${platformKey}`;
  }

  /**
   * Inject simulation fault
   * @param {Object} params - { fault, reset_s, platform, destination_id }
   */
  injectFault({ fault, reset_s, platform = 'all', destination_id = null }) {
    // Normalize fault names
    const faultMap = {
      '429': 'rate_limit',
      'rate_limit': 'rate_limit',
      '401': 'auth_expired',
      'auth_expired': 'auth_expired',
      '422': 'content_rejected',
      'content_rejected': 'content_rejected',
      '500': 'server_error',
      'server_error': 'server_error',
      'timeout_before_commit': 'timeout_before_commit',
      'timeout_after_commit': 'timeout_after_commit',
      'rename_field': 'field_rename',
      'field_rename': 'field_rename',
      'revoke': 'revoke'
    };

    const normalizedFault = faultMap[String(fault).toLowerCase()] || String(fault);
    const faultRecord = {
      fault: normalizedFault,
      original_fault: fault,
      reset_s: Number(reset_s) || 15,
      platform: platform || 'all',
      destination_id: destination_id || null,
      injected_at: new Date().toISOString()
    };

    this.activeFaults.set(platform || 'all', faultRecord);
    if (destination_id) {
      this.activeFaults.set(`dest:${destination_id}`, faultRecord);
    }

    logger.info(`Simulation fault injected: ${normalizedFault} for platform ${platform}`, faultRecord);
    return faultRecord;
  }

  /**
   * Get currently active fault for a platform or destination
   */
  getInjectedFault(platform = 'all', destinationId = null) {
    if (destinationId && this.activeFaults.has(`dest:${destinationId}`)) {
      return this.activeFaults.get(`dest:${destinationId}`);
    }
    if (this.activeFaults.has(platform)) {
      return this.activeFaults.get(platform);
    }
    if (this.activeFaults.has('all')) {
      return this.activeFaults.get('all');
    }
    return null;
  }

  /**
   * Reset all reviewer-controllable faults
   */
  resetFaults() {
    this.activeFaults.clear();
    logger.info('All simulation faults have been reset.');
  }

  /**
   * List all currently active faults
   */
  getActiveFaults() {
    return Array.from(this.activeFaults.values());
  }

  /**
   * Available fault injection types for test harnesses and chaos testing
   */
  getAvailableFaults() {
    return [
      { fault: '429', alias: 'rate_limit', description: 'Returns HTTP 429 with Retry-After header (supports reset_s parameter)' },
      { fault: '401', alias: 'auth_expired', description: 'Returns HTTP 401 with Token Expired error' },
      { fault: '422', alias: 'content_rejected', description: 'Returns HTTP 422 with moderation block' },
      { fault: '500', alias: 'server_error', description: 'Returns HTTP 500 internal server error' },
      { fault: 'timeout_before_commit', description: 'Simulates network drop/timeout before committing post' },
      { fault: 'timeout_after_commit', description: 'Commits post to platform but drops socket before response' },
      { fault: 'rename_field', alias: 'field_rename', description: 'Renames standard response id field breaking contract' },
      { fault: 'revoke', description: 'Simulates revoked partner permissions returning HTTP 403 / 401' }
    ];
  }
}

export const simulationService = new SimulationService();
export default simulationService;
