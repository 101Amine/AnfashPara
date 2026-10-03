// packages/core/src/testing/fakeOutboxHandler.ts
import {
  OutboxDeliveryError,
  type OutboxHandler,
  type OutboxMessage,
  type OutboxCancellation,
} from '../outbox';
export type FakeOutboxOutcome = 'success' | OutboxDeliveryError;
/** A deterministic adapter that models recipient-side idempotency without sending anything. */
export class FakeOutboxHandler implements OutboxHandler {
  readonly calls: OutboxMessage[] = [];
  readonly deliveries: OutboxMessage[] = [];
  private readonly deliveredKeys = new Set<string>();
  constructor(private readonly outcomes: readonly FakeOutboxOutcome[] = ['success']) {}
  async handle(message: OutboxMessage, signal: OutboxCancellation): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(message);
    if (this.deliveredKeys.has(message.idempotencyKey)) return;
    const outcome = this.outcomes[this.calls.length - 1] ?? this.outcomes.at(-1);
    if (outcome === undefined) throw new OutboxDeliveryError('provider_unavailable');
    if (outcome instanceof OutboxDeliveryError) throw outcome;
    this.deliveredKeys.add(message.idempotencyKey);
    this.deliveries.push(message);
  }
}
