import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (process.env.NODE_ENV === 'development') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const path = String(req.originalUrl ?? req.url ?? '');
      const isTrackedPath = path.includes('/v1/users/me') || path.includes('/v1/onboarding/register');
      if (!isTrackedPath) {
        next();
        return;
      }

      const hasBearerToken = typeof req.headers.authorization === 'string'
        && req.headers.authorization.startsWith('Bearer ');
      const hasDevHeaders = Boolean(req.headers['x-user-id'] && req.headers['x-team-id'] && req.headers['x-role']);
      let bearerSub = 'n/a';
      if (hasBearerToken) {
        try {
          const token = String(req.headers.authorization).slice(7);
          const payloadPart = token.split('.')[1];
          if (payloadPart) {
            const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { sub?: unknown };
            if (typeof payload.sub === 'string' && payload.sub.trim().length > 0) {
              bearerSub = payload.sub;
            }
          }
        } catch {
          bearerSub = 'decode-error';
        }
      }
      const onboardingRole = path.includes('/v1/onboarding/register')
        ? String((req.body as { role?: unknown } | undefined)?.role ?? 'unknown')
        : 'n/a';
      const start = Date.now();

      res.on('finish', () => {
        const durationMs = Date.now() - start;
        // Debug trace for onboarding/auth flow failures in local development.
        // eslint-disable-next-line no-console
        console.log(
          `[api-trace] ${req.method} ${path} -> ${res.statusCode} `
          + `(${durationMs}ms) auth=${hasBearerToken ? 'bearer' : hasDevHeaders ? 'dev-headers' : 'none'} `
          + `sub=${bearerSub} role=${onboardingRole}`
        );
      });

      next();
    });
  }

  const config = new DocumentBuilder()
    .setTitle('Suivo API')
    .setDescription('Suivo follow-up execution platform API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('/docs', app, document);

  const port = process.env.PORT ?? '3001';
  await app.listen(Number(port));
}

bootstrap();
