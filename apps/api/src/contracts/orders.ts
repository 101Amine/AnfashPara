// apps/api/src/contracts/orders.ts
export const ORDER_IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;

export interface OrderCreateRequest {
  readonly customer: {
    readonly name: string;
    readonly phone: string;
    readonly city: string;
    readonly address: string;
    readonly note?: string;
  };
  readonly items: readonly {
    readonly sku: string;
    readonly quantity: number;
  }[];
  readonly attribution?: {
    readonly utmSource?: string;
    readonly utmCampaign?: string;
    readonly utmContent?: string;
  };
}

export interface OrderCreateResponse {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: 'CONFIRMING';
  readonly codAmountCentimes: number;
  readonly currency: 'MAD';
}
