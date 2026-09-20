// packages/core/src/orderStateMachine.ts
export const ORDER_STATUSES = [
  'NEW',
  'CONFIRMING',
  'NO_ANSWER',
  'CONFIRMED',
  'CANCELLED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'REFUSED',
  'RETURNED',
  'SETTLED',
] as const;

export type Status = (typeof ORDER_STATUSES)[number];
export type Actor = 'system' | 'reconciliation' | `courier:${string}` | `user:${string}`;
export type ActorKind = 'system' | 'courier' | 'user' | 'reconciliation';

export interface Order {
  readonly id: string;
  readonly status: Status;
  readonly noAnswerAttempts: number;
}

export interface OrderEvent {
  readonly orderId: string;
  readonly fromStatus: Status;
  readonly toStatus: Status;
  readonly actor: Actor;
  readonly reason?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface TransitionContext {
  readonly actor: Actor;
  readonly reason?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface TransitionResult {
  readonly next: Order;
  readonly event: OrderEvent;
}

type ActorGuardTable = Readonly<
  Record<Status, Readonly<Partial<Record<Status, readonly ActorKind[]>>>>
>;

export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  NEW: ['CONFIRMING'],
  CONFIRMING: ['NO_ANSWER', 'CONFIRMED', 'CANCELLED'],
  NO_ANSWER: ['NO_ANSWER', 'CANCELLED'],
  CONFIRMED: ['PACKED'],
  CANCELLED: [],
  PACKED: ['SHIPPED'],
  SHIPPED: ['DELIVERED', 'REFUSED'],
  DELIVERED: ['SETTLED'],
  REFUSED: ['RETURNED'],
  RETURNED: [],
  SETTLED: [],
};

export const ACTOR_GUARDS: ActorGuardTable = {
  NEW: { CONFIRMING: ['system'] },
  CONFIRMING: {
    NO_ANSWER: ['user', 'system'],
    CONFIRMED: ['user', 'system'],
    CANCELLED: ['user', 'system'],
  },
  NO_ANSWER: {
    NO_ANSWER: ['user', 'system'],
    CANCELLED: ['user', 'system'],
  },
  CONFIRMED: { PACKED: ['user', 'system'] },
  CANCELLED: {},
  PACKED: { SHIPPED: ['courier', 'system', 'user'] },
  SHIPPED: {
    DELIVERED: ['courier', 'system'],
    REFUSED: ['courier', 'system'],
  },
  DELIVERED: { SETTLED: ['reconciliation'] },
  REFUSED: { RETURNED: ['courier', 'system', 'user'] },
  RETURNED: {},
  SETTLED: {},
};

export class IllegalTransition extends Error {
  readonly from: Status;
  readonly to: Status;

  constructor(from: Status, to: Status) {
    super(`Illegal order transition: ${from} → ${to}.`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
  }
}

export class UnauthorizedActor extends Error {
  readonly actor: Actor;
  readonly from: Status;
  readonly to: Status;

  constructor(actor: Actor, from: Status, to: Status) {
    super(`Actor ${actor} cannot transition an order from ${from} to ${to}.`);
    this.name = 'UnauthorizedActor';
    this.actor = actor;
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(order: Order, to: Status, context: TransitionContext): TransitionResult {
  if (!canTransition(order.status, to)) {
    throw new IllegalTransition(order.status, to);
  }

  const allowedActors = ACTOR_GUARDS[order.status][to]!;
  const actorKind = getActorKind(context.actor);

  if (actorKind === null || !allowedActors.includes(actorKind)) {
    throw new UnauthorizedActor(context.actor, order.status, to);
  }

  const noAnswerAttempts = to === 'NO_ANSWER' ? order.noAnswerAttempts + 1 : order.noAnswerAttempts;
  const autoCancelled = to === 'NO_ANSWER' && noAnswerAttempts >= 3;
  const nextStatus: Status = autoCancelled ? 'CANCELLED' : to;
  const reason = autoCancelled ? 'no_answer' : context.reason;

  const next: Order = {
    ...order,
    noAnswerAttempts,
    status: nextStatus,
  };
  const event: OrderEvent = {
    actor: context.actor,
    fromStatus: order.status,
    orderId: order.id,
    toStatus: nextStatus,
    ...(reason === undefined ? {} : { reason }),
    ...(context.payload === undefined ? {} : { payload: context.payload }),
  };

  return { event, next };
}

function getActorKind(actor: Actor): ActorKind | null {
  if (actor === 'system' || actor === 'reconciliation') return actor;
  if (actor.startsWith('courier:') && actor.length > 'courier:'.length) return 'courier';
  if (actor.startsWith('user:') && actor.length > 'user:'.length) return 'user';
  return null;
}
