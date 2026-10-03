// apps/api/test/labels.spec.ts
import { env } from 'cloudflare:test';
import { unzipSync } from 'fflate';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import { createCourierClientFromBindings } from '../src/integrations/courier/courierClient.factory';
import { createApp } from '../src/index';

const SHIPMENT_ONE = '0199b001-2000-7000-8000-000000000001';
const SHIPMENT_TWO = '0199b001-2000-7000-8000-000000000002';
const SHIPMENT_MISSING = '0199b001-2000-7000-8000-000000000003';

const authenticatedAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', {
    email: 'admin@anfashpara.test',
    subject: 'admin-subject',
  });
  await next();
};

beforeEach(async () => {
  for (const statement of [
    'DROP TABLE IF EXISTS shipments',
    'DROP TABLE IF EXISTS orders',
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_number TEXT
    )`,
    `CREATE TABLE shipments (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      label_url TEXT
    )`,
  ]) {
    await env.DB.prepare(statement).run();
  }

  await env.DB.batch([
    env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?)').bind('order-1', 'para-main', 'PARA-101'),
    env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?)').bind('order-2', 'para-main', 'PARA-102'),
    env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?)').bind('order-3', 'para-main', 'PARA-103'),
    env.DB.prepare('INSERT INTO shipments VALUES (?, ?, ?, ?, ?)').bind(
      SHIPMENT_ONE,
      'para-main',
      'order-1',
      'TRACK-101',
      'https://labels.example.test/label-101.pdf',
    ),
    env.DB.prepare('INSERT INTO shipments VALUES (?, ?, ?, ?, ?)').bind(
      SHIPMENT_TWO,
      'para-main',
      'order-2',
      'TRACK-102',
      'https://labels.example.test/label-102.pdf',
    ),
    env.DB.prepare('INSERT INTO shipments VALUES (?, ?, ?, ?, ?)').bind(
      SHIPMENT_MISSING,
      'para-main',
      'order-3',
      'TRACK-103',
      null,
    ),
  ]);
});

describe('authenticated shipment labels', () => {
  it('blocks label access before any courier file is fetched', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const blockedAccess: MiddlewareHandler<AppEnvironment> = (context) =>
      context.json({ error: 'unauthorized' }, 401);
    const response = await labelApp(blockedAccess, fetcher).request(
      `https://example.com/admin/shipments/${SHIPMENT_ONE}/label`,
      undefined,
      bindings(),
    );

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams one label inline or as an authenticated download', async () => {
    const fetcher = labelFetcher();
    const inline = await requestLabel(`/admin/shipments/${SHIPMENT_ONE}/label`, undefined, fetcher);

    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toBe('application/pdf');
    expect(inline.headers.get('content-disposition')).toBe(
      'inline; filename="etiquette-PARA-101.pdf"',
    );
    expect(inline.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(new TextDecoder().decode(await inline.arrayBuffer())).toContain('label-101.pdf');

    const download = await requestLabel(
      `/admin/shipments/${SHIPMENT_ONE}/label?download=1`,
      undefined,
      fetcher,
    );
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="etiquette-PARA-101.pdf"',
    );
  });

  it('returns a useful error when a shipment has no label', async () => {
    const response = await requestLabel(
      `/admin/shipments/${SHIPMENT_MISSING}/label`,
      undefined,
      labelFetcher(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'label_missing',
        message: 'Étiquette indisponible pour : PARA-103.',
      },
    });
  });

  it('refuses a stored label URL outside the configured HTTPS origins', async () => {
    await env.DB.prepare('UPDATE shipments SET label_url = ? WHERE id = ?')
      .bind('https://untrusted.example.test/label.pdf', SHIPMENT_ONE)
      .run();
    const fetcher = labelFetcher();
    const response = await requestLabel(
      `/admin/shipments/${SHIPMENT_ONE}/label`,
      undefined,
      fetcher,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'label_configuration_unavailable' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders a printable selected batch without exposing courier URLs', async () => {
    const body = selectedLabelsForm();
    const response = await requestLabel(
      '/admin/labels/batch',
      { body, method: 'POST' },
      labelFetcher(),
    );
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain('Imprimer la sélection');
    expect(page).toContain(`/admin/shipments/${SHIPMENT_ONE}/label`);
    expect(page).toContain(`/admin/shipments/${SHIPMENT_TWO}/label`);
    expect(page).not.toContain('labels.example.test');
  });

  it('downloads the selected batch as an uncompressed ZIP', async () => {
    const response = await requestLabel(
      '/admin/labels/batch/download',
      { body: selectedLabelsForm(), method: 'POST' },
      labelFetcher(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('etiquettes-selection.zip');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['01-etiquette-PARA-101.pdf', '02-etiquette-PARA-102.pdf']);
  });

  it('reports every missing label in a selected batch', async () => {
    const form = new FormData();
    form.append('shipmentId', SHIPMENT_ONE);
    form.append('shipmentId', SHIPMENT_MISSING);
    const response = await requestLabel(
      '/admin/labels/batch',
      { body: form, method: 'POST' },
      labelFetcher(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'label_missing', message: 'Étiquette indisponible pour : PARA-103.' },
    });
  });
});

function labelApp(access: MiddlewareHandler<AppEnvironment>, fetcher: typeof fetch) {
  return createApp(access, createCourierClientFromBindings, fetcher);
}

function requestLabel(
  path: string,
  init: RequestInit | undefined,
  fetcher: typeof fetch,
): Promise<Response> {
  return labelApp(authenticatedAccess, fetcher).request(
    `https://example.com${path}`,
    init,
    bindings(),
  );
}

function bindings(): AppBindings {
  return { ...env, COURIER_LABEL_ORIGINS: 'https://labels.example.test' };
}

function labelFetcher(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    return new Response(`PDF fixture for ${url}`, {
      headers: { 'content-type': 'application/pdf' },
    });
  });
}

function selectedLabelsForm(): FormData {
  const form = new FormData();
  form.append('shipmentId', SHIPMENT_ONE);
  form.append('shipmentId', SHIPMENT_TWO);
  return form;
}
