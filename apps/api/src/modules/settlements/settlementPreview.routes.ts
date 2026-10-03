import { MAX_SETTLEMENT_FILE_BYTES, parseSettlementCsv, SettlementParseError } from '@para/core';
import type { Context, Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { renderSettlementPreview } from './settlementPreview.view';

const MAX_UPLOAD_BYTES = MAX_SETTLEMENT_FILE_BYTES + 64 * 1024;

export function registerSettlementPreviewRoutes(app: Hono<AppEnvironment>): void {
  const privateResponse = async (context: Context<AppEnvironment>, next: () => Promise<void>) => {
    context.header('Cache-Control', 'private, no-store, max-age=0');
    context.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    await next();
  };
  app.use('/admin/settlements', privateResponse);
  app.use('/admin/settlements/*', privateResponse);
  app.get('/admin/settlements', (context) =>
    context.html(renderSettlementPreview({ email: context.get('accessIdentity').email })),
  );
  app.post('/admin/settlements/preview', async (context) => {
    const wantsJson = context.req.header('Accept')?.includes('application/json') ?? false;
    const failure = (status: 400 | 403 | 413 | 415 | 422, code: string, message: string) =>
      wantsJson
        ? context.json({ error: { code, message } }, status)
        : context.html(
            renderSettlementPreview({ email: context.get('accessIdentity').email, error: message }),
            status,
          );
    const origin = context.req.header('Origin');
    if (origin !== undefined && origin !== new URL(context.req.url).origin) {
      return failure(403, 'invalid_origin', 'Veuillez envoyer le fichier depuis ce site.');
    }
    if (!context.req.header('Content-Type')?.toLowerCase().startsWith('multipart/form-data;')) {
      return failure(415, 'unsupported_media_type', 'Envoyez un fichier CSV via le formulaire.');
    }
    try {
      const bytes = await readLimitedBody(context.req.raw);
      const form = await new Response(bytes, {
        headers: { 'Content-Type': context.req.header('Content-Type')! },
      }).formData();
      const file = form.get('file');
      if (
        !(file instanceof File) ||
        form.getAll('file').length !== 1 ||
        [...form.keys()].some((key) => key !== 'file')
      ) {
        return failure(400, 'invalid_upload', 'Sélectionnez un seul fichier CSV.');
      }
      if (!file.name.toLowerCase().endsWith('.csv')) {
        return failure(
          415,
          'unsupported_file_type',
          'Seuls les fichiers CSV sont acceptés pour le moment.',
        );
      }
      if (file.size > MAX_SETTLEMENT_FILE_BYTES) {
        return failure(413, 'file_too_large', 'Le fichier dépasse la limite de 1 Mio.');
      }
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        return failure(400, 'invalid_encoding', 'Le fichier doit être encodé en UTF-8.');
      }
      const preview = parseSettlementCsv(source);
      const status = preview.valid ? 200 : 422;
      return wantsJson
        ? context.json(preview, status)
        : context.html(
            renderSettlementPreview({
              email: context.get('accessIdentity').email,
              filename: file.name.slice(0, 128),
              preview,
            }),
            status,
          );
    } catch (error) {
      if (error instanceof SettlementParseError) {
        return failure(error.code === 'file_too_large' ? 413 : 422, error.code, error.message);
      }
      return failure(
        400,
        'invalid_upload',
        'Le fichier n’a pas pu être lu. Réessayez avec un CSV valide.',
      );
    }
  });
}

/** Bound the actual stream, even when Content-Length is absent or inaccurate. */
async function readLimitedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('Content-Length')) > MAX_UPLOAD_BYTES) {
    throw new SettlementParseError('file_too_large', 'Le fichier dépasse la limite de 1 Mio.');
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new SettlementParseError('file_too_large', 'Le fichier dépasse la limite de 1 Mio.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
