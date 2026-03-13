import { z } from 'zod';

export const oauthStartSchema = z.object({
  app_redirect_uri: z.string().url().optional(),
  login_hint: z.string().email().optional()
});

export const providerParamSchema = z.enum(['gmail', 'outlook']);

export const oauthCallbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  email_address: z.string().email().optional(),
  mailbox_type: z.enum(['primary', 'shared', 'delegated']).optional(),
  delegated_from: z.string().email().optional()
});

const booleanFromQuery = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

export const gmailPullInboxSchema = z.object({
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).default(24),
  max_results: z.coerce.number().int().min(1).max(5000).default(100),
  await_classification: booleanFromQuery.default(false),
  preview_limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const mailboxEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  include_body: booleanFromQuery.default(false)
});
