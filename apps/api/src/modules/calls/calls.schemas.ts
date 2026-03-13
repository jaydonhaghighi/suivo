import { z } from 'zod';

export const callIntentSchema = z.object({
  lead_id: z.string().uuid(),
  phone_number_id: z.string().uuid(),
  destination: z.string().min(4)
});
