// apps/api/src/modules/admin-orders/adminOrders.schema.ts
import { z } from 'zod';

import { ORDER_STATUSES } from '../../db/schema';

export const adminOrdersQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  q: z.string().trim().max(100).optional().default(''),
  status: z.enum(ORDER_STATUSES).optional(),
});

export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;

const cursorSchema = z.object({
  id: z.string().min(1).max(100),
  placedAt: z.iso.datetime(),
});

export type AdminOrdersCursor = z.infer<typeof cursorSchema>;

export function encodeAdminOrdersCursor(cursor: AdminOrdersCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeAdminOrdersCursor(value: string): AdminOrdersCursor | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}
