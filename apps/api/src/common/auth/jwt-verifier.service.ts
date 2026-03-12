import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeJwt, jwtVerify, JWTVerifyResult } from 'jose';

@Injectable()
export class JwtVerifierService {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly configService: ConfigService) {}

  async verifyAuthorizationHeader(authorization?: string): Promise<JWTVerifyResult> {
    if (!authorization) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Unsupported authorization scheme');
    }

    return this.verifyBearerToken(authorization.slice(7));
  }

  async getSubjectFromAuthorizationHeader(authorization?: string): Promise<string> {
    const verified = await this.verifyAuthorizationHeader(authorization);
    const subject = verified.payload.sub;
    if (!subject) {
      throw new UnauthorizedException('Token missing subject claim');
    }
    return subject;
  }

  async verifyBearerToken(token: string): Promise<JWTVerifyResult> {
    const jwks = this.getJwks();
    const issuerCandidates = this.getIssuerCandidates();
    const audienceCandidates = this.getAudienceCandidates();
    if (issuerCandidates.length === 0 || audienceCandidates.length === 0) {
      throw new UnauthorizedException('JWT issuer/audience is not configured');
    }

    try {
      return await jwtVerify(token, jwks, {
        issuer: issuerCandidates,
        audience: audienceCandidates
      });
    } catch (_error) {
      if (this.configService.get<string>('NODE_ENV') === 'development') {
        let tokenIssuer = 'unknown';
        let tokenAudience = 'unknown';
        try {
          const decoded = decodeJwt(token);
          tokenIssuer = String(decoded.iss ?? 'unknown');
          tokenAudience = Array.isArray(decoded.aud) ? decoded.aud.join('|') : String(decoded.aud ?? 'unknown');
        } catch (_decodeError) {
          // ignore decode failures and keep unknown placeholders
        }

        throw new UnauthorizedException(
          `Invalid bearer token (expected issuer=${issuerCandidates.join('|')}, audience=${audienceCandidates.join('|')}; token issuer=${tokenIssuer}, token audience=${tokenAudience})`
        );
      }
      throw new UnauthorizedException('Invalid bearer token');
    }
  }

  private getIssuerCandidates(): string[] {
    const rawIssuer = this.configService.get<string>('JWT_ISSUER')?.trim();
    if (!rawIssuer) {
      return [];
    }

    const normalized = rawIssuer.replace(/\/+$/, '');
    const withSlash = `${normalized}/`;
    return Array.from(new Set([rawIssuer, normalized, withSlash].filter((value) => value.length > 0)));
  }

  private getAudienceCandidates(): string[] {
    const rawAudience = this.configService.get<string>('JWT_AUDIENCE')?.trim();
    if (!rawAudience) {
      return [];
    }

    return rawAudience
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (this.jwks) {
      return this.jwks;
    }

    const jwksUri = this.configService.get<string>('JWT_JWKS_URI');
    if (!jwksUri) {
      throw new UnauthorizedException('JWKS not configured');
    }

    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    return this.jwks;
  }
}
