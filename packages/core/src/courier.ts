// packages/core/src/courier.ts
export const COURIER_STATUS_CODES = [
  'created',
  'picked',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'refused',
  'returned',
  'lost',
] as const;

export type CourierStatusCode = (typeof COURIER_STATUS_CODES)[number];

export interface CreateParcelInput {
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly orderReference: string;
  readonly receiver: {
    readonly name: string;
    readonly phoneE164: string;
    readonly city: string;
    readonly address: string;
  };
  readonly codAmountCentimes: number;
  readonly productSummary: string;
}

export interface CreateParcelResult {
  readonly courier: string;
  readonly trackingNumber: string;
  readonly rawStatus: string;
  readonly status: 'created' | 'picked';
  readonly deliveryFeeCentimes?: number;
  readonly returnFeeCentimes?: number;
  readonly labelUrl?: string;
}

export interface CourierStatus {
  readonly trackingNumber: string;
  readonly rawStatus: string;
  readonly status: CourierStatusCode;
  readonly occurredAt: string;
}

export interface CourierClient {
  createParcel(input: CreateParcelInput): Promise<CreateParcelResult>;
  getStatus(trackingNumber: string): Promise<CourierStatus>;
}

export type CourierOperation = 'create_parcel' | 'get_status';

export class CourierClientError extends Error {
  readonly code: string;
  readonly operation: CourierOperation;
  readonly retryable: boolean;

  constructor(
    operation: CourierOperation,
    code: string,
    message: string,
    options: { retryable: boolean },
  ) {
    super(message);
    this.name = 'CourierClientError';
    this.operation = operation;
    this.code = code;
    this.retryable = options.retryable;
  }
}
