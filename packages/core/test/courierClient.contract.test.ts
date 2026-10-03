// packages/core/test/courierClient.contract.test.ts
import { describe, expect, it } from 'vitest';

import {
  CourierClientError,
  type CourierClient,
  type CourierStatus,
  type CreateParcelInput,
  type CreateParcelResult,
} from '@para/core';
import { FakeCourierClient, courierFailure, courierSuccess } from '@para/core/testing';

const parcelInput: CreateParcelInput = {
  codAmountCentimes: 24_500,
  orderId: '0199a001-1000-7000-8000-000000000001',
  orderReference: 'PARA-101',
  productSummary: '2× Bio-Oil 125ml',
  receiver: {
    address: '12 rue Atlas',
    city: 'Rabat',
    name: 'Salma Test',
    phoneE164: '+212612345678',
  },
};

const parcelResult: CreateParcelResult = {
  courier: 'fake-courier',
  deliveryFeeCentimes: 3_500,
  labelUrl: 'https://example.test/labels/FAKE-PARA-101.pdf',
  rawStatus: 'CREATED',
  returnFeeCentimes: 1_500,
  status: 'created',
  trackingNumber: 'FAKE-PARA-101',
};

const deliveredStatus: CourierStatus = {
  occurredAt: '2026-10-05T14:15:00.000Z',
  rawStatus: 'LIVRE',
  status: 'delivered',
  trackingNumber: 'FAKE-PARA-101',
};

describe('CourierClient contract', () => {
  it('creates a parcel and preserves the normalized result contract', async () => {
    const client = successfulClient();

    await expect(client.createParcel(parcelInput)).resolves.toEqual(parcelResult);
    expect(client.createParcelCalls).toEqual([parcelInput]);
  });

  it('retrieves a normalized courier status by tracking number', async () => {
    const client = successfulClient();

    await expect(client.getStatus('FAKE-PARA-101')).resolves.toEqual(deliveredStatus);
    expect(client.getStatusCalls).toEqual(['FAKE-PARA-101']);
  });

  it.each([
    {
      expectedOperation: 'create_parcel',
      invoke: (client: CourierClient) => client.createParcel(parcelInput),
      operation: 'createParcel',
    },
    {
      expectedOperation: 'get_status',
      invoke: (client: CourierClient) => client.getStatus('FAKE-PARA-101'),
      operation: 'getStatus',
    },
  ] as const)(
    'surfaces deterministic typed failures from $operation',
    async ({ expectedOperation, invoke }) => {
      const error = new CourierClientError(expectedOperation, 'fake_failure', 'Planned failure.', {
        retryable: true,
      });
      const client = new FakeCourierClient({
        createParcel: courierFailure(error),
        statuses: { 'FAKE-PARA-101': courierFailure(error) },
      });

      await expect(invoke(client)).rejects.toBe(error);
      expect(error).toMatchObject({
        code: 'fake_failure',
        operation: expectedOperation,
        retryable: true,
      });
    },
  );

  it('fails explicitly when a status was not configured', async () => {
    const client = new FakeCourierClient({
      createParcel: courierSuccess(parcelResult),
      statuses: {},
    });

    await expect(client.getStatus('UNKNOWN')).rejects.toMatchObject({
      code: 'fake_status_not_configured',
      operation: 'get_status',
      retryable: false,
    });
  });
});

function successfulClient(): FakeCourierClient {
  return new FakeCourierClient({
    createParcel: courierSuccess(parcelResult),
    statuses: { 'FAKE-PARA-101': courierSuccess(deliveredStatus) },
  });
}
