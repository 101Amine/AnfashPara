// packages/core/test/orderStateMachine.test.ts
import { describe, expect, it } from 'vitest';

import {
  ACTOR_GUARDS,
  IllegalTransition,
  ORDER_STATUSES,
  TRANSITIONS,
  UnauthorizedActor,
  canTransition,
  transition,
  type Actor,
  type Order,
  type Status,
} from '../src/orderStateMachine';

const legalEdges = ORDER_STATUSES.flatMap((from) =>
  TRANSITIONS[from].map((to) => ({ expected: 'legal', from, to }) as const),
);

const illegalEdges = ORDER_STATUSES.flatMap((from) =>
  ORDER_STATUSES.filter((to) => !TRANSITIONS[from].includes(to)).map(
    (to) =>
      ({
        expected: 'illegal',
        from,
        to,
      }) as const,
  ),
);

const actorSamples = [
  { actor: 'system', kind: 'system' },
  { actor: 'courier:amana', kind: 'courier' },
  { actor: 'user:admin@example.com', kind: 'user' },
  { actor: 'reconciliation', kind: 'reconciliation' },
] as const satisfies readonly { readonly actor: Actor; readonly kind: string }[];

const actorFor = (from: Status, to: Status): Actor => {
  const actorKind = ACTOR_GUARDS[from][to]?.[0];

  if (actorKind === 'courier') return 'courier:amana';
  if (actorKind === 'user') return 'user:admin@example.com';
  if (actorKind === 'reconciliation') return 'reconciliation';
  return 'system';
};

const orderAt = (status: Status, noAnswerAttempts = 0): Order => ({
  id: '01995f0d-9b4d-7000-8000-000000000001',
  noAnswerAttempts,
  status,
});

describe('order transition table', () => {
  it.each(legalEdges)('$expected: $from → $to', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(illegalEdges)('$expected: $from → $to', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition(orderAt(from), to, { actor: 'system' })).toThrow(IllegalTransition);
  });
});

describe('transition', () => {
  it.each(legalEdges)(
    'returns an immutable next order and event for $from → $to',
    ({ from, to }) => {
      const order = orderAt(from);
      const actor = actorFor(from, to);
      const context = {
        actor,
        payload: { source: 'test' },
        reason: 'test_reason',
      } as const;

      const result = transition(order, to, context);

      expect(result.next).not.toBe(order);
      expect(order.status).toBe(from);
      expect(result.next.status).toBe(to);
      expect(result.event).toEqual({
        actor,
        fromStatus: from,
        orderId: order.id,
        payload: context.payload,
        reason: context.reason,
        toStatus: to,
      });
    },
  );

  it('counts no-answer attempts and cancels the order on the third one', () => {
    const first = transition(orderAt('CONFIRMING'), 'NO_ANSWER', {
      actor: 'user:operator@example.com',
    });
    const second = transition(first.next, 'NO_ANSWER', {
      actor: 'user:operator@example.com',
    });
    const third = transition(second.next, 'NO_ANSWER', {
      actor: 'user:operator@example.com',
      payload: { channel: 'call' },
      reason: 'operator_note',
    });

    expect(first.next).toMatchObject({ noAnswerAttempts: 1, status: 'NO_ANSWER' });
    expect(second.next).toMatchObject({ noAnswerAttempts: 2, status: 'NO_ANSWER' });
    expect(third.next).toMatchObject({ noAnswerAttempts: 3, status: 'CANCELLED' });
    expect(third.event).toMatchObject({
      fromStatus: 'NO_ANSWER',
      payload: { channel: 'call' },
      reason: 'no_answer',
      toStatus: 'CANCELLED',
    });
  });

  it.each([
    ['courier:amana', 'DELIVERED'],
    ['courier:amana', 'REFUSED'],
  ] as const)('allows %s to move a shipped order to %s', (actor, to) => {
    expect(transition(orderAt('SHIPPED'), to, { actor }).next.status).toBe(to);
  });

  it('allows a courier webhook to mark a refused parcel returned', () => {
    expect(transition(orderAt('REFUSED'), 'RETURNED', { actor: 'courier:amana' }).next.status).toBe(
      'RETURNED',
    );
  });

  it.each(['courier:amana', 'system', 'user:admin@example.com'] as const)(
    'prevents %s from setting SETTLED',
    (actor) => {
      expect(() => transition(orderAt('DELIVERED'), 'SETTLED', { actor })).toThrow(
        UnauthorizedActor,
      );
    },
  );

  it('allows only reconciliation to set SETTLED', () => {
    expect(
      transition(orderAt('DELIVERED'), 'SETTLED', { actor: 'reconciliation' }).next.status,
    ).toBe('SETTLED');
  });

  it.each(
    legalEdges.flatMap(({ from, to }) =>
      actorSamples.map(({ actor, kind }) => ({ actor, from, kind, to })),
    ),
  )('enforces actor guard: $kind on $from → $to', ({ actor, from, kind, to }) => {
    const allowed = ACTOR_GUARDS[from][to]?.includes(kind) ?? false;
    const perform = () => transition(orderAt(from), to, { actor });

    if (allowed) {
      expect(perform().next.status).toBe(to);
    } else {
      expect(perform).toThrow(UnauthorizedActor);
    }
  });

  it.each(['courier:', 'user:'] as const)(
    'rejects an actor with an empty identifier: %s',
    (actor) => {
      expect(() => transition(orderAt('SHIPPED'), 'DELIVERED', { actor })).toThrow(
        UnauthorizedActor,
      );
    },
  );

  it('omits optional event fields when they are not supplied', () => {
    const { event } = transition(orderAt('NEW'), 'CONFIRMING', { actor: 'system' });

    expect(event).toEqual({
      actor: 'system',
      fromStatus: 'NEW',
      orderId: '01995f0d-9b4d-7000-8000-000000000001',
      toStatus: 'CONFIRMING',
    });
    expect('reason' in event).toBe(false);
    expect('payload' in event).toBe(false);
  });
});
