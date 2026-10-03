// apps/api/src/modules/inventory/inventoryOperations.schema.ts
import { z } from 'zod';
export const inventorySkuSchema = z.string().trim().min(1).max(100);
export const inventoryOperationSchema = z
  .strictObject({
    sku: inventorySkuSchema,
    quantity: z
      .number()
      .int()
      .min(-100000)
      .max(100000)
      .refine((n) => n !== 0),
    reason: z.enum(['purchase', 'damaged', 'expired', 'adjustment']),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    note: z.string().trim().min(1).max(500),
  })
  .refine(
    (v) => v.reason === 'adjustment' || (v.reason === 'purchase' ? v.quantity > 0 : v.quantity < 0),
    {
      message: 'Quantity sign does not match reason',
      path: ['quantity'],
    },
  );
export type InventoryOperation = z.infer<typeof inventoryOperationSchema>;
export const inventoryCursorSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  sku: inventorySkuSchema,
});
export type InventoryCursor = z.infer<typeof inventoryCursorSchema>;
export function encodeInventoryCursor(value: InventoryCursor): string {
  return btoa(JSON.stringify(value));
}
export function decodeInventoryCursor(value: string): InventoryCursor | null {
  try {
    return inventoryCursorSchema.parse(JSON.parse(atob(value)));
  } catch {
    return null;
  }
}
