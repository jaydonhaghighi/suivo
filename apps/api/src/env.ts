import { z } from 'zod';

const emptyToUndefined = z.string().transform((v) => (v === '' ? undefined : v));
const booleanFromString = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

export const appEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_ISSUER: emptyToUndefined.pipe(z.string().url().optional()).optional(),
    JWT_AUDIENCE: emptyToUndefined.pipe(z.string().min(1).optional()).optional(),
    JWT_JWKS_URI: emptyToUndefined.pipe(z.string().url().optional()).optional(),
    WEBHOOK_SHARED_SECRET: emptyToUndefined.optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),
    OPENAI_REALTIME_SIP_URI: emptyToUndefined.optional(),
    TELNYX_API_KEY: emptyToUndefined.optional(),
    TELNYX_API_BASE_URL: z.string().url().default('https://api.telnyx.com/v2'),
    TELNYX_WEBHOOK_PUBLIC_KEY: emptyToUndefined.optional(),
    TELNYX_CONNECTION_ID: emptyToUndefined.optional(),
    TELNYX_DEFAULT_ASSISTANT_MODEL: z.string().default('gpt-4o-mini'),
    TELNYX_DEFAULT_ASSISTANT_VOICE: z.string().default('AWS.Polly.Joanna-Neural'),
    VOICE_ASSISTANT_PROVIDER_DEFAULT: z.enum(['telnyx_ai', 'openai_sip']).default('openai_sip'),
    KMS_PROVIDER: z.enum(['local', 'gcp']).default('local'),
    LOCAL_ENCRYPTION_KEY_BASE64: emptyToUndefined.optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_REDIRECT_URI: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().optional(),
    OAUTH_STATE_SECRET: emptyToUndefined.optional(),
    INTERNAL_API_TOKEN: emptyToUndefined.optional(),
    APP_REDIRECT_ALLOWLIST: emptyToUndefined.optional(),
    MAIL_SYNC_NEWER_THAN_HOURS: emptyToUndefined.optional(),
    MAIL_SYNC_MAX_RESULTS_PER_BOX: emptyToUndefined.optional(),
    MAIL_SYNC_MAILBOX_LIMIT: emptyToUndefined.optional(),
    EMAIL_INTAKE_ENABLED: booleanFromString.default(true),
    EMAIL_INTAKE_SHADOW_MODE: booleanFromString.default(true),
    EMAIL_INTAKE_CUTOVER_ENABLED: booleanFromString.default(false),
    EMAIL_INTAKE_CREATE_THRESHOLD: emptyToUndefined.optional(),
    EMAIL_INTAKE_REVIEW_THRESHOLD: emptyToUndefined.optional(),
    EMAIL_INTAKE_REVIEW_SLA_MINUTES: emptyToUndefined.optional(),
    EMAIL_INTAKE_BLOCKED_LOCALPARTS: emptyToUndefined.optional(),
    EMAIL_INTAKE_BLOCKED_DOMAINS: emptyToUndefined.optional(),
    EMAIL_INTAKE_DISPOSABLE_DOMAINS: emptyToUndefined.optional(),
    ALLOW_DEV_HEADER_AUTH: booleanFromString.default(false)
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production') {
      if (!config.JWT_ISSUER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_ISSUER'],
          message: 'JWT_ISSUER is required in production'
        });
      }
      if (!config.JWT_AUDIENCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_AUDIENCE'],
          message: 'JWT_AUDIENCE is required in production'
        });
      }
      if (!config.JWT_JWKS_URI) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_JWKS_URI'],
          message: 'JWT_JWKS_URI is required in production'
        });
      }
      if (!config.WEBHOOK_SHARED_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SHARED_SECRET'],
          message: 'WEBHOOK_SHARED_SECRET is required in production'
        });
      }
      if (!config.INTERNAL_API_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['INTERNAL_API_TOKEN'],
          message: 'INTERNAL_API_TOKEN is required in production'
        });
      }
      if (config.KMS_PROVIDER === 'local' && !config.LOCAL_ENCRYPTION_KEY_BASE64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOCAL_ENCRYPTION_KEY_BASE64'],
          message: 'LOCAL_ENCRYPTION_KEY_BASE64 is required when KMS_PROVIDER=local in production'
        });
      }
    }

    if (config.NODE_ENV !== 'development' && config.ALLOW_DEV_HEADER_AUTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_DEV_HEADER_AUTH'],
        message: 'ALLOW_DEV_HEADER_AUTH can only be enabled in development'
      });
    }
  });

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  return appEnvSchema.parse(config);
}
