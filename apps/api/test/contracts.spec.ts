// apps/api/test/contracts.spec.ts
import { describe, expect, it } from 'vitest';

import { SHIPMENT_STATUSES } from '../src/contracts/fulfillment';
import { ORDER_IDEMPOTENCY_HEADER } from '../src/contracts/orders';
import orderRequest from './fixtures/contracts/order-create.request.json';
import orderResponse from './fixtures/contracts/order-create.response.json';
import shipmentRequest from './fixtures/contracts/shipment-create.request.json';
import shipmentResponse from './fixtures/contracts/shipment-create.response.json';
import shipmentEvents from './fixtures/contracts/shipment-status-events.json';

const fixtures = [orderRequest, orderResponse, shipmentRequest, shipmentResponse, shipmentEvents];

describe('internal API contract fixtures', () => {
  it('uses a first-party idempotency header instead of a fake webhook signature', () => {
    expect(ORDER_IDEMPOTENCY_HEADER).toBe('Idempotency-Key');
  });

  it('lets the client send SKUs and quantities but never authoritative prices', () => {
    expect(orderRequest.items).toEqual([
      { quantity: 2, sku: 'BIO-OIL-125ML' },
      { quantity: 1, sku: 'MUSTELA-VERGETURES-250ML' },
    ]);
    expect(JSON.stringify(orderRequest)).not.toMatch(/price|cogs|total|codAmount/i);
  });

  it('documents the customer and optional attribution fields', () => {
    expect(orderRequest.customer).toMatchObject({
      address: expect.any(String),
      city: expect.any(String),
      name: expect.any(String),
      phone: expect.any(String),
    });
    expect(orderRequest.attribution).toEqual({
      utmCampaign: 'launch-test',
      utmContent: 'hook-03',
      utmSource: 'instagram',
    });
  });

  it('keeps money server-owned and represented as integer centimes', () => {
    expect(Number.isSafeInteger(orderResponse.codAmountCentimes)).toBe(true);
    expect(orderResponse.currency).toBe('MAD');
    expect(orderResponse.status).toBe('CONFIRMING');
  });

  it('covers every normalized shipment status exactly once', () => {
    expect(shipmentEvents.map(({ status }) => status)).toEqual(SHIPMENT_STATUSES);
  });

  it('keeps shipment fees in integer centimes', () => {
    expect(Number.isSafeInteger(shipmentRequest.deliveryFeeCentimes)).toBe(true);
    expect(Number.isSafeInteger(shipmentRequest.returnFeeCentimes)).toBe(true);
    expect(shipmentResponse.status).toBe('created');
  });

  it('contains no committed credentials or authorization headers', () => {
    const serialized = JSON.stringify(fixtures);

    expect(serialized).not.toMatch(/authorization|api[_-]?key|client[_-]?secret|bearer\s/i);
  });
});
