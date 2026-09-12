import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

const scratchInput = z.object({
  message: z.string().trim().min(1).max(200),
});

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use('*', async (context, next) => {
  const startedAt = Date.now();
  await next();
  console.log(
    `${context.req.method} ${context.req.path} ${context.res.status} ${Date.now() - startedAt}ms`,
  );
});

app.get('/', (context) =>
  context.json({
    app: context.env.APP_NAME,
    message: 'Hello Cloudflare Workers!',
  }),
);

app.post(
  '/scratch',
  zValidator('json', scratchInput, (result, context) => {
    if (!result.success) {
      return context.json(
        {
          error: 'Invalid request body',
          issues: result.error.issues,
        },
        400,
      );
    }
  }),
  (context) => {
    const input = context.req.valid('json');

    return context.json(
      {
        app: context.env.APP_NAME,
        message: input.message,
      },
      201,
    );
  },
);

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(
      Promise.resolve().then(() => {
        console.log(
          JSON.stringify({
            app: env.APP_NAME,
            cron: controller.cron,
            event: 'scheduled',
            scheduledTime: new Date(controller.scheduledTime).toISOString(),
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<CloudflareBindings>;
