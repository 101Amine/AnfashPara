// apps/api/src/modules/status-sync/courierWebhook.schema.ts
import { z } from 'zod';

export const courierWebhookSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  occurredAt: z.iso.datetime(),
  status: z.string().trim().min(1).max(100),
  trackingNumber: z.string().trim().min(1).max(200),
});

export type CourierWebhookPayload = z.infer<typeof courierWebhookSchema>;
