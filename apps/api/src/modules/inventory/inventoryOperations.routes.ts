// apps/api/src/modules/inventory/inventoryOperations.routes.ts
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import {
  decodeInventoryCursor,
  inventorySkuSchema,
  inventoryOperationSchema,
  type InventoryOperation,
} from './inventoryOperations.schema';
import {
  InventoryOperationError,
  readInventoryOperations,
  recordInventoryOperation,
} from './inventoryOperations.service';
import { renderInventoryOperations } from './inventoryOperations.view';

export function registerInventoryOperationsRoutes(app: Hono<AppEnvironment>): void {
  app.use('/admin/inventory', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    await next();
  });
  app.use('/admin/inventory/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    await next();
  });
  app.get('/admin/inventory', async (c) => {
    const query = z
      .strictObject({
        sku: inventorySkuSchema.optional(),
        cursor: z.string().min(1).max(500).optional(),
        saved: z.enum(['yes', 'duplicate']).optional(),
      })
      .safeParse(c.req.query());
    if (!query.success)
      return c.json({ error: { code: 'invalid_query', message: 'Recherche invalide.' } }, 400);
    const cursor = query.data.cursor ? decodeInventoryCursor(query.data.cursor) : undefined;
    if (query.data.cursor && (!cursor || cursor.sku !== query.data.sku))
      return c.json({ error: { code: 'invalid_cursor', message: 'Page invalide.' } }, 400);
    try {
      if (!c.env.DB) throw new Error('Missing database');
      const data = await readInventoryOperations(c.env.DB, query.data.sku, cursor ?? undefined);
      return c.req.header('Accept')?.includes('application/json')
        ? c.json(data)
        : c.html(
            renderInventoryOperations(
              data,
              query.data.sku,
              undefined,
              query.data.saved === 'duplicate'
                ? 'Mouvement déjà enregistré ; aucun nouvel effet.'
                : query.data.saved
                  ? 'Mouvement enregistré.'
                  : '',
            ),
          );
    } catch (error) {
      return c.json(
        {
          error: {
            code: error instanceof InventoryOperationError ? error.code : 'inventory_unavailable',
            message: 'Stock indisponible ou SKU introuvable.',
          },
        },
        error instanceof InventoryOperationError ? 404 : 503,
      );
    }
  });
  app.post('/admin/inventory/movements', async (c) => {
    const json = c.req.header('Accept')?.includes('application/json');
    let draft: InventoryOperation | undefined = undefined;
    const fail = (
      status: 400 | 403 | 404 | 409 | 413 | 415 | 503,
      code: string,
      message: string,
    ) =>
      json
        ? c.json({ error: { code, message } }, status)
        : c.html(
            renderInventoryOperations(
              { stock: [], history: [], nextCursor: null },
              draft?.sku ?? '',
              draft?.reference,
              message,
              draft,
            ),
            status,
          );
    const origin = c.req.header('Origin');
    if (
      !origin ||
      origin !== new URL(c.req.url).origin ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return fail(403, 'invalid_origin', 'Soumettez le formulaire depuis ce site.');
    const type = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded')
      return fail(415, 'unsupported_media_type', 'Format de formulaire invalide.');
    let body: unknown;
    try {
      // Bound request stream to 8KiB, independent of Content-Length.
      const reader = c.req.raw.body?.getReader();
      if (!reader) return fail(400, 'invalid_request', 'Formulaire vide.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return fail(413, 'body_too_large', 'Formulaire trop volumineux.');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      if (type === 'application/json') body = JSON.parse(source);
      else {
        const fields = new URLSearchParams(source);
        if ([...fields.keys()].some((key) => fields.getAll(key).length !== 1))
          return fail(400, 'invalid_request', 'Champs répétés.');
        body = { ...Object.fromEntries(fields), quantity: Number(fields.get('quantity')) };
      }
    } catch {
      return fail(400, 'invalid_request', 'Formulaire invalide.');
    }
    const parsed = inventoryOperationSchema.safeParse(body);
    if (!parsed.success)
      return fail(
        400,
        'invalid_operation',
        'Vérifiez SKU, quantité signée, motif, référence et note.',
      );
    draft = parsed.data;
    try {
      if (!c.env.DB) throw new Error('Missing database');
      const result = await recordInventoryOperation(
        c.env.DB,
        parsed.data,
        `user:${c.get('accessIdentity').email}`,
      );
      return json
        ? c.json(result, result.duplicate ? 200 : 201)
        : c.redirect(
            '/admin/inventory?' +
              new URLSearchParams({
                sku: parsed.data.sku,
                saved: result.duplicate ? 'duplicate' : 'yes',
              }),
            303,
          );
    } catch (error) {
      if (error instanceof InventoryOperationError)
        return fail(
          error.code === 'sku_not_found'
            ? 404
            : error.code === 'reference_conflict'
              ? 409
              : error.code === 'invalid_actor'
                ? 403
                : 400,
          error.code,
          error.code === 'reference_conflict'
            ? 'Référence déjà utilisée pour un autre mouvement.'
            : 'SKU ou opération invalide.',
        );
      return fail(
        503,
        'inventory_unavailable',
        'Enregistrement indisponible. Gardez la référence pour réessayer.',
      );
    }
  });
}
