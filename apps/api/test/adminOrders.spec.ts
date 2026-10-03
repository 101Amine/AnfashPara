// apps/api/test/adminOrders.spec.ts
import { env } from 'cloudflare:test';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import { formatSlaAge } from '../src/modules/admin-orders/adminOrders.presenter';

const authenticatedAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', {
    email: 'admin@anfashpara.test',
    subject: 'admin-subject',
  });
  await next();
};

const bindings = (): AppBindings => ({ ...env });

const resetDatabase = async (): Promise<void> => {
  if (!env.DB) throw new Error('The test D1 binding is missing');

  const statements = [
    'DROP TABLE IF EXISTS shipments',
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
      external_id TEXT NOT NULL,
      order_number TEXT,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cod_amount_centimes INTEGER NOT NULL,
      city TEXT,
      placed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL,
      to_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE shipments (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      label_url TEXT,
      tracking_number TEXT
    )`,
  ];

  for (const statement of statements) await env.DB.prepare(statement).run();

  const statusStartedAt = new Date(Date.now() - 90 * 60_000).toISOString();
  for (let index = 1; index <= 23; index += 1) {
    const suffix = index.toString().padStart(2, '0');
    const customerId = `customer-${suffix}`;
    const orderId = `order-${suffix}`;
    const status = index === 23 ? 'CONFIRMING' : index === 22 ? 'NO_ANSWER' : 'NEW';
    const placedAt = `2026-10-${index.toString().padStart(2, '0')}T10:00:00.000Z`;

    await env.DB.batch([
      env.DB.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)').bind(
        customerId,
        'para-main',
        index === 23 ? '+212612345678' : `+2126000000${suffix}`,
        index === 23 ? 'Salma Recherche' : `Cliente ${suffix}`,
        index === 23 ? 'Rabat' : 'Casablanca',
      ),
      env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        orderId,
        'para-main',
        `external-${suffix}`,
        index === 23 ? 'PARA-SEARCH' : `PARA-${suffix}`,
        customerId,
        status,
        index === 23 ? 24500 : 10000 + index,
        index === 23 ? 'Rabat' : 'Casablanca',
        placedAt,
        placedAt,
      ),
      env.DB.prepare('INSERT INTO order_events VALUES (?, ?, ?, ?)').bind(
        `event-${suffix}`,
        orderId,
        status,
        status === 'CONFIRMING' || status === 'NO_ANSWER' ? statusStartedAt : placedAt,
      ),
    ]);
  }

  await env.DB.prepare(
    'INSERT INTO shipments (id, store_id, order_id, label_url) VALUES (?, ?, ?, ?)',
  )
    .bind(
      '0199b001-2000-7000-8000-000000000023',
      'para-main',
      'order-23',
      'https://labels.example.test/PARA-SEARCH.pdf',
    )
    .run();
};

beforeEach(resetDatabase);

describe('GET /admin/orders', () => {
  it('is behind the /admin Cloudflare Access middleware', async () => {
    const blockedAccess: MiddlewareHandler<AppEnvironment> = (context) =>
      context.json({ error: 'unauthorized' }, 401);
    const response = await createApp(blockedAccess).request(
      'https://example.com/admin/orders',
      undefined,
      bindings(),
    );

    expect(response.status).toBe(401);
  });

  it('renders a private, mobile-friendly French queue with SLA ages', async () => {
    const response = await requestAdminOrders('/admin/orders?status=CONFIRMING');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(body).toContain('<html lang="fr">');
    expect(body).toContain('name="viewport"');
    expect(body).toContain('File des commandes');
    expect(body).toContain('PARA-SEARCH');
    expect(body).toContain('+212612345678');
    expect(body).toContain('SLA · 1 h 30 min');
    expect(body).toContain('Imprimer les étiquettes sélectionnées');
    expect(body).toContain('name="shipmentId"');
    expect(body).toContain('/admin/shipments/0199b001-2000-7000-8000-000000000023/label');
    expect(body).toContain('@media (max-width: 720px)');
    expect((body.match(/ selected/gu) ?? []).length).toBe(1);
    expect(body).not.toContain('PARA-22');
  });

  it('searches by formatted Moroccan phone or order number', async () => {
    const phoneResponse = await requestAdminOrders('/admin/orders?q=06+12+34');
    const phoneBody = await phoneResponse.text();
    expect(phoneBody).toContain('PARA-SEARCH');
    expect(phoneBody).not.toContain('PARA-22');

    const numberResponse = await requestAdminOrders('/admin/orders?q=PARA-SEARCH');
    expect(await numberResponse.text()).toContain('Salma Recherche');
  });

  it('paginates with a stable placed-at and ID cursor', async () => {
    const firstResponse = await requestAdminOrders('/admin/orders');
    const firstBody = await firstResponse.text();
    expect(firstBody).toContain('20 commande(s) sur cette page');
    expect(firstBody).toContain('Page suivante');
    expect(firstBody).toContain('PARA-SEARCH');
    expect(firstBody).toContain('class="status CONFIRMING"');

    const nextUrl = extractNextUrl(firstBody);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)').bind(
        'customer-new',
        'para-main',
        '+212699999999',
        'Nouvelle cliente',
        'Rabat',
      ),
      env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        'order-new',
        'para-main',
        'external-new',
        'PARA-NEWER',
        'customer-new',
        'NEW',
        10000,
        'Rabat',
        '2026-10-31T10:00:00.000Z',
        '2026-10-31T10:00:00.000Z',
      ),
    ]);

    const secondResponse = await requestAdminOrders(nextUrl);
    const secondBody = await secondResponse.text();
    expect(secondBody).toContain('3 commande(s) sur cette page');
    expect(secondBody).toContain('PARA-03');
    expect(secondBody).toContain('PARA-01');
    expect(secondBody).not.toContain('PARA-NEWER');
    expect(secondBody).not.toContain('PARA-SEARCH');
  });

  it('rejects tampered pagination cursors without exposing customer data', async () => {
    const response = await requestAdminOrders('/admin/orders?cursor=not-a-cursor');
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('Curseur de pagination invalide');
    expect(body).not.toContain('Salma Recherche');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});

describe('SLA age presentation', () => {
  it('only exposes an age for active confirmation statuses', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    expect(formatSlaAge('CONFIRMING', '2026-10-03T10:29:00.000Z', now)).toBe('1 h 31 min');
    expect(formatSlaAge('NO_ANSWER', '2026-10-01T10:00:00.000Z', now)).toBe('2 j 2 h');
    expect(formatSlaAge('CONFIRMED', '2026-10-03T10:29:00.000Z', now)).toBeNull();
  });
});

async function requestAdminOrders(path: string): Promise<Response> {
  return createApp(authenticatedAccess).request(
    `https://example.com${path}`,
    undefined,
    bindings(),
  );
}

function extractNextUrl(body: string): string {
  const match = /<a class="next" href="([^"]+)">Page suivante<\/a>/u.exec(body);
  if (match?.[1] === undefined) throw new Error('Next page link not found');
  return match[1].replaceAll('&amp;', '&');
}
