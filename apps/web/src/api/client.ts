/** A validation issue from the API: `path` is the Zod path, e.g. `['industry']` or `['contacts', 0, 'email']`. */
export type Issue = { path: (string | number)[]; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: Issue[],
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export type ApiInit = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /** Set when the caller handles 401 itself (e.g. the auth guard) instead of a full-page redirect. */
  noAuthRedirect?: boolean;
};

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { body, noAuthRedirect, headers, ...rest } = init;
  const hasBody = body !== undefined;
  const res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: { Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; issues?: Issue[] };
    if (res.status === 401 && !noAuthRedirect && window.location.pathname !== '/sign-in') {
      window.location.assign('/sign-in');
    }
    throw new ApiError(res.status, payload.error ?? `http_${res.status}`, payload.issues);
  }
  return data as T;
}
