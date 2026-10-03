// apps/api/src/modules/outbox/outbox.routes.ts
import type { Hono } from 'hono';
import { OUTBOX_TOPICS } from '@para/core';
import { html } from 'hono/html';
import type { AppEnvironment } from '../../auth/cloudflareAccess';

export function registerOutboxRoutes(app: Hono<AppEnvironment>): void {
  app.get('/admin/outbox', async (c) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    const json = c.req.header('Accept')?.includes('application/json') ?? false;
    if (!c.env.DB)
      return c.json(
        { error: { code: 'database_unavailable', message: 'Base indisponible.' } },
        503,
      );
    try {
      const rows = (
        await c.env.DB.prepare(
          `SELECT id,topic,status,attempts,next_attempt_at,last_error,updated_at
        FROM outbox WHERE store_id=? AND status!='done'
        ORDER BY CASE WHEN status='failed' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 25`,
        )
          .bind('para-main')
          .all<{
            id: string;
            topic: string;
            status: string;
            attempts: number;
            next_attempt_at: string | null;
            last_error: string | null;
            updated_at: string;
          }>()
      ).results;
      const messages: Readonly<Record<string, string>> = {
        provider_unavailable: 'Service indisponible',
        provider_rejected: 'Envoi rejeté',
        unsupported_topic: 'Type non pris en charge',
        invalid_payload: 'Données invalides',
        handler_timeout: 'Délai dépassé',
        delivery_failed: 'Échec de livraison',
        attempts_exhausted: 'Tentatives épuisées',
      };
      const jobs = rows.map((row) => ({
        ...row,
        topic: OUTBOX_TOPICS.some((topic) => topic === row.topic) ? row.topic : 'Type inconnu',
        last_error:
          row.last_error && Object.hasOwn(messages, row.last_error)
            ? messages[row.last_error]
            : row.last_error
              ? 'Erreur enregistrée (détail masqué)'
              : null,
        terminal: row.status === 'failed' && row.next_attempt_at === null,
      }));
      const tableRows = jobs.map(
        (job) =>
          html`<tr>
            <td>${job.id}</td>
            <td>${job.topic}</td>
            <td>${job.status}${job.terminal ? ' · Arrêté' : ''}</td>
            <td>${job.attempts}/5</td>
            <td>${job.next_attempt_at ?? '—'}</td>
            <td>${job.last_error ?? '—'}</td>
          </tr>`,
      );
      return json
        ? c.json({ jobs })
        : c.html(
            html`<!doctype html>
              <html lang="fr">
                <head>
                  <meta charset="utf-8" />
                  <meta name="viewport" content="width=device-width,initial-scale=1" />
                  <meta name="robots" content="noindex,nofollow" />
                  <title>Tâches différées · Anfash Para</title>
                </head>
                <body style="font:16px system-ui;padding:16px">
                  <a href="/admin/orders">Commandes</a>
                  <h1>Tâches différées</h1>
                  <p>
                    25 dernières tâches non terminées. Aucun envoi réel n’est configuré : le cron
                    conserve les tâches sans les consommer.
                  </p>
                  <p>
                    Les erreurs arrêtées demandent une vérification. Aucune relance automatique
                    après cinq tentatives.
                  </p>
                  <div style="overflow-x:auto">
                    <table>
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Type</th>
                          <th>Statut</th>
                          <th>Tentatives</th>
                          <th>Prochaine tentative / fin du bail</th>
                          <th>Erreur</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${tableRows}
                      </tbody>
                    </table>
                  </div>
                </body>
              </html>`,
          );
    } catch {
      return c.json(
        { error: { code: 'outbox_unavailable', message: 'Tâches indisponibles.' } },
        503,
      );
    }
  });
}
