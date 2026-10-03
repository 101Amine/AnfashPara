// apps/api/src/modules/status-sync/courierStatus.mapper.ts
import type { CourierStatusCode } from '@para/core';

const STATUS_ALIASES: Readonly<Record<string, CourierStatusCode>> = {
  created: 'created',
  cree: 'created',
  picked: 'picked',
  picked_up: 'picked',
  ramasse: 'picked',
  collecte: 'picked',
  in_transit: 'in_transit',
  transit: 'in_transit',
  en_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  en_livraison: 'out_for_delivery',
  delivered: 'delivered',
  livre: 'delivered',
  refused: 'refused',
  refuse: 'refused',
  returned: 'returned',
  retourne: 'returned',
  lost: 'lost',
  perdu: 'lost',
};

export function mapCourierStatus(rawStatus: string): CourierStatusCode | null {
  const normalized = rawStatus
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');

  return STATUS_ALIASES[normalized] ?? null;
}
