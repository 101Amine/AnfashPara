// apps/api/src/modules/confirmation/confirmation.routes.ts
import { IllegalTransition, UnauthorizedActor } from '@para/core';
import type { Context, Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { confirmationActionSchema, confirmationOrderIdSchema } from './confirmation.schema';
import { ConfirmationOrderNotFoundError, performConfirmationAction } from './confirmation.service';

export function registerConfirmationRoutes(app: Hono<AppEnvironment>): void {
  app.post('/admin/orders/:orderId/confirmation', async (context) => {
    context.header('Cache-Control', 'private, no-store, max-age=0');
    context.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');

    if (!context.env.DB) {
      return confirmationError(context, 503, 'service_unavailable', 'Service indisponible.');
    }

    const orderId = confirmationOrderIdSchema.safeParse(context.req.param('orderId'));
    if (!orderId.success) {
      return confirmationError(context, 400, 'invalid_order_id', 'Commande invalide.');
    }

    let body: unknown;
    try {
      body = await context.req.parseBody();
    } catch {
      return confirmationError(context, 400, 'invalid_request', 'Action invalide.');
    }

    const action = confirmationActionSchema.safeParse(body);
    if (!action.success) {
      return confirmationError(context, 400, 'invalid_action', 'Action invalide.');
    }

    try {
      const identity = context.get('accessIdentity');
      await performConfirmationAction(context.env.DB, {
        ...action.data,
        actor: `user:${identity.email}`,
        orderId: orderId.data,
      });
      return context.redirect('/admin/orders', 303);
    } catch (error) {
      if (error instanceof ConfirmationOrderNotFoundError) {
        return confirmationError(context, 404, 'order_not_found', 'Commande introuvable.');
      }
      if (error instanceof IllegalTransition) {
        return confirmationError(
          context,
          409,
          'illegal_transition',
          "Cette action n'est plus autorisée pour ce statut.",
        );
      }
      if (error instanceof UnauthorizedActor) {
        return confirmationError(context, 403, 'unauthorized_actor', 'Action non autorisée.');
      }
      return confirmationError(context, 503, 'service_unavailable', 'Service indisponible.');
    }
  });
}

function confirmationError(
  context: Context<AppEnvironment>,
  status: 400 | 403 | 404 | 409 | 503,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}
