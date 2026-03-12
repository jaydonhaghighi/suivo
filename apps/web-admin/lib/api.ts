const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001/v1';

function resolveAuthHeaders(): Record<string, string> {
  const bearerToken = process.env.API_BEARER_TOKEN?.trim();
  if (bearerToken) {
    return { authorization: `Bearer ${bearerToken}` };
  }

  const userId = process.env.WEB_USER_ID?.trim();
  const teamId = process.env.WEB_TEAM_ID?.trim();
  const role = process.env.WEB_ROLE?.trim();
  if (!userId || !teamId || !role) {
    throw new Error(
      'Web admin auth is not configured. Set API_BEARER_TOKEN or WEB_USER_ID/WEB_TEAM_ID/WEB_ROLE.'
    );
  }
  if (role !== 'AGENT' && role !== 'TEAM_LEAD') {
    throw new Error('WEB_ROLE must be AGENT or TEAM_LEAD');
  }

  return {
    'x-user-id': userId,
    'x-team-id': teamId,
    'x-role': role
  };
}

function defaultHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...resolveAuthHeaders()
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: defaultHeaders()
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: defaultHeaders(),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'PUT',
    headers: defaultHeaders(),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
