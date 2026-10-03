// apps/api/src/modules/labels/labels.schema.ts
import { z } from 'zod';

export const shipmentIdSchema = z.uuid();

export const labelBatchSchema = z.object({
  shipmentIds: z.array(shipmentIdSchema).min(1).max(20),
});
