import { toWaMeUrl } from '@para/core';
import { formatOrderMoney } from '../admin-orders/adminOrders.presenter';

export type MessageOrder = {
  id: string;
  status: string;
  order_number: string | null;
  name: string | null;
  phone_e164: string;
  city: string | null;
  cod_amount_centimes: number;
};

export function prepareManualMessage(order: MessageOrder) {
  const greeting = order.name ? `Bonjour ${order.name},` : 'Bonjour,';
  const reference = order.order_number ?? order.id;
  let template: string;
  let text: string;
  if (order.status === 'CONFIRMING' || order.status === 'NO_ANSWER') {
    template = 'confirmation';
    text = `${greeting} merci pour votre commande n°${reference} chez Anfash Para. Total à régler à la livraison : ${formatOrderMoney(order.cod_amount_centimes)}${order.city ? `, à ${order.city}` : ''}. Pouvez-vous confirmer votre commande ou nous indiquer une modification ? Merci !`;
  } else if (order.status === 'SHIPPED') {
    template = 'shipment';
    text = `${greeting} votre commande n°${reference} Anfash Para a été remise pour livraison. Montant à régler à la réception : ${formatOrderMoney(order.cod_amount_centimes)}. Gardez votre téléphone disponible pour organiser la remise. Merci !`;
  } else if (order.status === 'CANCELLED') {
    template = 'cancellation';
    text = `${greeting} votre commande n°${reference} chez Anfash Para a été annulée. Si vous souhaitez commander à nouveau ou avez une question, vous pouvez nous répondre ici. Merci !`;
  } else return null;
  const url = new URL(toWaMeUrl(order.phone_e164));
  url.searchParams.set('text', text);
  return { template, version: 1, text, url: url.toString() };
}
