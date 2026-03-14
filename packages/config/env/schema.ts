import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),
  JWT_JWKS_URI: z.string().url(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  KMS_PROVIDER: z.enum(['local', 'gcp']).default('local'),
  LOCAL_ENCRYPTION_KEY_BASE64: z.string().optional(),
  GCP_PROJECT_ID: z.string().optional(),
  GCP_KMS_KEY_NAME: z.string().optional(),
  API_BASE_URL: z.string().url().default('http://localhost:3001')
});

export type AppEnv = z.infer<typeof envSchema>;
