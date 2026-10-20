export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) { super(message); }
}
type Meta = { page: number; pageSize: number; total: number; totalPages: number };

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ data: T; meta?: Meta }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'piweb-crm', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and retry.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized?.();
    throw new ApiError(res.status, json?.error?.message || `Request failed (${res.status})`, json?.error?.code, json?.error?.details);
  }
  return { data: json.data as T, meta: json.meta };
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown, headers?: Record<string, string>) => api<T>('POST', p, b ?? {}, headers);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);

/** Multipart upload (payment proofs). The browser sets the multipart boundary, so no JSON content-type here. */
export async function upload<T = any>(path: string, form: FormData): Promise<{ data: T }> {
  let res: Response;
  try { res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'piweb-crm' }, body: form }); }
  catch { throw new ApiError(0, 'Network error — check your connection and retry.'); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, json?.error?.message || (res.status === 413 ? 'That file is too large (maximum 8 MB).' : `Upload failed (${res.status})`), json?.error?.code);
  }
  return { data: json.data as T };
}
