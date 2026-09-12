import type { ApiError } from '@/types';
import { useAuthStore } from '@/stores/auth.store';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api/v1';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Field-level messages from the server validator, for form binding. */
  get fieldErrors(): Record<string, string[]> {
    const fields = this.details?.['fields'];
    return (fields as Record<string, string[]>) ?? {};
  }
}

/** Read the CSRF cookie the server set; it is deliberately not HTTP-only. */
export function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)otdms_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Multipart uploads must not have Content-Type set manually. */
  formData?: FormData;
}

let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  // Collapse concurrent 401s into a single refresh call.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken() ?? '' },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise still see it.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    // Sends the HTTP-only auth cookies.
    credentials: 'include',
    headers,
    body,
    signal: options.signal,
  });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new ApiRequestError(res.status, 'INTERNAL_ERROR', `Request failed (${res.status})`);
    return (await res.text()) as unknown as T;
  }

  const payload = (await res.json()) as { success: boolean; data?: T } & ApiError;

  if (!res.ok || payload.success === false) {
    // An expired access token is refreshed once, transparently.
    const isExpired = payload.errorCode === 'SESSION_EXPIRED' || res.status === 401;
    const isAuthRoute = path.startsWith('/auth/');
    if (isExpired && !isRetry && !isAuthRoute) {
      if (await attemptRefresh()) return request<T>(path, options, true);
      // The session is truly gone (expired, revoked, or — in this dev
      // environment — the database was reseeded out from under an open tab).
      // Left alone, every subsequent action would fail the same way with no
      // visible feedback, since most call sites don't handle every error.
      // Forcing back to login makes that state recoverable instead of stuck.
      useAuthStore.getState().setUser(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    throw new ApiRequestError(
      res.status,
      payload.errorCode ?? 'INTERNAL_ERROR',
      payload.message ?? 'Something went wrong',
      payload.details,
    );
  }

  return payload.data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: 'POST', formData }),
  /** For CSV downloads, which return text rather than the JSON envelope. */
  raw: async (path: string): Promise<Blob> => {
    const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
    if (!res.ok) throw new ApiRequestError(res.status, 'INTERNAL_ERROR', 'Download failed');
    return res.blob();
  },
};

export { BASE as API_BASE };
