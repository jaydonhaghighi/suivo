import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredToken = this.configService.get<string>('INTERNAL_API_TOKEN');
    if (!configuredToken) {
      throw new UnauthorizedException('Internal token auth is not configured');
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const providedToken = request.headers['x-internal-token'];
    if (typeof providedToken !== 'string' || providedToken.length === 0) {
      throw new UnauthorizedException('Missing internal token');
    }

    const expectedBuffer = Buffer.from(configuredToken);
    const providedBuffer = Buffer.from(providedToken);
    if (expectedBuffer.length !== providedBuffer.length) {
      throw new UnauthorizedException('Invalid internal token');
    }

    if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new UnauthorizedException('Invalid internal token');
    }

    return true;
  }
}
