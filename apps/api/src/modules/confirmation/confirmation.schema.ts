// apps/api/src/modules/confirmation/confirmation.schema.ts
import { z } from 'zod';

export const CONFIRMATION_ACTIONS = ['confirmed', 'no_answer', 'cancelled', 'callback'] as const;

export const confirmationActionSchema = z.object({
  action: z.enum(CONFIRMATION_ACTIONS),
  channel: z.enum(['call', 'whatsapp']).default('call'),
});

export const confirmationOrderIdSchema = z.uuid();

export type ConfirmationAction = z.infer<typeof confirmationActionSchema>;
