// apps/api/src/modules/dashboard/dashboard.routes.ts
import type { Hono } from 'hono';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { loadDashboard } from './dashboard.repository';
import { renderDashboard } from './dashboard.view';

export function registerDashboardRoutes(app: Hono<AppEnvironment>): void {
  app.get('/admin/dashboard', async (c) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Vary', 'Accept, Cookie, Cf-Access-Jwt-Assertion');
    try {
      if (!c.env.DB) throw new Error('Missing database');
      const data = await loadDashboard(c.env.DB);
      return c.req.header('Accept')?.includes('application/json')
        ? c.json(data)
        : c.html(renderDashboard(data));
    } catch {
      return c.json(
        {
          error: {
            code: 'dashboard_unavailable',
            message: 'Tableau de bord temporairement indisponible.',
          },
        },
        503,
      );
    }
  });
}
