import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { products, settings } from './db/schema';

const STORE_ID = 'para-main';
const READ_CACHE_CONTROL = 'public, max-age=60';

const app = new Hono<{ Bindings: ApiBindings }>();

app.use('*', secureHeaders());
app.use('*', async (context, next) => {
  await next();
  if (!context.res.headers.has('Cache-Control')) {
    context.header('Cache-Control', 'no-store');
  }
});

app.get('/api/health', async (context) => {
  try {
    if (!context.env.DB) {
      throw new Error('D1 binding unavailable');
    }

    await context.env.DB.prepare('SELECT 1').first();

    return context.json({
      db: 'ok',
      environment: context.env.ENVIRONMENT,
      status: 'ok',
    });
  } catch {
    return context.json(
      {
        db: 'error',
        environment: context.env.ENVIRONMENT,
        status: 'error',
      },
      503,
    );
  }
});

app.get('/api/products', async (context) => {
  if (!context.env.DB) {
    return context.json({ error: 'Service unavailable' }, 503);
  }

  try {
    const db = drizzle(context.env.DB);
    const activeProducts = await db
      .select({
        id: products.id,
        name: products.name,
        priceCentimes: products.priceCentimes,
        slug: products.slug,
      })
      .from(products)
      .where(and(eq(products.storeId, STORE_ID), eq(products.active, true)))
      .orderBy(asc(products.name));

    context.header('Cache-Control', READ_CACHE_CONTROL);
    return context.json({ products: activeProducts });
  } catch {
    return context.json({ error: 'Service unavailable' }, 503);
  }
});

app.get('/api/settings', async (context) => {
  if (!context.env.DB) {
    return context.json({ error: 'Service unavailable' }, 503);
  }

  try {
    const db = drizzle(context.env.DB);
    const [storeSettings] = await db
      .select({
        currency: settings.currency,
        locale: settings.locale,
        minimumOrderCentimes: settings.minimumOrderCentimes,
        timezone: settings.timezone,
      })
      .from(settings)
      .where(eq(settings.storeId, STORE_ID))
      .limit(1);

    if (!storeSettings) {
      return context.json({ error: 'Settings not found' }, 404);
    }

    context.header('Cache-Control', READ_CACHE_CONTROL);
    return context.json({ settings: storeSettings });
  } catch {
    return context.json({ error: 'Service unavailable' }, 503);
  }
});

app.get('/api/version', (context) =>
  context.json({
    gitSha: context.env.GIT_SHA,
  }),
);

app.notFound((context) => context.json({ error: 'Not found' }, 404));

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(
      Promise.resolve().then(() => {
        console.log(
          JSON.stringify({
            cron: controller.cron,
            environment: env.ENVIRONMENT,
            event: 'scheduled',
            gitSha: env.GIT_SHA,
            scheduledTime: new Date(controller.scheduledTime).toISOString(),
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<ApiBindings>;
