import config from '../config/index.js';

// Sensitive keys to redact
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /api[_-]?key/i,
  /bearer/i,
  /cookie/i
];

export function redactSensitiveData(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Redact Bearer / API keys in string
    return obj.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{6,}/gi, '$1[REDACTED]')
              .replace(/(key[=:\s]+)[A-Za-z0-9_\-\.]{6,}/gi, '$1[REDACTED]');
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitiveData(item, depth + 1));
  }
  if (typeof obj === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSensitive = SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
      if (isSensitive) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return redacted;
  }
  return obj;
}

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const currentLevelPriority = LOG_LEVELS[config.logLevel] || 20;

class StructuredLogger {
  constructor(context = {}) {
    this.context = context;
  }

  child(extraContext = {}) {
    return new StructuredLogger({ ...this.context, ...extraContext });
  }

  log(level, message, meta = {}) {
    if ((LOG_LEVELS[level] || 20) < currentLevelPriority) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      correlation_id: meta.correlation_id || this.context.correlation_id || null,
      job_id: meta.job_id || this.context.job_id || null,
      ...redactSensitiveData({ ...this.context, ...meta })
    };

    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }

  info(message, meta) {
    this.log('info', message, meta);
  }

  warn(message, meta) {
    this.log('warn', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }
}

export const logger = new StructuredLogger();
export default logger;
