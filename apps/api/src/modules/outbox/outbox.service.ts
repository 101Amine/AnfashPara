// apps/api/src/modules/outbox/outbox.service.ts
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_TOPICS,
  OutboxDeliveryError,
  outboxRetryDelay,
  type OutboxHandler,
  type OutboxMessage,
} from '@para/core';
import { z } from 'zod';

const STORE = 'para-main';
// Two scan/cleanup queries + two per attempted job = at most 22 D1 queries.
// Leave headroom within the free-plan 50-query invocation budget.
export const OUTBOX_BATCH_SIZE = 10;
export const OUTBOX_LEASE_MS = 5 * 60_000;
export const OUTBOX_HANDLER_TIMEOUT_MS = 30_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const messageSchema = z
  .object({
    id: uuid,
    storeId: z.literal(STORE),
    topic: z.enum(OUTBOX_TOPICS),
    aggregateId: uuid,
    aggregateType: z.enum(['order', 'shipment']),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string(),
    attempt: z.number().int().min(1).max(OUTBOX_MAX_ATTEMPTS),
  })
  .refine((message) =>
    message.topic === 'shipment.status'
      ? message.aggregateType === 'shipment' && message.payload.shipmentId === message.aggregateId
      : message.aggregateType === 'order' && message.payload.orderId === message.aggregateId,
  );

type OutboxRow = {
  id: string;
  store_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  attempts: number;
  claim_token: string;
};
export interface OutboxSummary {
  processed: number;
  failed: number;
  skipped: number;
}
export interface OutboxLog {
  event: 'outbox_dispatch';
  topic: string;
  aggregateId: string;
  attempt: number;
  result: 'done' | 'retry' | 'terminal' | 'claim_lost' | 'persistence_failed';
  error?: string;
}
export type OutboxProcessorOptions = {
  now?: () => Date;
  batchSize?: number;
  logger?: (entry: OutboxLog) => void;
};
const due = `((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
  OR (status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
  OR (status='processing' AND (next_attempt_at IS NULL OR next_attempt_at<=?)))`;

class AttemptTimeout extends Error {}
function failure(error: unknown) {
  if (error instanceof AttemptTimeout) return { code: 'handler_timeout', retryable: true };
  if (
    error instanceof OutboxDeliveryError &&
    ['provider_unavailable', 'provider_rejected', 'unsupported_topic', 'invalid_payload'].includes(
      error.code,
    )
  )
    return { code: error.code, retryable: error.retryable !== false };
  return { code: 'delivery_failed', retryable: true };
}
function decode(row: OutboxRow): OutboxMessage {
  if (new TextEncoder().encode(row.payload_json).byteLength > 64 * 1024)
    throw new OutboxDeliveryError('invalid_payload', false);
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new OutboxDeliveryError('invalid_payload', false);
  }
  if (!OUTBOX_TOPICS.some((topic) => topic === row.topic))
    throw new OutboxDeliveryError('unsupported_topic', false);
  const parsed = messageSchema.safeParse({
    id: row.id,
    storeId: row.store_id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload,
    idempotencyKey: `outbox:${row.store_id}:${row.id}`,
    attempt: row.attempts,
  });
  if (!parsed.success) throw new OutboxDeliveryError('invalid_payload', false);
  return parsed.data;
}
async function deliver(handler: OutboxHandler, message: OutboxMessage): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handler.handle(message, {
        get aborted() {
          return controller.signal.aborted;
        },
        throwIfAborted: () => controller.signal.throwIfAborted(),
        onAbort: (callback) => {
          if (controller.signal.aborted) {
            callback();
            return () => undefined;
          }
          controller.signal.addEventListener('abort', callback, { once: true });
          return () => controller.signal.removeEventListener('abort', callback);
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AttemptTimeout());
        }, OUTBOX_HANDLER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** At-least-once delivery with conditional, token-fenced leases. No HTTP/framework dependency. */
export async function processOutbox(
  database: D1Database,
  handler: OutboxHandler,
  options: OutboxProcessorOptions = {},
): Promise<OutboxSummary> {
  const batchSize = options.batchSize ?? OUTBOX_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > OUTBOX_BATCH_SIZE)
    throw new RangeError('Outbox batch must be 1..10.');
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? ((entry) => console.info(JSON.stringify(entry)));
  // Even malformed metadata never allows secrets/customer data into logs; logger failures must not change delivery.
  const log = (row: OutboxRow, result: OutboxLog['result'], error?: string) => {
    try {
      logger({
        event: 'outbox_dispatch',
        topic: OUTBOX_TOPICS.some((t) => t === row.topic) ? row.topic : 'unknown_topic',
        aggregateId: uuid.safeParse(row.aggregate_id).success
          ? row.aggregate_id
          : 'invalid_aggregate',
        attempt: row.attempts,
        result,
        ...(error ? { error } : {}),
      });
    } catch {
      /* Observability cannot redeliver a completed job. */
    }
  };
  const summary: OutboxSummary = { processed: 0, failed: 0, skipped: 0 };
  const timestamp = now().toISOString();
  // Recover a crashed fifth/final attempt without allowing an unbounded cleanup query.
  const exhausted = await database
    .prepare(
      `UPDATE outbox SET status='failed',claim_token=NULL,next_attempt_at=NULL,
    last_error='attempts_exhausted',updated_at=? WHERE id IN
    (SELECT id FROM outbox WHERE store_id=? AND status IN ('pending','failed','processing') AND attempts>=?
      AND ${due} ORDER BY COALESCE(next_attempt_at,created_at),id LIMIT ?)
    RETURNING id,store_id,topic,aggregate_type,aggregate_id,payload_json,attempts,claim_token`,
    )
    .bind(timestamp, STORE, OUTBOX_MAX_ATTEMPTS, timestamp, timestamp, timestamp, batchSize)
    .all<OutboxRow>();
  for (const row of exhausted.results) {
    summary.failed++;
    log(row, 'terminal', 'attempts_exhausted');
  }
  const capacity = batchSize - exhausted.results.length;
  if (capacity === 0) return summary;
  const candidates = await database
    .prepare(
      `SELECT id FROM outbox WHERE store_id=? AND attempts<? AND ${due}
    ORDER BY COALESCE(next_attempt_at,created_at),id LIMIT ?`,
    )
    .bind(STORE, OUTBOX_MAX_ATTEMPTS, timestamp, timestamp, timestamp, capacity)
    .all<{ id: string }>();
  for (const candidate of candidates.results) {
    const claimedAt = now().toISOString();
    const token = crypto.randomUUID();
    let row: OutboxRow | null;
    try {
      // Eligibility is rechecked atomically at write time, not inferred from the earlier SELECT.
      row = await database
        .prepare(
          `UPDATE outbox SET status='processing',attempts=attempts+1,claim_token=?,
        next_attempt_at=?,updated_at=?,processed_at=NULL WHERE id=? AND store_id=? AND attempts<? AND ${due}
        RETURNING id,store_id,topic,aggregate_type,aggregate_id,payload_json,attempts,claim_token`,
        )
        .bind(
          token,
          new Date(now().getTime() + OUTBOX_LEASE_MS).toISOString(),
          claimedAt,
          candidate.id,
          STORE,
          OUTBOX_MAX_ATTEMPTS,
          claimedAt,
          claimedAt,
          claimedAt,
        )
        .first<OutboxRow>();
    } catch {
      summary.failed++;
      continue;
    }
    if (!row) {
      summary.skipped++;
      continue;
    }
    let deliveryError: ReturnType<typeof failure> | null = null;
    try {
      await deliver(handler, decode(row));
    } catch (error) {
      deliveryError = failure(error);
    }
    const completedAt = now();
    const terminal =
      deliveryError !== null && (!deliveryError.retryable || row.attempts >= OUTBOX_MAX_ATTEMPTS);
    const result: OutboxLog['result'] =
      deliveryError === null ? 'done' : terminal ? 'terminal' : 'retry';
    try {
      const updated = await database
        .prepare(
          `UPDATE outbox SET status=?,claim_token=NULL,next_attempt_at=?,last_error=?,
        processed_at=?,updated_at=? WHERE id=? AND store_id=? AND status='processing' AND claim_token=? AND next_attempt_at>?`,
        )
        .bind(
          deliveryError === null ? 'done' : 'failed',
          deliveryError === null || terminal
            ? null
            : new Date(completedAt.getTime() + outboxRetryDelay(row.attempts)).toISOString(),
          deliveryError?.code ?? null,
          deliveryError === null ? completedAt.toISOString() : null,
          completedAt.toISOString(),
          row.id,
          STORE,
          token,
          completedAt.toISOString(),
        )
        .run();
      if (updated.meta.changes === 0) {
        summary.skipped++;
        log(row, 'claim_lost');
      } else {
        if (deliveryError) summary.failed++;
        else summary.processed++;
        log(row, result, deliveryError?.code);
      }
    } catch {
      summary.failed++;
      log(row, 'persistence_failed', 'persistence_failed');
    }
  }
  return summary;
}
