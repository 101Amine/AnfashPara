// apps/api/test/outbox.spec.ts
import { env } from 'cloudflare:test';
import { OutboxDeliveryError, type OutboxHandler } from '@para/core';
import { FakeOutboxHandler } from '@para/core/testing';
import type { MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schemaMigration from '../migrations/0002_full_order_schema.sql?raw';
import claimMigration from '../migrations/0006_silent_kulan_gath.sql?raw';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp, runOutboxDispatch, runScheduledTasks } from '../src/index';
import {
  OUTBOX_HANDLER_TIMEOUT_MS,
  OUTBOX_LEASE_MS,
  processOutbox,
  type OutboxLog,
} from '../src/modules/outbox/outbox.service';

const uuid = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;
let current: Date;
const logs: OutboxLog[] = [];
const options = () => ({ now: () => current, logger: (entry: OutboxLog) => logs.push(entry) });
async function insert(
  n = 1,
  changes: Partial<{
    status: string;
    attempts: number;
    next: string | null;
    topic: string;
    payload: unknown;
    store: string;
    token: string | null;
    aggregate: string;
    aggregateType: string;
  }> = {},
) {
  await env.DB.prepare(
    `INSERT INTO outbox(id,store_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,next_attempt_at,last_error,processed_at,created_at,updated_at,claim_token)
    VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`,
  )
    .bind(
      uuid(n),
      changes.store ?? 'para-main',
      changes.topic ?? 'order.confirmation.requested',
      changes.aggregateType ?? 'order',
      changes.aggregate ?? uuid(100),
      JSON.stringify(changes.payload ?? { orderId: uuid(100), secret: 'sensitive-phone-token' }),
      changes.status ?? 'pending',
      changes.attempts ?? 0,
      changes.next ?? null,
      current.toISOString(),
      current.toISOString(),
      changes.token ?? null,
    )
    .run();
}
async function row(n = 1) {
  return (await env.DB.prepare('SELECT * FROM outbox WHERE id=?').bind(uuid(n)).first<{
    status: string;
    attempts: number;
    next_attempt_at: string | null;
    claim_token: string | null;
    last_error: string | null;
    processed_at: string | null;
  }>())!;
}
const advance = (ms: number) => {
  current = new Date(current.getTime() + ms);
};
beforeEach(async () => {
  current = new Date('2026-10-03T12:00:00.000Z');
  logs.length = 0;
  await env.DB.prepare('DROP TABLE IF EXISTS outbox').run();
  // Actual schema SQL with JSON/status/UUID/date CHECKs; test the additive migration too.
  for (const statement of schemaMigration.split('--> statement-breakpoint'))
    if (/CREATE TABLE `outbox`|CREATE (?:UNIQUE )?INDEX `outbox_/u.test(statement))
      await env.DB.prepare(statement).run();
  await env.DB.prepare(claimMigration).run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('leased scheduled outbox processor', () => {
  it('supports shipment topics and rejects aggregate-type mismatches', async () => {
    await insert(1, {
      topic: 'shipment.status',
      aggregateType: 'shipment',
      payload: { shipmentId: uuid(100) },
    });
    await insert(2, { topic: 'shipment.status', payload: { shipmentId: uuid(100) } });
    const handler = new FakeOutboxHandler();
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(handler.calls[0]?.topic).toBe('shipment.status');
  });
  it('preserves existing jobs through additive migration 0006', async () => {
    await env.DB.prepare('ALTER TABLE outbox DROP COLUMN claim_token').run();
    await env.DB.prepare(
      `INSERT INTO outbox(id,store_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,updated_at)
      VALUES (?,'para-main','order.confirmation.requested','order',?,?,'pending',0,?,?)`,
    )
      .bind(
        uuid(1),
        uuid(100),
        JSON.stringify({ orderId: uuid(100) }),
        current.toISOString(),
        current.toISOString(),
      )
      .run();
    await env.DB.prepare(claimMigration).run();
    expect((await row()).claim_token).toBeNull();
    expect((await processOutbox(env.DB, new FakeOutboxHandler(), options())).processed).toBe(1);
  });
  it('rejects oversized payloads without invoking the handler', async () => {
    await insert(1, { payload: { orderId: uuid(100), extra: 'x'.repeat(65536) } });
    const handler = new FakeOutboxHandler();
    expect((await processOutbox(env.DB, handler, options())).failed).toBe(1);
    expect(handler.calls).toHaveLength(0);
    expect((await row()).last_error).toBe('invalid_payload');
  });
  it('delivers once and records done with a stable key and safe metadata', async () => {
    await insert();
    const handler = new FakeOutboxHandler();
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(await row()).toMatchObject({
      status: 'done',
      attempts: 1,
      next_attempt_at: null,
      claim_token: null,
      processed_at: current.toISOString(),
    });
    expect(handler.calls[0]).toMatchObject({
      idempotencyKey: `outbox:para-main:${uuid(1)}`,
      attempt: 1,
    });
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(handler.deliveries).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      topic: 'order.confirmation.requested',
      aggregateId: uuid(100),
      attempt: 1,
      result: 'done',
    });
    expect(JSON.stringify(logs)).not.toContain('sensitive-phone-token');
  });
  it('retries only when due and preserves idempotency key across attempts', async () => {
    await insert();
    const handler = new FakeOutboxHandler([
      new OutboxDeliveryError('provider_unavailable'),
      'success',
    ]);
    expect((await processOutbox(env.DB, handler, options())).failed).toBe(1);
    expect(await row()).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'provider_unavailable',
      next_attempt_at: '2026-10-03T12:01:00.000Z',
    });
    advance(59_999);
    await processOutbox(env.DB, handler, options());
    expect(handler.calls).toHaveLength(1);
    advance(1);
    expect((await processOutbox(env.DB, handler, options())).processed).toBe(1);
    expect(handler.calls[1]?.idempotencyKey).toBe(handler.calls[0]?.idempotencyKey);
  });
  it('uses exponential delays and stops after five attempts', async () => {
    await insert();
    const handler = new FakeOutboxHandler([new OutboxDeliveryError('provider_unavailable')]);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await processOutbox(env.DB, handler, options());
      const stored = await row();
      expect(stored.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(stored.next_attempt_at).toBe(
          new Date(current.getTime() + 60_000 * 2 ** (attempt - 1)).toISOString(),
        );
        advance(60_000 * 2 ** (attempt - 1));
      } else expect(stored.next_attempt_at).toBeNull();
    }
    advance(24 * 60 * 60_000);
    await processOutbox(env.DB, handler, options());
    expect(handler.calls).toHaveLength(5);
    expect(logs.at(-1)?.result).toBe('terminal');
  });
  it('keeps a permanent failure visible without retrying or blocking other jobs', async () => {
    await insert(1);
    await insert(2);
    const handler = new FakeOutboxHandler([
      new OutboxDeliveryError('provider_rejected', false),
      'success',
    ]);
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(await row(1)).toMatchObject({ status: 'failed', attempts: 1, next_attempt_at: null });
    advance(60_000);
    await processOutbox(env.DB, handler, options());
    expect(handler.calls).toHaveLength(2);
  });
  it('isolates unknown topics and malformed payloads as poison rows', async () => {
    await insert(1, { topic: 'secret-token@evil.test' });
    await insert(2, { payload: [] });
    await insert(3, { payload: { orderId: uuid(999) } });
    await insert(4);
    const handler = new FakeOutboxHandler();
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 1,
      failed: 3,
      skipped: 0,
    });
    expect(handler.calls).toHaveLength(1);
    expect(await row(1)).toMatchObject({ last_error: 'unsupported_topic', next_attempt_at: null });
    expect(JSON.stringify(logs)).not.toContain('secret-token');
  });
  it('sanitizes arbitrary thrown errors instead of retaining provider secrets', async () => {
    await insert();
    const handler: OutboxHandler = {
      handle: async () => {
        throw new Error('api_key=secret phone=+212612345678');
      },
    };
    await processOutbox(env.DB, handler, options());
    expect((await row()).last_error).toBe('delivery_failed');
    expect(JSON.stringify(logs)).not.toContain('api_key');
  });
  it('processes no more than 10 jobs, deterministically, and only this store', async () => {
    for (let n = 1; n <= 27; n++) await insert(n);
    await insert(50, { store: 'other-store' });
    const handler = new FakeOutboxHandler();
    expect((await processOutbox(env.DB, handler, options())).processed).toBe(10);
    expect(handler.calls.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, n) => uuid(n + 1)),
    );
    expect((await row(11)).status).toBe('pending');
    expect((await row(50)).attempts).toBe(0);
  });
  it.each([0, -1, 1.5, 11, NaN])(
    'rejects unsafe batch size %s',
    async (batchSize) =>
      await expect(
        processOutbox(env.DB, new FakeOutboxHandler(), { ...options(), batchSize }),
      ).rejects.toThrow(RangeError),
  );
  it('skips future pending/retry rows and active leases', async () => {
    const next = '2026-10-03T12:05:00.000Z';
    await insert(1, { next });
    await insert(2, { status: 'failed', next });
    await insert(3, { status: 'processing', next, token: 'owner' });
    const handler = new FakeOutboxHandler();
    await processOutbox(env.DB, handler, options());
    expect(handler.calls).toHaveLength(0);
  });
  it('never lets concurrent processors both claim a due row', async () => {
    await insert();
    const handler = new FakeOutboxHandler();
    const result = await Promise.all([
      processOutbox(env.DB, handler, options()),
      processOutbox(env.DB, handler, options()),
    ]);
    expect(result.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
    expect(handler.calls).toHaveLength(1);
    expect((await row()).attempts).toBe(1);
  });
  it('recovers expired processing leases, including pre-migration tokenless rows', async () => {
    await insert(1, {
      status: 'processing',
      attempts: 1,
      next: '2026-10-03T11:59:59.000Z',
      token: 'dead-owner',
    });
    await insert(2, { status: 'processing', attempts: 2 });
    const handler = new FakeOutboxHandler();
    expect((await processOutbox(env.DB, handler, options())).processed).toBe(2);
    expect((await row(1)).attempts).toBe(2);
    expect((await row(2)).attempts).toBe(3);
  });
  it('exhausts a crashed final attempt without invoking the handler', async () => {
    await insert(1, {
      status: 'processing',
      attempts: 5,
      next: current.toISOString(),
      token: 'dead',
    });
    await insert(2);
    const handler = new FakeOutboxHandler();
    expect(await processOutbox(env.DB, handler, options())).toEqual({
      processed: 1,
      failed: 1,
      skipped: 0,
    });
    expect((await row(1)).last_error).toBe('attempts_exhausted');
    expect(handler.calls).toHaveLength(1);
  });
  it('fences a stale owner after a lease expires and another worker finishes', async () => {
    await insert();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held: OutboxHandler = {
      handle: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const first = processOutbox(env.DB, held, options());
    await ready;
    advance(OUTBOX_LEASE_MS + 1);
    const second = await processOutbox(env.DB, new FakeOutboxHandler(), options());
    expect(second.processed).toBe(1);
    release();
    expect((await first).skipped).toBe(1);
    expect((await row()).status).toBe('done');
    expect((await row()).attempts).toBe(2);
  });
  it('retains the lease on acknowledgement failure and retries with recipient-side deduplication', async () => {
    await insert();
    await env.DB.prepare(
      "CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'fail acknowledgement'); END",
    ).run();
    const handler = new FakeOutboxHandler();
    expect((await processOutbox(env.DB, handler, options())).failed).toBe(1);
    expect((await row()).status).toBe('processing');
    await env.DB.prepare('DROP TRIGGER fail_ack').run();
    advance(OUTBOX_LEASE_MS + 1);
    expect((await processOutbox(env.DB, handler, options())).processed).toBe(1);
    expect(handler.calls).toHaveLength(2);
    expect(handler.deliveries).toHaveLength(1);
  });
  it('aborts a hung handler after 30 seconds, without waiting out its full lease', async () => {
    vi.useFakeTimers();
    await insert();
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    let cancelled = false;
    const handler: OutboxHandler = {
      handle: async (_, signal) => {
        entered();
        await new Promise<void>((_, reject) => {
          signal.onAbort(() => {
            cancelled = true;
            reject(new Error('aborted'));
          });
        });
      },
    };
    const pending = processOutbox(env.DB, handler, options());
    await ready;
    await vi.advanceTimersByTimeAsync(OUTBOX_HANDLER_TIMEOUT_MS);
    expect((await pending).failed).toBe(1);
    expect(cancelled).toBe(true);
    expect((await row()).last_error).toBe('handler_timeout');
  });
  it('keeps completed jobs done even if logging fails', async () => {
    await insert();
    expect(
      (
        await processOutbox(env.DB, new FakeOutboxHandler(), {
          ...options(),
          logger: () => {
            throw new Error('logger down');
          },
        })
      ).processed,
    ).toBe(1);
    expect((await row()).status).toBe('done');
  });
  it('pauses unconfigured dispatch without losing pending work', async () => {
    await insert();
    expect(await runOutboxDispatch(env)).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      reason: 'handler_unconfigured',
    });
    expect((await row()).attempts).toBe(0);
    expect(await runOutboxDispatch({} as AppEnvironment['Bindings'])).toMatchObject({
      reason: 'database_unavailable',
    });
  });
  it('runs outbox independently of manual or failing shipment polling', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await insert();
    const summary = await runScheduledTasks(
      { ...env, COURIER_MODE: 'http', COURIER_API_URL: 'bad-url' },
      new FakeOutboxHandler(),
    );
    expect(summary.outbox.processed).toBe(1);
    expect(summary.shipmentStatusPoll.reason).toBe('poll_failed');
  });
});

describe('protected outbox monitoring', () => {
  const access: MiddlewareHandler<AppEnvironment> = async (c, next) => {
    c.set('accessIdentity', { email: 'admin@test.example', subject: 'test' });
    await next();
  };
  it('requires Access and never returns payloads, claim tokens or legacy raw errors', async () => {
    await insert(1, { status: 'failed', attempts: 5 });
    await env.DB.prepare("UPDATE outbox SET last_error='api_key=secret' WHERE id=?")
      .bind(uuid(1))
      .run();
    const bindings = {
      ...env,
      CF_ACCESS_AUD: 'test',
      CF_ACCESS_TEAM_DOMAIN: 'anfashpara.cloudflareaccess.com',
    };
    expect(
      (await createApp().request('https://example.com/admin/outbox', undefined, bindings)).status,
    ).toBe(401);
    const response = await createApp(access).request(
      'https://example.com/admin/outbox',
      { headers: { Accept: 'application/json' } },
      env,
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    const text = await response.text();
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('sensitive-phone-token');
    expect(text).not.toContain('claim_token');
    expect(JSON.parse(text).jobs[0].terminal).toBe(true);
    const page = await createApp(access).request(
      'https://example.com/admin/outbox',
      undefined,
      env,
    );
    expect(await page.text()).toContain('Arrêté');
  });
});
