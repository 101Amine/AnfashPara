// apps/api/src/modules/status-sync/statusPolling.service.ts
import type { CourierClient } from '@para/core';

import { synchronizeCourierStatus } from './statusSync.service';

const STORE_ID = 'para-main';
const DEFAULT_BATCH_SIZE = 50;

type OpenShipmentRow = {
  tracking_number: string;
};

export type PollingSummary = {
  failed: number;
  processed: number;
  skipped: number;
};

export async function pollOpenShipments(
  database: D1Database,
  courierClient: CourierClient,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<PollingSummary> {
  const openShipments = await database
    .prepare(
      `SELECT tracking_number
       FROM shipments
       WHERE store_id = ?
         AND status_normalized IN ('created', 'picked', 'in_transit', 'out_for_delivery')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(STORE_ID, batchSize)
    .all<OpenShipmentRow>();

  const summary: PollingSummary = { failed: 0, processed: 0, skipped: 0 };
  for (const shipment of openShipments.results) {
    try {
      const status = await courierClient.getStatus(shipment.tracking_number);
      if (status.trackingNumber !== shipment.tracking_number) {
        summary.failed += 1;
        continue;
      }

      const rawPayload = JSON.stringify(status);
      const result = await synchronizeCourierStatus(
        database,
        {
          eventId: `${status.trackingNumber}:${status.occurredAt}:${status.rawStatus}`,
          normalizedStatus: status.status,
          occurredAt: status.occurredAt,
          rawPayload,
          rawStatus: status.rawStatus,
          source: 'poll',
          trackingNumber: status.trackingNumber,
        },
        now,
      );
      if (result.duplicate || result.stale) summary.skipped += 1;
      else summary.processed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
