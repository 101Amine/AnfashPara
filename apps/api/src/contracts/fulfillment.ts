// apps/api/src/contracts/fulfillment.ts
import { COURIER_STATUS_CODES, type CourierStatusCode } from '@para/core';

export const SHIPMENT_STATUSES = COURIER_STATUS_CODES;

export type ShipmentStatus = CourierStatusCode;

export interface ShipmentCreateRequest {
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly deliveryFeeCentimes: number;
  readonly returnFeeCentimes: number;
  readonly labelUrl?: string;
}

export interface ShipmentCreateResponse extends ShipmentCreateRequest {
  readonly shipmentId: string;
  readonly orderId: string;
  readonly status: 'created';
}

export interface ShipmentStatusEventRequest {
  readonly eventId: string;
  readonly status: ShipmentStatus;
  readonly occurredAt: string;
  readonly note?: string;
}
