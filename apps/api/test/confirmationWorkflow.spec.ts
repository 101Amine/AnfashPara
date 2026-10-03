// apps/api/test/confirmationWorkflow.spec.ts
import { env } from 'cloudflare:test';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';

const ORDER_ID = '01995f0d-9b4d-7000-8000-000000000001';
const authenticatedAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', {
    email: 'admin@anfashpara.test',
    subject: 'admin-subject',
  });
  await next();
};

const bindings = (): AppBindings => ({ ...env });

beforeEach(async () => {
  if (!env.DB) throw new Error('The test D1 binding is missing');

  for (const statement of [
    'DROP TABLE IF EXISTS shipments',
    'DROP TABLE IF EXISTS confirmation_attempts',
    'DROP TABLE IF EXISTS order_events',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    `CREATE TABLE customers (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      name TEXT,
      city TEXT
    )`,
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_number TEXT,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cod_amount_centimes INTEGER NOT NULL,
      city TEXT,
      placed_at TEXT NOT NULL,
      confirmed_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE confirmation_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      outcome TEXT NOT NULL,
      attempted_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE shipments (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      label_url TEXT,
      tracking_number TEXT
    )`,
  ]) {
    await env.DB.prepare(statement).run();
  }

  const timestamp = '2026-10-03T10:00:00.000Z';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)').bind(
      'customer-1',
      'para-main',
      '+212612345678',
      'Salma Test',
      'Rabat',
    ),
    env.DB.prepare(
      `INSERT INTO orders
          (id, store_id, order_number, customer_id, status, cod_amount_centimes, city,
           placed_at, confirmed_at, closed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(
      ORDER_ID,
      'para-main',
      'PARA-101',
      'customer-1',
      'CONFIRMING',
      24_500,
      'Rabat',
      timestamp,
      timestamp,
    ),
  ]);
});

describe('confirmation workflow', () => {
  it('renders all actions and a normalized WhatsApp confirmation link', async () => {
    const response = await requestAdmin('/admin/orders');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('>Confirmé</button>');
    expect(body).toContain('>Pas de réponse</button>');
    expect(body).toContain('>Annulé</button>');
    expect(body).toContain('>Rappeler</button>');
    expect(body).toContain('https://wa.me/212612345678?text=');
    expect(decodeWhatsAppMessage(body)).toContain('commande n°PARA-101');
    expect(decodeWhatsAppMessage(body)).toContain('Salam');
  });

  it('confirms an order and writes its attempt and event atomically', async () => {
    const response = await postAction('confirmed', 'whatsapp');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/orders');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');

    const order = await env.DB.prepare('SELECT status, confirmed_at FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ confirmed_at: string | null; status: string }>();
    const attempt = await env.DB.prepare(
      'SELECT channel, outcome, attempted_by FROM confirmation_attempts WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<{ attempted_by: string; channel: string; outcome: string }>();
    const event = await env.DB.prepare(
      'SELECT from_status, to_status, actor, reason FROM order_events WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<{ actor: string; from_status: string; reason: string; to_status: string }>();

    expect(order?.status).toBe('CONFIRMED');
    expect(order?.confirmed_at).not.toBeNull();
    expect(attempt).toEqual({
      attempted_by: 'user:admin@anfashpara.test',
      channel: 'whatsapp',
      outcome: 'confirmed',
    });
    expect(event).toEqual({
      actor: 'user:admin@anfashpara.test',
      from_status: 'CONFIRMING',
      reason: 'customer_confirmed',
      to_status: 'CONFIRMED',
    });
  });

  it('cancels with no_answer on the third missed contact', async () => {
    expect((await postAction('no_answer')).status).toBe(303);
    expect((await postAction('no_answer')).status).toBe(303);
    expect((await postAction('no_answer')).status).toBe(303);

    const order = await env.DB.prepare('SELECT status, closed_at FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ closed_at: string | null; status: string }>();
    const attempts = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM confirmation_attempts
       WHERE order_id = ? AND outcome = 'no_answer'`,
    )
      .bind(ORDER_ID)
      .first<{ count: number }>();
    const finalEvent = await env.DB.prepare(
      'SELECT from_status, to_status, reason FROM order_events WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    )
      .bind(ORDER_ID)
      .first<{ from_status: string; reason: string; to_status: string }>();

    expect(order?.status).toBe('CANCELLED');
    expect(order?.closed_at).not.toBeNull();
    expect(attempts?.count).toBe(3);
    expect(finalEvent).toEqual({
      from_status: 'NO_ANSWER',
      reason: 'no_answer',
      to_status: 'CANCELLED',
    });
  });

  it('records a callback without changing the status', async () => {
    expect((await postAction('callback')).status).toBe(303);

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>();
    const attempt = await env.DB.prepare(
      'SELECT outcome FROM confirmation_attempts WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<{ outcome: string }>();
    const event = await env.DB.prepare(
      'SELECT from_status, to_status, reason FROM order_events WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<{ from_status: string; reason: string; to_status: string }>();

    expect(order?.status).toBe('CONFIRMING');
    expect(attempt?.outcome).toBe('callback');
    expect(event).toEqual({
      from_status: 'CONFIRMING',
      reason: 'callback_requested',
      to_status: 'CONFIRMING',
    });
  });

  it('returns a controlled conflict for an illegal transition', async () => {
    await env.DB.prepare("UPDATE orders SET status = 'PACKED' WHERE id = ?").bind(ORDER_ID).run();

    const response = await postAction('confirmed');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'illegal_transition',
        message: "Cette action n'est plus autorisée pour ce statut.",
      },
    });
    expect(await countAttempts()).toBe(0);
  });

  it('returns a controlled forbidden response for an unauthorized actor', async () => {
    const invalidIdentity: MiddlewareHandler<AppEnvironment> = async (context, next) => {
      context.set('accessIdentity', { email: '', subject: 'invalid-subject' });
      await next();
    };
    const response = await postAction('confirmed', 'call', invalidIdentity);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'unauthorized_actor', message: 'Action non autorisée.' },
    });
    expect(await countAttempts()).toBe(0);
  });

  it('rolls back the status and attempt when the event write fails', async () => {
    await env.DB.prepare('DROP TABLE order_events').run();

    const response = await postAction('confirmed');
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>();

    expect(response.status).toBe(503);
    expect(order?.status).toBe('CONFIRMING');
    expect(await countAttempts()).toBe(0);
  });

  it('is protected by the same Access middleware as the admin queue', async () => {
    const denied: MiddlewareHandler<AppEnvironment> = (context) =>
      context.json({ error: 'unauthorized' }, 401);
    const response = await postAction('confirmed', 'call', denied);

    expect(response.status).toBe(401);
    expect(await countAttempts()).toBe(0);
  });
});

async function requestAdmin(path: string): Promise<Response> {
  return createApp(authenticatedAccess).request(
    `https://example.com${path}`,
    undefined,
    bindings(),
  );
}

async function postAction(
  action: 'callback' | 'cancelled' | 'confirmed' | 'no_answer',
  channel: 'call' | 'whatsapp' = 'call',
  accessMiddleware = authenticatedAccess,
): Promise<Response> {
  return createApp(accessMiddleware).request(
    `https://example.com/admin/orders/${ORDER_ID}/confirmation`,
    {
      body: new URLSearchParams({ action, channel }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    bindings(),
  );
}

async function countAttempts(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM confirmation_attempts').first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

function decodeWhatsAppMessage(body: string): string {
  const match = /href="(https:\/\/wa\.me\/212612345678\?text=[^"]+)"/u.exec(body);
  if (match?.[1] === undefined) throw new Error('WhatsApp link not found');
  const escapedUrl = match[1].replaceAll('&amp;', '&');
  return new URL(escapedUrl).searchParams.get('text') ?? '';
}
