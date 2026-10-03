// apps/api/src/contracts/fulfillment.ts
export const SHIPMENT_STATUSES = [
  'created',
  'picked',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'refused',
  'returned',
  'lost',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

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
