import { generateKeyPairSync, sign } from 'crypto';

import { TelnyxClient } from './telnyx.client';

describe('TelnyxClient signature validation', () => {
  it('validates ed25519 webhook signatures', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const configService = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'TELNYX_API_BASE_URL') {
          return fallback ?? 'https://api.telnyx.com/v2';
        }
        if (key === 'TELNYX_WEBHOOK_PUBLIC_KEY') {
          return publicPem;
        }
        if (key === 'TELNYX_API_KEY') {
          return 'key';
        }
        return fallback;
      })
    };

    const client = new TelnyxClient(configService as never);

    const timestamp = '1711111111';
    const body = JSON.stringify({ hello: 'world' });
    const message = `${timestamp}|${body}`;
    const signature = sign(null, Buffer.from(message), privateKey).toString('base64');

    expect(client.verifyWebhookSignature(body, timestamp, signature)).toBe(true);
    expect(client.verifyWebhookSignature(body, timestamp, 'invalid-signature')).toBe(false);
    expect(client.verifyWebhookSignature(body, undefined, signature)).toBe(false);
  });
});
