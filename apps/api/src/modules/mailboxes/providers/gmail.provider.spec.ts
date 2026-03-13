import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GmailProviderClient } from './gmail.provider';

describe('GmailProviderClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(config: Record<string, string | undefined>): GmailProviderClient {
    const configService = {
      get: jest.fn((key: string) => config[key])
    };
    return new GmailProviderClient(configService as unknown as ConfigService);
  }

  it('builds oauth URL with expected defaults and optional login hint', () => {
    const service = createService({
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_REDIRECT_URI: 'https://app.example.com/oauth/google/callback'
    });

    const url = service.createOauthUrl('state-123', { loginHint: 'lead@example.com' });
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('google-client');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/oauth/google/callback');
    expect(parsed.searchParams.get('state')).toBe('state-123');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true');
    expect(parsed.searchParams.get('login_hint')).toBe('lead@example.com');
  });

  it('throws when required oauth configuration is missing', () => {
    const service = createService({
      GOOGLE_REDIRECT_URI: 'https://app.example.com/oauth/google/callback'
    });

    expect(() => service.createOauthUrl('state-1')).toThrow(BadRequestException);
    expect(() => service.createOauthUrl('state-1')).toThrow('GOOGLE_CLIENT_ID is not configured');
  });

  it('exchanges oauth code and returns normalized mailbox auth data', async () => {
    const service = createService({
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_REDIRECT_URI: 'https://app.example.com/oauth/google/callback'
    });

    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: 'scope-a'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'Owner@Example.com' }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.exchangeCodeForMailboxData('oauth-code')).resolves.toEqual({
      email: 'owner@example.com',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(1_700_003_600_000),
      scope: 'scope-a'
    });
  });

  it('throws when oauth token response does not include an access token', async () => {
    const service = createService({
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_REDIRECT_URI: 'https://app.example.com/oauth/google/callback'
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: 'only-refresh' }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = service.exchangeCodeForMailboxData('oauth-code');
    await expect(promise).rejects.toBeInstanceOf(BadGatewayException);
    await expect(promise).rejects.toThrow('Google OAuth token response missing access token');
  });
});
