import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Envelope {
  iv: string;
  tag: string;
  payload: string;
}

@Injectable()
export class RawContentCryptoService {
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const provider = this.configService.get<string>('KMS_PROVIDER', 'local');
    if (provider !== 'local') {
      throw new Error('Only local KMS provider is implemented in this MVP scaffold');
    }

    const configuredKey = this.configService.get<string>('LOCAL_ENCRYPTION_KEY_BASE64');
    if (configuredKey) {
      this.key = Buffer.from(configuredKey, 'base64');
    } else {
      if (this.configService.get<string>('NODE_ENV') === 'test') {
        this.key = randomBytes(32);
      } else {
        throw new Error('LOCAL_ENCRYPTION_KEY_BASE64 is required for deterministic raw-body encryption');
      }
    }

    if (this.key.length !== 32) {
      throw new Error('LOCAL_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
    }
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: Envelope = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      payload: encrypted.toString('base64')
    };

    return Buffer.from(JSON.stringify(envelope), 'utf8');
  }

  decrypt(ciphertext: Buffer | null): string | null {
    if (!ciphertext) {
      return null;
    }

    const envelope = JSON.parse(ciphertext.toString('utf8')) as Envelope;
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const payload = Buffer.from(envelope.payload, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  }
}
