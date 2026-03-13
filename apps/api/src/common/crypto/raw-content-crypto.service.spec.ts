import { ConfigService } from '@nestjs/config';

import { RawContentCryptoService } from './raw-content-crypto.service';

describe('RawContentCryptoService', () => {
  function createService(config: Record<string, string | undefined>): RawContentCryptoService {
    const configService = {
      get: jest.fn((key: string, defaultValue?: string) => config[key] ?? defaultValue)
    };
    return new RawContentCryptoService(configService as unknown as ConfigService);
  }

  it('encrypts and decrypts payloads with configured key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const service = createService({
      LOCAL_ENCRYPTION_KEY_BASE64: key,
      KMS_PROVIDER: 'local'
    });

    const encrypted = service.encrypt('hello-world');
    const decoded = JSON.parse(encrypted.toString('utf8')) as Record<string, unknown>;

    expect(Buffer.isBuffer(encrypted)).toBe(true);
    expect(decoded).toEqual(
      expect.objectContaining({
        iv: expect.any(String),
        tag: expect.any(String),
        payload: expect.any(String)
      })
    );
    expect(service.decrypt(encrypted)).toBe('hello-world');
  });

  it('returns null when decrypt input is null', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const service = createService({
      LOCAL_ENCRYPTION_KEY_BASE64: key
    });

    expect(service.decrypt(null)).toBeNull();
  });

  it('throws if non-local kms provider is configured', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    expect(() =>
      createService({
        KMS_PROVIDER: 'aws-kms',
        LOCAL_ENCRYPTION_KEY_BASE64: key
      })
    ).toThrow('Only local KMS provider is implemented in this MVP scaffold');
  });

  it('throws when encryption key is missing outside test mode', () => {
    expect(() =>
      createService({
        NODE_ENV: 'development'
      })
    ).toThrow('LOCAL_ENCRYPTION_KEY_BASE64 is required for deterministic raw-body encryption');
  });
});
