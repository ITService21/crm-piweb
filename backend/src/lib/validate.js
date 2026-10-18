import { badRequest } from './errors.js';

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}
