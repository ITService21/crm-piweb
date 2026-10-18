export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || `E${status}`;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, 'BAD_REQUEST', d);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m, 'UNAUTHENTICATED');
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m, d) => new HttpError(409, m, 'CONFLICT', d);

/** Wrap async route handlers so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
