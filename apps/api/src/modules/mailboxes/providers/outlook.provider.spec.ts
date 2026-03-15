import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OutlookProviderClient } from './outlook.provider';

describe('OutlookProviderClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(config: Record<string, string | undefined>): OutlookProviderClient {
    const configService = {
      get: jest.fn((key: string) => config[key])
    };
    return new OutlookProviderClient(configService as unknown as ConfigService);
  }

  it('builds oauth URL using default common tenant and optional login hint', () => {
    const service = createService({
      MICROSOFT_CLIENT_ID: 'ms-client',
      MICROSOFT_REDIRECT_URI: 'https://app.example.com/oauth/microsoft/callback'
    });

    const url = service.createOauthUrl('state-123', { loginHint: 'agent@example.com' });
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://login.microsoftonline.com');
    expect(parsed.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('ms-client');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/oauth/microsoft/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('response_mode')).toBe('query');
    expect(parsed.searchParams.get('state')).toBe('state-123');
    expect(parsed.searchParams.get('login_hint')).toBe('agent@example.com');
  });

  it('throws when required oauth configuration is missing', () => {
    const service = createService({
      MICROSOFT_REDIRECT_URI: 'https://app.example.com/oauth/microsoft/callback'
    });

    expect(() => service.createOauthUrl('state-1')).toThrow(BadRequestException);
    expect(() => service.createOauthUrl('state-1')).toThrow('MICROSOFT_CLIENT_ID is not configured');
  });

  it('exchanges oauth code and returns normalized mailbox auth data', async () => {
    const service = createService({
      MICROSOFT_CLIENT_ID: 'ms-client',
      MICROSOFT_CLIENT_SECRET: 'ms-secret',
      MICROSOFT_REDIRECT_URI: 'https://app.example.com/oauth/microsoft/callback',
      MICROSOFT_TENANT_ID: 'tenant-123'
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'ms-access-token' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mail: null, userPrincipalName: 'Owner@Example.com' }), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.exchangeCodeForMailboxData('oauth-code')).resolves.toMatchObject({
      email: 'owner@example.com',
      accessToken: 'ms-access-token'
    });
  });

  it('throws when oauth token response does not include an access token', async () => {
    const service = createService({
      MICROSOFT_CLIENT_ID: 'ms-client',
      MICROSOFT_CLIENT_SECRET: 'ms-secret',
      MICROSOFT_REDIRECT_URI: 'https://app.example.com/oauth/microsoft/callback'
    });

    const fetchMock = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = service.exchangeCodeForMailboxData('oauth-code');
    await expect(promise).rejects.toBeInstanceOf(BadGatewayException);
    await expect(promise).rejects.toThrow('Microsoft OAuth token response missing access token');
  });
});
