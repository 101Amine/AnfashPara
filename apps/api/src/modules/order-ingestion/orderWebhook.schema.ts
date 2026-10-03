// apps/api/src/modules/order-ingestion/orderWebhook.schema.ts
import { z } from 'zod';

const optionalText = z.string().trim().min(1).max(500).optional();

const orderItemSchema = z
  .object({
    quantity: z.number().int().positive().max(100),
    sku: z.string().trim().min(1).max(100),
  })
  .strict();

export const orderWebhookSchema = z
  .object({
    eventId: z.string().trim().min(1).max(255),
    order: z
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
        externalId: z.string().trim().min(1).max(255),
        items: z
          .array(orderItemSchema)
          .min(1)
          .max(50)
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
        orderNumber: z.string().trim().min(1).max(100).optional(),
        placedAt: z.iso.datetime(),
        shippingFeeCustomerCentimes: z.number().int().nonnegative().optional().default(0),
      })
      .strict(),
  })
  .strict();

export type OrderWebhookPayload = z.infer<typeof orderWebhookSchema>;
