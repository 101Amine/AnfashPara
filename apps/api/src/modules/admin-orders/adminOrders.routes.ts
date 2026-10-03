// apps/api/src/modules/admin-orders/adminOrders.routes.ts
import type { Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { listAdminOrders } from './adminOrders.repository';
import { adminOrdersQuerySchema, decodeAdminOrdersCursor } from './adminOrders.schema';
import { renderAdminOrdersPage } from './adminOrders.view';

export function registerAdminOrdersRoutes(app: Hono<AppEnvironment>): void {
  app.get('/admin/orders', async (context) => {
    context.header('Cache-Control', 'private, no-store, max-age=0');
    context.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');

    if (!context.env.DB) {
      return context.html('<h1>Service temporairement indisponible</h1>', 503);
    }

    const url = new URL(context.req.url);
    const parsedQuery = adminOrdersQuerySchema.safeParse({
      cursor: url.searchParams.get('cursor') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      status: url.searchParams.get('status') || undefined,
    });
    if (!parsedQuery.success) {
      return context.html('<h1>Filtres invalides</h1>', 400);
    }

    let cursor;
    if (parsedQuery.data.cursor !== undefined) {
      const decodedCursor = decodeAdminOrdersCursor(parsedQuery.data.cursor);
      if (decodedCursor === null) {
        return context.html('<h1>Curseur de pagination invalide</h1>', 400);
      }
      cursor = decodedCursor;
    }

    try {
      const page = await listAdminOrders(context.env.DB, {
        ...(cursor === undefined ? {} : { cursor }),
        query: parsedQuery.data.q,
        ...(parsedQuery.data.status === undefined ? {} : { status: parsedQuery.data.status }),
      });

      return context.html(
        await renderAdminOrdersPage({
          identityEmail: context.get('accessIdentity').email,
          now: new Date(),
          page,
          query: parsedQuery.data,
        }),
      );
    } catch {
      return context.html('<h1>Service temporairement indisponible</h1>', 503);
    }
  });
}
