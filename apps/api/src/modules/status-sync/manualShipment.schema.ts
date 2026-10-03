// apps/api/src/modules/status-sync/manualShipment.schema.ts
import { z } from 'zod';

export const manualShipmentIdsSchema = z.object({ orderId: z.uuid(), shipmentId: z.uuid() });
export const manualShipmentActionSchema = z.strictObject({
  action: z.enum(['picked', 'delivered', 'refused', 'returned']),
});
