import type { Hono } from 'hono';
import { html } from 'hono/html';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { createUuidV7 } from '../../shared/uuidV7';
import { prepareManualMessage, type MessageOrder } from './manualMessages';

const ROOT = '/admin/orders/:orderId/messages';
const requestSchema = z.strictObject({
  eventId: z.uuidv7(),
  status: z.enum(['CONFIRMING', 'NO_ANSWER', 'SHIPPED', 'CANCELLED']),
});
export function registerManualMessageRoutes(app: Hono<AppEnvironment>) {
  app.use(ROOT, async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
    if (c.get('accessIdentity')?.kind === 'service')
      return c.json({ error: 'human_admin_required' }, 403);
    if (!z.uuid().safeParse(c.req.param('orderId')).success)
      return c.json({ error: 'invalid_order_id' }, 400);
    await next();
  });
  app.get(ROOT, async (c) => {
    if (!c.env.DB) return c.json({ error: 'service_unavailable' }, 503);
    try {
      const order = await loadOrder(c.env.DB, c.req.param('orderId'));
      if (!order) return c.json({ error: 'order_not_found' }, 404);
      const message = prepareManualMessage(order);
      const history = await c.env.DB.prepare(
        `SELECT created_at,actor FROM order_events
        WHERE store_id='para-main' AND order_id=? AND reason='whatsapp_sent_manual'
        ORDER BY created_at DESC,id DESC LIMIT 20`,
      )
        .bind(order.id)
        .all<{ created_at: string; actor: string }>();
      return c.html(
        html`<!doctype html>
          <html lang="fr">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <meta name="robots" content="noindex,nofollow" />
              <title>Messages WhatsApp · Anfash Para</title>
              <style>
                body {
                  font: 16px system-ui;
                  margin: 0;
                  background: #f4f7f5;
                  color: #18221d;
                }
                main {
                  max-width: 760px;
                  margin: auto;
                  padding: 20px;
                }
                section {
                  background: white;
                  padding: 20px;
                  margin: 16px 0;
                  border-radius: 12px;
                }
                textarea {
                  box-sizing: border-box;
                  width: 100%;
                  min-height: 180px;
                  font: inherit;
                  padding: 12px;
                }
                button,
                .send {
                  display: inline-block;
                  padding: 12px;
                  margin: 8px 0;
                  background: #17643d;
                  color: white;
                  border: 0;
                  border-radius: 6px;
                  font: inherit;
                }
                li {
                  margin-bottom: 12px;
                  overflow-wrap: anywhere;
                }
                select {
                  padding: 10px;
                  font: inherit;
                }
              </style>
            </head>
            <body>
              <main>
                <a href="/admin/orders">Retour aux commandes</a>
                <h1>Messages WhatsApp</h1>
                <p>Commande ${order.order_number ?? order.id} · ${order.status}</p>
                <section>
                  <p>
                    Envoi manuel : vérifiez le destinataire et le texte dans WhatsApp avant
                    d’envoyer. Ouvrir le lien ne marque rien comme envoyé. Aucun accusé de livraison
                    ou de lecture n’est disponible.
                  </p>
                  ${
                    message
                      ? html`<label for="message">Message proposé</label
                          ><textarea id="message" readonly>${message.text}</textarea>
                          <a
                            class="send"
                            href=${message.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            >Ouvrir WhatsApp</a
                          >
                          <form method="post">
                            <input type="hidden" name="eventId" value=${createUuidV7()} />
                            <input type="hidden" name="status" value=${order.status} />
                            <p>
                              Après l’envoi uniquement, enregistrez votre déclaration. Cela ne
                              confirme pas la commande.
                            </p>
                            <button type="submit">J’ai envoyé ce message</button>
                          </form>`
                      : html`<p>Aucun message prévu pour ce statut.</p>`
                  }
                </section>
                ${
                  ['CONFIRMING', 'NO_ANSWER'].includes(order.status)
                    ? html`<section>
                        <h2>Réponse du client</h2>
                        <p>
                          Enregistrez la réponse après l’échange. Ne comptez pas l’ouverture de
                          WhatsApp comme une absence de réponse.
                        </p>
                        <form method="post" action=${`/admin/orders/${order.id}/confirmation`}>
                          <input type="hidden" name="channel" value="whatsapp" /><label
                            for="outcome"
                            >Résultat</label
                          >
                          <select id="outcome" name="action" required>
                            <option value="" disabled selected>Choisir un résultat</option>
                            <option value="confirmed">Confirmé</option>
                            <option value="no_answer">Pas de réponse</option>
                            <option value="cancelled">Annulé</option>
                            <option value="callback">Rappeler</option>
                          </select>
                          <button>Enregistrer la réponse</button>
                        </form>
                      </section>`
                    : ''
                }
                <section>
                  <h2>Envois déclarés</h2>
                  <p>20 derniers envois déclarés par un administrateur.</p>
                  ${
                    history.results.length
                      ? html`<ul>
                          ${history.results.map((entry) => html`<li>${entry.created_at} · ${entry.actor} · Envoi déclaré manuellement</li>`)}
                        </ul>`
                      : html`<p>Aucun envoi déclaré.</p>`
                  }
                </section>
              </main>
            </body>
          </html>`,
      );
    } catch {
      return c.json({ error: 'service_unavailable' }, 503);
    }
  });
  app.post(ROOT, bodyLimit({ maxSize: 2048 }), async (c) => {
    if (
      c.req.header('Origin') !== new URL(c.req.url).origin ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return c.json({ error: 'invalid_origin' }, 403);
    if (c.req.header('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
      return c.json({ error: 'unsupported_media_type' }, 415);
    if (!c.env.DB) return c.json({ error: 'service_unavailable' }, 503);
    try {
      const input = requestSchema.safeParse(await c.req.parseBody());
      if (!input.success) return c.json({ error: 'invalid_request' }, 400);
      const actor = `user:${c.get('accessIdentity').email}`;
      const orderId = c.req.param('orderId');
      const existing = await c.env.DB.prepare(
        'SELECT order_id,actor,from_status,reason FROM order_events WHERE id=? AND store_id=?',
      )
        .bind(input.data.eventId, 'para-main')
        .first<{ order_id: string; actor: string; from_status: string; reason: string }>();
      if (existing) {
        if (
          existing.order_id !== orderId ||
          existing.actor !== actor ||
          existing.from_status !== input.data.status ||
          existing.reason !== 'whatsapp_sent_manual'
        )
          return c.json({ error: 'message_conflict' }, 409);
        return c.redirect(`/admin/orders/${orderId}/messages`, 303);
      }
      const order = await loadOrder(c.env.DB, orderId);
      if (!order) return c.json({ error: 'order_not_found' }, 404);
      const message = prepareManualMessage(order);
      if (!message || order.status !== input.data.status)
        return c.json({ error: 'order_changed' }, 409);
      const result = await c.env.DB.prepare(
        `INSERT INTO order_events
        (id,store_id,order_id,from_status,to_status,actor,reason,payload_json,created_at)
        SELECT ?,'para-main',id,status,status,?,'whatsapp_sent_manual',?,? FROM orders
        WHERE id=? AND store_id='para-main' AND status=? ON CONFLICT(id) DO NOTHING`,
      )
        .bind(
          input.data.eventId,
          actor,
          JSON.stringify({
            channel: 'whatsapp',
            template: message.template,
            version: message.version,
            manual: true,
          }),
          new Date().toISOString(),
          orderId,
          input.data.status,
        )
        .run();
      if (result.meta.changes === 0) {
        const replay = await c.env.DB.prepare(
          `SELECT id FROM order_events WHERE id=? AND store_id='para-main'
          AND order_id=? AND actor=? AND from_status=? AND reason='whatsapp_sent_manual'`,
        )
          .bind(input.data.eventId, orderId, actor, input.data.status)
          .first();
        if (!replay) return c.json({ error: 'order_changed' }, 409);
      }
      return c.redirect(`/admin/orders/${orderId}/messages`, 303);
    } catch {
      return c.json({ error: 'service_unavailable' }, 503);
    }
  });
}
function loadOrder(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT o.id,o.status,o.order_number,o.city,o.cod_amount_centimes,c.name,c.phone_e164
    FROM orders o JOIN customers c ON c.id=o.customer_id AND c.store_id=o.store_id
    WHERE o.id=? AND o.store_id='para-main'`,
    )
    .bind(id)
    .first<MessageOrder>();
}
