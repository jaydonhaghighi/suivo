import { z } from 'zod';

export const notificationFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(80)
});

export const readManySchema = z.object({
  ids: z.array(z.string().min(1)).max(500).default([])
});
