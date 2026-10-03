// apps/api/src/modules/confirmation/confirmation.service.ts
import { ORDER_STATUSES, UnauthorizedActor, transition, type Actor, type Status } from '@para/core';
import { z } from 'zod';

import { createUuidV7 } from '../../shared/uuidV7';
import type { ConfirmationAction } from './confirmation.schema';

const STORE_ID = 'para-main';
const statusSchema = z.enum(ORDER_STATUSES);

type ConfirmationOrderRow = {
  id: string;
  status: string;
};

type AttemptCountRow = {
  count: number;
};

export type PerformConfirmationActionInput = ConfirmationAction & {
  actor: Actor;
  orderId: string;
};

export type ConfirmationActionResult = {
  status: Status;
};

export class ConfirmationOrderNotFoundError extends Error {
  constructor() {
    super('Confirmation order not found');
    this.name = 'ConfirmationOrderNotFoundError';
  }
}

export async function performConfirmationAction(
  database: D1Database,
  input: PerformConfirmationActionInput,
  now = new Date(),
): Promise<ConfirmationActionResult> {
  const order = await database
    .prepare('SELECT id, status FROM orders WHERE id = ? AND store_id = ? LIMIT 1')
    .bind(input.orderId, STORE_ID)
    .first<ConfirmationOrderRow>();

  if (order === null) throw new ConfirmationOrderNotFoundError();

  const currentStatus = statusSchema.parse(order.status);
  const attemptedBy = input.actor;
  const timestamp = now.toISOString();

  if (input.action === 'callback') {
    assertAdminActor(attemptedBy, currentStatus);
    await database.batch([
      buildAttemptStatement(database, input, attemptedBy, timestamp),
      database
        .prepare(
          `INSERT INTO order_events
            (id, store_id, order_id, from_status, to_status, actor, reason, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          createUuidV7(now.getTime()),
          STORE_ID,
          order.id,
          currentStatus,
          currentStatus,
          attemptedBy,
          'callback_requested',
          JSON.stringify({ channel: input.channel }),
          timestamp,
        ),
    ]);
    return { status: currentStatus };
  }

  const noAnswerAttempts = await countNoAnswerAttempts(database, order.id);
  const targetStatus = getTargetStatus(input.action);
  const result = transition(
    { id: order.id, noAnswerAttempts, status: currentStatus },
    targetStatus,
    {
      actor: attemptedBy,
      payload: { channel: input.channel },
      reason: getTransitionReason(input.action),
    },
  );

  await database.batch([
    database
      .prepare(
        `UPDATE orders
         SET status = ?,
             confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN ? ELSE confirmed_at END,
             closed_at = CASE WHEN ? = 'CANCELLED' THEN ? ELSE closed_at END,
             updated_at = ?
         WHERE id = ? AND store_id = ?`,
      )
      .bind(
        result.next.status,
        result.next.status,
        timestamp,
        result.next.status,
        timestamp,
        timestamp,
        order.id,
        STORE_ID,
      ),
    buildAttemptStatement(database, input, attemptedBy, timestamp),
    database
      .prepare(
        `INSERT INTO order_events
          (id, store_id, order_id, from_status, to_status, actor, reason, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createUuidV7(now.getTime()),
        STORE_ID,
        order.id,
        result.event.fromStatus,
        result.event.toStatus,
        result.event.actor,
        result.event.reason ?? null,
        JSON.stringify(result.event.payload ?? {}),
        timestamp,
      ),
  ]);

  return { status: result.next.status };
}

function buildAttemptStatement(
  database: D1Database,
  input: PerformConfirmationActionInput,
  attemptedBy: Actor,
  timestamp: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO confirmation_attempts
        (id, store_id, order_id, channel, outcome, attempted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      createUuidV7(new Date(timestamp).getTime()),
      STORE_ID,
      input.orderId,
      input.channel,
      input.action,
      attemptedBy,
      timestamp,
    );
}

async function countNoAnswerAttempts(database: D1Database, orderId: string): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM confirmation_attempts
       WHERE store_id = ? AND order_id = ? AND outcome = 'no_answer'`,
    )
    .bind(STORE_ID, orderId)
    .first<AttemptCountRow>();
  return row?.count ?? 0;
}

function getTargetStatus(action: Exclude<ConfirmationAction['action'], 'callback'>): Status {
  if (action === 'confirmed') return 'CONFIRMED';
  if (action === 'no_answer') return 'NO_ANSWER';
  return 'CANCELLED';
}

function getTransitionReason(action: Exclude<ConfirmationAction['action'], 'callback'>): string {
  if (action === 'confirmed') return 'customer_confirmed';
  if (action === 'no_answer') return 'no_answer';
  return 'customer_cancelled';
}

function assertAdminActor(actor: Actor, status: Status): void {
  if (!actor.startsWith('user:') || actor.length === 'user:'.length) {
    throw new UnauthorizedActor(actor, status, status);
  }
}
