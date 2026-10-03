// packages/core/src/testing/fakeCourierClient.ts
import {
  CourierClientError,
  type CourierClient,
  type CourierStatus,
  type CreateParcelInput,
  type CreateParcelResult,
} from '../courier';

export type FakeCourierOutcome<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly error: CourierClientError; readonly kind: 'failure' };

export interface FakeCourierPlan {
  readonly createParcel: FakeCourierOutcome<CreateParcelResult>;
  readonly statuses: Readonly<Record<string, FakeCourierOutcome<CourierStatus>>>;
}

export class FakeCourierClient implements CourierClient {
  readonly createParcelCalls: CreateParcelInput[] = [];
  readonly getStatusCalls: string[] = [];

  constructor(private readonly plan: FakeCourierPlan) {}

  async createParcel(input: CreateParcelInput): Promise<CreateParcelResult> {
    this.createParcelCalls.push(input);
    return resolveOutcome(this.plan.createParcel);
  }

  async getStatus(trackingNumber: string): Promise<CourierStatus> {
    this.getStatusCalls.push(trackingNumber);
    const outcome = this.plan.statuses[trackingNumber];
    if (outcome === undefined) {
      throw new CourierClientError(
        'get_status',
        'fake_status_not_configured',
        `No fake courier status configured for ${trackingNumber}.`,
        { retryable: false },
      );
    }
    return resolveOutcome(outcome);
  }
}

export function courierSuccess<T>(value: T): FakeCourierOutcome<T> {
  return { kind: 'success', value };
}

export function courierFailure<T>(error: CourierClientError): FakeCourierOutcome<T> {
  return { error, kind: 'failure' };
}

async function resolveOutcome<T>(outcome: FakeCourierOutcome<T>): Promise<T> {
  if (outcome.kind === 'failure') throw outcome.error;
  return outcome.value;
}
