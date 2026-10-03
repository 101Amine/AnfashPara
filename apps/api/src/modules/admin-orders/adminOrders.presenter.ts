// apps/api/src/modules/admin-orders/adminOrders.presenter.ts
import type { OrderStatus } from '../../db/schema';

const STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  CANCELLED: 'Annulée',
  CONFIRMED: 'Confirmée',
  CONFIRMING: 'À confirmer',
  DELIVERED: 'Livrée',
  NEW: 'Nouvelle',
  NO_ANSWER: 'Sans réponse',
  PACKED: 'Préparée',
  REFUSED: 'Refusée',
  RETURNED: 'Retournée',
  SETTLED: 'Réglée',
  SHIPPED: 'Expédiée',
};

const dateFormatter = new Intl.DateTimeFormat('fr-MA', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Africa/Casablanca',
});

const moneyFormatter = new Intl.NumberFormat('fr-MA', {
  currency: 'MAD',
  currencyDisplay: 'code',
  style: 'currency',
});

export function getOrderStatusLabel(status: OrderStatus): string {
  return STATUS_LABELS[status];
}

export function formatOrderDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatOrderMoney(centimes: number): string {
  return moneyFormatter.format(centimes / 100);
}

export function formatSlaAge(
  status: OrderStatus,
  statusStartedAt: string,
  now: Date,
): string | null {
  if (status !== 'CONFIRMING' && status !== 'NO_ANSWER') return null;

  const elapsedMinutes = Math.max(
    0,
    Math.floor((now.getTime() - new Date(statusStartedAt).getTime()) / 60_000),
  );
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;

  const hours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  if (hours < 24)
    return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days} j` : `${days} j ${remainingHours} h`;
}
