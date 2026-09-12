import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

const resetDatabase = async (): Promise<void> => {
  if (!env.DB) {
    throw new Error('The test D1 binding is missing');
  }

  const statements = [
    'DROP TABLE IF EXISTS products',
    'DROP TABLE IF EXISTS settings',
    `CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      price_centimes INTEGER NOT NULL,
      active INTEGER DEFAULT 1 NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE settings (
      store_id TEXT PRIMARY KEY NOT NULL,
      currency TEXT NOT NULL,
      locale TEXT NOT NULL,
      timezone TEXT NOT NULL,
      minimum_order_centimes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO settings VALUES (
      'para-main', 'MAD', 'fr-MA', 'Africa/Casablanca', 15000,
      '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
    )`,
    `INSERT INTO products VALUES
      (
        'active-product', 'para-main', 'active-product', 'Active product', 8900, 1,
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
      ),
      (
        'inactive-product', 'para-main', 'inactive-product', 'Inactive product', 9900, 0,
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
      ),
      (
        'other-store-product', 'other-store', 'other-store-product', 'Other store product', 10900, 1,
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
      )`,
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
};

beforeEach(resetDatabase);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API routes', () => {
  it('reports a healthy local deployment', async () => {
    const response = await SELF.fetch('https://example.com/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      db: 'ok',
      environment: 'local',
      status: 'ok',
    });
  });

  it('reports a database failure without leaking its error message', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      {
        ENVIRONMENT: 'local',
        GIT_SHA: 'uncommitted',
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      db: 'error',
      environment: 'local',
      status: 'error',
    });
    expect(body).not.toContain('binding');
    expect(body).not.toContain('D1');
  });

  it('returns only active products for the current store', async () => {
    const response = await SELF.fetch('https://example.com/api/products');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          id: 'active-product',
          name: 'Active product',
          priceCentimes: 8900,
          slug: 'active-product',
        },
      ],
    });
  });

  it('returns settings for the current store', async () => {
    const response = await SELF.fetch('https://example.com/api/settings');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    await expect(response.json()).resolves.toEqual({
      settings: {
        currency: 'MAD',
        locale: 'fr-MA',
        minimumOrderCentimes: 15000,
        timezone: 'Africa/Casablanca',
      },
    });
  });

  it('reports the configured git SHA', async () => {
    const response = await SELF.fetch('https://example.com/api/version');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ gitSha: 'uncommitted' });
  });

  it('adds basic security and cache headers', async () => {
    const response = await SELF.fetch('https://example.com/api/health');

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('returns JSON for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });
});

describe('scheduled handler', () => {
  it('logs cron execution metadata', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = createScheduledController({
      cron: '0 * * * *',
      scheduledTime: Date.UTC(2026, 8, 12, 12),
    });
    const ctx = createExecutionContext();

    worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        cron: '0 * * * *',
        environment: 'local',
        event: 'scheduled',
        gitSha: 'uncommitted',
        scheduledTime: '2026-09-12T12:00:00.000Z',
      }),
    );
  });
});
