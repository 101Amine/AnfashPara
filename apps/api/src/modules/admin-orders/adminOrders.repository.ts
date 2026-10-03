// apps/api/src/modules/admin-orders/adminOrders.repository.ts
import type { OrderStatus } from '../../db/schema';
import { encodeAdminOrdersCursor, type AdminOrdersCursor } from './adminOrders.schema';

const STORE_ID = 'para-main';
export const ADMIN_ORDERS_PAGE_SIZE = 20;

type AdminOrderDatabaseRow = {
  city: string | null;
  cod_amount_centimes: number;
  customer_name: string | null;
  order_id: string;
  order_number: string | null;
  phone_e164: string;
  placed_at: string;
  shipment_id: string | null;
  shipment_label_url: string | null;
  status: OrderStatus;
  status_started_at: string;
};

export type AdminOrderListItem = {
  city: string | null;
  codAmountCentimes: number;
  customerName: string | null;
  id: string;
  orderNumber: string | null;
  phoneE164: string;
  placedAt: string;
  shipmentId: string | null;
  shipmentLabelAvailable: boolean;
  status: OrderStatus;
  statusStartedAt: string;
};

export type AdminOrdersPage = {
  nextCursor: string | null;
  orders: AdminOrderListItem[];
};

export type ListAdminOrdersOptions = {
  cursor?: AdminOrdersCursor;
  query: string;
  status?: OrderStatus;
};

export async function listAdminOrders(
  database: D1Database,
  options: ListAdminOrdersOptions,
): Promise<AdminOrdersPage> {
  const conditions = ['o.store_id = ?'];
  const bindings: unknown[] = [STORE_ID];

  if (options.status !== undefined) {
    conditions.push('o.status = ?');
    bindings.push(options.status);
  }

  if (options.query !== '') {
    conditions.push(`(o.order_number LIKE ? ESCAPE '\\' OR c.phone_e164 LIKE ? ESCAPE '\\')`);
    bindings.push(toLikePattern(options.query), toLikePattern(toPhoneSearch(options.query)));
  }

  if (options.cursor !== undefined) {
    conditions.push('(o.placed_at < ? OR (o.placed_at = ? AND o.id < ?))');
    bindings.push(options.cursor.placedAt, options.cursor.placedAt, options.cursor.id);
  }

  const result = await database
    .prepare(
      `SELECT
         o.id AS order_id,
         o.order_number,
         o.status,
         o.cod_amount_centimes,
         o.city,
         o.placed_at,
         c.name AS customer_name,
         c.phone_e164,
         s.id AS shipment_id,
         s.label_url AS shipment_label_url,
         COALESCE(
           (SELECT MAX(oe.created_at)
              FROM order_events oe
             WHERE oe.order_id = o.id AND oe.to_status = o.status),
           o.updated_at
         ) AS status_started_at
       FROM orders o
       INNER JOIN customers c ON c.id = o.customer_id
       LEFT JOIN shipments s ON s.order_id = o.id AND s.store_id = o.store_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.placed_at DESC, o.id DESC
       LIMIT ?`,
    )
    .bind(...bindings, ADMIN_ORDERS_PAGE_SIZE + 1)
    .all<AdminOrderDatabaseRow>();

  const hasNextPage = result.results.length > ADMIN_ORDERS_PAGE_SIZE;
  const visibleRows = result.results.slice(0, ADMIN_ORDERS_PAGE_SIZE);
  const lastRow = visibleRows.at(-1);

  return {
    nextCursor:
      hasNextPage && lastRow !== undefined
        ? encodeAdminOrdersCursor({ id: lastRow.order_id, placedAt: lastRow.placed_at })
        : null,
    orders: visibleRows.map((row) => ({
      city: row.city,
      codAmountCentimes: row.cod_amount_centimes,
      customerName: row.customer_name,
      id: row.order_id,
      orderNumber: row.order_number,
      phoneE164: row.phone_e164,
      placedAt: row.placed_at,
      shipmentId: row.shipment_id,
      shipmentLabelAvailable:
        row.shipment_label_url !== null && row.shipment_label_url.trim() !== '',
      status: row.status,
      statusStartedAt: row.status_started_at,
    })),
  };
}

function toPhoneSearch(query: string): string {
  const compact = query.replace(/[^+\d]/gu, '');
  if (compact.startsWith('0')) return `+212${compact.slice(1)}`;
  if (compact.startsWith('212')) return `+${compact}`;
  return compact;
}

function toLikePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}
