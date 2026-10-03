import { env } from 'cloudflare:test';
import { MAX_SETTLEMENT_FILE_BYTES, MAX_SETTLEMENT_ROWS, SETTLEMENT_COLUMNS } from '@para/core';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';

const endpoint = 'https://example.com/admin/settlements/preview';
const validCsv = `${SETTLEMENT_COLUMNS.join(',')}\nSELF-FICTIONAL,250.00,30.00,0,220.00,delivered`;
const access: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', { email: 'admin@anfashpara.test', subject: 'admin-test' });
  await next();
};

beforeEach(async () => {
  // A real D1 sentinel confirms uploads cannot settle or persist anything.
  for (const sql of [
    'DROP TABLE IF EXISTS settlement_lines',
    'DROP TABLE IF EXISTS courier_settlements',
    'DROP TABLE IF EXISTS orders',
    'CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL)',
    'CREATE TABLE courier_settlements (id TEXT PRIMARY KEY)',
    'CREATE TABLE settlement_lines (id TEXT PRIMARY KEY)',
    "INSERT INTO orders VALUES ('sentinel', 'DELIVERED')",
  ])
    await env.DB.prepare(sql).run();
});

function upload(source: string | Uint8Array = validCsv, filename = 'fictional.csv', json = true) {
  const form = new FormData();
  form.set(
    'file',
    new File([typeof source === 'string' ? source : new Uint8Array(source)], filename, {
      type: 'text/csv',
    }),
  );
  return createApp(access).request(
    endpoint,
    {
      method: 'POST',
      headers: { Accept: json ? 'application/json' : 'text/html', Origin: 'https://example.com' },
      body: form,
    },
    env,
  );
}

describe('protected settlement upload and preview', () => {
  it('requires Access for both the upload page and preview', async () => {
    const bindings: AppBindings = {
      ...env,
      CF_ACCESS_AUD: 'test',
      CF_ACCESS_TEAM_DOMAIN: 'anfashpara.cloudflareaccess.com',
    };
    expect(
      (await createApp().request('https://example.com/admin/settlements', undefined, bindings))
        .status,
    ).toBe(401);
    expect((await createApp().request(endpoint, { method: 'POST' }, bindings)).status).toBe(401);
    expect(
      (
        await createApp().request(
          endpoint,
          { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'forged.token.value' } },
          bindings,
        )
      ).status,
    ).toBe(401);
  });

  it('previews normalized rows and totals privately, leaving D1 untouched', async () => {
    const response = await upload();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Vary')).toContain('Accept');
    expect(await response.json()).toMatchObject({
      valid: true,
      rowCount: 1,
      rows: [{ trackingNumber: 'SELF-FICTIONAL', codCollectedCentimes: 25000 }],
      totals: { netCentimes: 22000 },
    });
    await expect(env.DB.prepare('SELECT status FROM orders').first()).resolves.toEqual({
      status: 'DELIVERED',
    });
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM courier_settlements').first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM settlement_lines').first(),
    ).resolves.toEqual({ count: 0 });
  });

  it('does not need a database binding for a pure preview', async () => {
    const form = new FormData();
    form.set('file', new File([validCsv], 'fictional.csv'));
    const response = await createApp(access).request(
      endpoint,
      { method: 'POST', headers: { Accept: 'application/json' }, body: form },
      {} as AppBindings,
    );
    expect(response.status).toBe(200);
  });

  it('renders a French upload form and accessible mobile preview', async () => {
    const page = await createApp(access).request(
      'https://example.com/admin/settlements',
      undefined,
      env,
    );
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(await page.text()).toContain('enctype="multipart/form-data"');
    const response = await upload(validCsv, 'fictional.csv', false);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Fichier valide.');
    expect(body).toContain('Totaux des lignes valides uniquement');
    expect(body).toContain('name="viewport"');
    expect(body).toContain('SELF-FICTIONAL');
    expect(body).toContain('aucune commande ni donnée financière');
  });

  it('escapes file names, tracking values and raw statuses in HTML', async () => {
    const response = await upload(
      validCsv
        .replace('SELF-FICTIONAL', '<script>alert(1)</script>')
        .replace('delivered', '<img src=x onerror=alert(1)>'),
      '<script>.csv',
      false,
    );
    const body = await response.text();
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;script&gt;');
  });

  it('returns row-level French errors with 422 and excludes invalid rows', async () => {
    const response = await upload(
      validCsv.replace('SELF-FICTIONAL', '').replace('250.00', '250.001'),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({
      valid: false,
      invalidRowCount: 1,
      rows: [],
      errors: [
        { line: 2, column: 'tracking_number', code: 'invalid_text' },
        { line: 2, column: 'cod_collected', code: 'invalid_money' },
      ],
    });
  });

  it('renders structural CSV errors in French without exposing private source data', async () => {
    const response = await upload('tracking_number\nPRIVATE-TRACKING', 'fictional.csv', false);
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('Colonnes manquantes');
    expect(body).not.toContain('PRIVATE-TRACKING');
  });

  it('rejects missing and duplicate columns and unterminated quotes', async () => {
    for (const [source, code] of [
      ['tracking_number\nA', 'missing_columns'],
      [validCsv.replace('courier_status', 'delivery_fee'), 'duplicate_columns'],
      [validCsv.replace('SELF-FICTIONAL', '"unfinished'), 'invalid_csv'],
    ]) {
      const response = await upload(source);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });

  it('enforces file and row limits', async () => {
    expect((await upload('a'.repeat(MAX_SETTLEMENT_FILE_BYTES + 1))).status).toBe(413);
    const tooManyRows = `${SETTLEMENT_COLUMNS.join(',')}\n${Array(MAX_SETTLEMENT_ROWS + 1)
      .fill('A,1,0,0,1,delivered')
      .join('\n')}`;
    expect((await upload(tooManyRows)).status).toBe(422);
  });

  it('bounds streamed multipart bytes even with a false Content-Length', async () => {
    const response = await createApp(access).request(
      endpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'multipart/form-data; boundary=x',
          'Content-Length': '1',
        },
        body: 'x'.repeat(MAX_SETTLEMENT_FILE_BYTES + 64 * 1024 + 1),
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'file_too_large' } });
  });

  it('rejects unsupported files and invalid UTF-8', async () => {
    expect((await upload(validCsv, 'statement.xlsx')).status).toBe(415);
    const badEncoding = await upload(new Uint8Array([0xff, 0xfe]));
    expect(badEncoding.status).toBe(400);
    expect(await badEncoding.json()).toMatchObject({ error: { code: 'invalid_encoding' } });
  });

  it('rejects missing files, multiple files, unknown fields and malformed multipart', async () => {
    for (const kind of ['missing', 'multiple', 'unknown']) {
      const form = new FormData();
      if (kind !== 'missing') form.append('file', new File([validCsv], 'test.csv'));
      if (kind === 'multiple') form.append('file', new File([validCsv], 'second.csv'));
      if (kind === 'unknown') form.append('actor', 'reconciliation');
      const response = await createApp(access).request(
        endpoint,
        { method: 'POST', headers: { Accept: 'application/json' }, body: form },
        env,
      );
      expect(response.status).toBe(400);
    }
    const response = await createApp(access).request(
      endpoint,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'multipart/form-data; boundary=x' },
        body: 'broken',
      },
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects foreign origins and unsupported request media types', async () => {
    const form = new FormData();
    form.set('file', new File([validCsv], 'test.csv'));
    expect(
      (
        await createApp(access).request(
          endpoint,
          { method: 'POST', headers: { Origin: 'https://evil.test' }, body: form },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await createApp(access).request(endpoint, { method: 'POST', body: '{}' }, env)).status,
    ).toBe(415);
  });
});
