import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function inferDevHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    return hostUri.split(':')[0] ?? null;
  }

  if (Constants.linkingUri) {
    try {
      const linkingUrl = new URL(Constants.linkingUri);
      if (linkingUrl.hostname) {
        return linkingUrl.hostname;
      }
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function withDefaultV1Path(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/v1';
  }
  return pathname.endsWith('/v1') ? pathname : `${pathname.replace(/\/+$/, '')}/v1`;
}

function resolveApiBaseUrl(): string {
  const raw = (extra.API_BASE_URL ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? '').trim();
  const fallbackHost = inferDevHost() ?? 'localhost';

  if (!raw) {
    return `http://${fallbackHost}:3001/v1`;
  }

  try {
    const parsed = new URL(raw);
    const inferredHost = inferDevHost();

    // "localhost:8081" usually points to Metro, not API.
    if (parsed.port === '8081') {
      parsed.port = '3001';
      parsed.pathname = '/v1';
    }

    // On physical devices, localhost points to phone itself; prefer dev host.
    if (inferredHost && !isLoopbackHost(inferredHost) && isLoopbackHost(parsed.hostname)) {
      parsed.hostname = inferredHost;
    }

    parsed.pathname = withDefaultV1Path(parsed.pathname);
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return `http://${fallbackHost}:3001/v1`;
  }
}

const apiBaseUrl = resolveApiBaseUrl();

let _getToken: (() => Promise<string | null>) | null = null;

export function setTokenProvider(fn: () => Promise<string | null>): void {
  _getToken = fn;
}

function devHeaderValue(key: string): string | undefined {
  const extraValue = extra[key];
  if (typeof extraValue === 'string' && extraValue.trim().length > 0) {
    return extraValue.trim();
  }

  const envValue = process.env[`EXPO_PUBLIC_${key}`];
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }

  return undefined;
}

function devAuthHeaders(): Record<string, string> {
  const userId = devHeaderValue('DEV_USER_ID');
  const teamId = devHeaderValue('DEV_TEAM_ID');
  const role = devHeaderValue('DEV_ROLE');
  if (!userId || !teamId || !role) {
    return {};
  }

  return {
    'x-user-id': userId,
    'x-team-id': teamId,
    'x-role': role
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const fallbackHeaders = devAuthHeaders();
  if (Object.keys(fallbackHeaders).length > 0) {
    return fallbackHeaders;
  }

  if (_getToken) {
    const token = await _getToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
  }
  return {};
}

async function buildHttpError(response: Response): Promise<Error> {
  let details: string | undefined;

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const parsed = (await response.json()) as { message?: unknown; error?: unknown; statusCode?: unknown };
      if (typeof parsed.message === 'string') {
        details = parsed.message;
      } else if (Array.isArray(parsed.message)) {
        details = parsed.message.filter((item) => typeof item === 'string').join(', ');
      } else if (typeof parsed.error === 'string') {
        details = parsed.error;
      } else {
        try {
          details = JSON.stringify(parsed);
        } catch (_jsonError) {
          details = undefined;
        }
      }
    } else {
      const textBody = await response.text();
      if (textBody.trim().length > 0) {
        details = textBody.trim();
      }
    }
  } catch (_error) {
    details = undefined;
  }

  const statusText = response.statusText || 'Request failed';
  if (details) {
    return new Error(`${response.status} ${statusText}: ${details}`);
  }
  return new Error(`${response.status} ${statusText}`);
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const response = await fetch(`${apiBaseUrl}${path}`, { headers });
  if (!response.ok) {
    throw await buildHttpError(response);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw await buildHttpError(response);
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw await buildHttpError(response);
  }

  return response.json() as Promise<T>;
}
