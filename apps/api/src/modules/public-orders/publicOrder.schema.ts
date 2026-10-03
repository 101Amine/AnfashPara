// apps/api/src/modules/public-orders/publicOrder.schema.ts
import { z } from 'zod';

const optionalText = z.string().trim().min(1).max(500).optional();

const itemSchema = z
  .object({
    quantity: z.number().int().min(1).max(20),
    sku: z.string().trim().min(1).max(100),
  })
  .strict();

export const publicOrderSchema = z
  .object({
    attribution: z
      .object({
        utmCampaign: optionalText,
        utmContent: optionalText,
        utmSource: optionalText,
      })
      .strict()
      .optional(),
    customer: z
      .object({
        address: z.string().trim().min(1).max(500),
        city: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(160),
        note: optionalText,
        phone: z.string().trim().min(1).max(40),
      })
      .strict(),
    items: z
      .array(itemSchema)
      .min(1)
      .max(20)
      .superRefine((items, context) => {
        const seen = new Set<string>();

        for (const [index, item] of items.entries()) {
          if (seen.has(item.sku)) {
            context.addIssue({
              code: 'custom',
              message: 'Duplicate SKU',
              path: [index, 'sku'],
            });
          }
          seen.add(item.sku);
        }
      }),
  })
  .strict();

export type PublicOrderPayload = z.infer<typeof publicOrderSchema>;
