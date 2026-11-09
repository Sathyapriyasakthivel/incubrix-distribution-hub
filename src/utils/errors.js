/**
 * Standardized IncuBrix Error codes and classes for connector contracts and publishing API.
 */

export const ERROR_CODES = {
  // Connector & Destination Contract Error Codes
  DEST_SPEC_VIOLATION: 'DEST_SPEC_VIOLATION',
  DEST_RULE_FREQUENCY_CAP: 'DEST_RULE_FREQUENCY_CAP',
  CONNECTION_AUTH_EXPIRED: 'CONNECTION_AUTH_EXPIRED',
  PLATFORM_RATE_LIMIT: 'PLATFORM_RATE_LIMIT',
  PLATFORM_QUOTA_EXHAUSTED: 'PLATFORM_QUOTA_EXHAUSTED',
  PLATFORM_CONTENT_REJECTED: 'PLATFORM_CONTENT_REJECTED',
  PLATFORM_UNAVAILABLE: 'PLATFORM_UNAVAILABLE',
  CONNECTOR_DISABLED: 'CONNECTOR_DISABLED',
  PLATFORM_SCHEMA_MISMATCH: 'PLATFORM_SCHEMA_MISMATCH',
  CONNECTION_SECRET_MISSING: 'CONNECTION_SECRET_MISSING',

  // Rules Engine Error Codes
  DEST_RULE_SELF_PROMO: 'DEST_RULE_SELF_PROMO',
  DEST_RULE_LINK_POLICY: 'DEST_RULE_LINK_POLICY',
  DEST_RULE_AI_DISCLOSURE: 'DEST_RULE_AI_DISCLOSURE',
  DEST_NOT_CERTIFIED: 'DEST_NOT_CERTIFIED',
  DEST_DEMOTED: 'DEST_DEMOTED',

  // API & Service Operational Error Codes
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  MALFORMED_JSON: 'MALFORMED_JSON',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  FILE_UPLOAD_ERROR: 'FILE_UPLOAD_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

export const RETRY_POLICY = {
  [ERROR_CODES.DEST_SPEC_VIOLATION]: false,
  [ERROR_CODES.DEST_RULE_FREQUENCY_CAP]: true,  // retry: Yes (retryable after frequency window)
  [ERROR_CODES.CONNECTION_AUTH_EXPIRED]: false, // retry: After reconnect
  [ERROR_CODES.PLATFORM_RATE_LIMIT]: true,      // retry: Yes with backoff
  [ERROR_CODES.PLATFORM_QUOTA_EXHAUSTED]: false,// retry: Next window
  [ERROR_CODES.PLATFORM_CONTENT_REJECTED]: false,
  [ERROR_CODES.PLATFORM_UNAVAILABLE]: true,     // retry: Yes (bounded)
  [ERROR_CODES.CONNECTOR_DISABLED]: false,
  [ERROR_CODES.PLATFORM_SCHEMA_MISMATCH]: false,
  [ERROR_CODES.CONNECTION_SECRET_MISSING]: false,
  [ERROR_CODES.DEST_RULE_SELF_PROMO]: false,
  [ERROR_CODES.DEST_RULE_LINK_POLICY]: false,
  [ERROR_CODES.DEST_RULE_AI_DISCLOSURE]: false,
  [ERROR_CODES.DEST_NOT_CERTIFIED]: false,
  [ERROR_CODES.DEST_DEMOTED]: false,
  [ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED]: false,
  [ERROR_CODES.VALIDATION_ERROR]: false,
  [ERROR_CODES.DESTINATION_NOT_FOUND]: false,
  [ERROR_CODES.JOB_NOT_FOUND]: false,
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: false,
  [ERROR_CODES.MALFORMED_JSON]: false,
  [ERROR_CODES.METHOD_NOT_ALLOWED]: false,
  [ERROR_CODES.FILE_UPLOAD_ERROR]: false,
  [ERROR_CODES.UNAUTHORIZED]: false,
  [ERROR_CODES.NOT_FOUND]: false,
  [ERROR_CODES.INTERNAL_ERROR]: true
};

export class IncuBrixError extends Error {
  constructor(code, message, details = {}, statusCode = 400, retryable = null) {
    super(message);
    this.name = 'IncuBrixError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable !== null ? retryable : (RETRY_POLICY[code] ?? false);
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        details: this.details
      }
    };
  }
}

export class DestinationSpecViolationError extends IncuBrixError {
  constructor(message = 'Content violates destination specifications', details = {}) {
    super(ERROR_CODES.DEST_SPEC_VIOLATION, message, details, 422, false);
  }
}

export class FrequencyCapError extends IncuBrixError {
  constructor(message = 'Destination posting frequency cap reached', details = {}) {
    super(ERROR_CODES.DEST_RULE_FREQUENCY_CAP, message, details, 429, true);
  }
}

export class AuthExpiredError extends IncuBrixError {
  constructor(message = 'Destination authentication token has expired or is invalid', details = {}) {
    super(ERROR_CODES.CONNECTION_AUTH_EXPIRED, message, details, 401, false);
  }
}

export class PlatformRateLimitError extends IncuBrixError {
  constructor(message = 'Platform rate limit encountered', details = {}) {
    super(ERROR_CODES.PLATFORM_RATE_LIMIT, message, details, 429, true);
  }
}

export class PlatformContentRejectedError extends IncuBrixError {
  constructor(message = 'Platform refused content', details = {}) {
    super(ERROR_CODES.PLATFORM_CONTENT_REJECTED, message, details, 422, false);
  }
}

export class PlatformUnavailableError extends IncuBrixError {
  constructor(message = 'Platform temporarily unavailable or timed out', details = {}) {
    super(ERROR_CODES.PLATFORM_UNAVAILABLE, message, details, 503, true);
  }
}

export class ConnectorDisabledError extends IncuBrixError {
  constructor(message = 'Connector kill-switch is active', details = {}) {
    super(ERROR_CODES.CONNECTOR_DISABLED, message, details, 503, false);
  }
}

export class IdempotencyConflictError extends IncuBrixError {
  constructor(message = 'Idempotency key reused with mismatched request parameters', details = {}) {
    super(ERROR_CODES.IDEMPOTENCY_CONFLICT, message, details, 409, false);
  }
}

export class ConnectionSecretMissingError extends IncuBrixError {
  constructor(message = 'Destination credentials/secret missing from environment', details = {}) {
    super(ERROR_CODES.CONNECTION_SECRET_MISSING, message, details, 401, false);
  }
}

export class DestinationNotCertifiedError extends IncuBrixError {
  constructor(message = 'Destination is not certified for publishing', details = {}) {
    super(ERROR_CODES.DEST_NOT_CERTIFIED, message, details, 403, false);
  }
}

export class DestinationDemotedError extends IncuBrixError {
  constructor(message = 'Destination has been demoted and cannot accept publications', details = {}) {
    super(ERROR_CODES.DEST_DEMOTED, message, details, 403, false);
  }
}

export class DestinationSelfPromoError extends IncuBrixError {
  constructor(message = 'Destination strictly prohibits self-promotional content', details = {}) {
    super(ERROR_CODES.DEST_RULE_SELF_PROMO, message, details, 422, false);
  }
}

export class DestinationLinkPolicyError extends IncuBrixError {
  constructor(message = 'Content violates destination link policy', details = {}) {
    super(ERROR_CODES.DEST_RULE_LINK_POLICY, message, details, 422, false);
  }
}

export class DestinationAiDisclosureError extends IncuBrixError {
  constructor(message = 'Destination requires explicit AI disclosure statement for AI-generated content', details = {}) {
    super(ERROR_CODES.DEST_RULE_AI_DISCLOSURE, message, details, 422, false);
  }
}

export function formatErrorResponse(err) {
  if (err instanceof IncuBrixError) {
    return {
      status: err.statusCode,
      body: err.toJSON()
    };
  }

  // Handle JSON parse errors from express.json()
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && 'body' in err) {
    return {
      status: 400,
      body: {
        error: {
          code: ERROR_CODES.MALFORMED_JSON,
          message: 'Malformed or invalid JSON payload: ' + err.message,
          retryable: false,
          details: { error: err.message }
        }
      }
    };
  }

  // Handle Multer upload errors
  if (err.name === 'MulterError') {
    return {
      status: 400,
      body: {
        error: {
          code: ERROR_CODES.FILE_UPLOAD_ERROR,
          message: err.message || 'File upload error',
          retryable: false,
          details: { code: err.code, field: err.field }
        }
      }
    };
  }

  // Handle explicit 404 or NOT_FOUND
  if (err.status === 404 || err.statusCode === 404 || err.code === 'NOT_FOUND') {
    return {
      status: 404,
      body: {
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: err.message || 'Resource not found',
          retryable: false,
          details: err.details || {}
        }
      }
    };
  }

  // Handle 405 Method Not Allowed
  if (err.status === 405 || err.statusCode === 405 || err.code === 'METHOD_NOT_ALLOWED') {
    return {
      status: 405,
      body: {
        error: {
          code: ERROR_CODES.METHOD_NOT_ALLOWED,
          message: err.message || 'Method not allowed for this route',
          retryable: false,
          details: err.details || {}
        }
      }
    };
  }

  // Generic unhandled error
  return {
    status: err.status || err.statusCode || 500,
    body: {
      error: {
        code: err.code || ERROR_CODES.INTERNAL_ERROR,
        message: err.message || 'An internal server error occurred',
        retryable: typeof err.retryable === 'boolean' ? err.retryable : true,
        details: err.details || {}
      }
    }
  };
}
