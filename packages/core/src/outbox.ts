// packages/core/src/outbox.ts
export const OUTBOX_TOPICS = [
  'order.confirmation.requested',
  'order.confirmed',
  'shipment.status',
] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];
export interface OutboxMessage {
  readonly id: string;
  readonly storeId: string;
  readonly topic: OutboxTopic;
  readonly aggregateType: 'order' | 'shipment';
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Stable across attempts and leases. Adapters must deduplicate side effects with this key. */
  readonly idempotencyKey: string;
  readonly attempt: number;
}
export interface OutboxHandler {
  /** Resolve only after durable delivery; respect cancellation and reuse idempotencyKey on retry. */
  handle(message: OutboxMessage, cancellation: OutboxCancellation): Promise<void>;
}
/** Structural cancellation keeps the core independent of DOM/Worker runtime types. */
export interface OutboxCancellation {
  readonly aborted: boolean;
  throwIfAborted(): void;
  onAbort(callback: () => void): () => void;
}
export type OutboxErrorCode =
  'provider_unavailable' | 'provider_rejected' | 'unsupported_topic' | 'invalid_payload';
export class OutboxDeliveryError extends Error {
  constructor(
    readonly code: OutboxErrorCode,
    readonly retryable = true,
  ) {
    // No provider error text, credentials or customer data can be attached to this error.
    super(code);
    this.name = 'OutboxDeliveryError';
  }
}
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BASE_DELAY_MS = 60_000;
export function outboxRetryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > OUTBOX_MAX_ATTEMPTS)
    throw new RangeError('Invalid outbox attempt.');
  return OUTBOX_BASE_DELAY_MS * 2 ** (attempt - 1);
}
