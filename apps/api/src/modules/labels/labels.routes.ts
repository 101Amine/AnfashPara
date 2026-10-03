// apps/api/src/modules/labels/labels.routes.ts
import { zipSync } from 'fflate';
import type { Context, Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { labelBatchSchema, shipmentIdSchema } from './labels.schema';
import {
  LabelConfigurationError,
  LabelDownloadError,
  ShipmentLabelMissingError,
  ShipmentLabelNotFoundError,
  assertAllowedLabelUrls,
  downloadShipmentLabel,
  getShipmentLabel,
  getShipmentLabels,
  labelFilename,
  parseAllowedLabelOrigins,
  type LabelFetcher,
} from './labels.service';
import { renderLabelBatchPage } from './labels.view';

const MAX_BATCH_BYTES = 25_000_000;

export function registerLabelRoutes(
  app: Hono<AppEnvironment>,
  fetchLabel: LabelFetcher = fetch,
): void {
  app.get('/admin/shipments/:shipmentId/label', async (context) => {
    setPrivateHeaders(context);
    if (!context.env.DB)
      return labelError(context, 503, 'service_unavailable', 'Service indisponible.');

    const shipmentId = shipmentIdSchema.safeParse(context.req.param('shipmentId'));
    if (!shipmentId.success) {
      return labelError(context, 400, 'invalid_shipment_id', 'Colis invalide.');
    }

    try {
      const label = await getShipmentLabel(context.env.DB, shipmentId.data);
      const allowedOrigins = parseAllowedLabelOrigins(context.env.COURIER_LABEL_ORIGINS);
      const downloaded = await downloadShipmentLabel(label, allowedOrigins, fetchLabel);
      const disposition = context.req.query('download') === '1' ? 'attachment' : 'inline';
      context.header('Content-Type', downloaded.contentType);
      context.header(
        'Content-Disposition',
        `${disposition}; filename="${labelFilename(label, downloaded.extension)}"`,
      );
      return context.body(toArrayBuffer(downloaded.bytes));
    } catch (error) {
      return handleLabelError(context, error);
    }
  });

  app.post('/admin/labels/batch', async (context) => {
    setPrivateHeaders(context);
    if (!context.env.DB)
      return labelError(context, 503, 'service_unavailable', 'Service indisponible.');

    const selection = await parseSelection(context);
    if (selection instanceof Response) return selection;

    try {
      const labels = await getShipmentLabels(context.env.DB, selection);
      const allowedOrigins = parseAllowedLabelOrigins(context.env.COURIER_LABEL_ORIGINS);
      assertAllowedLabelUrls(labels, allowedOrigins);
      return context.html(renderLabelBatchPage(labels));
    } catch (error) {
      return handleLabelError(context, error);
    }
  });

  app.post('/admin/labels/batch/download', async (context) => {
    setPrivateHeaders(context);
    if (!context.env.DB)
      return labelError(context, 503, 'service_unavailable', 'Service indisponible.');

    const selection = await parseSelection(context);
    if (selection instanceof Response) return selection;

    try {
      const labels = await getShipmentLabels(context.env.DB, selection);
      const allowedOrigins = parseAllowedLabelOrigins(context.env.COURIER_LABEL_ORIGINS);
      const files: Record<string, Uint8Array> = {};
      let totalBytes = 0;
      for (const [index, label] of labels.entries()) {
        const downloaded = await downloadShipmentLabel(label, allowedOrigins, fetchLabel);
        totalBytes += downloaded.bytes.byteLength;
        if (totalBytes > MAX_BATCH_BYTES) throw new LabelDownloadError();
        const prefix = String(index + 1).padStart(2, '0');
        files[`${prefix}-${labelFilename(label, downloaded.extension)}`] = downloaded.bytes;
      }

      const archive = zipSync(files, { level: 0 });
      context.header('Content-Type', 'application/zip');
      context.header('Content-Disposition', 'attachment; filename="etiquettes-selection.zip"');
      return context.body(toArrayBuffer(archive));
    } catch (error) {
      return handleLabelError(context, error);
    }
  });
}

async function parseSelection(context: Context<AppEnvironment>): Promise<Response | string[]> {
  let formData: FormData;
  try {
    formData = await context.req.formData();
  } catch {
    return labelError(context, 400, 'invalid_selection', 'Sélection invalide.');
  }
  const parsed = labelBatchSchema.safeParse({
    shipmentIds: formData
      .getAll('shipmentId')
      .filter((value): value is string => typeof value === 'string'),
  });
  if (!parsed.success) {
    return labelError(context, 400, 'invalid_selection', 'Sélectionnez entre 1 et 20 étiquettes.');
  }
  return parsed.data.shipmentIds;
}

function handleLabelError(context: Context<AppEnvironment>, error: unknown): Response {
  if (error instanceof ShipmentLabelNotFoundError) {
    return labelError(context, 404, 'shipment_not_found', 'Colis introuvable.');
  }
  if (error instanceof ShipmentLabelMissingError) {
    return labelError(
      context,
      409,
      'label_missing',
      `Étiquette indisponible pour : ${error.references.join(', ')}.`,
    );
  }
  if (error instanceof LabelConfigurationError) {
    return labelError(
      context,
      503,
      'label_configuration_unavailable',
      "L'origine de l'étiquette n'est pas configurée.",
    );
  }
  if (error instanceof LabelDownloadError) {
    return labelError(
      context,
      502,
      'label_download_failed',
      "L'étiquette n'a pas pu être téléchargée.",
    );
  }
  return labelError(context, 503, 'service_unavailable', 'Service indisponible.');
}

function setPrivateHeaders(context: Context<AppEnvironment>): void {
  context.header('Cache-Control', 'private, no-store, max-age=0');
  context.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
}

function labelError(
  context: Context<AppEnvironment>,
  status: 400 | 404 | 409 | 502 | 503,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
