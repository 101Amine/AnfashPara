// apps/api/src/modules/shipping/manualFees.routes.ts
import { cents, format, parse, SettlementParseError } from '@para/core';
import type { Hono } from 'hono';
import { html } from 'hono/html';
import { z } from 'zod';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { loadManualFees, ManualFeesError, recordManualFees } from './manualFees.service';
import { readLimitedBody } from '../settlements/settlementPreview.routes';

const idSchema = z.uuid({ version: 'v7' });
const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(?:[.,]\d{1,2})?$/u)
  .transform(parse);
const inputSchema = z.strictObject({
  deliveryFee: amountSchema,
  returnFee: amountSchema,
  reason: z.string().trim().min(5).max(300),
});

export function registerManualFeesRoutes(app: Hono<AppEnvironment>): void {
  const path = '/admin/shipments/:shipmentId/fees';
  app.use(path, async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    if (c.get('accessIdentity').kind === 'service')
      return c.json(
        { error: { code: 'human_required', message: 'Accès administrateur requis.' } },
        403,
      );
    await next();
  });
  app.get(path, async (c) => {
    if (!c.env.DB)
      return c.json({ error: { code: 'service_unavailable', message: 'Base indisponible.' } }, 503);
    const id = idSchema.safeParse(c.req.param('shipmentId'));
    if (!id.success)
      return c.json({ error: { code: 'invalid_id', message: 'Colis invalide.' } }, 400);
    try {
      const shipment = await loadManualFees(c.env.DB, id.data);
      return c.html(
        html`<!doctype html>
          <html lang="fr">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <title>Frais manuels</title>
            </head>
            <body style="font:18px system-ui;max-width:600px;margin:auto;padding:20px">
              <a href="/admin/orders">Commandes</a>
              <h1>Frais de livraison manuelle</h1>
              <p>${shipment.tracking_number}</p>
              <p>
                Inconnu n’est pas zéro. Saisissez explicitement 0 pour une livraison gratuite. Les
                deux frais seront verrouillés après enregistrement.
              </p>
              ${
                shipment.delivery_fee_centimes !== null && shipment.return_fee_centimes !== null
                  ? html`<p>
                      Frais enregistrés : livraison
                      ${format(cents(shipment.delivery_fee_centimes))}, retour
                      ${format(cents(shipment.return_fee_centimes))}.
                    </p>`
                  : shipment.status === 'SETTLED'
                    ? html`<p>Commande réglée : frais verrouillés.</p>`
                    : html`<form method="post">
                        <p>
                          <label
                            >Frais de livraison (MAD)
                            <input name="deliveryFee" inputmode="decimal" required
                          /></label>
                        </p>
                        <p>
                          <label
                            >Frais de retour (MAD)
                            <input name="returnFee" inputmode="decimal" required
                          /></label>
                        </p>
                        <p>
                          <label
                            >Justification
                            <textarea
                              name="reason"
                              minlength="5"
                              maxlength="300"
                              required
                            ></textarea>
                          </label>
                        </p>
                        <button type="submit">Enregistrer les frais</button>
                      </form>`
              }
            </body>
          </html>`,
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code: error instanceof ManualFeesError ? error.code : 'service_unavailable',
            message: 'Frais indisponibles.',
          },
        },
        error instanceof ManualFeesError ? 404 : 503,
      );
    }
  });
  app.post(path, async (c) => {
    const fail = (status: 400 | 403 | 404 | 409 | 413 | 415 | 503, code: string, message: string) =>
      c.json({ error: { code, message } }, status);
    if (!c.env.DB) return fail(503, 'service_unavailable', 'Base indisponible.');
    if (
      c.req.header('Origin') !== new URL(c.req.url).origin ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return fail(403, 'invalid_origin', 'Soumettez les frais depuis ce site.');
    const id = idSchema.safeParse(c.req.param('shipmentId'));
    if (!id.success) return fail(400, 'invalid_id', 'Colis invalide.');
    const contentType = c.req.header('Content-Type')?.split(';')[0];
    if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded')
      return fail(415, 'unsupported_media_type', 'Envoyez un formulaire ou du JSON.');
    try {
      const bytes = await readLimitedBody(c.req.raw, 4096);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      const params = contentType === 'application/json' ? null : new URLSearchParams(text);
      if (params && [...params.keys()].some((key) => params.getAll(key).length !== 1))
        return fail(400, 'invalid_input', 'Champs dupliqués.');
      const parsed = inputSchema.safeParse(params ? Object.fromEntries(params) : JSON.parse(text));
      if (!parsed.success)
        return fail(400, 'invalid_input', 'Vérifiez les frais en MAD et la justification.');
      const result = await recordManualFees(
        c.env.DB,
        id.data,
        {
          deliveryFeeCentimes: parsed.data.deliveryFee,
          returnFeeCentimes: parsed.data.returnFee,
          reason: parsed.data.reason,
        },
        `user:${c.get('accessIdentity').email}`,
      );
      return c.req.header('Accept')?.includes('application/json')
        ? c.json(result)
        : c.redirect(path.replace(':shipmentId', id.data), 303);
    } catch (error) {
      if (error instanceof ManualFeesError)
        return fail(
          error.code === 'not_found' ? 404 : 409,
          error.code,
          'Frais verrouillés ou colis modifié. Rechargez la page.',
        );
      if (error instanceof SettlementParseError)
        return fail(413, 'body_too_large', 'Limite : 4 Kio.');
      if (error instanceof SyntaxError || error instanceof TypeError)
        return fail(400, 'invalid_input', 'Données illisibles.');
      return fail(503, 'service_unavailable', 'Aucun changement partiel enregistré. Réessayez.');
    }
  });
}
