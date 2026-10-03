// apps/api/src/integrations/courier/manualCourierClient.ts
import {
  CourierClientError,
  type CourierClient,
  type CourierStatus,
  type CreateParcelInput,
  type CreateParcelResult,
} from '@para/core';

export class ManualCourierClient implements CourierClient {
  constructor(private readonly courierName = 'self-delivery') {}

  async createParcel(input: CreateParcelInput): Promise<CreateParcelResult> {
    return {
      courier: this.courierName,
      rawStatus: 'MANUAL_CREATED',
      status: 'created',
      trackingNumber: createManualTrackingNumber(input),
    };
  }

  async getStatus(_trackingNumber: string): Promise<CourierStatus> {
    throw new CourierClientError(
      'get_status',
      'manual_status_required',
      'Manual deliveries require an operator status update.',
      { retryable: false },
    );
  }
}

function createManualTrackingNumber(input: CreateParcelInput): string {
  const reference = input.orderReference
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toUpperCase()
    .slice(0, 24);
  const suffix = input.orderId.replaceAll('-', '').slice(-8).toUpperCase();
  return `SELF-${reference || 'ORDER'}-${suffix}`;
}
