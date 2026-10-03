// packages/core/test/settlementReconciliation.test.ts
import { describe, expect, it } from 'vitest';
import {
  parseSettlementCsv,
  reconcileSettlement,
  SETTLEMENT_COLUMNS,
  type ReconciliationShipment,
} from '../src/index';

const shipment: ReconciliationShipment = {
  shipmentId: 's1',
  orderId: 'o1',
  orderStatus: 'DELIVERED',
  shipmentStatus: 'delivered',
  trackingNumber: 'T1',
  codCentimes: 25000,
  deliveryFeeCentimes: 3000,
  returnFeeCentimes: 1500,
  previouslyMatched: false,
};
function report(
  row = 'T1,250,30,0,220,delivered',
  overrides: Partial<ReconciliationShipment> = {},
  amount = 22000,
) {
  return reconcileSettlement(
    parseSettlementCsv(`${SETTLEMENT_COLUMNS.join(',')}\n${row}`),
    [{ ...shipment, ...overrides }],
    amount,
  );
}
describe('settlement reconciliation rules', () => {
  it('matches COD less delivery fee exactly without charging the quoted return fee', () => {
    expect(report()).toMatchObject({
      exactCount: 1,
      exceptionCount: 0,
      expectedNetCentimes: 22000,
      statementVarianceCentimes: 0,
      lines: [{ classification: 'exact' }],
    });
  });
  it('accepts the known French delivered alias', () =>
    expect(report('T1,250,30,0,220,Livré').exactCount).toBe(1));
  it.each([
    [-101, 'variance_over_100'],
    [-100, 'variance'],
    [-1, 'variance'],
    [0, 'exact'],
    [1, 'variance'],
    [100, 'variance'],
    [101, 'variance_over_100'],
  ])('classifies signed centime difference %s as %s', (delta, classification) => {
    const net = 22000 + Number(delta);
    const decimal = `${Math.floor(net / 100)}.${String(net % 100).padStart(2, '0')}`;
    expect(report(`T1,250,30,0,${decimal},delivered`).lines[0]?.classification).toBe(
      classification,
    );
  });
  it('detects a wrong fee even when the reported net hides it', () =>
    expect(report('T1,250,31,0,220,delivered').lines[0]?.classification).toBe('variance'));
  it('detects shifted COD and fees with zero net difference', () =>
    expect(report('T1,251,31,0,220,delivered').exactCount).toBe(0));
  it('marks every repeated tracking line duplicate and counts expectation once', () =>
    expect(report('T1,250,30,0,220,delivered\nT1,250,30,0,220,delivered', {}, 44000)).toMatchObject(
      {
        exactCount: 0,
        expectedNetCentimes: 22000,
        lines: [{ classification: 'duplicate' }, { classification: 'duplicate' }],
      },
    ));
  it('does not match unknown tracking', () =>
    expect(report('OTHER,250,30,0,220,delivered').lines[0]?.classification).toBe('unmatched'));
  it.each([{ previouslyMatched: true }, { orderStatus: 'SETTLED' as const }])(
    'rejects already reconciled shipments %s',
    (overrides) => expect(report(undefined, overrides).lines[0]?.classification).toBe('duplicate'),
  );
  it.each(['SHIPPED', 'REFUSED', 'RETURNED'] as const)('does not settle %s', (orderStatus) =>
    expect(report(undefined, { orderStatus }).lines[0]?.classification).toBe('status_conflict'),
  );
  it('retains negative expected net on returns without inventing COD', () =>
    expect(report(undefined, { orderStatus: 'RETURNED' }).lines[0]?.expectedNetCentimes).toBe(
      -4500,
    ));
  it('does not guess unknown fees', () =>
    expect(report(undefined, { deliveryFeeCentimes: null }).lines[0]?.classification).toBe(
      'missing_fee',
    ));
  it('does not require a return quote on a delivered parcel', () =>
    expect(report(undefined, { returnFeeCentimes: null }).exactCount).toBe(1));
  it('rejects unknown raw statuses and stale shipment status', () => {
    expect(report('T1,250,30,0,220,paid').lines[0]?.classification).toBe('status_conflict');
    expect(report(undefined, { shipmentStatus: 'in_transit' }).exactCount).toBe(0);
  });
  it('retains unmatched statement amounts and flags receipt difference', () =>
    expect(report('OTHER,250,30,0,220,delivered', {}, 21999)).toMatchObject({
      expectedNetCentimes: 0,
      statementVarianceCentimes: -1,
      totals: { netCentimes: 22000 },
    }));
  it('refuses invalid parsed rows', () =>
    expect(() => report('T1,bad,30,0,220,delivered')).toThrow('invalid preview'));
});
