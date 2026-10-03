// apps/api/src/integrations/courier/courierClient.factory.ts
import {
  CourierClientError,
  type CourierClient,
  type CourierStatus,
  type CreateParcelInput,
  type CreateParcelResult,
} from '@para/core';
import { z } from 'zod';

import type { AppBindings } from '../../auth/cloudflareAccess';

const courierConfigSchema = z.object({
  accountId: z.string().trim().min(1),
  apiToken: z.string().trim().min(1),
  apiUrl: z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  courierName: z.string().trim().min(1),
});

const createParcelResultSchema = z.object({
  deliveryFeeCentimes: z.int().nonnegative().optional(),
  labelUrl: z.url().optional(),
  rawStatus: z.string().min(1),
  returnFeeCentimes: z.int().nonnegative().optional(),
  status: z.enum(['created', 'picked']),
  trackingNumber: z.string().min(1),
});

const courierStatusSchema = z.object({
  occurredAt: z.iso.datetime(),
  rawStatus: z.string().min(1),
  status: z.enum([
    'created',
    'picked',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'refused',
    'returned',
    'lost',
  ]),
  trackingNumber: z.string().min(1),
});

type CourierConfig = z.infer<typeof courierConfigSchema>;
export type CourierClientFactory = (bindings: AppBindings) => CourierClient;

export class CourierConfigurationError extends Error {
  constructor() {
    super('Courier credentials are unavailable');
    this.name = 'CourierConfigurationError';
  }
}

export function createCourierClientFromBindings(bindings: AppBindings): CourierClient {
  const config = courierConfigSchema.safeParse({
    accountId: bindings.COURIER_ACCOUNT_ID,
    apiToken: bindings.COURIER_API_TOKEN,
    apiUrl: bindings.COURIER_API_URL,
    courierName: bindings.COURIER_NAME,
  });
  if (!config.success) throw new CourierConfigurationError();
  return new HttpCourierClient(config.data);
}

export class HttpCourierClient implements CourierClient {
  constructor(
    private readonly config: CourierConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createParcel(input: CreateParcelInput): Promise<CreateParcelResult> {
    const response = await this.request('create_parcel', this.url('parcels'), {
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.idempotencyKey },
      method: 'POST',
    });
    const parsed = await parseResponse(response, createParcelResultSchema, 'create_parcel');
    return {
      courier: this.config.courierName,
      rawStatus: parsed.rawStatus,
      status: parsed.status,
      trackingNumber: parsed.trackingNumber,
      ...(parsed.deliveryFeeCentimes === undefined
        ? {}
        : { deliveryFeeCentimes: parsed.deliveryFeeCentimes }),
      ...(parsed.returnFeeCentimes === undefined
        ? {}
        : { returnFeeCentimes: parsed.returnFeeCentimes }),
      ...(parsed.labelUrl === undefined ? {} : { labelUrl: parsed.labelUrl }),
    };
  }

  async getStatus(trackingNumber: string): Promise<CourierStatus> {
    const response = await this.request(
      'get_status',
      this.url(`parcels/${encodeURIComponent(trackingNumber)}`),
      { method: 'GET' },
    );
    return parseResponse(response, courierStatusSchema, 'get_status');
  }

  private async request(
    operation: 'create_parcel' | 'get_status',
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
          'X-Courier-Account-Id': this.config.accountId,
          ...init.headers,
        },
      });
    } catch {
      throw new CourierClientError(operation, 'network_error', 'Courier request failed.', {
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new CourierClientError(operation, 'courier_rejected', 'Courier request failed.', {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return response;
  }

  private url(path: string): URL {
    const baseUrl = `${this.config.apiUrl.replace(/\/+$/u, '')}/`;
    return new URL(path, baseUrl);
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  operation: 'create_parcel' | 'get_status',
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new CourierClientError(operation, 'invalid_response', 'Courier response is invalid.', {
      retryable: true,
    });
  }
}
