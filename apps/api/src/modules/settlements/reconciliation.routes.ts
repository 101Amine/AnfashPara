// apps/api/src/modules/settlements/reconciliation.routes.ts
import { MAX_SETTLEMENT_FILE_BYTES, SettlementParseError } from '@para/core';
import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { readLimitedBody } from './settlementPreview.routes';
import { reconciliationInputSchema } from './reconciliation.schema';
import {
  importReconciliation,
  listSettlementReports,
  loadSettlementReport,
  previewReconciliation,
  ReconciliationError,
} from './reconciliation.service';
import { renderLegacySettlement, renderReconciliation } from './reconciliation.view';

export function registerReconciliationRoutes(app: Hono<AppEnvironment>): void {
  app.get('/admin/settlements/reconcile', (c) =>
    c.html(renderReconciliation({ email: c.get('accessIdentity').email })),
  );
  for (const path of ['/admin/settlements/reconcile', '/admin/settlements/import'] as const) {
    app.post(path, async (c) => {
      const failure = (
        status: 400 | 403 | 409 | 413 | 415 | 422 | 503,
        code: string,
        message: string,
      ) => respondError(c, status, code, message);
      if (!c.env.DB) return failure(503, 'database_unavailable', 'Base de données indisponible.');
      const origin = c.req.header('Origin');
      if (origin && origin !== new URL(c.req.url).origin)
        return failure(403, 'invalid_origin', 'Envoyez le relevé depuis ce site.');
      try {
        const bytes = await readLimitedBody(c.req.raw);
        const contentType = c.req.header('Content-Type') ?? '';
        let raw: Record<string, unknown>;
        if (contentType.startsWith('application/json')) {
          raw = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
          ) as Record<string, unknown>;
        } else if (contentType.startsWith('multipart/form-data;')) {
          const form = await new Response(bytes, {
            headers: { 'Content-Type': contentType },
          }).formData();
          if ([...form.keys()].some((key) => form.getAll(key).length !== 1))
            return failure(400, 'invalid_upload', 'Champs dupliqués.');
          raw = Object.fromEntries(form);
          const file = form.get('file');
          if (file !== null) {
            if (
              !(file instanceof File) ||
              !file.name.toLowerCase().endsWith('.csv') ||
              form.has('source')
            )
              return failure(400, 'invalid_upload', 'Sélectionnez un seul fichier CSV.');
            if (file.size > MAX_SETTLEMENT_FILE_BYTES)
              return failure(413, 'file_too_large', 'Limite : 1 Mio.');
            raw.source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
              await file.arrayBuffer(),
            );
            delete raw.file;
          }
        } else
          return failure(415, 'unsupported_media_type', 'Envoyez du JSON ou un formulaire CSV.');
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return failure(400, 'invalid_input', 'Données invalides.');
        const { approval, confirmed, ...data } = raw;
        const parsed = reconciliationInputSchema.safeParse(data);
        if (!parsed.success)
          return failure(
            422,
            'invalid_input',
            'Vérifiez le CSV, le livreur, la référence, les dates et le montant en MAD.',
          );
        const input = parsed.data;
        const email = c.get('accessIdentity').email;
        if (path === '/admin/settlements/import') {
          if (
            (confirmed !== true && confirmed !== 'true') ||
            typeof approval !== 'string' ||
            !/^[a-f0-9]{64}$/.test(approval)
          )
            return failure(
              422,
              'approval_required',
              'Confirmez l’aperçu et le montant reçu avant l’import.',
            );
          const result = await importReconciliation(c.env.DB, input, approval, email);
          return wantsJson(c)
            ? c.json(result, result.duplicate ? 200 : 201)
            : c.html(renderReconciliation({ email, ...result }), result.duplicate ? 200 : 201);
        }
        if (approval !== undefined || confirmed !== undefined)
          return failure(422, 'invalid_input', 'Champs d’approbation inattendus.');
        const result = await previewReconciliation(c.env.DB, input);
        return wantsJson(c)
          ? c.json(result)
          : c.html(renderReconciliation({ email, input, ...result }));
      } catch (error) {
        if (error instanceof ReconciliationError)
          return failure(error.code === 'invalid_csv' ? 422 : 409, error.code, error.message);
        if (error instanceof SettlementParseError)
          return failure(error.code === 'file_too_large' ? 413 : 422, error.code, error.message);
        if (error instanceof SyntaxError || error instanceof TypeError)
          return failure(400, 'invalid_input', 'Fichier ou données illisibles. Utilisez UTF-8.');
        if (error instanceof RangeError)
          return failure(422, 'amount_overflow', 'Les montants dépassent la plage autorisée.');
        return failure(
          503,
          'import_unavailable',
          'Import indisponible. Aucun changement partiel enregistré. Réessayez.',
        );
      }
    });
  }
  app.get('/admin/settlements/reports', async (c) => {
    if (!c.env.DB) return respondError(c, 503, 'database_unavailable', 'Base indisponible.');
    try {
      const reports = await listSettlementReports(c.env.DB);
      return wantsJson(c)
        ? c.json({ reports })
        : c.html(
            html`<!doctype html>
              <html lang="fr">
                <meta charset="utf-8" /><meta
                  name="viewport"
                  content="width=device-width,initial-scale=1"
                /><title>Relevés · Anfash Para</title>
                <body style="font:16px system-ui;padding:16px">
                  <a href="/admin/settlements/reconcile">Nouveau rapprochement</a>
                  <h1>30 derniers relevés</h1>
                  <ul>
                    ${reports.map((r) => html`<li><a href="/admin/settlements/reports/${r.id}">${r.courier} · ${r.statement_reference} · ${r.imported_at}</a></li>`)}
                  </ul>
                </body>
              </html>`,
          );
    } catch {
      return respondError(c, 503, 'report_unavailable', 'Rapports indisponibles.');
    }
  });
  app.get('/admin/settlements/reports/:id', async (c) => {
    if (!c.env.DB) return respondError(c, 503, 'database_unavailable', 'Base indisponible.');
    try {
      const result = await loadSettlementReport(c.env.DB, c.req.param('id'));
      if (!result) return respondError(c, 404, 'not_found', 'Relevé introuvable.');
      if (!result.report)
        return wantsJson(c)
          ? c.json(result)
          : c.html(
              renderLegacySettlement(
                c.get('accessIdentity').email,
                result.settlementId,
                result.legacyLines!,
              ),
            );
      return wantsJson(c)
        ? c.json(result)
        : c.html(
            renderReconciliation({
              email: c.get('accessIdentity').email,
              settlementId: result.settlementId,
              report: result.report,
            }),
          );
    } catch {
      return respondError(c, 503, 'report_unavailable', 'Rapport indisponible.');
    }
  });
}

function wantsJson(c: Context<AppEnvironment>) {
  return c.req.header('Accept')?.includes('application/json') ?? false;
}
function respondError(
  c: Context<AppEnvironment>,
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 503,
  code: string,
  message: string,
) {
  return wantsJson(c)
    ? c.json({ error: { code, message } }, status)
    : c.html(
        renderReconciliation({ email: c.get('accessIdentity').email, error: message }),
        status,
      );
}
