import { formatErrorResponse } from '../utils/errors.js';
import logger from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  const formatted = formatErrorResponse(err);

  logger.error(`API Error: ${err.message}`, {
    correlation_id: req.correlationId || null,
    status_code: formatted.status,
    code: formatted.body?.error?.code,
    path: req.originalUrl,
    method: req.method
  });

  res.status(formatted.status).json(formatted.body);
}

export default errorHandler;
