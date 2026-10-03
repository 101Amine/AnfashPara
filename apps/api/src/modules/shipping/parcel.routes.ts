// apps/api/src/modules/shipping/parcel.routes.ts
import { CourierClientError, UnauthorizedActor } from '@para/core';
import type { Context, Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import {
  CourierConfigurationError,
  type CourierClientFactory,
} from '../../integrations/courier/courierClient.factory';
import { parcelOrderIdSchema } from './parcel.schema';
import {
  ParcelAlreadyExistsError,
  ParcelOrderDataInvalidError,
  ParcelOrderNotEligibleError,
  ParcelOrderNotFoundError,
  createParcelForOrder,
} from './parcel.service';

export function registerParcelRoutes(
  app: Hono<AppEnvironment>,
  createCourierClient: CourierClientFactory,
): void {
  app.post('/admin/orders/:orderId/parcel', async (context) => {
    context.header('Cache-Control', 'private, no-store, max-age=0');
    context.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');

    const origin = context.req.header('Origin');
    if (
      (origin !== undefined && origin !== new URL(context.req.url).origin) ||
      context.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return parcelError(context, 403, 'invalid_origin', 'Action non autorisée depuis ce site.');

    if (!context.env.DB) {
      return parcelError(context, 503, 'service_unavailable', 'Service indisponible.');
    }

    const orderId = parcelOrderIdSchema.safeParse(context.req.param('orderId'));
    if (!orderId.success) {
      return parcelError(context, 400, 'invalid_order_id', 'Commande invalide.');
    }

    try {
      const courierClient = createCourierClient(context.env);
      await createParcelForOrder(context.env.DB, courierClient, {
        actor: `user:${context.get('accessIdentity').email}`,
        orderId: orderId.data,
      });
      return context.redirect('/admin/orders?status=CONFIRMED', 303);
    } catch (error) {
      if (error instanceof CourierConfigurationError) {
        return parcelError(
          context,
          503,
          'courier_configuration_unavailable',
          'Configuration du transporteur indisponible.',
        );
      }
      if (error instanceof ParcelOrderNotFoundError) {
        return parcelError(context, 404, 'order_not_found', 'Commande introuvable.');
      }
      if (error instanceof ParcelAlreadyExistsError) {
        return parcelError(context, 409, 'parcel_already_exists', 'Un colis existe déjà.');
      }
      if (error instanceof ParcelOrderNotEligibleError) {
        return parcelError(
          context,
          409,
          'order_not_eligible',
          'Seule une commande confirmée peut créer un colis.',
        );
      }
      if (error instanceof ParcelOrderDataInvalidError) {
        return parcelError(
          context,
          409,
          'order_data_incomplete',
          'Les informations de livraison sont incomplètes.',
        );
      }
      if (error instanceof UnauthorizedActor) {
        return parcelError(context, 403, 'unauthorized_actor', 'Action non autorisée.');
      }
      if (error instanceof CourierClientError) {
        return parcelError(
          context,
          error.retryable ? 503 : 502,
          error.retryable ? 'courier_temporarily_unavailable' : 'courier_rejected',
          'Le transporteur a refusé la création. Vous pouvez réessayer.',
        );
      }
      return parcelError(context, 503, 'service_unavailable', 'Service indisponible.');
    }
  });
}

function parcelError(
  context: Context<AppEnvironment>,
  status: 400 | 403 | 404 | 409 | 502 | 503,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}
