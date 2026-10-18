export const ok = (res, data, meta, status = 200) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
export const fail = (res, status, message, code, details) =>
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
