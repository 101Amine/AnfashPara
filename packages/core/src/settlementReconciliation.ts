// packages/core/src/settlementReconciliation.ts
import { add, cents, sub } from './money';
import type { Status } from './orderStateMachine';
import type { SettlementPreview, SettlementRow } from './settlementParser';

export interface ReconciliationShipment {
  shipmentId: string;
  orderId: string;
  orderStatus: Status;
  shipmentStatus: string;
  trackingNumber: string;
  codCentimes: number;
  deliveryFeeCentimes: number | null;
  returnFeeCentimes: number | null;
  previouslyMatched: boolean;
}

export type ReconciliationClassification =
  | 'exact'
  | 'unmatched'
  | 'duplicate'
  | 'status_conflict'
  | 'missing_fee'
  | 'variance'
  | 'variance_over_100';

export interface ReconciliationLine extends SettlementRow {
  classification: ReconciliationClassification;
  shipment: ReconciliationShipment | null;
  expectedNetCentimes: number | null;
  expectedFeeCentimes: number | null;
  varianceCentimes: number | null;
}

export interface ReconciliationReport {
  lines: ReconciliationLine[];
  totals: SettlementPreview['totals'];
  expectedNetCentimes: number;
  exactCount: number;
  exceptionCount: number;
  amountPaidCentimes: number;
  statementVarianceCentimes: number;
}

/** Pure matching. A tolerance flag never grants permission to settle money. */
export function reconcileSettlement(
  preview: SettlementPreview,
  shipments: readonly ReconciliationShipment[],
  amountPaidCentimes: number,
): ReconciliationReport {
  if (!preview.valid) throw new Error('An invalid preview cannot be reconciled.');
  const byTracking = new Map(shipments.map((s) => [s.trackingNumber, s]));
  const counts = new Map<string, number>();
  for (const row of preview.rows)
    counts.set(row.trackingNumber, (counts.get(row.trackingNumber) ?? 0) + 1);
  const lines = preview.rows.map((row): ReconciliationLine => {
    const shipment = byTracking.get(row.trackingNumber) ?? null;
    let expectedFeeCentimes: number | null = null;
    let expectedNetCentimes: number | null = null;
    let varianceCentimes: number | null = null;
    const returned = shipment?.orderStatus === 'RETURNED' || shipment?.orderStatus === 'REFUSED';
    if (
      shipment?.deliveryFeeCentimes !== null &&
      shipment?.deliveryFeeCentimes !== undefined &&
      (!returned || shipment.returnFeeCentimes !== null)
    ) {
      expectedFeeCentimes = add(
        cents(shipment.deliveryFeeCentimes),
        cents(returned ? shipment.returnFeeCentimes! : 0),
      );
      const expectedCod = returned ? 0 : shipment.codCentimes;
      expectedNetCentimes = sub(cents(expectedCod), cents(expectedFeeCentimes));
      varianceCentimes = sub(cents(row.netCentimes), cents(expectedNetCentimes));
    }
    let classification: ReconciliationClassification;
    if (
      counts.get(row.trackingNumber)! > 1 ||
      shipment?.previouslyMatched ||
      shipment?.orderStatus === 'SETTLED'
    )
      classification = 'duplicate';
    else if (!shipment) classification = 'unmatched';
    else if (
      shipment.orderStatus !== 'DELIVERED' ||
      shipment.shipmentStatus !== 'delivered' ||
      !['delivered', 'livre'].includes(
        row.rawCourierStatus
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/gu, '')
          .trim()
          .toLowerCase(),
      )
    )
      classification = 'status_conflict';
    else if (expectedFeeCentimes === null) classification = 'missing_fee';
    else if (varianceCentimes !== null && Math.abs(varianceCentimes) > 100)
      classification = 'variance_over_100';
    else if (
      row.codCollectedCentimes !== shipment.codCentimes ||
      row.deliveryFeeCentimes !== shipment.deliveryFeeCentimes ||
      row.returnFeeCentimes !== 0 ||
      varianceCentimes !== 0
    )
      classification = 'variance';
    else classification = 'exact';
    return {
      ...row,
      classification,
      shipment,
      expectedFeeCentimes,
      expectedNetCentimes,
      varianceCentimes,
    };
  });
  const exactCount = lines.filter((line) => line.classification === 'exact').length;
  return {
    lines,
    totals: preview.totals,
    exactCount,
    exceptionCount: lines.length - exactCount,
    // Count each shipment once; repeated statement lines must not inflate our expectation.
    expectedNetCentimes: [
      ...new Map(
        lines
          .filter((l) => l.shipment)
          .map((l) => [l.shipment!.shipmentId, l.expectedNetCentimes ?? 0]),
      ).values(),
    ].reduce((sum, value) => add(cents(sum), cents(value)), cents(0)),
    amountPaidCentimes: cents(amountPaidCentimes),
    statementVarianceCentimes: sub(cents(amountPaidCentimes), preview.totals.netCentimes),
  };
}
