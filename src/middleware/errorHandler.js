import { HttpError } from '../utils/errors.js';

export function notFound(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}`, code: 'not_found' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return res.end();
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code, request_id: req.id, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON body', code: 'invalid_json', request_id: req.id } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Request body too large', code: 'too_large', request_id: req.id } });
  }
  console.error(JSON.stringify({ level: 'error', requestId: req.id, msg: err?.message, stack: err?.stack }));
  res.status(500).json({ error: { message: 'Internal server error', code: 'internal', request_id: req.id } });
}
