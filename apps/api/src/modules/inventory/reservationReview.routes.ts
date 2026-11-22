import type { Hono } from 'hono';
import { html } from 'hono/html';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import {
  applyReservationBackfill,
  previewReservationBackfill,
  readReservationInventory,
  readUnreservedOrders,
  ReservationReviewError,
} from './reservationReview.service';

const ROOT = '/admin/inventory/reservations';
export function registerReservationReviewRoutes(app: Hono<AppEnvironment>) {
  app.use(`${ROOT}*`, async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    if (c.get('accessIdentity')?.kind === 'service')
      return c.json({ error: { code: 'human_admin_required' } }, 403);
    await next();
  });
  app.get(ROOT, async (c) => {
    const query = z
      .strictObject({
        after: z.string().max(100).optional(),
        ordersAfter: z.uuid().optional(),
        order: z.uuid().optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'invalid_query' } }, 400);
    try {
      if (!c.env.DB) throw new Error('Missing database');
      const [inventory, pending, preview] = await Promise.all([
        readReservationInventory(c.env.DB, query.data.after),
        readUnreservedOrders(c.env.DB, query.data.ordersAfter),
        query.data.order
          ? previewReservationBackfill(c.env.DB, query.data.order)
          : Promise.resolve(null),
      ]);
      const data = { ...inventory, pending, preview };
      if (c.req.header('Accept')?.includes('application/json')) return c.json(data);
      return c.html(
        html`<!doctype html>
          <html lang="fr">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <meta name="robots" content="noindex,nofollow" />
              <title>Réservations · Anfash Para</title>
              <style>
                body {
                  font: 16px system-ui;
                  color: #18221d;
                  background: #f4f7f5;
                  margin: 0;
                }
                main {
                  max-width: 1100px;
                  margin: auto;
                  padding: 20px;
                }
                section {
                  background: white;
                  padding: 16px;
                  margin: 16px 0;
                  border-radius: 12px;
                }
                .scroll {
                  overflow-x: auto;
                }
                table {
                  border-collapse: collapse;
                  width: 100%;
                }
                th,
                td {
                  text-align: left;
                  padding: 12px;
                  border-bottom: 1px solid #ddd;
                }
                button {
                  padding: 12px;
                  font: inherit;
                  background: #17643d;
                  color: white;
                  border: 0;
                  border-radius: 6px;
                }
                .short {
                  color: #a01919;
                  font-weight: bold;
                }
              </style>
            </head>
            <body>
              <main>
                <a href="/admin/inventory">Mouvements de stock</a>
                <h1>Stock et réservations</h1>
                <p>
                  Disponible = physique − réservé. Les commandes anciennes non réservées restent à
                  régulariser. Un solde positif ne suffit pas à autoriser l’activation.
                </p>
                <section>
                  <div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Produit / SKU</th>
                          <th>Physique</th>
                          <th>Réservé</th>
                          <th>Disponible</th>
                          <th>Non réservé</th>
                          <th>Après régularisation</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${inventory.stock.map(
                          (r) =>
                            html`<tr>
                              <td>${r.name}<br />${r.sku}</td>
                              <td>${r.physical}</td>
                              <td>${r.reserved}</td>
                              <td class=${r.available < 0 ? 'short' : ''}>${r.available}</td>
                              <td>${r.unreserved}</td>
                              <td class=${r.afterReconciliation < 0 ? 'short' : ''}>
                                ${r.afterReconciliation}${r.afterReconciliation < 0 ? ' — Manque de stock' : ''}
                              </td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>
                  ${inventory.next ? html`<a href=${`${ROOT}?${new URLSearchParams({ after: inventory.next, ...(query.data.ordersAfter ? { ordersAfter: query.data.ordersAfter } : {}) })}`}>Produits suivants</a>` : ''}
                </section>
                <section>
                  <h2>Commandes à vérifier</h2>
                  <p>
                    20 commandes par page. Les dossiers partiellement réservés ou sans articles
                    nécessitent une vérification manuelle.
                  </p>
                  ${pending.orders.length ? pending.orders.map((o) => html`<p><a href=${`${ROOT}?order=${o.id}`}>${o.order_number ?? o.id}</a> · ${o.status}${o.existingHolds ? ' · Réservation partielle : vérifier' : ''}</p>`) : html`<p>Aucune commande manquante sur cette page.</p>`}
                  ${pending.next ? html`<a href=${`${ROOT}?${new URLSearchParams({ ordersAfter: pending.next, ...(query.data.after ? { after: query.data.after } : {}) })}`}>Commandes suivantes</a>` : ''}
                </section>
                ${
                  preview
                    ? html`<section>
                        <h2>Vérifier la réservation</h2>
                        <p>Commande ${preview.order.id} · ${preview.order.status}</p>
                        ${preview.lines.map((i) => html`<p>${i.sku} : ${i.quantity} demandés · ${i.available ?? 'inconnu'} disponibles</p>`)}
                        ${
                          preview.ready
                            ? html`<p>
                                  Après vérification, réserver tous les articles de cette commande.
                                  Aucun stock physique ne sera modifié.
                                </p>
                                <form method="post" action=${ROOT}>
                                  <input
                                    type="hidden"
                                    name="orderId"
                                    value=${preview.order.id}
                                  /><input
                                    type="hidden"
                                    name="token"
                                    value=${preview.token}
                                  /><button>Valider la réservation de cette commande</button>
                                </form>`
                            : html`<p class="short">
                                Régularisation bloquée : stock insuffisant, statut incompatible,
                                réservation existante ou articles manquants.
                              </p>`
                        }
                      </section>`
                    : ''
                }
              </main>
            </body>
          </html>`,
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code:
              error instanceof ReservationReviewError
                ? error.message
                : 'reservation_review_unavailable',
          },
        },
        error instanceof ReservationReviewError ? 404 : 503,
      );
    }
  });
  app.post(ROOT, bodyLimit({ maxSize: 4096 }), async (c) => {
    if (
      c.req.header('Origin') !== new URL(c.req.url).origin ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return c.json({ error: { code: 'invalid_origin' } }, 403);
    const type = c.req.header('Content-Type')?.split(';')[0];
    if (type !== 'application/x-www-form-urlencoded' && type !== 'application/json')
      return c.json({ error: { code: 'unsupported_media_type' } }, 415);
    let body: unknown;
    try {
      body = type === 'application/json' ? await c.req.json() : await c.req.parseBody();
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const parsed = z
      .strictObject({ orderId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/u) })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      if (!c.env.DB) throw new Error('Missing database');
      const result = await applyReservationBackfill(
        c.env.DB,
        parsed.data.orderId,
        parsed.data.token,
        `user:${c.get('accessIdentity').email}`,
      );
      return c.req.header('Accept')?.includes('application/json')
        ? c.json(result, result.duplicate ? 200 : 201)
        : c.redirect(`${ROOT}?order=${parsed.data.orderId}`, 303);
    } catch (error) {
      return c.json(
        {
          error: {
            code:
              error instanceof ReservationReviewError
                ? error.message
                : 'reservation_review_unavailable',
            message: 'Actualisez la vérification avant de réessayer.',
          },
        },
        error instanceof ReservationReviewError ? 409 : 503,
      );
    }
  });
}
