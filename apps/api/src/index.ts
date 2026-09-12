import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

const app = new Hono<{ Bindings: ApiBindings }>();

app.use('*', secureHeaders());
app.use('*', async (context, next) => {
  await next();
  context.header('Cache-Control', 'no-store');
});

app.get('/api/health', (context) =>
  context.json({
    environment: context.env.ENVIRONMENT,
    status: 'ok',
  }),
);

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
