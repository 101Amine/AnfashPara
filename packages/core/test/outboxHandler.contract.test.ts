// packages/core/test/outboxHandler.contract.test.ts
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxDeliveryError,
  outboxRetryDelay,
  type OutboxCancellation,
  type OutboxMessage,
} from '../src/outbox';
import { FakeOutboxHandler } from '../src/testing';
const message: OutboxMessage = {
  id: 'message',
  storeId: 'para-main',
  topic: 'order.confirmation.requested',
  aggregateType: 'order',
  aggregateId: 'order',
  payload: { orderId: 'order' },
  idempotencyKey: 'stable-key',
  attempt: 1,
};
const active: OutboxCancellation = {
  aborted: false,
  throwIfAborted: () => undefined,
  onAbort: () => () => undefined,
};
describe('OutboxHandler contract', () => {
  it('supports deterministic success without external calls', async () => {
    const handler = new FakeOutboxHandler();
    await handler.handle(message, active);
    expect(handler.calls).toEqual([message]);
    expect(handler.deliveries).toEqual([message]);
  });
  it('reuses a stable key to prevent duplicate effects', async () => {
    const handler = new FakeOutboxHandler();
    await handler.handle(message, active);
    await handler.handle({ ...message, attempt: 2 }, active);
    expect(handler.calls).toHaveLength(2);
    expect(handler.deliveries).toHaveLength(1);
  });
  it('supports retryable failure followed by success', async () => {
    const handler = new FakeOutboxHandler([
      new OutboxDeliveryError('provider_unavailable'),
      'success',
    ]);
    await expect(handler.handle(message, active)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    await handler.handle({ ...message, attempt: 2 }, active);
    expect(handler.deliveries).toHaveLength(1);
  });
  it('supports permanent failure and empty plans explicitly', async () => {
    await expect(
      new FakeOutboxHandler([new OutboxDeliveryError('provider_rejected', false)]).handle(
        message,
        active,
      ),
    ).rejects.toMatchObject({ retryable: false });
    await expect(new FakeOutboxHandler([]).handle(message, active)).rejects.toThrow(
      'provider_unavailable',
    );
  });
  it('checks cancellation before any attempt/effect', async () => {
    const handler = new FakeOutboxHandler();
    await expect(
      handler.handle(message, {
        ...active,
        aborted: true,
        throwIfAborted: () => {
          throw new Error('aborted');
        },
      }),
    ).rejects.toThrow('aborted');
    expect(handler.calls).toHaveLength(0);
  });
  it.each([1, 2, 3, 4, 5])('calculates backoff after attempt %s', (attempt) =>
    expect(outboxRetryDelay(attempt)).toBe(60_000 * 2 ** (attempt - 1)),
  );
  it.each([0, -1, 1.5, 6, NaN, Infinity])('rejects invalid attempt %s', (attempt) =>
    expect(() => outboxRetryDelay(attempt)).toThrow(RangeError),
  );
  it('caps attempts at five and does not accept arbitrary error text', () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
    expect(new OutboxDeliveryError('invalid_payload', false).message).toBe('invalid_payload');
  });
});
